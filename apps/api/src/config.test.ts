import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("runtime configuration", () => {
  it("provides local-only defaults for development", () => {
    const config = loadConfig({ NODE_ENV: "development" });
    expect(config.port).toBe(4000);
    expect(config.kafkaBrokers).toEqual(["localhost:9092"]);
    expect(config.signingEncryptionKey).toHaveLength(32);
  });

  it("requires explicit production secrets, database, broker, and HTTPS origins", () => {
    const production = {
      NODE_ENV: "production",
      API_BOOTSTRAP_TOKEN: "production-bootstrap-token-is-long-enough",
      SIGNING_SECRET_ENCRYPTION_KEY: "ab".repeat(32),
      DATABASE_URL: "postgres://service:password@postgres.internal:5432/devpulse",
      KAFKA_BROKERS: "redpanda.internal:9092",
      CORS_ORIGINS: "https://dashboard.example.com",
    };
    expect(loadConfig(production).environment).toBe("production");
    expect(() =>
      loadConfig({ ...production, SIGNING_SECRET_ENCRYPTION_KEY: "44".repeat(32) }),
    ).toThrow("local example value");
    expect(() =>
      loadConfig({ ...production, CORS_ORIGINS: "http://dashboard.example.com" }),
    ).toThrow("HTTPS origins");
    expect(() =>
      loadConfig({
        ...production,
        API_BOOTSTRAP_TOKEN: "devpulse-local-bootstrap-only-change-before-use",
      }),
    ).toThrow("API_BOOTSTRAP_TOKEN");
  });

  it("rejects invalid schemes and limits", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "development", DATABASE_URL: "http://localhost/db" }),
    ).toThrow("postgres or postgresql");
    expect(() => loadConfig({ NODE_ENV: "development", API_PORT: "70000" })).toThrow("valid port");
    expect(() => loadConfig({ NODE_ENV: "development", DB_POOL_SIZE: "1000" })).toThrow(
      "DB_POOL_SIZE",
    );
  });
});
