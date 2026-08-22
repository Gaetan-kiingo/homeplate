-- 0005_moderation_indexes.sql — U4-MODERATION: the human-decision note column (append-only
-- migration). The moderation indexes this file was provisionally named for turned out to be
-- ALREADY SHIPPED by 0002_indexes_constraints.sql (moderation_decisions_content_idx, the
-- moderation_queue_open_content_key partial unique index — the RT-02 one-open-item-per-content
-- backstop the repo's ON CONFLICT insert targets — and moderation_queue_status_idx), so per
-- build-plan §4A ("only if measurably needed") no index is added here.
--
-- Requirement traceability (SRS Appendix B):
--   FR-08 (TC-08) — moderation_decisions.note records the pre-filter rule id that fired, the
--                   escalation reason detail (rate-limit measurement, ADR-007 data-use-gate
--                   reasons), or the human moderator's optional note (build-plan §4A
--                   "approve/reject + category + optional note").
--   NFR-08        — the note is persisted HERE precisely so it never needs to ride in a log
--                   line: audit records stay IDs/categories only.
--
-- Append-only (build-plan §1 convention 4): nothing in 0001-0004 is edited. No backfill is
-- needed: no application code wrote moderation_decisions before this wave (wave 3 enqueued
-- scans with no handler), and the column is nullable.

ALTER TABLE moderation_decisions
  ADD COLUMN note text;

COMMENT ON COLUMN moderation_decisions.note IS
  'FR-08: pre-filter rule id / escalation detail / human moderator note. Never logged (NFR-08 audit records carry IDs and categories only).';
