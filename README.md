# DevPulse

> **Status:** Core implementation complete and locally verified.
>
> **Verification:** PostgreSQL integration + broker/worker/receiver failure-recovery path verified locally.

## One-line positioning

Self-hosted reliable webhook delivery infrastructure.

DevPulse delivers application events to external HTTP endpoints using durable PostgreSQL persistence, a transactional outbox, asynchronous Kafka/Redpanda processing, signed HTTP requests, retries, idempotency, tenant isolation, and delivery observability. It is software for teams to run under their own infrastructure, not a hosted production service.

## Why DevPulse?

An application may create events such as `payment.succeeded`, `order.created`, `user.created`, or `subscription.updated`. Shipping, notifications, analytics, partner integrations, and other services may all need those events.

Calling each destination directly makes delivery behavior part of every application: the destination may be unavailable, a request may time out or return `5xx`/`429`, the sender may crash after accepting an event, or a request may be duplicated. Developers also need a way to find out what happened and recover when delivery fails.

DevPulse provides a reusable delivery layer for durable acceptance, asynchronous processing, retry scheduling, request signing, delivery tracking, and recovery. Application teams can use that layer instead of rebuilding those mechanisms in each service.

## Who benefits?

### SaaS and application developers

Deliver application events to integrations and downstream services with persisted delivery state and retry handling.

### Backend/platform teams

Provide a shared delivery layer instead of implementing queueing, retries, signing, and delivery-state logic repeatedly across services.

### Startups and smaller teams

Run a self-hostable implementation locally or deploy it under your own infrastructure.

### Developers operating integrations

Use persisted attempts, failure and retry state, signatures, and audit history to investigate integration failures and recover deliveries.

## What DevPulse solves

| Problem                                                | DevPulse approach                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| An event could be lost around asynchronous publication | PostgreSQL transaction and transactional outbox                                        |
| A downstream service is temporarily unavailable        | Durable retry scheduling in PostgreSQL                                                 |
| A receiver needs to authenticate webhook origin        | HMAC-SHA256 signatures                                                                 |
| An event submission is repeated                        | Idempotency handling for event ingestion                                               |
| An HTTP delivery is repeated                           | At-least-once delivery semantics, delivery IDs, and receiver-side idempotency guidance |
| A team needs to understand a failure                   | Persisted delivery status, attempts, and audit history                                 |
| Multiple tenants share infrastructure                  | Tenant-scoped API-key authentication, authorization, and database constraints          |
| A destination URL could reach an unsafe address        | URL, DNS, and destination-address validation; redirects are disabled                   |
| Delivery work must run asynchronously                  | Kafka-compatible broker processing through Redpanda and a delivery worker              |

## Verified end-to-end

The local Docker Compose audit exercised the failure and recovery path using PostgreSQL, Redpanda, the DevPulse API and worker, and a deterministic local HTTP receiver:

```text
Event
  ↓
DevPulse API
  ↓
PostgreSQL transaction + outbox
  ↓
Redpanda
  ↓
Delivery worker
  ↓
Signed HTTP request
  ↓
Receiver returns 503
  ↓
Retry persisted/scheduled
  ↓
Second delivery
  ↓
Receiver returns 204
  ↓
Final success recorded in PostgreSQL
```

The test verified both HMAC signatures against the exact received request bytes, the two persisted attempts and final delivery state, and transactional cleanup of the disposable tenant. The receiver returned `503` on attempt one and `204` on attempt two.

The latest local audit also passed the PostgreSQL-backed test suite (**22 tests across 6 files**), formatting, lint, workspace type checks, and API/dashboard HTTP checks. An uncached worker image build installed dependencies with `pnpm install --frozen-lockfile` and verified the KafkaJS patch was applied. The audit services were stopped after the run, and both named data volumes were preserved.

These results describe the local Compose setup. They do not represent a hosted service or a production deployment, and they do not replace deployment-specific security, capacity, or operational review.

## Existing ecosystem

