-- 0004_bookings_completed_at.sql — U3-BOOKINGS: bookings.completed_at (append-only migration).
--
-- Requirement traceability (SRS Appendix B):
--   FR-04 (TC-04) — when BOTH parties have confirmed the end of the meal the booking becomes
--                   'completed' and completed_at records the instant of that transition
--                   (the FR-04 acceptance asserts the column). The 0001 CHECK
--                   bookings_completed_requires_both_confirmations still guards the flags;
--                   this column only timestamps the transition.
--
-- Append-only (build-plan §1 convention 4): nothing in 0001–0003 is edited; a wave-2
-- database picks this up cleanly via scripts/migrate.js. No backfill is needed — waves 0–2
-- shipped no completion flow, so no legitimate 'completed' row predates this column, and the
-- column stays nullable so any pre-existing test fixture row survives the migration.

ALTER TABLE bookings
  ADD COLUMN completed_at timestamptz;

COMMENT ON COLUMN bookings.completed_at IS
  'FR-04: set by the booking service in the same UPDATE that moves status to ''completed'' (both confirmation flags true).';
