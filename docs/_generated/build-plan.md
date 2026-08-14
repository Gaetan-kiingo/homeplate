---
output:
  pdf_document: default
  html_document: default
---
# Homeplate v1.0 — Build Plan

Derived from **SRS v3.2** (frozen baseline), **SPMP v1.0**, and **ADR-001…011**.
Companion artifact: `requirements-inventory.json` (all 14 FR + 13 NFR + 8 AB with executable
acceptance criteria — unchanged from the 2026-08-12 inventory; only the buildRun record moved).

**Revision 2026-08-14.** Supersedes the 2026-08-12 plan (its content is preserved below where it
still describes reality). Changes of substance:

1. **Waves 0–2 are BUILT.** `npm run build` passes (56 source files, 3 migrations, app factory
   boots); the repository contains config, schema/migrations, DB/Redis clients, observability,
   validation, HTTPS enforcement, outbox+worker, auth/identity, eligibility, media service, and
   all five external adapters with their unit and lane tests. This is an **increment**, not a
   green-field build.
2. **This run implements wave 3 — core marketplace** (the units the 2026-08-12 plan's §4 named
   U3-LISTINGS, U3-SEARCH, U3-HOSTS-MEDIA, U3-BOOKINGS), split here into two dependency layers
   (3A write core, 3B read surface) because two of the four units import serializer/URL modules
   the other two own. Waves 4–6 remain the roadmap and are **not built in this run**.
3. Five mechanism decisions this decomposition had to make (search-path Maps use, media upload
   without request-path adapters, the `pending → in_progress` trigger, `bookings.completed_at`,
   the `/api/listings/search` mount) are recorded in §6 as team-visible readings, none blocking.

---

## 1. Stack (unchanged, now on disk)

| Concern | Choice | Why |
|---|---|---|
| API | Node.js 20+ / Express 4, CommonJS, stateless REST over HTTPS/JSON | SRS §2.4; built (waves 0–2) |
| Source of truth | PostgreSQL 16 via `pg`, parameterized SQL only | SRS §2.4, NFR-11 |
| Cache / sessions | Redis 7 via `ioredis` — sessions and read cache only | ADR-001/006 |
| Media | S3-compatible object storage (MinIO locally), referenced by key | ADR-004 |
| Deferred work | `outbox_jobs` table + in-process polling worker (`FOR UPDATE SKIP LOCKED`, retry/backoff/dead-letter) | ADR-001/003; built |
| Validation | `zod` schemas via `src/middleware/validate.js` | NFR-11 |
| Moderation LLM | Provider-agnostic adapter, Gemini free tier configured, deterministic mock in CI | ADR-007 |
| Maps | Google Maps/Places adapter, Redis cache at public precision only | ADR-005, ADR-010 |
| Email / push | SendGrid channel; FCM behind `notifications.push.enabled=false`; mock transport in dev/test recording NOTIFICATION_ATTEMPT rows | ADR-011 |
| Tests | Jest 29 + Supertest; k6 (LT), axe-core (UT-01), ZAP baseline (ST-04) | SRS §4 |
| Package manager / infra | npm; Docker Compose (PostgreSQL 5432, Redis 6379, MinIO 9000/9001) | SPMP §5.1.3, free tier |

### Directory layout (repo-relative; **bold** = new in this run)

```
db/migrations/            0001 core schema, 0002 indexes, 0003 outbox, **0004 bookings.completed_at**
scripts/                  migrate.js, seed.js, worker.js, dev.js, check-build.js, gen-dev-certs.sh
src/config/               env schema, fail-fast loader, locale/AB 626 caps (ADR-009)
src/db/                   pool, withTransaction, redis, fieldCrypto
src/lib/                  logger, errors, resilience, httpClient, cache, sanitize, geoPrecision,
                          **mediaUrls.js** (local URL derivation/presigning — no network call)
src/middleware/           requestContext, errorHandler, security, validate
src/routes/index.js       route registry (mounts src/modules/*/routes.js; wave-3 names already known)
src/adapters/             maps, sendgrid, fcm, llmModeration(+mock), objectStorage
src/outbox/               outbox, dispatch, worker; handlers/emailVerification.js,
                          **handlers/listingGeocode.js, bookingNotifications.js, bookingPromote.js**
src/modules/              auth, users, eligibility, media, notifications        (waves 0–2, built)
                          **listings, search, hosts, bookings** (+ **media/routes.js**)  (this run)
                          reviews, messaging, moderation, safety, privacy       (wave 4)
src/schemas/              common, auth, **listings, bookings, search, hosts, media**
client/                   React + Vite responsive web app                       (waves 5–6)
tests/unit/               implementer unit/integration tests (per unit)
tests/<lane>/             verifier lanes (tc-core, tc-booking, it-adapters, st-security,
                          rt-lt-resilience, mt-ut-quality, adr-conformance, coverage)
docs/_generated/          this plan, requirements-inventory.json, SRS.txt, SPMP.txt
```

