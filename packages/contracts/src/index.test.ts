import { describe, expect, it } from "vitest";
import {
  ApiErrorSchema,
  CreateEndpointSchema,
  DeliveryAttemptSchema,
  DeliverySchema,
  EndpointSchema,
  HealthSchema,
  PaginationSchema,
  RetryPolicySchema,
  UpdateEndpointSchema,
  WebhookEventSchema,
} from "./index.js";

const validEvent = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  type: "payment.succeeded",
  occurredAt: "2026-10-01T12:00:00.000Z",
  data: {
    paymentId: "pay_123",
    amount: 499,
    currency: "INR",
    metadata: {
      source: "checkout",
      verified: true,
      tags: ["web", "mobile"],
    },
  },
};

describe("WebhookEventSchema", () => {
  it("accepts a valid event with nested JSON data", () => {
    expect(WebhookEventSchema.safeParse(validEvent).success).toBe(true);
  });

  it("rejects an invalid event ID", () => {
    const result = WebhookEventSchema.safeParse({
      ...validEvent,
      id: "not-a-uuid",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an invalid event type", () => {
    const result = WebhookEventSchema.safeParse({
      ...validEvent,
      type: "Payment Succeeded",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an invalid timestamp", () => {
    const result = WebhookEventSchema.safeParse({
      ...validEvent,
      occurredAt: "yesterday",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an event without data", () => {
    const eventWithoutData = {
      id: validEvent.id,
      type: validEvent.type,
      occurredAt: validEvent.occurredAt,
    };
    const result = WebhookEventSchema.safeParse(eventWithoutData);

    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level fields", () => {
    const result = WebhookEventSchema.safeParse({
      ...validEvent,
      unexpected: true,
    });

    expect(result.success).toBe(false);
  });
});

describe("domain contracts", () => {
  it("applies safe endpoint defaults and rejects invalid timeout bounds", () => {
    const parsed = CreateEndpointSchema.parse({
      url: "https://hooks.example.com/events",
      eventTypes: ["payment.succeeded"],
    });
    expect(parsed.timeoutMs).toBe(10000);
    expect(parsed.retryPolicy.maxAttempts).toBe(8);
    expect(
      CreateEndpointSchema.safeParse({ url: "ftp://hooks.example.com", eventTypes: [] }).success,
    ).toBe(false);
    expect(
      CreateEndpointSchema.safeParse({
        url: "https://hooks.example.com",
        eventTypes: [],
        timeoutMs: 5,
      }).success,
    ).toBe(false);
  });

  it("rejects inconsistent retry bounds and unknown endpoint fields", () => {
    expect(
      RetryPolicySchema.safeParse({ initialDelaySeconds: 90, maxDelaySeconds: 10 }).success,
    ).toBe(false);
    expect(
      EndpointSchema.safeParse({
        id: validEvent.id,
        url: "https://hooks.example.com",
        eventTypes: [],
        createdAt: validEvent.occurredAt,
        updatedAt: validEvent.occurredAt,
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("validates delivery, attempt, pagination, update, error, and health DTOs", () => {
    expect(
      DeliverySchema.safeParse({
        id: validEvent.id,
        eventId: validEvent.id,
        endpointId: validEvent.id,
        eventType: "payment.succeeded",
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: null,
        createdAt: validEvent.occurredAt,
        updatedAt: validEvent.occurredAt,
      }).success,
    ).toBe(true);
    expect(
      DeliveryAttemptSchema.safeParse({
        id: validEvent.id,
        deliveryId: validEvent.id,
        attemptNumber: 1,
        startedAt: validEvent.occurredAt,
        completedAt: null,
        httpStatus: 599,
        durationMs: 1,
        responseExcerpt: "x".repeat(513),
        errorCategory: null,
        nextAttemptAt: null,
      }).success,
    ).toBe(false);
    expect(PaginationSchema.parse({ limit: "100" }).limit).toBe(100);
    expect(PaginationSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(UpdateEndpointSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(
      ApiErrorSchema.safeParse({
        error: { code: "BAD_INPUT", message: "Bad request", requestId: validEvent.id },
      }).success,
    ).toBe(true);
    expect(
      HealthSchema.safeParse({
        status: "ok",
        database: "ok",
        outboxPending: 0,
        workerHeartbeatAt: null,
      }).success,
    ).toBe(true);
  });
});
