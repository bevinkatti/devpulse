import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://devpulse:devpulse@localhost:5432/devpulse",
  max: Number(process.env.DB_POOL_SIZE ?? 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  application_name: "devpulse-api",
});

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
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

export async function queryRows<T extends QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(sql, [...params]);
}
