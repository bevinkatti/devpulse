import { describe, expect, it } from "vitest";
import { WebhookEventSchema } from "./index.js";

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
