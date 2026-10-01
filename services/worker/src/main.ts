import { createDecipheriv, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import http, { type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import type { LookupFunction } from "node:net";
import https from "node:https";
import { Kafka, logLevel, type Consumer, type KafkaConfig, type Producer } from "kafkajs";
import {
  createWebhookSignature,
  isRetryableFailure,
  resolveDestination,
  retryDelayMs,
  type ErrorCategory,
  type RetryPolicy,
} from "@devpulse/contracts";
import { Pool, type PoolClient } from "pg";

const nodeEnvironment = process.env.NODE_ENV ?? "development";
if (!["development", "test", "production"].includes(nodeEnvironment)) {
  throw new Error("NODE_ENV must be development, test, or production");
}
const environment = nodeEnvironment as "development" | "test" | "production";
const brokers = (
  process.env.KAFKA_BROKERS ?? (environment === "production" ? "" : "localhost:9092")
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (brokers.length === 0) throw new Error("KAFKA_BROKERS must contain at least one broker");
const kafkaSslSetting = process.env.KAFKA_SSL ?? (environment === "production" ? "true" : "false");
if (kafkaSslSetting !== "true" && kafkaSslSetting !== "false")
  throw new Error("KAFKA_SSL must be true or false");
const kafkaSsl = kafkaSslSetting === "true";
if (environment === "production" && !kafkaSsl)
  throw new Error("KAFKA_SSL must be enabled in production");
const saslMechanism = process.env.KAFKA_SASL_MECHANISM;
const saslUsername = process.env.KAFKA_SASL_USERNAME;
const saslPassword = process.env.KAFKA_SASL_PASSWORD;
let sasl: KafkaConfig["sasl"];
if (saslMechanism || saslUsername || saslPassword) {
  if (!saslMechanism || !saslUsername || !saslPassword)
    throw new Error("Kafka SASL mechanism, username, and password must be configured together");
  if (!kafkaSsl) throw new Error("Kafka SASL credentials require KAFKA_SSL=true");
  if (saslMechanism === "plain") {
    sasl = { mechanism: "plain", username: saslUsername, password: saslPassword };
  } else if (saslMechanism === "scram-sha-256") {
    sasl = { mechanism: "scram-sha-256", username: saslUsername, password: saslPassword };
  } else if (saslMechanism === "scram-sha-512") {
    sasl = { mechanism: "scram-sha-512", username: saslUsername, password: saslPassword };
  } else {
    throw new Error("KAFKA_SASL_MECHANISM must be plain, scram-sha-256, or scram-sha-512");
  }
}
const kafka = new Kafka({
  clientId: "devpulse-worker",
  brokers,
  logLevel: logLevel.NOTHING,
  ssl: kafkaSsl,
  ...(sasl ? { sasl } : {}),
});
const producer = kafka.producer({ allowAutoTopicCreation: false });
const consumer = kafka.consumer({
  groupId: "devpulse-delivery-workers",
  allowAutoTopicCreation: false,
});
const databaseUrl =
  process.env.DATABASE_URL ??
  (environment === "production" ? "" : "postgres://devpulse:devpulse@localhost:5432/devpulse");
if (!databaseUrl) throw new Error("DATABASE_URL is required in production");
if (
  environment === "production" &&
  ["localhost", "127.0.0.1", "::1"].includes(new URL(databaseUrl).hostname)
) {
  throw new Error("DATABASE_URL must point to the configured production database");
}
const poolSize = Number(process.env.DB_POOL_SIZE ?? 10);
if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 50)
  throw new Error("DB_POOL_SIZE must be between 1 and 50");
const pool = new Pool({
  connectionString: databaseUrl,
  max: poolSize,
  connectionTimeoutMillis: 5000,
  application_name: "devpulse-worker",
});
const configuredEncryptionKey =
  process.env.SIGNING_SECRET_ENCRYPTION_KEY ??
  (environment === "production" ? "" : "44".repeat(32));
if (!/^[a-f0-9]{64}$/i.test(configuredEncryptionKey))
  throw new Error("SIGNING_SECRET_ENCRYPTION_KEY must be a 32-byte hex value");
if (environment === "production" && configuredEncryptionKey.toLowerCase() === "44".repeat(32)) {
  throw new Error(
    "SIGNING_SECRET_ENCRYPTION_KEY must not use the local example value in production",
  );
}
const encryptionKey = Buffer.from(configuredEncryptionKey, "hex");
const allowPrivate =
  environment !== "production" && process.env.ALLOW_PRIVATE_DESTINATIONS === "true";
const responseLimit = Number(process.env.WEBHOOK_RESPONSE_LIMIT_BYTES ?? 65536);
const defaultTimeoutMs = Number(process.env.WEBHOOK_TIMEOUT_MS ?? 10000);
if (!Number.isInteger(responseLimit) || responseLimit < 1 || responseLimit > 1048576)
  throw new Error("WEBHOOK_RESPONSE_LIMIT_BYTES must be between 1 and 1048576");
if (!Number.isInteger(defaultTimeoutMs) || defaultTimeoutMs < 100 || defaultTimeoutMs > 30000)
  throw new Error("WEBHOOK_TIMEOUT_MS must be between 100 and 30000");
const stopController = new AbortController();
const workerInstanceId = randomUUID();

type Job = { deliveryId: string };
type ClaimedDelivery = {
  deliveryId: string;
  tenantId: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  eventPayload: Record<string, unknown>;
  endpointUrl: string;
  timeoutMs: number;
  retryPolicy: RetryPolicy;
  secretCiphertext: string;
  attemptNumber: number;
  createdAt: Date;
};
type Outcome =
  | { ok: true; status: number; durationMs: number; responseBytes: number }
  | {
      ok: false;
      status: number | null;
      durationMs: number;
      responseBytes: number;
      category: ErrorCategory;
    };

async function main(): Promise<void> {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({
    topic: process.env.KAFKA_DELIVERY_TOPIC ?? "devpulse.deliveries",
    fromBeginning: true,
  });
  const consumerLoop = consumer.run({
    autoCommit: false,
    eachMessage: async ({ topic, partition, message, heartbeat }) => {
      if (!message.value) throw new Error("Received an empty delivery message");
      const job = JSON.parse(message.value.toString("utf8")) as Job;
      if (!job.deliveryId || !isUuid(job.deliveryId))
        throw new Error("Received an invalid delivery message");
      await processDelivery(job.deliveryId);
      await consumer.commitOffsets([
        { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
      ]);
      await heartbeat();
    },
  });
  const publisherLoop = runOutboxPublisher(stopController.signal);
  const schedulerLoop = runRetryScheduler(stopController.signal);
  await consumerLoop;
  await Promise.all([publisherLoop, schedulerLoop]);
}

async function processDelivery(deliveryId: string): Promise<void> {
  const claimed = await claimDelivery(deliveryId);
  if (!claimed) {
    writeLog("delivery.skipped", { deliveryId, reason: "missing_or_not_claimable" });
    return;
  }
  const started = Date.now();
  let outcome: Outcome;
  try {
    const secret = decryptSecret(claimed.secretCiphertext);
    outcome = await deliver(claimed, secret, stopController.signal);
  } catch (error) {
    outcome = {
      ok: false,
      status: null,
      durationMs: Date.now() - started,
      responseBytes: 0,
      category:
        error instanceof DestinationPolicyError
          ? "policy"
          : error instanceof DestinationNetworkError
            ? "network"
            : "internal",
    };
    writeLog("delivery.exception", { deliveryId, category: outcome.category });
  }
  await persistOutcome(claimed, outcome);
}

async function claimDelivery(deliveryId: string): Promise<ClaimedDelivery | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{
      id: string;
      tenant_id: string;
      endpoint_id: string;
      event_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      url: string;
      timeout_ms: number;
      retry_policy: RetryPolicy;
      signing_secret_ciphertext: string;
      attempt_count: number;
      created_at: Date;
      status: string;
      next_attempt_at: Date | null;
      lease_expires_at: Date | null;
      enabled: boolean;
    }>(
      `SELECT d.id,d.tenant_id,d.endpoint_id,d.event_id,d.status,d.attempt_count,d.next_attempt_at,d.lease_expires_at,d.created_at,
              e.event_type,e.payload,ep.url,ep.timeout_ms,ep.retry_policy,ep.signing_secret_ciphertext,ep.enabled
       FROM deliveries d JOIN events e ON e.id=d.event_id AND e.tenant_id=d.tenant_id
       JOIN endpoints ep ON ep.id=d.endpoint_id AND ep.tenant_id=d.tenant_id
       WHERE d.id=$1 FOR UPDATE OF d`,
      [deliveryId],
    );
    const row = result.rows[0];
    if (!row || !["pending", "retry_scheduled", "processing"].includes(row.status)) {
      await client.query("COMMIT");
      return null;
    }
    if (row.status === "processing" && row.lease_expires_at && row.lease_expires_at > new Date()) {
      await client.query("COMMIT");
      return null;
    }
    if (
      row.status === "retry_scheduled" &&
      row.next_attempt_at &&
      row.next_attempt_at > new Date()
    ) {
      await client.query("COMMIT");
      return null;
    }
    const attemptNumber = row.attempt_count + 1;
    await client.query(
      `UPDATE deliveries SET status='processing',attempt_count=$2,lease_expires_at=now()+interval '2 minutes',updated_at=now()
       WHERE id=$1`,
      [deliveryId, attemptNumber],
    );
    await client.query(
      "INSERT INTO delivery_attempts (id,delivery_id,attempt_number,started_at) VALUES ($1,$2,$3,now())",
      [randomUUID(), deliveryId, attemptNumber],
    );
    await client.query("COMMIT");
    if (!row.enabled) {
      return {
        deliveryId,
        tenantId: row.tenant_id,
        endpointId: row.endpoint_id,
        eventId: row.event_id,
        eventType: row.event_type,
        eventPayload: row.payload,
        endpointUrl: "",
        timeoutMs: row.timeout_ms,
        retryPolicy: row.retry_policy,
        secretCiphertext: row.signing_secret_ciphertext,
        attemptNumber,
        createdAt: row.created_at,
      };
    }
    return {
      deliveryId,
      tenantId: row.tenant_id,
      endpointId: row.endpoint_id,
      eventId: row.event_id,
      eventType: row.event_type,
      eventPayload: row.payload,
      endpointUrl: row.url,
      timeoutMs: row.timeout_ms,
      retryPolicy: row.retry_policy,
      secretCiphertext: row.signing_secret_ciphertext,
      attemptNumber,
      createdAt: row.created_at,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function deliver(
  job: ClaimedDelivery,
  secret: string,
  signal: AbortSignal,
): Promise<Outcome> {
  if (!job.endpointUrl)
    return { ok: false, status: null, durationMs: 0, responseBytes: 0, category: "policy" };
  const timeoutMs = Math.min(Math.max(job.timeoutMs, 100), defaultTimeoutMs);
  let destination;
  try {
    destination = await withTimeout(
      resolveDestination(job.endpointUrl, { environment, allowPrivate }),
      Math.min(timeoutMs, 5000),
      "Webhook destination DNS resolution timed out",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Destination rejected";
    if (message.includes("could not be resolved") || message.includes("DNS resolution timed out")) {
      throw new DestinationNetworkError(message);
    }
    throw new DestinationPolicyError(message);
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(job.eventPayload);
  const signature = createWebhookSignature(secret, timestamp, body);
  const headers = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body).toString(),
    "user-agent": "DevPulse-Webhook/0.1",
    "x-devpulse-event": job.eventId,
    "x-devpulse-delivery": job.deliveryId,
    "x-devpulse-attempt": job.attemptNumber.toString(),
    "x-devpulse-signature": signature,
    "idempotency-key": job.deliveryId,
  };
  return requestWebhook(
    destination.url,
    destination.addresses[0]!,
    body,
    headers,
    timeoutMs,
    responseLimit,
    signal,
  );
}

function requestWebhook(
  url: URL,
  address: { address: string; family: number },
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<Outcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    let responseBytes = 0;
    let settled = false;
    let category: ErrorCategory = "network";
    // The abort path may call finish before the hard timeout is assigned below.
    // eslint-disable-next-line prefer-const
    let hardTimer: NodeJS.Timeout | undefined;
    const protocol = url.protocol === "https:" ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const pinnedLookup: LookupFunction = (_host, options, callback) =>
      options.all
        ? callback(null, [{ address: address.address, family: address.family }])
        : callback(null, address.address, address.family);
    const options: RequestOptions = {
      protocol: url.protocol,
      hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers,
      lookup: pinnedLookup,
      ...(url.protocol === "https:" && isIP(hostname) === 0 ? { servername: hostname } : {}),
    };
    const finish = (outcome: Outcome) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      signal.removeEventListener("abort", abortRequest);
      resolve(outcome);
    };
    const req: ClientRequest = protocol.request(options, (response: IncomingMessage) => {
      response.on("data", (chunk: Buffer | string) => {
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes > maxResponseBytes) {
          category = "response_too_large";
          req.destroy(new Error("Webhook response exceeded the configured size limit"));
        }
      });
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        finish(
          status >= 200 && status < 300
            ? { ok: true, status, durationMs: Date.now() - started, responseBytes }
            : {
                ok: false,
                status,
                durationMs: Date.now() - started,
                responseBytes,
                category: "http",
              },
        );
      });
    });
    const abortRequest = () => req.destroy(new Error("delivery cancelled"));
    signal.addEventListener("abort", abortRequest, { once: true });
    if (signal.aborted) {
      finish({ ok: false, status: null, durationMs: 0, responseBytes, category: "network" });
      return;
    }
    hardTimer = setTimeout(() => {
      category = "timeout";
      req.destroy(new Error("webhook request exceeded its total timeout"));
    }, timeoutMs);
    req.setTimeout(timeoutMs, () => {
      category = "timeout";
      req.destroy(new Error("webhook request timed out"));
    });
    req.on("error", (error: Error) => {
      if (category !== "response_too_large" && category !== "timeout") category = "network";
      writeLog("webhook.request.failed", { category, error: safeErrorMessage(error.message) });
      finish({
        ok: false,
        status: null,
        durationMs: Date.now() - started,
        responseBytes,
        category,
      });
    });
    req.end(body);
  });
}