Reliable webhook delivery is an established infrastructure category. Products such as [Svix](https://www.svix.com/) and [Hookdeck](https://hookdeck.com/) provide related webhook delivery, routing, retry, observability, and integration infrastructure.

DevPulse is primarily a self-hostable engineering implementation intended to explore and demonstrate the underlying delivery architecture. It is not presented as feature-for-feature parity with mature commercial webhook platforms.

## Developer documentation

### Current implementation

The core product path is implemented and locally verified: create a workspace → create an endpoint → accept an event durably → publish through the transactional outbox → process through Redpanda → deliver a signed webhook → retry a failed delivery → record final success.

The local product also supports creating API keys, publishing matching deliveries, and inspecting attempts and delivery status. Delivery and replay identities are persisted and auditable. External HTTP delivery is **at least once**.

### Current limits

The dashboard supports endpoint management, endpoint secret rotation, API key creation and revocation, event intake, delivery history, attempt timelines, retry, and replay. Lists are currently capped at 100 rows and do not yet expose cursor pagination or rich search/filter controls. Authentication uses tenant API keys; there is no human identity provider or role model.

The worker boundary uses Kafka and typed database contracts; gRPC/Protobuf is not used because this delivery path does not need synchronous RPC. A CI workflow is configured in [`.github/workflows/ci.yml`](.github/workflows/ci.yml). The hosted workflow and a production deployment environment still need operational review.

### Architecture

```mermaid
flowchart LR
  Dashboard[Next.js dashboard] -->|GraphQL, tenant API key| API[NestJS API]
  Client[Developer service] -->|REST event ingestion| API
  API -->|transaction: event + deliveries + idempotency + outbox| DB[(PostgreSQL)]
  Worker[Delivery worker] -->|claim outbox rows, publish with acks| Kafka[(Redpanda)]
  Kafka -->|delivery ID keyed messages| Worker
  Worker -->|lease, attempt, retry and audit writes| DB
  Worker -->|HMAC signed HTTP, redirects disabled| Receiver[Webhook receiver]
```

The API commits the event, matching deliveries, idempotency response, audit row, and outbox messages in one PostgreSQL transaction. A worker publishes outbox messages to Redpanda and marks them published only after broker acknowledgement. A crash after publish but before the database commit can publish a duplicate; consumers reload the delivery from PostgreSQL and ignore already completed work. The database remains the authority for delivery state and delayed retries. Worker leases recover interrupted attempts. Recipients should deduplicate using `Idempotency-Key` or `X-DevPulse-Delivery`.

See [architecture and operations](docs/ARCHITECTURE.md), [implementation checklist](docs/IMPLEMENTATION.md), and the [architecture decisions](docs/adr/).

### Run locally on Windows PowerShell

Prerequisites: Node.js 24+, pnpm 11.13.1 through Corepack, and Docker Desktop with the Compose plugin.

```powershell
Copy-Item .env.example .env
pnpm.cmd install --frozen-lockfile
docker compose up --build -d
docker compose ps
```

The API container applies the ordered SQL migration before starting. Open the dashboard at <http://localhost:3000>. The local bootstrap token is in `.env`; enter it once to create a workspace. The dashboard shows the new API key once. Copy it and keep it private. Compose uses development-only keys and enables private HTTP destinations so a controlled local receiver can be used. Do not reuse those values outside local development.

To stop services while retaining local database and broker data:

```powershell
docker compose down
```

To delete local development data, remove the named `devpulse-postgres` and `devpulse-redpanda` volumes in Docker Desktop. This does not affect deployed data.

Services are also runnable as local processes for debugging. Start Postgres and Redpanda with Compose, then in separate PowerShell terminals run `pnpm.cmd db:migrate`, `pnpm.cmd dev:api`, `pnpm.cmd dev:worker`, and `pnpm.cmd dev:dashboard`. Set `DATABASE_URL`, `KAFKA_BROKERS=localhost:19092`, `API_BOOTSTRAP_TOKEN`, `SIGNING_SECRET_ENCRYPTION_KEY`, and `NEXT_PUBLIC_API_URL` in those shells as shown in `.env.example` before starting the processes. The dashboard URL defaults to `http://localhost:4000`.

### API examples

Create a development workspace once using the bootstrap token:

```powershell
$token = (Get-Content .env | Where-Object { $_ -like 'API_BOOTSTRAP_TOKEN=*' }).Split('=', 2)[1]
$workspace = Invoke-RestMethod -Uri http://localhost:4000/v1/tenants -Method Post `
  -Headers @{ 'X-Bootstrap-Token' = $token } -ContentType 'application/json' `
  -Body (@{ name = 'Local development' } | ConvertTo-Json)
$apiKey = $workspace.apiKey
```

Create an endpoint and keep the returned signing secret; it is returned only at creation or rotation. Replace the example URL with an HTTPS receiver you control before ingesting an event:

```powershell
$endpoint = Invoke-RestMethod -Uri http://localhost:4000/v1/endpoints -Method Post `
  -Headers @{ Authorization = "Bearer $apiKey" } -ContentType 'application/json' `
  -Body (@{ url = 'https://example.com/webhook'; description = 'Example'; eventTypes = @('payment.succeeded') } | ConvertTo-Json -Depth 10)
$endpoint.signingSecret
```

Ingest an event. A successful `202` means its database transaction committed. Reuse the same idempotency key only when retrying the same request body:

```powershell
$event = @{
  id = [guid]::NewGuid().ToString()
  type = 'payment.succeeded'
  occurredAt = [DateTime]::UtcNow.ToString('o')
  data = @{ paymentId = 'pay_123'; amount = 499; currency = 'INR' }
}
$headers = @{ Authorization = "Bearer $apiKey"; 'Idempotency-Key' = [guid]::NewGuid().ToString() }
Invoke-RestMethod -Uri http://localhost:4000/v1/events -Method Post -Headers $headers `
  -ContentType 'application/json' -Body ($event | ConvertTo-Json -Depth 10)
```

The dashboard GraphQL endpoint is `http://localhost:4000/graphql`. It provides tenant-scoped endpoint, key, delivery, attempt, health, retry, and replay operations. Public ingestion and liveness/readiness checks use REST.

### Webhook signature verification

DevPulse signs the exact UTF-8 request body with HMAC-SHA256 over `timestamp + "." + body`. It sends `X-DevPulse-Signature: t=<unix-seconds>,v1=<hex>`, `X-DevPulse-Event`, `X-DevPulse-Delivery`, `X-DevPulse-Attempt`, and `Idempotency-Key`. Verify the raw request bytes before parsing JSON, compare signatures in constant time, and reject timestamps outside a short tolerance. A recipient must also make processing idempotent because a successful remote response can be lost after the receiver commits its work.

### Configuration and operations

See [`.env.example`](.env.example) for local values. Production must set `DATABASE_URL`, `KAFKA_BROKERS`, `API_BOOTSTRAP_TOKEN`, and a randomly generated 32-byte hex `SIGNING_SECRET_ENCRYPTION_KEY`. The worker requires `KAFKA_SSL=true` in production and supports SASL PLAIN or SCRAM-SHA-256/SCRAM-SHA-512 credentials over TLS. Configure PostgreSQL TLS through the connection URL and terminate public API TLS at a trusted ingress. Keep the encryption key stable while endpoint secrets are stored; changing it requires a planned secret re-encryption operation, which is not yet provided. Production destination URLs must use HTTPS. Do not set `ALLOW_PRIVATE_DESTINATIONS` in production.

The outbox and retry schedule are durable in PostgreSQL. Kafka messages may be duplicated; HTTP requests can also be repeated when a receiver accepted a request but DevPulse did not record the response. The worker does not follow redirects, caps endpoint timeouts and response sizes, pins a validated DNS address for each outbound request, and records bounded status metadata without storing response bodies. Use network egress controls as an additional SSRF boundary. API rate limits are process-local; production deployments should enforce a shared edge/API gateway limit.

### Development checks

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd format:check
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
docker compose config
git diff --check
```

The database migration can be run separately with `pnpm.cmd db:migrate`. `pnpm.cmd test` always runs the domain and configuration tests. If `TEST_DATABASE_URL` points to a migrated disposable PostgreSQL database, it also runs the transaction and tenant foreign-key integration test. The CI job provides PostgreSQL and runs both.

To run the PostgreSQL integration test using the Compose database from PowerShell:

```powershell
$env:TEST_DATABASE_URL = 'postgres://devpulse:devpulse@127.0.0.1:5432/devpulse'
pnpm.cmd test
```

The local API/worker/receiver failure-and-recovery path has been exercised as described above. Broader broker-failure, multi-worker, load, and deployment security reviews remain before a production release.

After `docker compose up --build -d` is healthy, run the bounded local receiver check from a second PowerShell window. It passes the bootstrap token only through the process environment, verifies each signature against the raw received bytes, checks retry and final PostgreSQL attempt state, and deletes its disposable tenant records in a transaction:

```powershell
$env:API_BOOTSTRAP_TOKEN = docker compose exec -T api printenv API_BOOTSTRAP_TOKEN
$env:TEST_DATABASE_URL = 'postgres://devpulse:devpulse@127.0.0.1:5432/devpulse'
pnpm.cmd --filter @devpulse/contracts build
pnpm.cmd test:webhook:e2e
```
