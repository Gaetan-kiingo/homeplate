-- 0002_indexes_constraints.sql — U1-DB: indexes, cross-row invariants, updated_at triggers.
--
-- Requirement traceability (SRS Appendix B):
--   FR-11 / AB-07 — listings_host_local_date_key: the database-level backstop for the MEHKO
--                   one-listing-per-host-per-day rule; two concurrent creations for the same
--                   host + America/Los_Angeles calendar day cannot both commit. Cancelled
--                   listings are excluded so a host may re-create after cancelling (FR-11).
--   NFR-01/NFR-02 — required indexes on listings(scheduled_start), (host_id, local_date),
--                   (moderation_status) and the geo/cuisine filter columns so the LT-01/LT-02
--                   search paths never sequential-scan listings at 10k-user volume.
--   FR-12 / AB-02 — bookings (guest_id, status): O(log n) pending-count for the per-guest
--                   concurrent pending-booking cap.
--   FR-08 / ADR-002 — moderation queue/scan indexes; one open queue item per content.
--   NFR-12        — data_requests (status, due_at) drives the erasure/inactivity sweeps;
--                   users(last_active_at) drives the 24-month inactivity scan.
--   NFR-13        — access_log (subject) lookup for the audit trail; users lower(email)
--                   uniqueness closes the case-variant duplicate-account gap (AB-07).

-- ---- users -----------------------------------------------------------------------------------
-- AB-07: users_email_key (0001) is exact-match unique; this closes Foo@x vs foo@x duplicates.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
-- NFR-12: 24-month inactivity sweep.
CREATE INDEX users_last_active_at_idx ON users (last_active_at);

-- ---- email_verification_tokens (FR-10) -------------------------------------------------------
CREATE INDEX email_verification_tokens_user_idx ON email_verification_tokens (user_id);

-- ---- listings --------------------------------------------------------------------------------
-- FR-11 / AB-07 / ADR-009: the single-day uniqueness invariant, non-cancelled listings only.
CREATE UNIQUE INDEX listings_host_local_date_key
  ON listings (host_id, local_date)
  WHERE status <> 'cancelled';
-- NFR-02 required indexes for the discovery/search path (LT-02 EXPLAIN must show index usage).
CREATE INDEX listings_scheduled_start_idx ON listings (scheduled_start);
CREATE INDEX listings_moderation_status_idx ON listings (moderation_status);
-- FR-01 filters: cuisine and public-precision geo (ADR-010 — search never touches lat/lng).
CREATE INDEX listings_cuisine_idx ON listings (cuisine);
CREATE INDEX listings_coarse_geo_idx ON listings (coarse_lat, coarse_lng);
-- Composite for the common public search predicate: approved + active, by day.
CREATE INDEX listings_public_search_idx
  ON listings (moderation_status, status, local_date, scheduled_start);

-- ---- bookings --------------------------------------------------------------------------------
-- FR-12 / AB-02: per-guest concurrent pending-booking cap count.
CREATE INDEX bookings_guest_status_idx ON bookings (guest_id, status);
-- FR-14 / capacity restore + listing detail: bookings by listing.
CREATE INDEX bookings_listing_status_idx ON bookings (listing_id, status);

-- ---- reviews ---------------------------------------------------------------------------------
-- FR-05 host page: approved reviews about a target user.
CREATE INDEX reviews_target_moderation_idx ON reviews (target_user_id, moderation_status);
CREATE INDEX reviews_moderation_status_idx ON reviews (moderation_status);

-- ---- messages --------------------------------------------------------------------------------
-- FR-06 thread reads in order; FR-08 async scan picks up pending messages.
CREATE INDEX messages_booking_created_idx ON messages (booking_id, created_at);
CREATE INDEX messages_moderation_status_idx ON messages (moderation_status);

-- ---- safety_alerts (FR-07 delivery worker: retried until delivered) --------------------------
CREATE INDEX safety_alerts_delivery_status_idx ON safety_alerts (delivery_status);
CREATE INDEX safety_alerts_booking_idx ON safety_alerts (booking_id);

-- ---- moderation (FR-08 / ADR-002) ------------------------------------------------------------
CREATE INDEX moderation_decisions_content_idx ON moderation_decisions (content_type, content_id);
-- At most ONE unresolved queue item per piece of content — re-flagging joins the open item.
CREATE UNIQUE INDEX moderation_queue_open_content_key
  ON moderation_queue (content_type, content_id)
  WHERE status <> 'resolved';
CREATE INDEX moderation_queue_status_idx ON moderation_queue (status, created_at);

-- ---- notification_attempts (FR-13 / ADR-011) -------------------------------------------------
CREATE INDEX notification_attempts_recipient_idx ON notification_attempts (recipient_user_id, created_at);
CREATE INDEX notification_attempts_status_idx ON notification_attempts (status);

-- ---- media_objects (ADR-004 / NFR-12: delete-by-key per owner during erasure) ----------------
CREATE INDEX media_objects_owner_idx ON media_objects (owner_user_id);
CREATE INDEX media_objects_entity_idx ON media_objects (entity_type, entity_id);

-- ---- data_requests (NFR-12 / NFR-13 sweeps: what is due now?) --------------------------------
CREATE INDEX data_requests_status_due_idx ON data_requests (status, due_at);
CREATE INDEX data_requests_user_idx ON data_requests (user_id);

-- ---- access_log (NFR-13 audit trail lookup by subject) ---------------------------------------
CREATE INDEX access_log_subject_created_idx ON access_log (subject_user_id, created_at);

-- ---- updated_at maintenance ------------------------------------------------------------------
-- One trigger function keeps updated_at honest on every mutable table, so no service can forget
-- to bump it (NFR-08: records sufficient to identify what changed when).
CREATE FUNCTION homeplate_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION homeplate_set_updated_at();
CREATE TRIGGER host_profiles_set_updated_at
  BEFORE UPDATE ON host_profiles
  FOR EACH ROW EXECUTE FUNCTION homeplate_set_updated_at();
CREATE TRIGGER listings_set_updated_at
  BEFORE UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION homeplate_set_updated_at();
CREATE TRIGGER bookings_set_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION homeplate_set_updated_at();
CREATE TRIGGER reviews_set_updated_at
  BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION homeplate_set_updated_at();
CREATE TRIGGER safety_alerts_set_updated_at
  BEFORE UPDATE ON safety_alerts
  FOR EACH ROW EXECUTE FUNCTION homeplate_set_updated_at();
CREATE TRIGGER notification_attempts_set_updated_at
  BEFORE UPDATE ON notification_attempts
  FOR EACH ROW EXECUTE FUNCTION homeplate_set_updated_at();
CREATE TRIGGER data_requests_set_updated_at
  BEFORE UPDATE ON data_requests
  FOR EACH ROW EXECUTE FUNCTION homeplate_set_updated_at();
