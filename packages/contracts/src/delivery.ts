import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import type { DeliveryStatus, ErrorCategory, RetryPolicy } from "./index.js";

const transitions: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  pending: ["processing", "failed"],
  processing: ["succeeded", "retry_scheduled", "failed", "dead_lettered"],
  succeeded: [],
  retry_scheduled: ["processing", "failed", "dead_lettered"],
  failed: ["pending"],
  dead_lettered: ["pending"],
};

export function canTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: DeliveryStatus, to: DeliveryStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal delivery transition: ${from} -> ${to}`);
  }
}

export type DeliveryFailure = { category: ErrorCategory; httpStatus?: number };

export function isRetryableFailure(failure: DeliveryFailure): boolean {
  if (failure.category === "network" || failure.category === "timeout") return true;
  if (failure.category !== "http" || failure.httpStatus === undefined) return false;
  return (
    failure.httpStatus === 408 ||
    failure.httpStatus === 429 ||
    [500, 502, 503, 504].includes(failure.httpStatus)
  );
}

export function retryDelayMs(
  policy: RetryPolicy,
  attemptNumber: number,
  random = Math.random,
): number {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new RangeError("attemptNumber must be a positive integer");
  }
  const exponential = Math.min(
    policy.maxDelaySeconds * 1000,
    policy.initialDelaySeconds * 1000 * 2 ** Math.min(attemptNumber - 1, 30),
  );
  return Math.floor(exponential * (0.8 + Math.max(0, Math.min(1, random())) * 0.4));
}

export function createWebhookSignature(
  secret: string,
  timestampSeconds: number,
  body: string | Uint8Array,
): string {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  const signature = createHmac("sha256", secret)
    .update(`${timestampSeconds}.`)
    .update(bytes)
    .digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}

export function verifyWebhookSignature(
  secret: string,
  body: string | Uint8Array,
  header: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  const entries = header.split(",");
  const timestampPart = entries.find((part) => part.startsWith("t="));
  const timestamp = Number(timestampPart?.slice(2));
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds)
    return false;
  const expected = createWebhookSignature(secret, timestamp, body).slice(
    `t=${timestamp},v1=`.length,
  );
  return entries
    .filter((part) => part.startsWith("v1="))
    .some((part) => {
      const provided = part.slice(3);
      if (!/^[a-f0-9]{64}$/i.test(provided)) return false;
      return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
    });
}

export function createApiKey(): { key: string; hash: string; prefix: string } {
  const token = randomBytes(32).toString("base64url");
  const key = `dp_live_${token}`;
  return {
    key,
    hash: hashApiKey(key),
    prefix: key.slice(0, 24),
  };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function verifyApiKey(key: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashApiKey(key), "hex");
  const expected = /^[a-f0-9]{64}$/i.test(expectedHash)
    ? Buffer.from(expectedHash, "hex")
    : Buffer.alloc(32);
  return timingSafeEqual(actual, expected) && /^[a-f0-9]{64}$/i.test(expectedHash);
}

export type DestinationPolicy = {
  environment: "development" | "test" | "production";
  allowPrivate?: boolean;
};

export async function validateDestination(rawUrl: string, policy: DestinationPolicy): Promise<URL> {
  return (await resolveDestination(rawUrl, policy)).url;
}

export type ResolvedDestination = {
  url: URL;
  addresses: Array<{ address: string; family: number }>;
};

export async function resolveDestination(
  rawUrl: string,
  policy: DestinationPolicy,
): Promise<ResolvedDestination> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Destination must be a valid URL");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && policy.environment !== "production")
  ) {
    throw new Error("Destination must use HTTPS outside development and test");
  }
  if (url.username || url.password)
    throw new Error("Destination must not contain embedded credentials");
  if (url.hash) throw new Error("Destination must not contain a fragment");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (policy.environment === "production" && url.protocol !== "https:") {
    throw new Error("Production destinations must use HTTPS");
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    if (policy.environment === "production" || !policy.allowPrivate)
      throw new Error("Private destinations are disabled");
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      return { url, addresses: [{ address: "127.0.0.1", family: 4 }] };
    }
  }
  const ipVersion = isIP(hostname);
  const addresses = ipVersion
    ? [{ address: hostname, family: ipVersion }]
    : await lookup(hostname, { all: true, verbatim: true }).catch(() => {
        throw new Error("Destination hostname could not be resolved");
      });
  if (addresses.length === 0) throw new Error("Destination hostname has no addresses");
  if (addresses.some(({ address, family }) => !isPublicAddress(address, family))) {
    if (policy.environment === "production" || !policy.allowPrivate) {
      throw new Error("Private or reserved destination addresses are disabled");
    }
  }
  return { url, addresses };
}

function isPublicAddress(address: string, family: number): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return false;
  }
  if (family === 4 && parsed.kind() === "ipv4") {
    const [a = 0, b = 0] = (parsed as ipaddr.IPv4).octets;
    // Benchmarking networks are reported as unicast by ipaddr.js.
    return parsed.range() === "unicast" && !(a === 198 && (b === 18 || b === 19));
  }
  if (family === 6 && parsed.kind() === "ipv6") {
    const address6 = parsed as ipaddr.IPv6;
    return (
      address6.range() === "unicast" &&
      !address6.match([ipaddr.IPv6.parse("2001::"), 23]) &&
      !address6.match([ipaddr.IPv6.parse("3fff::"), 20])
    );
  }
  return false;
}
