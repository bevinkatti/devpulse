import "reflect-metadata";
import { randomUUID } from "node:crypto";
import express from "express";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Request, Response, NextFunction } from "express";
import { AppModule } from "./app.module.js";
import { loadConfig } from "./config.js";
import { pool } from "./database.js";

const logger = new Logger("DevPulse");
const config = loadConfig();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bodyParser: false, bufferLogs: true });
  app.use(express.json({ limit: "1mb", strict: true }));
  app.use((error: unknown, request: Request, response: Response, next: NextFunction) => {
    if (typeof error !== "object" || error === null || !("status" in error)) {
      next(error);
      return;
    }
    const status = Number(error.status);
    if (status !== 400 && status !== 413) {
      next(error);
      return;
    }
    const requestId = randomUUID();
    logger.warn(
      JSON.stringify({ event: "http.body.rejected", requestId, status, path: request.path }),
    );
    response.setHeader("x-request-id", requestId);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cache-control", "no-store");
    response.status(status).json({
      error: {
        code: status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_JSON",
        message: status === 413 ? "Request body exceeds the 1 MiB limit" : "Malformed JSON body",
        requestId,
      },
    });
  });
  app.use(requestControls);
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? "http://localhost:3000")
      .split(",")
      .map((origin) => origin.trim()),
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-Bootstrap-Token",
      "X-Request-Id",
    ],
    maxAge: 600,
  });
  app.enableShutdownHooks();
  await app.listen(config.port, "0.0.0.0");
  logger.log(`API listening on port ${config.port}`);
  const closePool = async () => pool.end();
  app.getHttpServer().once("close", () => void closePool());
}

type RateEntry = { count: number; resetAt: number };
const rateEntries = new Map<string, RateEntry>();
function requestControls(request: Request, response: Response, next: NextFunction): void {
  const incoming = request.headers["x-request-id"];
  const requestId =
    typeof incoming === "string" && /^[a-f0-9-]{36}$/i.test(incoming) ? incoming : randomUUID();
  request.headers["x-request-id"] = requestId;
  response.setHeader("x-request-id", requestId);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cache-control", "no-store");
  if (process.env.NODE_ENV === "production")
    response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  const now = Date.now();
  const ip = request.ip ?? request.socket.remoteAddress ?? "unknown";
  const key = `${ip}:${Math.floor(now / 60000)}`;
  if (!rateEntries.has(key) && rateEntries.size >= 10000) {
    for (const [entryKey, value] of rateEntries)
      if (value.resetAt <= now) rateEntries.delete(entryKey);
    if (rateEntries.size >= 10000) {
      response
        .status(429)
        .json({ error: { code: "RATE_LIMITED", message: "Too many request sources", requestId } });
      return;
    }
  }
  const entry = rateEntries.get(key) ?? { count: 0, resetAt: now + 60000 };
  entry.count += 1;
  rateEntries.set(key, entry);
  if (rateEntries.size > 10000) {
    for (const [entryKey, value] of rateEntries)
      if (value.resetAt <= now) rateEntries.delete(entryKey);
  }
  if (entry.count > 300) {
    response
      .status(429)
      .json({ error: { code: "RATE_LIMITED", message: "Too many requests", requestId } });
    return;
  }
  next();
}

bootstrap().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      service: "api",
      event: "startup.failed",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
  );
  process.exitCode = 1;
});
