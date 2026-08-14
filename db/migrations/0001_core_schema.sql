-- 0001_core_schema.sql — U1-DB: the complete SRS §3.4 entity schema.
--
-- Requirement traceability (SRS Appendix B):
--   FR-11 / AB-07 — listings.local_date supports the one-listing-per-host-per-day invariant
--                   (unique partial index in 0002); users.email UNIQUE blocks duplicate accounts
--   FR-12 / FR-14 — bookings + CHECK (seats_remaining >= 0 AND <= seat_capacity) makes
--                   overbooking impossible at the database even under races
--   FR-04         — booking lifecycle (pending → in_progress → completed / cancelled) with dual
--                   completion-confirmation flags, enforced by CHECK for 'completed'
--   FR-05         — reviews (rating CHECK 1..5, up to two per booking: guest↔host)
--   FR-06 / FR-08 — messages, moderation_decisions, moderation_queue (ADR-002 two-stage pipeline;
--                   listings/reviews default moderation_status 'pending' — never public unreviewed)
--   FR-07         — safety_alerts with delivery status retried until delivered ('no_channel' when
--                   no emergency contact exists — build-plan open question 10)
--   FR-10         — email_verification_tokens (unverified account until token confirmation)
--   FR-13         — notification_attempts (ADR-011: mock transport records these rows in dev/test)
--   NFR-02        — schema sized for >= 10,000 users / 1,000 listings/bookings per day
--   NFR-12        — data_requests (erasure/export/inactivity), anonymizable author references
--                   (nullable FKs), media_objects referenced by key for per-object delete (ADR-004)
--   NFR-13        — PII minimization: users carries EXACTLY the §3.4 attribute set; phone and
--                   emergency-contact columns hold AES-256-GCM ciphertext (src/db/fieldCrypto.js),
--                   never plaintext; access_log records role-restricted PII reads
--   NFR-04        — users.password_hash only; no plaintext password column exists
--   ADR-009       — NO MEHKO cap value appears in this schema on purpose: caps are configuration
--                   (src/config/locale.js) enforced at one server-side point; the DB contributes
--                   only the (host_id, local_date) uniqueness backstop. local_date is computed by
--                   the service in the configured America/Los_Angeles boundary timezone.
--   ADR-010       — listings store BOTH precise (lat/lng, street address) and public-precision
--                   (coarse_lat/coarse_lng/area_label) location; serializers choose what leaves.
--
-- Anonymization over hard delete: NFR-12 erasure ANONYMIZES rows (nullable author/actor FKs go
-- NULL, PII columns are overwritten). ON DELETE CASCADE / SET NULL rules below are the backstop
-- for a true hard delete so no orphan can ever survive one.

-- gen_random_uuid() is built into PostgreSQL 13+ (no extension needed on PostgreSQL 16).

-- ---- enums -----------------------------------------------------------------------------------

-- FR-08: content is pending until approved; a moderation outage keeps it pending forever.
CREATE TYPE moderation_status AS ENUM ('pending', 'approved', 'rejected');

-- FR-11: cancelled listings do not count against the daily uniqueness invariant.
CREATE TYPE listing_status AS ENUM ('active', 'cancelled');

-- FR-04 / §3.4 lifecycle: pending → in_progress (at scheduled start) → completed; cancelled
-- reachable until the scheduled start (FR-14).
CREATE TYPE booking_status AS ENUM ('pending', 'in_progress', 'completed', 'cancelled');

-- FR-08 / ADR-002: what a moderation decision or queue item refers to.
CREATE TYPE moderation_content_type AS ENUM ('listing', 'review', 'message');

-- ADR-002 two-stage pipeline: deterministic pre-filter → LLM → human moderator.
CREATE TYPE moderation_actor AS ENUM ('pre_filter', 'llm', 'human');

CREATE TYPE moderation_outcome AS ENUM ('approved', 'rejected', 'escalated');

