# ADR 0002: PostgreSQL-backed retry scheduling

Status: accepted

The delivery row stores `next_attempt_at`; a worker scheduler polls due rows and inserts an outbox message whose `available_at` matches the scheduled time. PostgreSQL is the scheduling source of truth, so process restarts do not lose delayed retries. The outbox uniqueness key limits duplicate schedule insertion. Kafka is used for prompt work distribution, not as the retry database.
