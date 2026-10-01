import { z } from "zod";

const JsonObjectSchema = z.record(z.string(), z.json());

export const WebhookEventSchema = z
  .object({
    id: z.string().uuid(),
    type: z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/),
    occurredAt: z.iso.datetime(),
    data: JsonObjectSchema,
  })
  .strict();

export type WebhookEvent = z.infer<typeof WebhookEventSchema>;
