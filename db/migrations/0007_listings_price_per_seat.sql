-- 0007_listings_price_per_seat.sql — HOST LISTING UI (2026-09-11): listings.price_per_seat_cents
-- (append-only migration).
--
-- Requirement / decision traceability (SRS Appendix B):
--   FR-11 — a listing's "complete listing data" gains the price a guest pays per seat, shown on
--           the search card and the meal page. Homeplate v1.0 has NO payment feature (SRS §1.2:
--           payments are out of scope, deferred to v2.0), so this is INFORMATION the host
--           publishes and settles directly with the guest — never a charge the platform makes.
--   NFR-11 — stored as whole cents (integer, never floating point) with a CHECK >= 0; the API
--           schema bounds it further. 0 renders as "Free".
--
-- Append-only (build-plan §1 convention 4): nothing in 0001–0006 is edited. DEFAULT 0 keeps every
-- existing row and fixture valid (a pre-existing meal is "Free" until its host edits it); the
-- demo seed sets real prices.

ALTER TABLE listings
  ADD COLUMN price_per_seat_cents integer NOT NULL DEFAULT 0
    CONSTRAINT listings_price_per_seat_cents_nonneg CHECK (price_per_seat_cents >= 0);

COMMENT ON COLUMN listings.price_per_seat_cents IS
  'FR-11: price per seat in whole cents, published by the host and settled off-platform (v1.0 has no payments). 0 = free.';
