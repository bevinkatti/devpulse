import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

const connectionString = process.env.TEST_DATABASE_URL;
const poolPromise = connectionString
  ? import("pg").then(({ Pool }) => new Pool({ connectionString, max: 2 }))
  : undefined;

describe.skipIf(!poolPromise)("PostgreSQL durability and tenant constraints", () => {
  afterAll(async () => {
    await poolPromise?.then((pool) => pool.end());
  });

  it("commits an event, delivery, attempt, and outbox together and rejects cross-tenant delivery links", async () => {
    const client = await poolPromise!.then((pool) => pool.connect());
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const endpointId = randomUUID();
    const otherEndpointId = randomUUID();
    const eventId = randomUUID();
    const deliveryId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO tenants(id,name) VALUES($1,'integration A'),($2,'integration B')",
        [tenantId, otherTenantId],
      );
      await client.query(
        `INSERT INTO endpoints(id,tenant_id,url,event_types,retry_policy,signing_secret_ciphertext)
         VALUES($1,$2,'https://a.example.test',ARRAY[]::text[],'{}'::jsonb,'test-ciphertext'),
               ($3,$4,'https://b.example.test',ARRAY[]::text[],'{}'::jsonb,'test-ciphertext')`,
        [endpointId, tenantId, otherEndpointId, otherTenantId],
      );
      await client.query(
        "INSERT INTO events(id,tenant_id,event_type,occurred_at,payload) VALUES($1,$2,'test.created',now(),'{}'::jsonb)",
        [eventId, tenantId],
      );
      await client.query("SAVEPOINT tenant_boundary");
      await expect(
        client.query(
          "INSERT INTO deliveries(id,tenant_id,event_id,endpoint_id,status) VALUES($1,$2,$3,$4,'pending')",
          [randomUUID(), tenantId, eventId, otherEndpointId],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await client.query("ROLLBACK TO SAVEPOINT tenant_boundary");
      await client.query(
        "INSERT INTO deliveries(id,tenant_id,event_id,endpoint_id,status) VALUES($1,$2,$3,$4,'pending')",
        [deliveryId, tenantId, eventId, endpointId],
      );
      await client.query(
        "INSERT INTO delivery_attempts(id,delivery_id,attempt_number,started_at) VALUES($1,$2,1,now())",
        [randomUUID(), deliveryId],
      );
      await client.query(
        "INSERT INTO outbox(id,tenant_id,delivery_id,message_type,payload) VALUES($1,$2,$3,'delivery.requested',$4::jsonb)",
        [randomUUID(), tenantId, deliveryId, JSON.stringify({ deliveryId })],
      );
      const result = await client.query<{ deliveries: string; attempts: string; outbox: string }>(
        `SELECT
          (SELECT count(*)::text FROM deliveries WHERE id=$1) AS deliveries,
          (SELECT count(*)::text FROM delivery_attempts WHERE delivery_id=$1) AS attempts,
          (SELECT count(*)::text FROM outbox WHERE delivery_id=$1) AS outbox`,
        [deliveryId],
      );
      expect(result.rows[0]).toEqual({ deliveries: "1", attempts: "1", outbox: "1" });
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
});