async function persistOutcome(job: ClaimedDelivery, outcome: Outcome): Promise<void> {
  const policy = job.retryPolicy;
  const inRetryWindow = Date.now() - job.createdAt.getTime() < policy.maxElapsedSeconds * 1000;
  const retryable =
    !outcome.ok &&
    isRetryableFailure({
      category: outcome.category,
      ...(outcome.status ? { httpStatus: outcome.status } : {}),
    });
  const shouldRetry = retryable && job.attemptNumber < policy.maxAttempts && inRetryWindow;
  const nextAt = shouldRetry
    ? new Date(Date.now() + retryDelayMs(policy, job.attemptNumber))
    : null;
  const status = outcome.ok
    ? "succeeded"
    : shouldRetry
      ? "retry_scheduled"
      : retryable
        ? "dead_lettered"
        : "failed";
  await inTransaction(async (client) => {
    await client.query(
      `UPDATE delivery_attempts SET completed_at=now(),http_status=$3,duration_ms=$4,response_excerpt=$5,
         error_category=$6,next_attempt_at=$7 WHERE delivery_id=$1 AND attempt_number=$2`,
      [
        job.deliveryId,
        job.attemptNumber,
        outcome.status,
        outcome.durationMs,
        outcome.responseBytes ? `HTTP response received (${outcome.responseBytes} bytes)` : null,
        outcome.ok ? null : outcome.category,
        nextAt,
      ],
    );
    await client.query(
      `UPDATE deliveries SET status=$2,next_attempt_at=$3,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND status='processing'`,
      [job.deliveryId, status, nextAt],
    );
    await client.query(
      `INSERT INTO audit_events (id,tenant_id,action,subject_type,subject_id,metadata)
       VALUES ($1,$2,$3,'delivery',$4,$5::jsonb)`,
      [
        randomUUID(),
        job.tenantId,
        `delivery.${status}`,
        job.deliveryId,
        JSON.stringify({ attempt: job.attemptNumber }),
      ],
    );
  });
  writeLog("delivery.completed", {
    deliveryId: job.deliveryId,
    eventId: job.eventId,
    status,
    attempt: job.attemptNumber,
    httpStatus: outcome.status,
  });
}

