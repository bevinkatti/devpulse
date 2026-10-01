import { z } from "zod";

const JsonObjectSchema = z.record(z.string(), z.json());
const UuidSchema = z.string().uuid();
const TimestampSchema = z.iso.datetime({ offset: true });
const HttpUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Endpoint URL must use HTTP or HTTPS");

// Keep this event envelope stable: it is the public ingestion contract.
export const WebhookEventSchema = z
  .object({
    id: UuidSchema,
    type: z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/),
    occurredAt: TimestampSchema,
    data: JsonObjectSchema,
  })
  .strict();

export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

export const RetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(20).default(8),
    initialDelaySeconds: z.number().int().min(1).max(3600).default(5),
    maxDelaySeconds: z.number().int().min(1).max(86400).default(3600),
    maxElapsedSeconds: z.number().int().min(60).max(604800).default(86400),
  })
  .strict()
  .refine((policy) => policy.initialDelaySeconds <= policy.maxDelaySeconds, {
    message: "initialDelaySeconds must not exceed maxDelaySeconds",
    path: ["initialDelaySeconds"],
  });

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;
const defaultRetryPolicy = {
  maxAttempts: 8,
  initialDelaySeconds: 5,
  maxDelaySeconds: 3600,
  maxElapsedSeconds: 86400,
};

export const EndpointSchema = z
  .object({
    id: UuidSchema,
    url: HttpUrlSchema,
    description: z.string().trim().max(160).default(""),
    enabled: z.boolean().default(true),
    eventTypes: z.array(z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/)).max(100),
    timeoutMs: z.number().int().min(100).max(30000).default(10000),
    retryPolicy: RetryPolicySchema.default(defaultRetryPolicy),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export type Endpoint = z.infer<typeof EndpointSchema>;

export const CreateEndpointSchema = z
  .object({
    url: HttpUrlSchema,
    description: z.string().trim().max(160).default(""),
    eventTypes: z.array(z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/)).max(100),
    timeoutMs: z.number().int().min(100).max(30000).default(10000),
    retryPolicy: RetryPolicySchema.default(defaultRetryPolicy),
  })
  .strict();

export type CreateEndpoint = z.infer<typeof CreateEndpointSchema>;

export const UpdateEndpointSchema = CreateEndpointSchema.partial()
  .extend({ enabled: z.boolean().optional() })
  .strict();
export type UpdateEndpoint = z.infer<typeof UpdateEndpointSchema>;

export const DeliveryStatusSchema = z.enum([
  "pending",
  "processing",
  "succeeded",
  "retry_scheduled",
  "failed",
  "dead_lettered",
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

export const ErrorCategorySchema = z.enum([
  "http",
  "timeout",
  "network",
  "policy",
  "response_too_large",
  "internal",
]);
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

export const DeliveryAttemptSchema = z
  .object({
    id: UuidSchema,
    deliveryId: UuidSchema,
    attemptNumber: z.number().int().min(1),
    startedAt: TimestampSchema,
    completedAt: TimestampSchema.nullable(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    durationMs: z.number().int().min(0).nullable(),
    responseExcerpt: z.string().max(512).nullable(),
    errorCategory: ErrorCategorySchema.nullable(),
    nextAttemptAt: TimestampSchema.nullable(),
  })
  .strict();
export type DeliveryAttempt = z.infer<typeof DeliveryAttemptSchema>;

export const DeliverySchema = z
  .object({
    id: UuidSchema,
    eventId: UuidSchema,
    endpointId: UuidSchema,
    eventType: z.string(),
    status: DeliveryStatusSchema,
    attemptCount: z.number().int().min(0),
    nextAttemptAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    attempts: z.array(DeliveryAttemptSchema).default([]),
  })
  .strict();
export type Delivery = z.infer<typeof DeliverySchema>;

export const PaginationSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: UuidSchema.optional(),
  })
  .strict();
export type Pagination = z.infer<typeof PaginationSchema>;

export const ApiKeyPrincipalSchema = z
  .object({
    tenantId: UuidSchema,
    apiKeyId: UuidSchema,
    scopes: z.array(
      z.enum([
        "endpoints:read",
        "endpoints:write",
        "events:write",
        "deliveries:write",
        "keys:write",
      ]),
    ),
  })
  .strict();
export type ApiKeyPrincipal = z.infer<typeof ApiKeyPrincipalSchema>;

export const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
        message: z.string().max(256),
        requestId: UuidSchema,
        details: z
          .array(z.object({ path: z.string(), message: z.string() }).strict())
          .max(20)
          .optional(),
      })
      .strict(),
  })
  .strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const HealthSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    database: z.enum(["ok", "unavailable"]),
    outboxPending: z.number().int().min(0).nullable(),
    workerHeartbeatAt: TimestampSchema.nullable(),
  })
  .strict();
export type Health = z.infer<typeof HealthSchema>;

export { isWithinJsonLimits } from "./json-bounds.js";

export {
  assertTransition,
  canTransition,
  createApiKey,
  createWebhookSignature,
  hashApiKey,
  isRetryableFailure,
  retryDelayMs,
  resolveDestination,
  validateDestination,
  verifyApiKey,
  verifyWebhookSignature,
} from "./delivery.js";
