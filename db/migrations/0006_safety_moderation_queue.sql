-- 0006_safety_moderation_queue.sql — U4-SAFETY-COMPLETE: extend the §3.4
-- moderation_content_type domain with 'safety_alert' so the FR-07 delivery worker can file a
-- moderation_queue entry per safety alert (build-plan §5 U4-SAFETY-COMPLETE: "moderators work
-- one queue") once the unified-queue read model supports the type.
--
-- Requirement / decision traceability (SRS Appendix B):
--   FR-07 (TC-07, IT-04) — a safety alert's unified-queue entry is a moderation_queue row of
--                   content_type 'safety_alert' whose content_id is the safety_alerts.id; it
--                   is filed by the worker (src/outbox/handlers/safetyAlert.js) BEFORE any
--                   delivery leg runs, so a dead-lettered alert's queue entry still exists.
--   AB-04         — the same enum value lets a human moderator's escalation trail tie a
--                   flagged item back to the safety surface through one content-type domain.
--   RT-02         — no new index is needed: 0002's moderation_queue_open_content_key partial
--                   unique index is defined over (content_type, content_id) generically, so
--                   it already gives 'safety_alert' rows the same one-open-item-per-content
--                   idempotency backstop the FR-08 types have.
--
-- Append-only (build-plan §1 convention 4): nothing in 0001-0005 is edited; ALTER TYPE ...
-- ADD VALUE only appends to the enum. IF NOT EXISTS keeps a re-run against a database that
-- already has the label from failing (the runner records versions, but a drifted dev database
-- may have been patched by hand).
--
-- Transaction note: scripts/migrate.js wraps each file in BEGIN/COMMIT. PostgreSQL allows
-- ALTER TYPE ... ADD VALUE inside a transaction PROVIDED the new value is not used before the
-- transaction commits — so this file must contain NOTHING that references 'safety_alert' as an
-- enum value (no seed rows, no partial index on it). It only adds the label.

ALTER TYPE moderation_content_type ADD VALUE IF NOT EXISTS 'safety_alert';

COMMENT ON TYPE moderation_content_type IS
  'FR-08 moderated surfaces (listing, review, message) plus safety_alert (FR-07): a moderation_queue row of this type references safety_alerts.id and is the unified-queue entry the safety-alert worker files.';