### Conventions that make parallel work safe (carried forward, binding)

1. **File ownership is exclusive within a wave.** A unit may *import* a sibling's module only
   through the `publicInterface` contract in this plan, and never edits a file it does not own.
   This revision goes one step further: where the 2026-08-12 plan let same-wave units import
   not-yet-written sibling files, this run **splits those pairs into two layers (3A → 3B)** so
   every import target exists before its importer is built.
2. **Route registry** (`src/routes/index.js`, wave 1) already knows the module names `listings`,
   `search`, `hosts`, `bookings`. Dropping `src/modules/<name>/routes.js` on disk mounts it at
   `/api/<name>` (or at the module's exported `basePath`) with no edit to any shared file.
3. **Outbox handler discovery** (`src/outbox/dispatch.js`): each `src/outbox/handlers/*.js`
   exports `{ type, handle(payload, ctx) }` and is auto-registered. Feature units own individual
   handler files. An enqueued type with no registered handler retries and dead-letters at the
   attempt cap; `outbox.requeueDeadLetter(jobId)` re-opens it once the handler lands (see §6.2).
4. **Migrations are append-only.** A wave never edits an applied migration; new columns arrive as
   new numbered files. This run appends exactly one: `0004` (owned by U3-BOOKINGS).

---

## 2. Commands (unchanged; all in package.json today)

| Purpose | Command |
|---|---|
| install | `npm install` |
| infra | `docker compose up -d` (PostgreSQL, Redis, MinIO) |
| migrate | `npm run migrate` |
| seed | `npm run seed` / `npm run seed:volume` (NFR-02 scale for LT-02) |
| build | `npm run build` (`scripts/check-build.js`: env schema, migration ordering, syntax, app boot) |
| test | `npm test` (Jest over `tests/**`; `npm run test:unit` for the unit subset) |
| lint | `npm run lint` |
| dev | `docker compose up -d && npm run dev` (API + outbox worker) |
| load | `npm run test:load` (k6 — **meaningful from this wave on**: LT-01/LT-02 now have read paths) |

---

## 3. Waves built in this run

Wave numbering continues from the built waves 0–2. Wave 3A may assume waves 0–2 exist on disk;
wave 3B may additionally assume 3A.

### Wave 3A — Marketplace write core (2 units)

| Unit | Title | Requirements | Owns (exclusive) |
|---|---|---|---|
| U3-LISTINGS | Listing service: MEHKO enforcement, moderation gating, progressive-disclosure serializers, deferred geocoding | FR-11, FR-02, FR-08 (enqueue + pending-until-approved), FR-09 (consumes gate), NFR-08, NFR-11, NFR-13, AB-01, AB-03, AB-07, AB-08 | `src/modules/listings/{repo,mehko,serializers,access,service,routes}.js`, `src/schemas/listings.js`, `src/lib/mediaUrls.js`, `src/outbox/handlers/listingGeocode.js`, `tests/unit/listings.test.js` |
| U3-BOOKINGS | Booking service: atomic capacity, lifecycle (pending→in_progress→completed, cancel), transactional notifications | FR-12, FR-04, FR-13, FR-14, AB-02, NFR-08, NFR-11 | `db/migrations/0004_bookings_completed_at.sql`, `src/modules/bookings/{repo,service,lifecycle,routes}.js`, `src/schemas/bookings.js`, `src/outbox/handlers/{bookingNotifications,bookingPromote}.js`, `tests/unit/bookings.test.js` |

**U3-LISTINGS specification highlights**

- **One MEHKO enforcement point** (`src/modules/listings/mehko.js`, ADR-009): computes
  `local_date` from `scheduled_start` in `config.mehko.timezone` (`America/Los_Angeles`, via
  `Intl.DateTimeFormat` — no new dependency), checks `listingsPerHostPerDay` (backed by the
  0002 unique index on `(host_id, local_date) WHERE status <> 'cancelled'`, so concurrent
  duplicates cannot both commit — the service maps the constraint violation to
  `409 MEHKO_DAILY_LISTING_LIMIT`), `maxMealsPerDay` (seat_capacity + same-day non-cancelled
  seats ≤ 30 → else `422 MEHKO_DAILY_MEAL_LIMIT`), and `maxMealsPerWeek` (Monday-anchored LA
  week, ≤ 60). Consulted by create, update, and cancel/re-create paths; numbers only ever read
  from `config.mehko` — never inline (adr-conformance greps for the literals).
- **Serializers are the ADR-010 chokepoint** (`serializers.js`): `publicListing(row, media)` —
  coarse_lat/coarse_lng/area_label/city only, explicit key allowlist, **no** address_line/lat/lng,
  no host email/phone; `privilegedListing(row, media)` adds exact address + precise coordinates.
  `access.js` exports `canViewPreciseLocation(viewer, listingId, client?)` → true only for
  (a) a guest with a booking on that listing in `pending`/`in_progress`, or (b) a caller with the
  `moderator` role handling an open safety alert on that listing's bookings — case (b) writes an
  `access_log` row (actor, subject host, purpose `'fr07_safety_alert'`). Search (3B), host
  profile (3B), and any future read path import THESE modules rather than shaping rows themselves.
- **Geocoding is deferred** (ADR-001/003): `POST /api/listings` persists the address fields and
  enqueues `listing.geocode` (payload `{listingId}`) in the same transaction; the
  `listingGeocode` handler (worker-only) calls the Maps adapter, writes `lat/lng`,
  `coarse_lat/coarse_lng` (via `geoPrecision.coarsen`) and `area_label`. Safe because the listing
  is `moderation_status='pending'` — invisible publicly — until approved, by which time geocoding
  has long completed; a Maps outage delays map placement, never listing creation (NFR-09).
- **Moderation substrate** (FR-08): create and material update (title/description/ingredients
  change) set/reset `moderation_status='pending'` and enqueue `moderation.scan`
  (payload `{contentType:'listing', contentId}`) in the same transaction. The scan handler is
  wave-4 (U4-MODERATION); until then jobs dead-letter harmlessly and content **stays pending —
  the safe direction** (see §6.2). Owner sees own pending listing on `GET /api/listings/:id`;
  everyone else gets 404 until approved.
- **Routes** (`/api/listings`): `POST /` (requireSession + requireEligibility(PUBLISH_LISTING)),
  `GET /:id` — **the `:id` param is regex-constrained to a UUID** so `/api/listings/search`
  falls through to the search router (3B, §6.5) — `PATCH /:id`, `POST /:id/cancel` (owner-only,
  403 otherwise; cancel sets `status='cancelled'`, cancels active bookings via SQL and enqueues
  one `notify.booking` job per affected guest in the same transaction — handler owned by
  U3-BOOKINGS, type contract below). Every mutation writes an NFR-08 audit log line
  (event, actor, listing id, outcome, correlationId). Image URLs in responses come from
  `src/lib/mediaUrls.js` (below) over `media_objects` rows (`entity_type='listing'`).
- **`src/lib/mediaUrls.js`** (ADR-004-adjacent, request-path-safe): derives a GET URL for a
  storage key by **local computation only** — S3 presign (SigV4 is pure crypto over
  `config.objectStorage`) or plain `endpoint/bucket/key` concatenation for the mock/dev store.
  It performs no network I/O and imports nothing from `src/adapters/`, so the adr-conformance
  boot check stays green (§6.3). Also exports `createUploadTarget(userId, kind, contentType)` →
  `{storageKey, uploadUrl, headers, expiresAt}` with the key namespaced
  `<kind>/<userId>/<uuid>.<ext>` so a user can only ever upload under their own prefix.

**U3-BOOKINGS specification highlights**

- **Migration 0004** adds `completed_at timestamptz` to `bookings` (FR-04 acceptance asserts it).
  Append-only; nothing in 0001–0003 is edited.
- **Atomic reservation** (FR-12): inside `withTransaction` — (1)
  `pg_advisory_xact_lock` on the guest id to make the per-guest cap race-free, (2) count guest's
  `pending` bookings `>= config.booking.maxConcurrentPending` → `409 BOOKING_LIMIT` (AB-02),
  (3) conditional
  `UPDATE listings SET seats_remaining = seats_remaining - 1 WHERE id=$1 AND seats_remaining > 0
  AND status='active' AND moderation_status='approved' AND scheduled_start > now()` — zero rows →
  `409 NO_CAPACITY` (or 404 if not visible), (4) `INSERT booking (status='pending')`, (5) enqueue
  `notify.booking` per recipient (guest and host) **and** `booking.promote` with
  `availableAt = scheduled_start`, same client. Booking own listing → 409. Ineligible → 403 via
  `requireEligibility(RESERVE_SEAT)` before any capacity work (FR-09). The DB CHECK
  (`seats_remaining >= 0 AND <= seat_capacity`) makes overbooking and over-restoring impossible
  even if service logic regresses.
- **Cancellation** (FR-14): guest or listing host, strictly before `scheduled_start`
  (else 409); `UPDATE bookings SET status='cancelled', cancelled_at=now() WHERE id=$1 AND status
  = 'pending' RETURNING …` — zero rows on a repeat means idempotent no-restore; seat restored
  (`seats_remaining + 1`) and `notify.booking` rows written in the same transaction.
  Non-participant → 403.
- **Completion** (FR-04): `POST /api/bookings/:id/confirm-completion` sets the caller's flag
  (guest_confirmed_completion / host_confirmed_completion) only while `in_progress`
  (pending/cancelled → 409); both flags → `status='completed'`, `completed_at=now()` (the 0001
  CHECK already refuses `completed` without both flags). Repeat confirmation → 200 no-op.
  Third party → 403.
- **Lifecycle** (`lifecycle.js` + `bookingPromote` handler): promotion `pending → in_progress`
  is a **per-booking scheduled outbox job** enqueued at creation with
  `availableAt = scheduled_start` (deviation from the old §4 note's "periodic job" — §6.4).
  Handler: booking no longer `pending` → done; listing's `scheduled_start` moved later → enqueue
  a fresh promote job for the new instant and finish; else set `in_progress`. Idempotent under
  redelivery (keyed on `ctx.idempotencyKey`).
- **`bookingNotifications` handler** (FR-13 end-to-end, following the wave-2
  `emailVerification.js` precedent so wave 3 closes the loop): consumes `notify.booking`
  (payload `{bookingId, event, recipientUserId}` — **IDs only**, enforced by
  `outbox.assertIdOnlyPayload`), loads what it needs by ID, and calls the wave-2
  `notifications/transport.send({userId, channel, template, params, idempotencyKey})`, which
  resolves to the mock in dev/test and records a NOTIFICATION_ATTEMPT row (ADR-011). Events:
  `created`, `cancelled_by_guest`, `cancelled_by_host`, `listing_cancelled`, `completed`.
  U4-NOTIFY's former scope collapses into this file; wave 4 keeps only reviews/moderation
  notification handlers.
- **Read routes**: `GET /api/bookings` (own bookings, both roles) and `GET /api/bookings/:id`
  (participant-only) — booking payloads reference the listing by ID + public fields; the
  privileged address stays on `GET /api/listings/:id` (single ADR-010 chokepoint).

### Wave 3B — Marketplace read surface (2 units)

| Unit | Title | Requirements | Owns (exclusive) |
|---|---|---|---|
| U3-SEARCH | Search/discovery with Redis result cache and degraded mode | FR-01, NFR-01, NFR-02, NFR-09, NFR-11, AB-08 | `src/modules/search/{repo,service,routes}.js`, `src/schemas/search.js`, `tests/unit/search.test.js` |
| U3-HOSTS-MEDIA | Host profile page + media HTTP surface (upload targets, attach) | FR-03, FR-02/FR-05 (media supply), NFR-13, AB-08, ADR-004 | `src/modules/hosts/{repo,service,serializers,routes}.js`, `src/modules/media/routes.js`, `src/schemas/{hosts,media}.js`, `tests/unit/hosts-media.test.js` |

**U3-SEARCH specification highlights**

- **Route**: `GET /api/listings/search` — the module exports
  `{ basePath: '/api/listings', router }`; mount order (listings first, `:id` UUID-constrained)
  makes `/search` reach it (§6.5). Query params (all optional, any combination):
  `location` + `radiusKm`, `from`/`to`, `hostId`, `cuisine`, plus pagination. Zod-validated;
  unknown params stripped (NFR-11).
- **Visibility invariant**: only `moderation_status='approved' AND status='active' AND
  scheduled_start > now()` rows are ever returned, shaped by **U3-LISTINGS' `publicListing`
  serializer** — coarse coordinates + area label only (ADR-010; the adr-conformance lane asserts
  no exact address/precise coordinate in any search payload).
- **Location resolution**: `location` strings resolve through the wave-2 Maps adapter
  (**call-time require** — request-path use of the *read* adapter is the ADR-005 design and does
  not touch the deferred-work rule; reading recorded in §6.1). The adapter already caches
  geocodes in Redis at public precision; the search service additionally caches result pages via
  `cache.wrap` (key = hash of normalized query, TTL from config) — a repeat query performs zero
  provider calls. Distance filtering compares against the listing's **coarse** coordinates
  (the public precision is also the honest precision — ADR-010).
- **Degraded mode** (NFR-09/RT-01): Maps failure + cache miss → `503 SEARCH_DEGRADED` with a
  user-facing message for location queries; cached queries and non-location queries keep working,
  responses carry a `degraded: true` flag when served stale.
- **NFR-02**: the search SQL is written against the 0002 indexes (`scheduled_start`,
  `moderation_status`, `cuisine`, `(coarse_lat, coarse_lng)`, partial public-search index);
  acceptance includes an `EXPLAIN` check showing no sequential scan at volume seed.

**U3-HOSTS-MEDIA specification highlights**

- **`GET /api/hosts/:id`** (session required — 401 unauthenticated, AB-08): `selfIntroduction`
  (host_profiles.bio), `exampleDishes` (the host's approved active listings via U3-LISTINGS'
  `publicListing`), approved reviews about the host (rating, body, created_at, anonymized-safe
  author display) + `averageRating`/`reviewCount`, kitchen/dining images
  (`media_objects` `entity_type='host_profile'` → `mediaUrls`). Response built from an explicit
  key allowlist: **no** email, phone, emergency contact, password hash, exact address (NFR-13);
  `GET /api/hosts/:id/reviews` for the paginated list (LT-01 exercises it).
- **Media HTTP surface** (`src/modules/media/routes.js`, mounts at `/api/media` — module `media`
  is already in the registry): `POST /api/media/uploads` (authenticated) validates
  `{kind ∈ media_entity_type, contentType ∈ allowlist, sizeBytes ≤ cap}` and returns
  `mediaUrls.createUploadTarget(...)` — the client PUTs bytes **directly to object storage**;
  the API never proxies bytes and never calls an adapter (§6.3). `POST /api/media`
  (authenticated) records `{storageKey, kind, entityId?}` via the wave-2
  `mediaService.attach(userId, key, kind, …)` after asserting the key sits under the caller's
  own `<kind>/<userId>/` prefix (403 otherwise). `DELETE /api/media/:id` marks the row deleted;
  physical per-key deletion stays on the worker/erasure path (ADR-004, NFR-12).
- Attaching listing images (`entityId` = listing) checks the caller owns that listing; review
  images arrive in wave 4 through the same endpoint (no new surface needed).

### Public interfaces this run publishes (waves 4–6 rely on these)

| Unit | Contract |
|---|---|
| U3-LISTINGS | `serializers.publicListing(row, media)` / `serializers.privilegedListing(row, media)`; `access.canViewPreciseLocation(viewer, listingId, client?)`; `mehko.assertWithinCaps(client, {hostId, scheduledStart, seatCapacity, excludeListingId?})` → throws typed AppError; `repo.findById`, `repo.findApprovedByHost`; routes `POST/GET/PATCH /api/listings…` as above; outbox types **`listing.geocode`** `{listingId}`, **`moderation.scan`** `{contentType, contentId}` (handler lands in wave 4); `mediaUrls.urlForKey(key)`, `mediaUrls.createUploadTarget(userId, kind, contentType)` |
| U3-BOOKINGS | routes `POST /api/bookings`, `POST /api/bookings/:id/{cancel,confirm-completion}`, `GET /api/bookings[/:id]`; outbox types **`notify.booking`** `{bookingId, event, recipientUserId}`, **`booking.promote`** `{bookingId}`; `repo.findParticipantBooking(bookingId, userId)` (wave-4 messaging/reviews/safety gate on participant + status through this) |
| U3-SEARCH | `GET /api/listings/search` returning `{results: publicListing[], degraded?: true, page…}` |
| U3-HOSTS-MEDIA | `GET /api/hosts/:id`, `GET /api/hosts/:id/reviews`; `POST /api/media/uploads`, `POST /api/media`, `DELETE /api/media/:id` (wave-4 reviews attach photos through these) |

---

## 4. Roadmap — waves 4–6 (NOT built in this run)

| Wave | Units |
|---|---|
| 4 — Trust, safety, data lifecycle | U4-REVIEWS-MESSAGING (FR-05, FR-06, AB-04) · U4-MODERATION (FR-08, NFR-10, ADR-008 eval set, **owns the `moderation.scan` handler and must `requeueDeadLetter` the wave-3 scan jobs on landing — §6.2**) · U4-SAFETY (FR-07) · U4-PRIVACY (NFR-12, NFR-13 erasure/export jobs) · U4-NOTIFY (residual non-booking notification handlers — booking handlers landed in U3-BOOKINGS) |
| 5 — Client foundation | U5-SHELL · U5-API-AUTH · U5-UI-KIT (NFR-07, SRS §2.1.2) |
| 6 — Client features | U6-DISCOVERY · U6-BOOKING · U6-COMMUNITY · U6-ACCOUNT-MOD |

---

## 5. Binding invariants every unit is checked against (unchanged, restated)

1. **No inline deferred-work adapter calls.** Request handlers never import `src/adapters/*` at
   module scope, and app boot loads none (adr-conformance lane). SendGrid/FCM/LLM/objectStorage
   writes are worker-only. The Maps **read** adapter on the search path is the one documented
   exception, per ADR-005 and §6.1 — call-time required, resilience-wrapped, cache-first.
2. **One transaction, no dual writes.** Business row + outbox row commit together via
   `withTransaction`; payloads carry IDs only (`assertIdOnlyPayload` enforces it at enqueue).
3. **Pending until approved.** Listings and reviews default `pending` and are filtered from every
   public read path; a moderation outage leaves them pending forever. Messages deliver
   immediately, scanned async.
4. **One eligibility interface** (`src/modules/eligibility/policy.js`) — wave 3 consumes
   `requireEligibility`, never re-implements.
5. **One MEHKO enforcement point**, caps from `src/config`, boundaries in `America/Los_Angeles`.
6. **Public serializer by default** (ADR-010): `publicListing` is the only shape search, host
   pages, and booking payloads emit; `privilegedListing` only behind
   `canViewPreciseLocation` (moderator case access-logged). Redis caches public precision only.
7. **Media by key** in object storage; per-object deletion on erasure (ADR-004).
8. **Email is the channel; push is off** (ADR-011); tests assert on NOTIFICATION_ATTEMPT rows.
9. **Redis = sessions + cache only.** 10. **HTTPS/TLS 1.2+, boundary validation, no
   MFA/ID-verification/payments.** 11. **No secrets in code; `.env.example` documents all.**

---

## 6. Decisions and open questions from this run

Items 1–13 of the 2026-08-12 plan's §8 stand as recorded there (with 2, 4, 5, 6, 11 decided as
ADR-007…011 and item 14's ratification still pending). New readings this decomposition had to
take — each chosen for fidelity to the SRS/ADRs, none blocking, all flagged for the team:

1. **Maps on the search request path vs. the worker-only adapter rule.** ADR-001/003's inline-call
   ban exists so a provider failure never blocks or rolls back a business transaction; ADR-005
   *by design* puts Maps on the FR-01 read path with timeout/retry/cache fallback (NFR-09's
   degraded mode is meaningless otherwise — there is no deferred way to answer a live location
   query). Reading: deferred-work adapters (SendGrid, FCM, LLM, object storage) are worker-only
   without exception; the Maps read adapter is callable from the search service via call-time
   require, keeping app boot adapter-free (the existing adr-conformance checks pass unchanged).
   Listing-address geocoding still runs on the worker (`listing.geocode`). Team should ratify.
2. **`moderation.scan` jobs dead-letter until wave 4.** Wave 3 enqueues them (FR-08 substrate,
   same-transaction guarantee); no handler exists until U4-MODERATION. The worker retries then
   dead-letters — content **stays pending**, which is FR-08's required failure direction; nothing
   publishes unreviewed. U4-MODERATION's acceptance includes requeueing wave-3 dead letters.
3. **Media upload without request-path adapters.** Bytes never transit the API: the server issues
   a locally-computed upload target (S3 presign is pure SigV4 crypto over config — no network
   call, no `src/adapters` import), the client PUTs straight to storage, then registers the key.
   Server-generated keys are namespaced per user, so cross-user attachment is impossible. This
   honors ADR-001 (nothing on the request path can block on the storage provider) and ADR-004
   (storage by key behind the adapter for worker-side get/delete). Team should ratify.
4. **`pending → in_progress` as a scheduled outbox job**, not a periodic sweep: enqueued with the
   booking (`availableAt = scheduled_start`), transactional, idempotent, self-repairing when a
   listing's start moves. Deviation from the 2026-08-12 §4 note ("periodic job"); mechanically
   simpler on the existing worker and avoids editing wave-2-owned scripts. Flagged for the team.
5. **`/api/listings/search` mount.** The Appendix-B "Search Service" stays its own module;
   it exports `basePath: '/api/listings'` and the listings router constrains `:id` to a UUID so
   `/search` falls through. Two routers on one base path is standard Express layering.
6. **`bookings.completed_at`** was not in the wave-1 schema; FR-04's acceptance asserts it. Added
   as append-only migration 0004 — no applied migration is edited.
7. **LT-01/LT-02 become meaningful after this wave** (the read paths now exist) but remain
   host-hardware-bound: a run that cannot reach 200 VUs reports the achieved level and is marked
   untestable, never passed (2026-08-12 §8 item 12 unchanged). NFR-10 remains unclaimable until
   the ADR-008 set exists **and** carries a human label sign-off (wave 4).

---

## 7. Verification expectations for this run

- Newly fully verifiable at the API level: **FR-11, FR-12, FR-14, FR-04, FR-02, FR-03, FR-01**
  (TC-01…04, TC-11, TC-12, TC-14; LT-01's race test), **FR-13 end-to-end** (enqueue → worker →
  NOTIFICATION_ATTEMPT; TC-13, RT-02 already exercise the mechanism), **AB-02, AB-03, AB-07,
  AB-08** (serializer allowlists), plus the wave-2 set (FR-09/10, NFR-03/04/05/06/08/09/11/13).
- Still `not_implemented`, never skipped/failed: FR-05, FR-06, FR-07, FR-08 (pipeline — the
  substrate rows ARE asserted), NFR-10, NFR-12 (erasure job), NFR-07/UT-01 (client).
- The **adr-conformance** lane gains teeth this wave: it must now enumerate search, listing
  detail, host profile and booking payloads and fail on any exact address/precise coordinate
  outside the pending/in-progress-guest and access-logged-moderator cases (ADR-010's stated
  failure mode), assert MEHKO literals appear only in `src/config`, and re-assert boot loads no
  adapter now that four new modules mount.

---

## 8. Mapping to the SPMP work activities

| SPMP activity | Status after this run |
|---|---|
| WA-1 Auth & eligibility | built (wave 2) |
| WA-2 Discovery/listing + Maps | **completed by U3-LISTINGS + U3-SEARCH** (adapter was wave 2) |
| WA-3 Booking — the never-cut core loop (SPMP §5.3.2) | **completed by U3-BOOKINGS** (outbox was wave 2) |
| WA-8 Media storage | **completed by U3-HOSTS-MEDIA** (adapter/service were wave 2) |
| WA-10 Worker/dispatcher + adapters | built (wave 2) + wave-3 handlers |
| WA-4/5/6/7 Reviews·messaging / safety / lifecycle / moderation | wave 4 |
| WA-9 Web client | waves 5–6 |
| WA-11 Test suite vs SRS §4 | verifier lanes, extended per §7 |

Per SPMP §5.2.2 this is Week 6–7 work (WA-2/WA-3 continuing); the schedule position is
consistent with the plan, with CDR (Aug 22) next.