CREATE TYPE moderation_queue_status AS ENUM ('open', 'in_review', 'resolved');

-- §3.4 NOTIFICATION_ATTEMPT channel (ADR-011: email is the v1.0 channel, push gated off).
CREATE TYPE notification_channel AS ENUM ('email', 'push');

-- §3.4: sent/failed/retrying, plus 'queued' (recorded before the worker picks it up) and
-- 'no_channel' (FR-07 with no emergency contact — recorded, not failed).
CREATE TYPE notification_status AS ENUM ('queued', 'sent', 'failed', 'retrying', 'no_channel');

-- FR-07: delivery retried until delivered; 'no_channel' when no emergency contact exists.
CREATE TYPE alert_delivery_status AS ENUM ('pending', 'retrying', 'delivered', 'failed', 'no_channel');

-- ADR-004: what a media object is attached to.
CREATE TYPE media_entity_type AS ENUM ('listing', 'review', 'host_profile');

-- NFR-12 / NFR-13 data lifecycle jobs.
CREATE TYPE data_request_kind AS ENUM ('erasure', 'export', 'inactivity_notice');

CREATE TYPE data_request_status AS ENUM ('pending', 'processing', 'completed', 'failed');

-- ---- users (§3.4 USER; NFR-04, NFR-06, NFR-12, NFR-13, FR-10, AB-07) -------------------------
-- Column set is EXACTLY the §3.4 PII register plus non-personal lifecycle metadata; the ST-06
-- schema test asserts no extra personal attribute is ever added (data minimization, NFR-13).
-- *_enc columns hold AES-256-GCM ciphertext produced by src/db/fieldCrypto.js — never plaintext.
CREATE TABLE users (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                       text NOT NULL,
  email_verified              boolean NOT NULL DEFAULT false,          -- FR-10
  password_hash               text NOT NULL,                           -- NFR-04: hash only
  full_name                   text,
  phone_enc                   text,                                    -- NFR-13: encrypted at rest
  emergency_contact_name_enc  text,                                    -- FR-07 third-party PII,
  emergency_contact_phone_enc text,                                    --   encrypted at rest and
  emergency_contact_email_enc text,                                    --   deleted with the account
  can_reserve_seat            boolean NOT NULL DEFAULT false,          -- NFR-06 eligibility flag
  can_publish_listing         boolean NOT NULL DEFAULT false,          -- NFR-06 eligibility flag
  roles                       text[] NOT NULL DEFAULT ARRAY['user'],   -- SRS §2.3 Moderator role
  last_active_at              timestamptz NOT NULL DEFAULT now(),      -- NFR-12 inactivity sweep
  deleted_at                  timestamptz,                             -- NFR-12 deletion mark
  anonymized_at               timestamptz,                             -- NFR-12 erasure completed
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  -- AB-07: duplicate-account mitigation — a second registration with the same email conflicts.
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_roles_allowed CHECK (
    roles <@ ARRAY['user', 'moderator', 'admin']::text[] AND cardinality(roles) >= 1
  )
);

