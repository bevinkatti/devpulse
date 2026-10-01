# ADR 0001: PostgreSQL transactional outbox

Status: accepted

The API writes events, deliveries, idempotency results, audit records, and outbox messages in one PostgreSQL transaction. The worker polls the outbox with `FOR UPDATE SKIP LOCKED`, publishes Kafka messages with acknowledgements, and marks published rows only after the send succeeds.

This prevents a committed event from disappearing when the broker is unavailable. A broker acknowledgement can precede a database rollback, so duplicate messages are expected and handled by the delivery state/lease check. The initial publisher keeps a short database transaction open while sending a bounded batch; this favors a small local system and should be load-tested before high-volume use.
