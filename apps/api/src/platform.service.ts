import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  CreateEndpointSchema,
  UpdateEndpointSchema,
  WebhookEventSchema,
  createApiKey,
  isWithinJsonLimits,
  verifyApiKey,
  validateDestination,
  type ApiKeyPrincipal,
} from "@devpulse/contracts";
import {
  Inject,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { pool, withTransaction } from "./database.js";
import { RUNTIME_CONFIG } from "./tokens.js";
import type { RuntimeConfig } from "./config.js";

export type EndpointView = {
  id: string;
  url: string;
  description: string;
  enabled: boolean;
  eventTypes: string[];
  timeoutMs: number;
  retryPolicy: Record<string, number>;
  createdAt: string;
  updatedAt: string;
};

export type DeliveryView = {
  id: string;
  eventId: string;
  endpointId: string;
  eventType: string;
  status: string;
  attemptCount: number;
  nextAttemptAt: string | null;
  createdAt: string;
};

export type AttemptView = {
  id: string;
  attemptNumber: number;
  startedAt: string;
  completedAt: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  responseExcerpt: string | null;
  errorCategory: string | null;
  nextAttemptAt: string | null;
};

export type ApiKeyView = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  current: boolean;
};

@Injectable()
export class PlatformService {
  constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {}

  async createTenant(name: string): Promise<{ tenantId: string; apiKey: string }> {
    const tenantId = randomUUID();
    const issued = createApiKey();
    await withTransaction(async (client) => {
      await client.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenantId, name]);
      await client.query(
        "INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, scopes) VALUES ($1, $2, $3, $4, $5, $6)",
        [
          randomUUID(),
          tenantId,
          "Initial API key",
          issued.prefix,
          issued.hash,
          ["endpoints:read", "endpoints:write", "events:write", "deliveries:write", "keys:write"],
        ],
      );
    });
    return { tenantId, apiKey: issued.key };
  }

  async authenticate(apiKey: string | undefined): Promise<ApiKeyPrincipal> {
    if (!apiKey || !/^dp_live_[A-Za-z0-9_-]{40,}$/.test(apiKey))
      throw new UnauthorizedException("Invalid API key");
    const result = await pool.query<{
      id: string;
      tenant_id: string;
      key_hash: string;
      scopes: string[];
    }>(
      "SELECT id, tenant_id, key_hash, scopes FROM api_keys WHERE key_prefix = $1 AND revoked_at IS NULL",
      [apiKey.slice(0, 24)],
    );
    const record = result.rows.find((row) => verifyApiKey(apiKey, row.key_hash));
    if (!record) throw new UnauthorizedException("Invalid API key");
    await pool.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [record.id]);
    return {
      tenantId: record.tenant_id,
      apiKeyId: record.id,
      scopes: record.scopes as ApiKeyPrincipal["scopes"],
    };
  }

  async endpoints(principal: ApiKeyPrincipal): Promise<EndpointView[]> {
    this.requireScope(principal, "endpoints:read");
    const result = await pool.query<EndpointRow>(
      `SELECT id, url, description, enabled, event_types, timeout_ms, retry_policy, created_at, updated_at
       FROM endpoints WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100`,
      [principal.tenantId],
    );
    return result.rows.map(toEndpointView);
  }

  async createEndpoint(
    principal: ApiKeyPrincipal,
    input: unknown,
  ): Promise<{ endpoint: EndpointView; signingSecret: string }> {
    this.requireScope(principal, "endpoints:write");
    const parsed = CreateEndpointSchema.safeParse(input);
    if (!parsed.success)
      throw new BadRequestException(
        parsed.error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
      );
    await validateDestination(parsed.data.url, {
      environment: this.config.environment,
      allowPrivate:
        this.config.environment !== "production" &&
        process.env.ALLOW_PRIVATE_DESTINATIONS === "true",
    });
    const id = randomUUID();
    const signingSecret = randomBytes(32).toString("base64url");
    const encrypted = encryptSecret(this.config.signingEncryptionKey, signingSecret);
    return withTransaction(async (client) => {
      const result = await client.query<EndpointRow>(
        `INSERT INTO endpoints (id, tenant_id, url, description, event_types, timeout_ms, retry_policy, signing_secret_ciphertext)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
         RETURNING id,url,description,enabled,event_types,timeout_ms,retry_policy,created_at,updated_at`,
        [
          id,
          principal.tenantId,
          parsed.data.url,
          parsed.data.description,
          parsed.data.eventTypes,
          parsed.data.timeoutMs,
          JSON.stringify(parsed.data.retryPolicy),
          encrypted,
        ],
      );
      await client.query(
        `INSERT INTO audit_events (id,tenant_id,actor_api_key_id,action,subject_type,subject_id)
         VALUES ($1,$2,$3,'endpoint.created','endpoint',$4)`,
        [randomUUID(), principal.tenantId, principal.apiKeyId, id],
      );
      return { endpoint: toEndpointView(result.rows[0]!), signingSecret };
    });
  }

  async updateEndpoint(
    principal: ApiKeyPrincipal,
    id: string,
    changes: unknown,
  ): Promise<EndpointView> {
    this.requireScope(principal, "endpoints:write");
    const update = UpdateEndpointSchema.safeParse(changes);
    if (!update.success)
      throw new BadRequestException(
        update.error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
      );
    if (update.data.url) {
      await validateDestination(update.data.url, {
        environment: this.config.environment,
        allowPrivate:
          this.config.environment !== "production" &&
          process.env.ALLOW_PRIVATE_DESTINATIONS === "true",
      });
    }
    const result = await pool.query<EndpointRow>(
      `UPDATE endpoints SET
         url = COALESCE($3,url), description = COALESCE($4,description), event_types = COALESCE($5,event_types),
         timeout_ms = COALESCE($6,timeout_ms), retry_policy = COALESCE($7::jsonb,retry_policy),
         enabled = COALESCE($8,enabled), updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
       RETURNING id,url,description,enabled,event_types,timeout_ms,retry_policy,created_at,updated_at`,
      [
        principal.tenantId,
        id,
        update.data.url ?? null,
        update.data.description ?? null,
        update.data.eventTypes ?? null,
        update.data.timeoutMs ?? null,
        update.data.retryPolicy ? JSON.stringify(update.data.retryPolicy) : null,
        update.data.enabled ?? null,
      ],
    );
    if (!result.rows[0]) throw new BadRequestException("Endpoint not found");
    return toEndpointView(result.rows[0]);
  }

  async ingest(
    principal: ApiKeyPrincipal,
    idempotencyKey: string | undefined,
    input: unknown,
  ): Promise<{ eventId: string; deliveryIds: string[]; duplicate: boolean }> {
    this.requireScope(principal, "events:write");
    if (!idempotencyKey || idempotencyKey.length > 200 || /[\r\n]/.test(idempotencyKey)) {
      throw new BadRequestException("A valid Idempotency-Key header is required");
    }
    if (!isWithinJsonLimits(input))
      throw new BadRequestException("Event JSON exceeds the maximum nesting or node limit");
    const parsed = WebhookEventSchema.safeParse(input);
    if (!parsed.success)
      throw new BadRequestException(
        parsed.error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
      );
    const payload = JSON.stringify(parsed.data);
    const requestHash = createHash("sha256").update(payload).digest("hex");
    return withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${principal.tenantId}:${idempotencyKey}`,
      ]);
      await client.query(
        "DELETE FROM idempotency_records WHERE tenant_id=$1 AND idempotency_key=$2 AND expires_at <= now()",
        [principal.tenantId, idempotencyKey],
      );
      const existing = await client.query<{
        request_hash: string;
        response: { eventId: string; deliveryIds: string[] };
      }>(
        "SELECT request_hash,response FROM idempotency_records WHERE tenant_id = $1 AND idempotency_key = $2 AND expires_at > now() FOR UPDATE",
        [principal.tenantId, idempotencyKey],
      );
      if (existing.rows[0]) {
        if (!safeDigestEquals(requestHash, existing.rows[0].request_hash))
          throw new BadRequestException(
            "Idempotency-Key was already used with a different request",
          );
        return { ...existing.rows[0].response, duplicate: true };
      }
      const eventId = randomUUID();
      await client.query(
        "INSERT INTO events (id, tenant_id, event_type, occurred_at, payload) VALUES ($1,$2,$3,$4,$5::jsonb)",
        [eventId, principal.tenantId, parsed.data.type, parsed.data.occurredAt, payload],
      );
      const endpoints = await client.query<{ id: string }>(
        `SELECT id FROM endpoints WHERE tenant_id = $1 AND enabled = true AND deleted_at IS NULL
         AND (cardinality(event_types) = 0 OR $2 = ANY(event_types))`,
        [principal.tenantId, parsed.data.type],
      );
      const deliveryIds: string[] = [];
      for (const endpoint of endpoints.rows) {
        const deliveryId = randomUUID();
        deliveryIds.push(deliveryId);
        await client.query(
          "INSERT INTO deliveries (id,tenant_id,event_id,endpoint_id,status) VALUES ($1,$2,$3,$4,'pending')",
          [deliveryId, principal.tenantId, eventId, endpoint.id],
        );
        await client.query(
          "INSERT INTO outbox (id,tenant_id,delivery_id,message_type,payload) VALUES ($1,$2,$3,'delivery.requested',$4::jsonb)",
          [randomUUID(), principal.tenantId, deliveryId, JSON.stringify({ deliveryId })],
        );
      }
      const response = { eventId, deliveryIds };
      await client.query(
        "INSERT INTO idempotency_records (tenant_id,idempotency_key,request_hash,response,expires_at) VALUES ($1,$2,$3,$4::jsonb,now()+interval '24 hours')",
        [principal.tenantId, idempotencyKey, requestHash, JSON.stringify(response)],
      );
      await client.query(
        "INSERT INTO audit_events (id,tenant_id,actor_api_key_id,action,subject_type,subject_id) VALUES ($1,$2,$3,'event.ingested','event',$4)",
        [randomUUID(), principal.tenantId, principal.apiKeyId, eventId],
      );
      return { ...response, duplicate: false };
    });
  }

  async deliveries(principal: ApiKeyPrincipal): Promise<DeliveryView[]> {
    this.requireScope(principal, "endpoints:read");
    const result = await pool.query<{
      id: string;
      event_id: string;
      endpoint_id: string;
      event_type: string;
      status: string;
      attempt_count: number;
      next_attempt_at: Date | null;
      created_at: Date;
    }>(
      `SELECT d.id,d.event_id,d.endpoint_id,e.event_type,d.status,d.attempt_count,d.next_attempt_at,d.created_at
       FROM deliveries d JOIN events e ON e.id = d.event_id AND e.tenant_id=d.tenant_id
       WHERE d.tenant_id = $1 ORDER BY d.created_at DESC LIMIT 100`,
      [principal.tenantId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      endpointId: row.endpoint_id,
      eventType: row.event_type,
      status: row.status,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async deliveryAttempts(principal: ApiKeyPrincipal, deliveryId: string): Promise<AttemptView[]> {
    this.requireScope(principal, "endpoints:read");
    const owned = await pool.query("SELECT 1 FROM deliveries WHERE id=$1 AND tenant_id=$2", [
      deliveryId,
      principal.tenantId,
    ]);
    if (!owned.rowCount) throw new BadRequestException("Delivery not found");
    const result = await pool.query<{
      id: string;
      attempt_number: number;
      started_at: Date;
      completed_at: Date | null;
      http_status: number | null;
      duration_ms: number | null;
      response_excerpt: string | null;
      error_category: string | null;
      next_attempt_at: Date | null;
    }>(
      `SELECT a.id,a.attempt_number,a.started_at,a.completed_at,a.http_status,a.duration_ms,a.response_excerpt,a.error_category,a.next_attempt_at
       FROM delivery_attempts a JOIN deliveries d ON d.id=a.delivery_id
       WHERE d.id=$1 AND d.tenant_id=$2 ORDER BY a.attempt_number`,
      [deliveryId, principal.tenantId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      attemptNumber: row.attempt_number,
      startedAt: row.started_at.toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null,
      httpStatus: row.http_status,
      durationMs: row.duration_ms,
      responseExcerpt: row.response_excerpt,
      errorCategory: row.error_category,
      nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
    }));
  }

  async retryDelivery(
    principal: ApiKeyPrincipal,
    deliveryId: string,
    idempotencyKey: string,
    mode: "retry" | "replay",
  ): Promise<{ deliveryId: string; duplicate: boolean }> {
    this.requireScope(principal, "deliveries:write");
    if (!idempotencyKey || idempotencyKey.length > 200 || /[\r\n]/.test(idempotencyKey))
      throw new BadRequestException("A valid idempotency key is required");
    return withTransaction(async (client) => {
      const original = await client.query<{
        event_id: string;
        endpoint_id: string;
        status: string;
      }>(
        "SELECT event_id,endpoint_id,status FROM deliveries WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
        [deliveryId, principal.tenantId],
      );
      const row = original.rows[0];
      if (!row) throw new BadRequestException("Delivery not found");
      if (mode === "retry" && row.status !== "failed" && row.status !== "dead_lettered") {
        throw new BadRequestException("Only failed or dead-lettered deliveries can be retried");
      }
      const replayKey = `${mode}:${deliveryId}:${idempotencyKey}`;
      const replayId = randomUUID();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO deliveries (id,tenant_id,event_id,endpoint_id,status,replay_of,replay_key)
         VALUES ($1,$2,$3,$4,'pending',$5,$6) ON CONFLICT (tenant_id,replay_key) DO NOTHING RETURNING id`,
        [replayId, principal.tenantId, row.event_id, row.endpoint_id, deliveryId, replayKey],
      );
      const duplicate = inserted.rowCount === 0;
      const newDeliveryId =
        inserted.rows[0]?.id ??
        (
          await client.query<{ id: string }>(
            "SELECT id FROM deliveries WHERE tenant_id=$1 AND replay_key=$2",
            [principal.tenantId, replayKey],
          )
        ).rows[0]?.id;
      if (!newDeliveryId) throw new Error("Replay delivery was not created");
      if (!duplicate) {
        await client.query(
          `INSERT INTO outbox (id,tenant_id,delivery_id,message_type,payload)
           VALUES ($1,$2,$3,'delivery.replay',$4::jsonb)`,
          [
            randomUUID(),
            principal.tenantId,
            newDeliveryId,
            JSON.stringify({ deliveryId: newDeliveryId }),
          ],
        );
        await client.query(
          `INSERT INTO audit_events (id,tenant_id,actor_api_key_id,action,subject_type,subject_id,metadata)
           VALUES ($1,$2,$3,$4,'delivery',$5,$6::jsonb)`,
          [
            randomUUID(),
            principal.tenantId,
            principal.apiKeyId,
            `delivery.${mode}`,
            newDeliveryId,
            JSON.stringify({ sourceDeliveryId: deliveryId }),
          ],
        );
      }
      return { deliveryId: newDeliveryId, duplicate };
    });
  }

  async apiKeys(principal: ApiKeyPrincipal): Promise<ApiKeyView[]> {
    this.requireScope(principal, "keys:write");
    const result = await pool.query<{
      id: string;
      name: string;
      key_prefix: string;
      scopes: string[];
      created_at: Date;
      revoked_at: Date | null;
      last_used_at: Date | null;
    }>(
      `SELECT id,name,key_prefix,scopes,created_at,revoked_at,last_used_at FROM api_keys
       WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [principal.tenantId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.key_prefix,
      scopes: row.scopes,
      createdAt: row.created_at.toISOString(),
      revokedAt: row.revoked_at?.toISOString() ?? null,
      lastUsedAt: row.last_used_at?.toISOString() ?? null,
      current: row.id === principal.apiKeyId,
    }));
  }

  async issueApiKey(
    principal: ApiKeyPrincipal,
    name: string,
  ): Promise<{ key: string; record: ApiKeyView }> {
    this.requireScope(principal, "keys:write");
    if (name.trim().length < 1 || name.trim().length > 100)
      throw new BadRequestException("API key name must be 1 to 100 characters");
    const issued = createApiKey();
    const id = randomUUID();
    const scopes = [
      "endpoints:read",
      "endpoints:write",
      "events:write",
      "deliveries:write",
      "keys:write",
    ];
    return withTransaction(async (client) => {
      const result = await client.query<{ created_at: Date }>(
        `INSERT INTO api_keys (id,tenant_id,name,key_prefix,key_hash,scopes)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING created_at`,
        [id, principal.tenantId, name.trim(), issued.prefix, issued.hash, scopes],
      );
      await client.query(
        `INSERT INTO audit_events (id,tenant_id,actor_api_key_id,action,subject_type,subject_id)
         VALUES ($1,$2,$3,'api_key.created','api_key',$4)`,
        [randomUUID(), principal.tenantId, principal.apiKeyId, id],
      );
      return {
        key: issued.key,
        record: {
          id,
          name: name.trim(),
          prefix: issued.prefix,
          scopes,
          createdAt: result.rows[0]!.created_at.toISOString(),
          revokedAt: null,
          lastUsedAt: null,
          current: false,
        },
      };
    });
  }

  async revokeApiKey(principal: ApiKeyPrincipal, id: string): Promise<boolean> {
    this.requireScope(principal, "keys:write");
    return withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND tenant_id=$2 AND revoked_at IS NULL`,
        [id, principal.tenantId],
      );
      if (!result.rowCount) throw new BadRequestException("API key not found or already revoked");
      await client.query(
        `INSERT INTO audit_events (id,tenant_id,actor_api_key_id,action,subject_type,subject_id)
         VALUES ($1,$2,$3,'api_key.revoked','api_key',$4)`,
        [randomUUID(), principal.tenantId, principal.apiKeyId, id],
      );
      return true;
    });
  }

  async rotateEndpointSecret(principal: ApiKeyPrincipal, endpointId: string): Promise<string> {
    this.requireScope(principal, "endpoints:write");
    const signingSecret = randomBytes(32).toString("base64url");
    return withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE endpoints SET signing_secret_ciphertext=$3,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL`,
        [
          principal.tenantId,
          endpointId,
          encryptSecret(this.config.signingEncryptionKey, signingSecret),
        ],
      );
      if (!result.rowCount) throw new BadRequestException("Endpoint not found");
      await client.query(
        `INSERT INTO audit_events (id,tenant_id,actor_api_key_id,action,subject_type,subject_id)
         VALUES ($1,$2,$3,'endpoint.secret_rotated','endpoint',$4)`,
        [randomUUID(), principal.tenantId, principal.apiKeyId, endpointId],
      );
      return signingSecret;
    });
  }

  async deleteEndpoint(principal: ApiKeyPrincipal, endpointId: string): Promise<boolean> {
    this.requireScope(principal, "endpoints:write");
    const result = await pool.query(
      `UPDATE endpoints SET enabled=false,deleted_at=now(),updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL`,
      [principal.tenantId, endpointId],
    );
    if (!result.rowCount) throw new BadRequestException("Endpoint not found");
    return true;
  }

  async health(): Promise<{
    status: "ok" | "degraded";
    database: "ok" | "unavailable";
    outboxPending: number | null;
    workerHeartbeatAt: string | null;
  }> {
    try {
      const result = await pool.query<{ count: string; worker_heartbeat_at: Date | null }>(
        `SELECT (SELECT count(*)::text FROM outbox WHERE published_at IS NULL) AS count,
         (SELECT last_seen_at FROM worker_heartbeats WHERE service_name='delivery-worker') AS worker_heartbeat_at`,
      );
      const heartbeatAt = result.rows[0]?.worker_heartbeat_at?.toISOString() ?? null;
      const workerRecent = heartbeatAt !== null && Date.now() - Date.parse(heartbeatAt) < 60000;
      return {
        status: workerRecent ? "ok" : "degraded",
        database: "ok",
        outboxPending: Number(result.rows[0]?.count ?? 0),
        workerHeartbeatAt: heartbeatAt,
      };
    } catch {
      return {
        status: "degraded",
        database: "unavailable",
        outboxPending: null,
        workerHeartbeatAt: null,
      };
    }
  }

  async decryptEndpointSecret(
    client: PoolClient,
    tenantId: string,
    endpointId: string,
  ): Promise<string> {
    const result = await client.query<{ signing_secret_ciphertext: string }>(
      "SELECT signing_secret_ciphertext FROM endpoints WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL",
      [tenantId, endpointId],
    );
    const encrypted = result.rows[0]?.signing_secret_ciphertext;
    if (!encrypted) throw new Error("Endpoint is unavailable");
    return decryptSecret(this.config.signingEncryptionKey, encrypted);
  }

  private requireScope(principal: ApiKeyPrincipal, scope: ApiKeyPrincipal["scopes"][number]): void {
    if (!principal.scopes.includes(scope))
      throw new ForbiddenException("API key lacks required scope");
  }
}

type EndpointRow = {
  id: string;
  url: string;
  description: string;
  enabled: boolean;
  event_types: string[];
  timeout_ms: number;
  retry_policy: Record<string, number>;
  created_at: Date;
  updated_at: Date;
};

function toEndpointView(row: EndpointRow): EndpointView {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    enabled: row.enabled,
    eventTypes: row.event_types,
    timeoutMs: row.timeout_ms,
    retryPolicy: row.retry_policy,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function safeDigestEquals(value: string, stored: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(stored)) return false;
  return timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(stored, "hex"));
}

function encryptSecret(key: Buffer, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function decryptSecret(key: Buffer, value: string): string {
  const [ivText, tagText, encryptedText] = value.split(".");
  if (!ivText || !tagText || !encryptedText) throw new Error("Stored endpoint secret is invalid");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
