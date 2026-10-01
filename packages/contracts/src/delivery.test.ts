import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  createApiKey,
  createWebhookSignature,
  hashApiKey,
  isRetryableFailure,
  retryDelayMs,
  validateDestination,
  verifyApiKey,
  verifyWebhookSignature,
} from "./delivery.js";
import { isWithinJsonLimits, RetryPolicySchema } from "./index.js";

const policy = RetryPolicySchema.parse({});

describe("delivery domain rules", () => {
  it("permits only legal delivery transitions", () => {
    expect(canTransition("pending", "processing")).toBe(true);
    expect(canTransition("succeeded", "pending")).toBe(false);
    expect(() => assertTransition("succeeded", "pending")).toThrow("Illegal delivery transition");
  });

  it("classifies retryable HTTP and transport failures without retrying ordinary 4xx", () => {
    expect(isRetryableFailure({ category: "network" })).toBe(true);
    expect(isRetryableFailure({ category: "http", httpStatus: 429 })).toBe(true);
    expect(isRetryableFailure({ category: "http", httpStatus: 503 })).toBe(true);
    expect(isRetryableFailure({ category: "http", httpStatus: 400 })).toBe(false);
    expect(isRetryableFailure({ category: "policy" })).toBe(false);
  });

  it("caps exponential retry delay and adds bounded jitter", () => {
    expect(retryDelayMs(policy, 1, () => 0.5)).toBe(5000);
    expect(retryDelayMs(policy, 100, () => 1)).toBe(4320000);
    expect(() => retryDelayMs(policy, 0)).toThrow(RangeError);
  });

  it("signs the transmitted bytes and enforces timestamp tolerance", () => {
    const body = '{"id":"evt-1"}';
    const header = createWebhookSignature("secret", 1000, body);
    expect(verifyWebhookSignature("secret", body, header, 1000)).toBe(true);
    expect(verifyWebhookSignature("wrong", body, header, 1000)).toBe(false);
    expect(verifyWebhookSignature("secret", `${body} `, header, 1000)).toBe(false);
    expect(verifyWebhookSignature("secret", body, header, 2000)).toBe(false);
  });

  it("creates opaque API keys and stores verifiable one-way digests", () => {
    const issued = createApiKey();
    expect(issued.key.startsWith("dp_live_")).toBe(true);
    expect(issued.key).not.toContain(issued.hash);
    expect(verifyApiKey(issued.key, issued.hash)).toBe(true);
    expect(verifyApiKey(issued.key, hashApiKey("different"))).toBe(false);
    expect(verifyApiKey(issued.key, "invalid")).toBe(false);
  });

  it("blocks unsafe destination schemes, credentials, private IPs, and production HTTP", async () => {
    const production = { environment: "production" as const };
    await expect(validateDestination("http://example.com/hook", production)).rejects.toThrow(
      "HTTPS",
    );
    await expect(
      validateDestination("https://user:pass@example.com/hook", production),
    ).rejects.toThrow("credentials");
    await expect(validateDestination("https://127.0.0.1/hook", production)).rejects.toThrow(
      "Private",
    );
    await expect(
      validateDestination("https://169.254.169.254/latest/meta-data", production),
    ).rejects.toThrow("Private");
    await expect(validateDestination("https://[::1]/hook", production)).rejects.toThrow("Private");
    await expect(
      validateDestination("https://[::ffff:127.0.0.1]/hook", production),
    ).rejects.toThrow("Private");
    await expect(validateDestination("https://192.88.99.1/hook", production)).rejects.toThrow(
      "Private",
    );
    await expect(validateDestination("https://[2001::1]/hook", production)).rejects.toThrow(
      "Private",
    );
    await expect(validateDestination("https://[3fff::1]/hook", production)).rejects.toThrow(
      "Private",
    );
    await expect(
      validateDestination("https://[2606:4700:4700::1111]/hook", production),
    ).resolves.toBeInstanceOf(URL);
    await expect(validateDestination("https://198.51.100.1/hook", production)).rejects.toThrow(
      "Private",
    );
    await expect(
      validateDestination("http://127.0.0.1/hook", {
        environment: "development",
        allowPrivate: true,
      }),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      validateDestination("http://127.0.0.1/hook", { environment: "development" }),
    ).rejects.toThrow("Private");
  });

  it("bounds JSON nesting and node counts without recursion", () => {
    expect(isWithinJsonLimits({ data: { value: [1, true, null] } })).toBe(true);
    expect(isWithinJsonLimits({ a: { b: { c: 1 } } }, { maxDepth: 1 })).toBe(false);
    expect(
      isWithinJsonLimits(
        { values: Array.from({ length: 20 }, (_, index) => index) },
        { maxNodes: 10 },
      ),
    ).toBe(false);
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(isWithinJsonLimits(cycle)).toBe(false);
  });
});
