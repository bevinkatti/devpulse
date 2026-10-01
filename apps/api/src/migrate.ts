import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://devpulse:devpulse@localhost:5432/devpulse",
});
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const version = "001_initial";
  const existing = await pool.query("SELECT 1 FROM schema_migrations WHERE version=$1", [version]);
  if (existing.rowCount) {
    process.stdout.write(`Migration ${version} already applied.\n`);
  } else {
    const sql = await readFile(path.join(projectRoot, "db/migrations/001_initial.sql"), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [version]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    process.stdout.write(`Applied migration ${version}.\n`);
  }
} finally {
  await pool.end();
}
