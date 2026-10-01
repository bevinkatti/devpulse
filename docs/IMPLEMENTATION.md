# DevPulse implementation status

## Baseline

- Repository: `C:\Users\ABHISHEK\Desktop\pr\devpuls\devpulse`
- Branch/HEAD: `main` / `28fdaea` (`feat(contracts): add validated webhook event schema`)
- Initial worktree: clean; the repository contained the contracts package only. The `apps`, `services`, `db`, `infra`, and `docs` directories were empty.
- Runtime available: Node 24.18.0, pnpm 11.13.1, Docker CLI 29.1.3. The isolated Docker Compose stack was started for final integration validation.

## Dependency ordered checklist

- [x] Inspect the repository, package manager, branch, commit, and runtime baseline.
- [x] Expand shared schemas and implement/test delivery domain rules without changing the event envelope.
- [x] Add migrations and repository boundaries for durable tenants, endpoints, ingestion, attempts, and outbox.
- [x] Wire authenticated REST ingestion and dashboard GraphQL to durable persistence.
- [x] Publish outbox work to the broker and process deliveries with signed HTTP, persisted retry scheduling, and replay.
- [x] Connect a dashboard to the real API.
- [x] Add local infrastructure and operations/security documentation.
- [ ] **Partial:** CI workflow is authored and local checks passed; its hosted GitHub Actions run has not been observed.
- [ ] **Partial:** Previous Compose validation exercised persisted network failure/retry. This audit could not start Docker because the Docker Desktop engine was unavailable, so successful receiver delivery and browser review remain unverified.

## Verification performed

- `pnpm install --lockfile-only --frozen-lockfile`, Prettier, ESLint, TypeScript checks, Vitest, and the Next.js production build passed during this audit. Vitest reported 36 passed and 1 skipped because the database-backed integration test had no `TEST_DATABASE_URL`.
- Previous Compose validation built and started API, dashboard, worker, PostgreSQL 17, and Redpanda 25.1.1; applied migration `001_initial`; accepted an event; confirmed idempotent replay; and persisted a worker network-failure attempt as `retry_scheduled`.
- This audit fixed additional SSRF range checks, Node 24's pinned DNS callback shape, KafkaJS's empty-queue negative timeout warning, and added Kafka TLS/SASL configuration for production.
- The remote GitHub Actions workflow has not been observed on GitHub. A successful receiver response and signature verification, retry-to-success flow, and browser visual review were not completed because Docker Desktop and browser surfaces were unavailable.
- The build still prints a Next.js warning that the existing ESLint flat config does not load Next's plugin; the separate ESLint run succeeds.

## Architecture intent

PostgreSQL is the source of truth. Event acceptance writes the event, matching deliveries, an idempotency record, and outbox rows in one transaction. A publisher sends outbox rows to a Kafka-compatible broker with delivery IDs as message keys; consumers are idempotent and reload current configuration from Postgres. Delivery and retry scheduling state remain durable in Postgres. The public boundary is REST; the authenticated dashboard boundary is GraphQL. The delivery worker owns outbound HTTP, SSRF checks, HMAC signatures, attempt records, and backoff. External HTTP is at least once, so recipients must deduplicate by delivery ID. gRPC/Protobuf was not added: the API-to-worker delivery interaction is asynchronous and persisted through the broker, while the dashboard is served directly by GraphQL.

## Current limitations

The hosted GitHub Actions workflow remains unobserved. Successful receiver delivery and signature verification, retry-to-success, and browser visual review remain outstanding. The transitive `@apollo/server-plugin-landing-page-graphql-playground` dependency still declares an Apollo Server 4 peer requirement while the API uses Apollo Server 5; Playground is explicitly disabled. Kafka TLS is now required in production, and SASL PLAIN/SCRAM credentials can be configured over TLS. Production deployment, shared rate limiting, external egress controls, certificate-based Kafka client authentication, tested backup/restore, key rewrapping, and load/security review remain operational work.
