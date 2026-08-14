-- 0003_outbox.sql — U2-OUTBOX: the ADR-001/ADR-003 transactional outbox table.
--
-- Requirement traceability (SRS Appendix B):
--   FR-13  — a booking (or any business) row and its outbox row commit in the SAME PostgreSQL
--            transaction: src/outbox/outbox.js enqueue() writes this table on the caller's
--            transaction client, so a provider failure can never roll back or delay the
--            triggering business write, and there is no dual write (ADR-001/003).
--   NFR-09 — deferred work survives an external-service outage as 'pending' rows; the worker
--            (src/outbox/worker.js) retries with exponential backoff via available_at and
--            dead-letters via status='dead' with the failure reason in last_error, still
--            queryable for operator visibility.
--   NFR-08 — correlation_id carries the originating request's correlation ID into the worker's
--            log lines (MT-01: the same ID appears on the request side and the worker side).
--   RT-02  — claim semantics are row locks (FOR UPDATE SKIP LOCKED) held for the duration of
--            processing: a crashed worker's transaction rolls back, the row stays 'pending'
--            and is re-claimed; dedupe_key is the idempotency key that makes redelivery safe.
--
-- Payload rule (ADR-003): payload carries entity IDs only — NEVER names, email addresses or
-- phone numbers. Enforced at write time by enqueue()'s PII guard; this comment is the schema-
-- level record of the invariant the adr-conformance lane audits.

-- Job lifecycle: 'pending' (claimable once available_at has passed, including between retry
-- backoffs) → 'delivered' (handler succeeded) | 'dead' (attempts exhausted; dead-letter).
-- There is deliberately NO 'processing' status: a claim is a row lock held by the worker's
-- open transaction, so a crash releases it automatically instead of stranding the job.
CREATE TYPE outbox_job_status AS ENUM ('pending', 'delivered', 'dead');

CREATE TABLE outbox_jobs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type           text NOT NULL CHECK (char_length(type) BETWEEN 1 AND 200),
  payload        jsonb NOT NULL DEFAULT '{}',                 -- IDs only (ADR-003)
  correlation_id text,                                        -- NFR-08 propagation
  dedupe_key     text,                                        -- idempotency key (RT-02)
  status         outbox_job_status NOT NULL DEFAULT 'pending',
  attempt_count  integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at   timestamptz NOT NULL DEFAULT now(),          -- retry backoff pushes this out
  delivered_at   timestamptz,
  last_error     text,                                        -- dead-letter failure reason
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- At most one job row per idempotency key: a duplicate enqueue is a no-op (RT-02).
  CONSTRAINT outbox_jobs_dedupe_key_key UNIQUE (dedupe_key)
);

-- The worker's claim scan: pending jobs ordered by due time. Partial index keeps it small
-- no matter how much delivered/dead history accumulates (NFR-02 scale).
CREATE INDEX outbox_jobs_claim_idx ON outbox_jobs (available_at, id) WHERE status = 'pending';

-- Dead-letter visibility: operators list failures without scanning the whole table (NFR-09).
CREATE INDEX outbox_jobs_dead_idx ON outbox_jobs (created_at) WHERE status = 'dead';

-- homeplate_set_updated_at() is created by 0002_indexes_constraints.sql.
CREATE TRIGGER outbox_jobs_set_updated_at
  BEFORE UPDATE ON outbox_jobs
  FOR EACH ROW EXECUTE FUNCTION homeplate_set_updated_at();