async function runOutboxPublisher(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const count = await publishOutboxBatch();
      if (count === 0) await delay(500, signal);
    } catch (error) {
      writeLog("outbox.publish.failed", {
        message: safeErrorMessage(error instanceof Error ? error.message : String(error)),
      });
      await delay(2000, signal);
    }
  }
}

async function publishOutboxBatch(): Promise<number> {
  const client = await pool.connect();
  let lockedIds: string[] = [];
  try {
    await client.query("BEGIN");
    const result = await client.query<{ id: string; delivery_id: string; payload: object }>(
      `SELECT id,delivery_id,payload FROM outbox WHERE published_at IS NULL AND available_at <= now()
       ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
    );
    lockedIds = result.rows.map((row) => row.id);
    for (const row of result.rows) {
      await producer.send({
        topic: process.env.KAFKA_DELIVERY_TOPIC ?? "devpulse.deliveries",
        acks: -1,
        messages: [
          {
            key: row.delivery_id,
            value: JSON.stringify(row.payload),
            headers: { "outbox-id": row.id },
          },
        ],
      });
      await client.query(
        "UPDATE outbox SET published_at=now(),publish_attempts=publish_attempts+1 WHERE id=$1",
        [row.id],
      );
      await client.query("UPDATE deliveries SET last_enqueued_at=now() WHERE id=$1", [
        row.delivery_id,
      ]);
    }
    await client.query("COMMIT");
    return result.rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    if (lockedIds.length > 0) {
      await pool.query(
        `UPDATE outbox SET publish_attempts=publish_attempts+1,
         available_at=now()+make_interval(secs=>LEAST(300,power(2,LEAST(publish_attempts,8))))
         WHERE id=ANY($1::uuid[]) AND published_at IS NULL`,
        [lockedIds],
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function runRetryScheduler(signal: AbortSignal): Promise<void> {
  let lastHeartbeatAt = 0;
  while (!signal.aborted) {
    try {
      await inTransaction(async (client) => {
        if (Date.now() - lastHeartbeatAt >= 10000) {
          await client.query(
            `INSERT INTO worker_heartbeats (service_name,instance_id,last_seen_at,details)
             VALUES ('delivery-worker',$1,now(),$2::jsonb)
             ON CONFLICT (service_name) DO UPDATE SET instance_id=EXCLUDED.instance_id,last_seen_at=EXCLUDED.last_seen_at,details=EXCLUDED.details`,
            [
              workerInstanceId,
              JSON.stringify({ topic: process.env.KAFKA_DELIVERY_TOPIC ?? "devpulse.deliveries" }),
            ],
          );
          lastHeartbeatAt = Date.now();
        }
        const expiredLeases = await client.query<{
          id: string;
          tenant_id: string;
          attempt_count: number;
          created_at: Date;
          retry_policy: RetryPolicy;
        }>(
          `SELECT d.id,d.tenant_id,d.attempt_count,d.created_at,ep.retry_policy
           FROM deliveries d JOIN endpoints ep ON ep.id=d.endpoint_id
           JOIN delivery_attempts a ON a.delivery_id=d.id AND a.attempt_number=d.attempt_count
           WHERE d.status='processing' AND d.lease_expires_at <= now()
           ORDER BY d.lease_expires_at LIMIT 100 FOR UPDATE OF d SKIP LOCKED`,
        );
        for (const delivery of expiredLeases.rows) {
          const exhausted =
            delivery.attempt_count >= delivery.retry_policy.maxAttempts ||
            Date.now() - delivery.created_at.getTime() >=
              delivery.retry_policy.maxElapsedSeconds * 1000;
          await client.query(
            `UPDATE delivery_attempts SET completed_at=now(),duration_ms=GREATEST(0,(extract(epoch from (now()-started_at))*1000)::integer),
             response_excerpt='Worker lease expired before completion',error_category='internal'
             WHERE delivery_id=$1 AND attempt_number=$2 AND completed_at IS NULL`,
            [delivery.id, delivery.attempt_count],
          );
          await client.query(
            `UPDATE deliveries SET status=$2,next_attempt_at=CASE WHEN $2='retry_scheduled' THEN now() ELSE NULL END,
             lease_expires_at=NULL,updated_at=now() WHERE id=$1`,
            [delivery.id, exhausted ? "dead_lettered" : "retry_scheduled"],
          );
          if (exhausted) {
            await client.query(
              `INSERT INTO audit_events (id,tenant_id,action,subject_type,subject_id,metadata)
               VALUES ($1,$2,'delivery.dead_lettered','delivery',$3,$4::jsonb)`,
              [
                randomUUID(),
                delivery.tenant_id,
                delivery.id,
                JSON.stringify({ reason: "worker_lease_expired" }),
              ],
            );
          }
        }
        const due = await client.query<{ id: string; tenant_id: string; next_attempt_at: Date }>(
          `SELECT id,tenant_id,next_attempt_at FROM deliveries
           WHERE status='retry_scheduled' AND next_attempt_at <= now()
           ORDER BY next_attempt_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
        );
        for (const delivery of due.rows) {
          await client.query(
            `INSERT INTO outbox (id,tenant_id,delivery_id,message_type,payload,available_at)
             VALUES ($1,$2,$3,'delivery.retry',$4::jsonb,$5) ON CONFLICT (message_type,delivery_id,available_at) DO NOTHING`,
            [
              randomUUID(),
              delivery.tenant_id,
              delivery.id,
              JSON.stringify({ deliveryId: delivery.id }),
              delivery.next_attempt_at,
            ],
          );
        }
        const stalled = await client.query<{ id: string; tenant_id: string }>(
          `SELECT d.id,d.tenant_id FROM deliveries d
           WHERE d.status IN ('pending','retry_scheduled')
             AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= now())
             AND (d.last_enqueued_at IS NULL OR d.last_enqueued_at <= now()-interval '30 seconds')
             AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.delivery_id=d.id AND o.published_at IS NULL)
           ORDER BY d.created_at LIMIT 100 FOR UPDATE OF d SKIP LOCKED`,
        );
        for (const delivery of stalled.rows) {
          await client.query(
            `INSERT INTO outbox (id,tenant_id,delivery_id,message_type,payload,available_at)
             VALUES ($1,$2,$3,'delivery.reconcile',$4::jsonb,now())`,
            [
              randomUUID(),
              delivery.tenant_id,
              delivery.id,
              JSON.stringify({ deliveryId: delivery.id }),
            ],
          );
          await client.query("UPDATE deliveries SET last_enqueued_at=now() WHERE id=$1", [
            delivery.id,
          ]);
        }
      });
      await delay(1000, signal);
    } catch (error) {
      writeLog("retry.scheduler.failed", {
        message: safeErrorMessage(error instanceof Error ? error.message : String(error)),
      });
      await delay(2000, signal);
    }
  }
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function decryptSecret(value: string): string {
  const [ivText, tagText, encryptedText] = value.split(".");
  if (!ivText || !tagText || !encryptedText) throw new Error("Stored endpoint secret is invalid");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeErrorMessage(message: string): string {
  return message.replace(/[\r\n\t]/g, " ").slice(0, 160);
}

function writeLog(event: string, fields: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), service: "worker", event, ...fields })}\n`,
  );
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function shutdown(): Promise<void> {
  writeLog("worker.shutdown.started", {});
  stopController.abort();
  const consumerState = consumer as Consumer;
  const producerState = producer as Producer;
  await Promise.allSettled([consumerState.stop()]);
  writeLog("worker.shutdown.consumer_stopped", {});
  await Promise.allSettled([consumerState.disconnect(), producerState.disconnect(), pool.end()]);
  writeLog("worker.shutdown.complete", {});
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
main().catch((error: unknown) => {
  writeLog("worker.startup.failed", {
    message: safeErrorMessage(error instanceof Error ? error.message : String(error)),
  });
  process.exitCode = 1;
  void shutdown();
});

class DestinationPolicyError extends Error {}
class DestinationNetworkError extends Error {}
