# Architecture and operations

## Service boundaries

- **Contracts** (`packages/contracts`) owns strict Zod schemas, delivery transitions, retry policy helpers, API key hashing, HMAC helpers, and destination validation.
- **API** (`apps/api`) owns tenant API key authentication, REST ingestion/endpoint operations, GraphQL dashboard operations, validation, and database transaction boundaries.
- **PostgreSQL** (`db/migrations`) is the source of truth for tenant records, credentials, endpoints, events, deliveries, attempts, idempotency, audit history, outbox records, and worker health.
- **Worker** (`services/worker`) publishes committed outbox entries to Kafka-compatible Redpanda, consumes delivery IDs, leases work from PostgreSQL, and sends signed HTTP requests.
- **Dashboard** (`apps/dashboard`) uses the authenticated GraphQL API and REST ingestion. API keys live in browser `sessionStorage` for the current tab session.

## State and durability

An event is accepted only after a single database transaction stores its payload, eligible endpoint delivery rows, outbox work, an idempotency response, and an audit row. A repeated `Idempotency-Key` and identical request body returns the original acceptance result. Reusing the same key with a different body is rejected. Idempotency records expire after 24 hours and expired records are removed when that key is reused.

The outbox publisher locks a bounded batch with `FOR UPDATE SKIP LOCKED`, waits for broker acknowledgement, and marks those rows published inside the transaction. A broker outage rolls back the batch and advances its durable `available_at` using bounded exponential delay. A publish can happen twice if the broker acknowledges and PostgreSQL then rolls back; consumers treat broker messages as hints and load the current row before doing work. New consumer groups read from the beginning, and the worker periodically reconciles old pending database deliveries to the outbox so Kafka retention or a prolonged worker outage does not strand already-published jobs.

The worker changes a delivery to `processing`, increments its attempt count, creates the attempt row, and places a two-minute lease in one transaction. Success is terminal. Network errors, timeouts, HTTP 408, 429, and selected 5xx statuses are retryable; ordinary 4xx and policy errors are not. Retry times are stored on the delivery and scheduled into the outbox by a polling loop. Exhausted work becomes `dead_lettered`; other permanent failures become `failed`. A replay creates a new delivery ID linked to the original event/delivery and an auditable replay key. A retry creates a new delivery from a failed or dead-lettered source.

No in-memory timer is used as the durable retry record. If a worker exits while holding a lease, the scheduler completes the abandoned attempt, requeues eligible work, and dead-letters work whose attempt/time bounds were exhausted. Broker acknowledgement happens after the database result is persisted. The internal asynchronous boundary is Kafka with tenant-scoped database rows; this delivery flow has no synchronous service RPC, so gRPC/Protobuf is intentionally not added as a decorative second protocol.

## Security boundaries

- API keys contain 256 bits of random material. Only SHA-256 digests and a lookup prefix are stored. The full value is returned at creation and is not in list/detail output.
- Endpoint signing secrets are encrypted with AES-256-GCM using a 32-byte deployment key. They are revealed only at creation or rotation. Encryption key rotation requires re-encrypting existing ciphertext before switching keys.
- Every API repository operation scopes endpoint, event, delivery, attempt, audit, and credential reads by the principal tenant. Composite database foreign keys keep event and endpoint references in the delivery tenant.
- The API accepts up to 1 MiB JSON, requires an idempotency key for event ingestion, bounds list results to 100, and has a process-local per-IP request limit. Use a shared gateway limiter for multiple API replicas.
- Production endpoint URLs require HTTPS. URLs with user-info, fragments, private/reserved IPs, or unsafe schemes are rejected. The worker repeats DNS validation before every attempt, validates all returned addresses, pins one validated address for the request, and does not follow redirects. Response bodies are not stored. Network egress ACLs remain necessary in production.
- API exceptions avoid logging request bodies and API keys. Worker logs contain event/delivery IDs, bounded classifications, and status codes, not payloads, signatures, credentials, or response bodies.
- GraphQL uses API-key context authentication, depth/field-count validation, and capped result lists. It does not expose secrets from ordinary endpoint or key queries.

## Local operations

`docker compose up --build -d` starts PostgreSQL, Redpanda, a delivery topic initializer, the API, worker, and dashboard. The topic is created with three partitions for consumer parallelism. Named volumes retain PostgreSQL and Redpanda data. API startup applies migration `001_initial` once. Migrations run in a transaction with a version record. Future migrations should be additive; rollback is restore-from-backup unless a tested explicit down migration is added.

`GET /health/live` reports process liveness. `GET /health/ready` checks PostgreSQL, unpublished outbox count, and the last worker heartbeat. It reports a degraded state when the worker heartbeat is missing or stale. Redpanda has a Compose health check; broker lag metrics are not yet exposed by the API.

Production operations still need tested PostgreSQL backup/restore, a shared rate limiter, outbound network policy, encryption key rewrapping, load tests, alerts, and deployment-specific secret management. The worker requires Kafka TLS and supports SASL PLAIN/SCRAM credentials over TLS; client-certificate authentication is not implemented.