-- ---- host_profiles (§3.4: at most ONE host profile per user — PK enforces it; NFR-06) --------
CREATE TABLE host_profiles (
  user_id                    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bio                        text,
  host_agreement_accepted_at timestamptz,                              -- NFR-06 canPublishListing
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- ---- email_verification_tokens (FR-10) -------------------------------------------------------
-- Stores a HASH of the token (U2-IDENTITY hashes before storage) — a database leak must not
-- yield usable verification links.
CREATE TABLE email_verification_tokens (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---- listings (§3.4 LISTING; FR-01, FR-02, FR-11, FR-12, AB-07, ADR-009, ADR-010) ------------
CREATE TABLE listings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             text NOT NULL,                                     -- §3.4 "name"
  description       text NOT NULL,                                     -- FR-02 dish description
  ingredients       text[] NOT NULL DEFAULT '{}',                      -- FR-02
  allergens         text[] NOT NULL DEFAULT '{}',                      -- FR-02 allergy information
  cuisine           text,                                              -- FR-01 filter (NFR-02 index)
  scheduled_start   timestamptz NOT NULL,                              -- §3.4 date
  duration_minutes  integer NOT NULL CHECK (duration_minutes > 0),     -- §3.4 duration
  -- ADR-009: the listing's calendar day in the configured operating timezone
  -- (America/Los_Angeles), computed by the single server-side enforcement point — never by the
  -- caller. Backs the FR-11/AB-07 daily-uniqueness index in 0002.
  local_date        date NOT NULL,
  -- ADR-010 progressive disclosure: precise location (street address, exact coordinates) goes
  -- ONLY to a pending/in-progress guest or an FR-07 moderator; every other read path serializes
  -- the coarse_* / area_label public precision. Redis caches public precision only.
  address_line1     text,
  address_line2     text,
  city              text,
  region            text,
  postal_code       text,
  country           text NOT NULL DEFAULT 'US',
  lat               double precision,                                  -- precise (privileged)
  lng               double precision,                                  -- precise (privileged)
  coarse_lat        double precision,                                  -- public precision
  coarse_lng        double precision,                                  -- public precision
  area_label        text,                                              -- e.g. "North Park, San Diego"
  seat_capacity     integer NOT NULL CHECK (seat_capacity > 0),
  seats_remaining   integer NOT NULL,
  -- FR-08: pending until approved — public read paths filter on 'approved'.
  moderation_status moderation_status NOT NULL DEFAULT 'pending',
  status            listing_status NOT NULL DEFAULT 'active',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- FR-12/FR-14: overbooking (and over-restoring on cancel) is impossible at the database.
  -- Deliberately NO AB 626 numeric cap here: 30/60 live in src/config only (ADR-009).
  CONSTRAINT listings_seats_within_capacity
    CHECK (seats_remaining >= 0 AND seats_remaining <= seat_capacity)
);

-- ---- bookings (§3.4 BOOKING; FR-04, FR-12, FR-14, AB-02) -------------------------------------
CREATE TABLE bookings (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id                 uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  guest_id                   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status                     booking_status NOT NULL DEFAULT 'pending',
  host_confirmed_completion  boolean NOT NULL DEFAULT false,           -- FR-04
  guest_confirmed_completion boolean NOT NULL DEFAULT false,           -- FR-04
  cancelled_at               timestamptz,                              -- FR-14
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  -- FR-04: 'completed' requires BOTH confirmation flags — the database refuses otherwise.
  CONSTRAINT bookings_completed_requires_both_confirmations
    CHECK (status <> 'completed' OR (host_confirmed_completion AND guest_confirmed_completion))
);

-- ---- reviews (§3.4 REVIEW; FR-05, FR-08, NFR-12) ---------------------------------------------
-- author_id / target_user_id are nullable so NFR-12 anonymization can sever authorship while
-- retaining the review ("reviews may be retained in anonymized form").
CREATE TABLE reviews (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  author_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  target_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  rating            integer NOT NULL CHECK (rating BETWEEN 1 AND 5),   -- §3.4 numeric rating
  body              text,
  moderation_status moderation_status NOT NULL DEFAULT 'pending',      -- FR-08 pending until approved
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- FR-05: up to two reviews per completed booking — one per author (guest↔host).
  CONSTRAINT reviews_one_per_booking_author UNIQUE (booking_id, author_id)
);

-- ---- messages (§3.4 MESSAGE; FR-06, FR-08 / ADR-002) -----------------------------------------
-- Messages DELIVER IMMEDIATELY and are scanned asynchronously (ADR-002): moderation_status here
-- is the scan state; delivery never waits on it.
CREATE TABLE messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  sender_id         uuid REFERENCES users(id) ON DELETE SET NULL,      -- nullable: NFR-12 anonymize
  body              text NOT NULL,
  moderation_status moderation_status NOT NULL DEFAULT 'pending',
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ---- safety_alerts (§3.4 SAFETY_ALERT; FR-07) ------------------------------------------------
CREATE TABLE safety_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  raised_by       uuid REFERENCES users(id) ON DELETE SET NULL,        -- nullable: NFR-12 anonymize
  delivery_status alert_delivery_status NOT NULL DEFAULT 'pending',    -- retried until delivered
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---- moderation_decisions (§3.4 MODERATION_DECISION; FR-08, NFR-10, ADR-002/007) -------------
-- Retained anonymized per NFR-12: content reference + acting moderator FK are severable.
CREATE TABLE moderation_decisions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type       moderation_content_type NOT NULL,
  content_id         uuid NOT NULL,
  category           text NOT NULL,                                    -- offensive/spam/fraudulent/benign
  confidence         numeric(4, 3) CHECK (confidence >= 0 AND confidence <= 1),
  outcome            moderation_outcome NOT NULL,
  decided_by         moderation_actor NOT NULL,                        -- pre_filter | llm | human
  decided_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,     -- the human moderator, if any
  model_id           text,                                             -- ADR-007: record the model id
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ---- moderation_queue (FR-08 / ADR-002 human review stage) -----------------------------------
CREATE TABLE moderation_queue (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type moderation_content_type NOT NULL,
  content_id   uuid NOT NULL,
  reason       text NOT NULL,                                          -- low_confidence | flagged | …
  status       moderation_queue_status NOT NULL DEFAULT 'open',
  assigned_to  uuid REFERENCES users(id) ON DELETE SET NULL,
  decision_id  uuid REFERENCES moderation_decisions(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

-- ---- notification_attempts (§3.4 NOTIFICATION_ATTEMPT; FR-13, FR-07, ADR-011) ----------------
-- PII register rule: these rows carry USER IDS ONLY, never names/emails/phones. `params` is for
-- template identifiers/IDs; the worker resolves recipients at send time. The whole test suite
-- asserts on these rows instead of any third party's behaviour (ADR-011).
CREATE TABLE notification_attempts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel           notification_channel NOT NULL,                     -- email (v1.0) | push (gated)
  template          text NOT NULL,
  params            jsonb NOT NULL DEFAULT '{}',                       -- IDs only — never raw PII
  status            notification_status NOT NULL DEFAULT 'queued',
  attempt_count     integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  idempotency_key   text,
  last_error        text,
  sent_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- transport.send() idempotency (U2-ADAPTERS-COMMS): a retried outbox delivery reuses its key.
  CONSTRAINT notification_attempts_idempotency_key_key UNIQUE (idempotency_key)
);

-- ---- media_objects (§3.4 Media; ADR-004, FR-02/03/05, NFR-12) --------------------------------
-- Media live in object storage referenced BY KEY; account erasure deletes per object key.
CREATE TABLE media_objects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type   media_entity_type NOT NULL,
  entity_id     uuid,
  storage_key   text NOT NULL,
  content_type  text,
  size_bytes    bigint CHECK (size_bytes >= 0),
  deleted_at    timestamptz,                                           -- NFR-12 erasure audit mark
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_objects_storage_key_key UNIQUE (storage_key)
);

-- ---- data_requests (NFR-12 erasure/inactivity, NFR-13 CCPA export) ---------------------------
CREATE TABLE data_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         data_request_kind NOT NULL,
  status       data_request_status NOT NULL DEFAULT 'pending',
  due_at       timestamptz NOT NULL,                                   -- now + 30 days (config)
  completed_at timestamptz,
  detail       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---- access_log (NFR-13: role-restricted personal-data reads are logged) ---------------------
-- Append-only audit of privileged PII access (actor, subject, purpose). Survives account
-- deletion (FKs go NULL) because it is the evidence trail, and carries no PII itself.
CREATE TABLE access_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  subject_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  purpose         text NOT NULL,
  resource        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
