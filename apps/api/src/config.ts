export type RuntimeConfig = {
  port: number;
  databaseUrl: string;
  kafkaBrokers: string[];
  apiBootstrapToken: string;
  signingEncryptionKey: Buffer;
  environment: "development" | "test" | "production";
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const environment = env.NODE_ENV ?? "development";
  if (environment !== "development" && environment !== "test" && environment !== "production") {
    throw new Error("NODE_ENV must be development, test, or production");
  }
  const signingKey =
    env.SIGNING_SECRET_ENCRYPTION_KEY ?? (environment === "production" ? "" : "44".repeat(32));
  if (!/^[a-f0-9]{64}$/i.test(signingKey)) {
    throw new Error("SIGNING_SECRET_ENCRYPTION_KEY must be a 32-byte hex value");
  }
  if (environment === "production" && signingKey.toLowerCase() === "44".repeat(32)) {
    throw new Error(
      "SIGNING_SECRET_ENCRYPTION_KEY must not use the local example value in production",
    );
  }
  const bootstrapToken =
    env.API_BOOTSTRAP_TOKEN ??
    (environment === "development" ? "devpulse-local-bootstrap-only" : "");
  if (
    bootstrapToken.length < 24 ||
    (environment === "production" &&
      ["devpulse-local-bootstrap-only", "devpulse-local-bootstrap-only-change-before-use"].includes(
        bootstrapToken,
      ))
  ) {
    throw new Error(
      "API_BOOTSTRAP_TOKEN must be at least 24 characters and explicitly configured in production",
    );
  }
  const port = Number(env.API_PORT ?? "4000");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("API_PORT must be a valid port");
  const databaseUrl =
    env.DATABASE_URL ??
    (environment === "production" ? "" : "postgres://devpulse:devpulse@localhost:5432/devpulse");
  let parsedDatabaseUrl: URL;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be configured as a PostgreSQL connection URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsedDatabaseUrl.protocol)) {
    throw new Error("DATABASE_URL must use the postgres or postgresql scheme");
  }
  if (
    environment === "production" &&
    ["localhost", "127.0.0.1", "::1"].includes(parsedDatabaseUrl.hostname)
  ) {
    throw new Error("DATABASE_URL must point to the configured production database");
  }
  const kafkaBrokers = (env.KAFKA_BROKERS ?? (environment === "production" ? "" : "localhost:9092"))
    .split(",")
    .map((broker) => broker.trim())
    .filter(Boolean);
  if (kafkaBrokers.length === 0) throw new Error("KAFKA_BROKERS must contain at least one broker");
  if (
    environment === "production" &&
    kafkaBrokers.some((broker) => /(^|@)(localhost|127\.0\.0\.1|redpanda)(:|$)/i.test(broker))
  ) {
    throw new Error("KAFKA_BROKERS must point to configured production brokers");
  }
  const poolSize = Number(env.DB_POOL_SIZE ?? "10");
  if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 50)
    throw new Error("DB_POOL_SIZE must be between 1 and 50");
  if (environment === "production" && !env.CORS_ORIGINS) {
    throw new Error("CORS_ORIGINS must be explicitly configured in production");
  }
  const corsOrigins = (env.CORS_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim());
  if (corsOrigins.some((origin) => origin === "*" || !isAllowedOrigin(origin, environment))) {
    throw new Error("CORS_ORIGINS must contain valid origins and HTTPS origins in production");
  }
  return {
    port,
    databaseUrl,
    kafkaBrokers,
    apiBootstrapToken: bootstrapToken,
    signingEncryptionKey: Buffer.from(signingKey, "hex"),
    environment,
  };
}

function isAllowedOrigin(origin: string, environment: RuntimeConfig["environment"]): boolean {
  try {
    const parsed = new URL(origin);
    return (
      (environment !== "production" || parsed.protocol === "https:") &&
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.origin === origin
    );
  } catch {
    return false;
  }
}
