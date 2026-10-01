import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { verifyWebhookSignature } from "../packages/contracts/dist/delivery.js";

const apiUrl = process.env.DEVPULSE_API_URL ?? "http://127.0.0.1:4000";
const bootstrapToken = process.env.API_BOOTSTRAP_TOKEN;
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!bootstrapToken) throw new Error("API_BOOTSTRAP_TOKEN is required");
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for persisted-state assertions");

const apiRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { Pool } = apiRequire("pg");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const server = createServer();
const requests = [];
let tenantId;
let deliveryId;
let serverStarted = false;
let passed = false;

server.on("request", (request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  request.on("end", () => {
    requests.push({
      body: Buffer.concat(chunks),
      signature: request.headers["x-devpulse-signature"],
      eventId: request.headers["x-devpulse-event"],
      deliveryId: request.headers["x-devpulse-delivery"],
      attempt: request.headers["x-devpulse-attempt"],
    });
    response.statusCode = requests.length === 1 ? 503 : 204;
    response.end();
  });
});

async function api(path, options = {}) {
  const response = await fetch(new URL(path, apiUrl), {
    ...options,
    signal: AbortSignal.timeout(8000),
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`API ${path} returned HTTP ${response.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function cleanupTenant() {
  if (!tenantId) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM audit_events WHERE tenant_id=$1", [tenantId]);
    await client.query(
      "DELETE FROM delivery_attempts WHERE delivery_id IN (SELECT id FROM deliveries WHERE tenant_id=$1)",
      [tenantId],
    );
    await client.query("DELETE FROM outbox WHERE tenant_id=$1", [tenantId]);
    await client.query("DELETE FROM deliveries WHERE tenant_id=$1", [tenantId]);
    await client.query("DELETE FROM idempotency_records WHERE tenant_id=$1", [tenantId]);
    await client.query("DELETE FROM events WHERE tenant_id=$1", [tenantId]);
    await client.query("DELETE FROM endpoints WHERE tenant_id=$1", [tenantId]);
    await client.query("DELETE FROM api_keys WHERE tenant_id=$1", [tenantId]);
    await client.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  serverStarted = true;
  const address = server.address();
  assert(address && typeof address === "object");
  const receiverUrl = `http://host.docker.internal:${address.port}/webhook`;

  const workspace = await api("/v1/tenants", {
    method: "POST",
    headers: { "x-bootstrap-token": bootstrapToken },
    body: JSON.stringify({ name: `Webhook audit ${randomUUID()}` }),
  });
  tenantId = workspace.tenantId ?? workspace.tenant?.id;
  assert.match(tenantId, /^[0-9a-f-]{36}$/i, "tenant creation returns its ID");
  process.stdout.write(`Audit tenant: ${tenantId}\n`);
  const apiKey = workspace.apiKey;
  assert.equal(typeof apiKey, "string");

  const endpoint = await api("/v1/endpoints", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      url: receiverUrl,
      description: "Disposable local receiver audit",
      eventTypes: ["audit.delivery.test"],
      timeoutMs: 3000,
      retryPolicy: {
        maxAttempts: 3,
        initialDelaySeconds: 1,
        maxDelaySeconds: 1,
        maxElapsedSeconds: 60,
      },
    }),
  });
  const signingSecret = endpoint.signingSecret;
  assert.equal(typeof signingSecret, "string");

  const event = {
    id: randomUUID(),
    type: "audit.delivery.test",
    occurredAt: new Date().toISOString(),
    data: { auditRun: randomUUID(), expected: "retry-then-success" },
  };
  const ingestion = await api("/v1/events", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify(event),
  });
  deliveryId = ingestion.deliveryIds?.[0];
  assert.match(deliveryId, /^[0-9a-f-]{36}$/i, "ingestion returns a delivery ID");
  process.stdout.write(`Audit delivery: ${deliveryId}\n`);

  const deadline = Date.now() + 45000;
  let attempts = [];
  let deliveryStatus;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT d.status, d.attempt_count, a.attempt_number, a.http_status,
              a.error_category, a.next_attempt_at, a.completed_at
         FROM deliveries d
         LEFT JOIN delivery_attempts a ON a.delivery_id=d.id
        WHERE d.tenant_id=$1 AND d.id=$2
        ORDER BY a.attempt_number`,
      [tenantId, deliveryId],
    );
    if (result.rows.length) {
      deliveryStatus = result.rows[0].status;
      attempts = result.rows;
      if (deliveryStatus === "succeeded" && attempts.length === 2) break;
    }
    await delay(250);
  }

  if (deliveryStatus !== "succeeded" || attempts.length !== 2) {
    const outboxState = deliveryId
      ? await pool.query(
          "SELECT message_type,published_at,available_at,publish_attempts FROM outbox WHERE delivery_id=$1 ORDER BY created_at",
          [deliveryId],
        )
      : { rows: [] };
    process.stderr.write(
      `${JSON.stringify({
        deliveryStatus,
        attempts: attempts.map(
          ({ attempt_number, http_status, error_category, next_attempt_at }) => ({
            attempt_number,
            http_status,
            error_category,
            next_attempt_at,
          }),
        ),
        receiverRequests: requests.length,
        outbox: outboxState.rows,
      })}\n`,
    );
  }
  assert.equal(deliveryStatus, "succeeded", "delivery reaches succeeded before timeout");
  assert.equal(attempts.length, 2, "database records two attempts");
  assert.deepEqual(
    attempts.map(({ attempt_number, http_status, error_category }) => [
      attempt_number,
      http_status,
      error_category,
    ]),
    [
      [1, 503, "http"],
      [2, 204, null],
    ],
  );
  assert.ok(attempts[0].next_attempt_at, "retryable 503 schedules the next attempt");
  assert.ok(
    attempts.every((attempt) => attempt.completed_at),
    "both attempts are completed",
  );
  assert.equal(requests.length, 2, "receiver gets exactly two requests");

  for (const [index, received] of requests.entries()) {
    assert.equal(received.eventId, ingestion.eventId);
    assert.equal(received.deliveryId, deliveryId);
    assert.equal(received.attempt, String(index + 1));
    assert.deepEqual(JSON.parse(received.body.toString("utf8")), event);
    assert.equal(
      verifyWebhookSignature(signingSecret, received.body, received.signature),
      true,
      `attempt ${index + 1} signature verifies against the exact received bytes`,
    );
  }

  passed = true;
  process.stdout.write(
    "PASS: receiver got the event twice; both raw-body HMACs verified; attempt 1 was 503/retry_scheduled and attempt 2 was 204/succeeded.\n",
  );
} finally {
  if (serverStarted) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    if (!passed && process.env.KEEP_TEST_TENANT_ON_FAILURE === "true") {
      process.stderr.write(`Preserved failed audit tenant for diagnosis: ${tenantId}\n`);
    } else {
      await cleanupTenant();
      if (tenantId)
        process.stdout.write("PASS: disposable tenant records removed transactionally.\n");
    }
  } finally {
    await pool.end();
  }
}
