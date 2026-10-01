# ADR 0003: At-least-once external delivery

Status: accepted

DevPulse persists attempt state and retries selected transport/HTTP failures, but it cannot atomically commit with an arbitrary receiver. A receiver may commit work and lose its response, causing a retry. Every request carries a stable delivery ID in `Idempotency-Key` and `X-DevPulse-Delivery`; receivers must deduplicate that value. The product does not promise exactly-once HTTP delivery.
