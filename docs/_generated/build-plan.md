---
output:
  pdf_document: default
  html_document: default
---
# Homeplate v1.0 — Build Plan

Derived from **SRS v3.2** (frozen baseline), **SPMP v1.0**, and **ADR-001…006**.
Companion artifact: `requirements-inventory.json` (all 14 FR + 13 NFR + 8 AB with executable
acceptance criteria).

Repository state at planning time: **green-field for application code**. The repo contains only
`ADRs/`, `Weekly Report/`, `.claude/workflows/homeplate-build.js` and `docs/_generated/`. No
`package.json`, `src/`, `client/`, migrations or tests exist yet. Everything below is a new build.

---

## 1. Stack

| Concern | Choice | Why |
|---|---|---|
| Client | React 18 + Vite, responsive single-page web app | SRS §2.1.2 (SPMP §5.2.1's "React Native" loses to the SRS) |
| API | Node.js 20+ / Express 4, stateless REST over HTTPS/JSON | SRS §2.4 fixed constraint |
| Language | JavaScript (CommonJS on the server, ESM in the client) | No transpile step; Jest + Supertest work out of the box (SRS §4.1) |
| Source of truth | PostgreSQL 16 via `pg` connection pool, parameterized SQL only | SRS §2.4, NFR-11 |
| Cache / sessions | Redis 7 via `ioredis` — **sessions and read cache only** | SRS §2.4, ADR-001, ADR-006 |
| Media | S3-compatible object storage (MinIO locally) via `@aws-sdk/client-s3`, referenced by key | ADR-004 |
| Deferred work | PostgreSQL outbox table + in-process polling worker, per-service adapters | ADR-001 / ADR-003 |
| Validation | `zod` schemas at the API boundary + shared sanitizer | NFR-11, ADR-006 |
| Passwords | Argon2id via `@node-rs/argon2` (prebuilt binaries). Documented fallback: `bcryptjs` cost 12 if the prebuilt binary is unavailable on the build host — record it as a deviation | NFR-04 |
| Sessions | Opaque 256-bit token in an HttpOnly/Secure/SameSite=Lax cookie; session record in Redis with TTL | ADR-006 |
| Moderation LLM | HTTPS adapter, provider configurable by env (`LLM_MODERATION_BASE_URL`, `LLM_MODERATION_API_KEY`, `MODERATION_MODEL`); **Google Gemini free tier** is the configured provider, returning structured `{category, confidence}`. Model id pinned at implementation time and recorded with the IT-03 results. Mock adapter in CI | **ADR-007**, ADR-002, FR-08 |
| Maps | Google Maps/Places Geocoding + Places over HTTPS behind one adapter, results cached in Redis | ADR-005 |
| Email / push | SendGrid (`@sendgrid/mail`) and Firebase Cloud Messaging (`firebase-admin`), worker-only | SRS §2.1.3, FR-13, FR-07 |
| Server tests | Jest + Supertest against a seeded test database; k6 (load), axe-core (a11y), OWASP ZAP baseline (ST-04) | SRS §4 |
| Client tests | Vitest + @testing-library/react + axe-core | NFR-07 |
| Package manager | npm (Node 20+); client installed with `npm --prefix client` | SPMP §5.1.3 free tier |
| Local infra | Docker Compose: PostgreSQL, Redis, MinIO | SPMP §5.1.3, ADR-004 |

### Directory layout

```
db/migrations/            numbered .sql migrations (source of truth for the §3.4 schema)
scripts/                  migrate.js, seed.js, worker.js, retention-sweep.js, gen-dev-certs.sh
src/config/               env schema, fail-fast loader, locale/AB 626 caps (SRS §2.1.7)
src/db/                   pg pool, withTransaction, redis client
src/lib/                  logger, errors, resilience (timeout/retry/backoff), httpClient, cache, sanitize
src/middleware/           requestContext, errorHandler, security (TLS/HSTS), validate
src/routes/               router registry that mounts src/modules/*/routes.js
src/adapters/             maps, sendgrid, fcm, llmModeration, objectStorage (worker-side only)
src/outbox/               outbox.enqueue, dispatch registry, worker; handlers/*.js
src/modules/              auth, users, eligibility, media, listings, search, hosts, bookings,
                          reviews, messaging, moderation, safety, privacy, notifications
src/app.js, src/server.js Express app factory and HTTPS bootstrap
client/                   React + Vite responsive web app (own package.json)
tests/unit/               implementer-written unit/integration tests
tests/<lane>/             verifier lanes (tc-core, tc-booking, it-adapters, st-security,
                          rt-lt-resilience, mt-ut-quality, adr-conformance, coverage)
tests/fixtures/           seed + the versioned >=200-item moderation evaluation set (IT-03)
docs/_generated/          this plan, the requirement inventory, extracted SRS/SPMP text
```

### Two conventions that make parallel work safe

1. **Route registry (`src/routes/index.js`, owned by U1-HTTP).** It resolves the known list of
   `src/modules/<name>/routes.js` paths, mounts each one that exists, and logs a startup warning
   for any that does not. Real logic, no stub — later waves drop their router in and it is mounted
   with no edit to a shared file.
2. **Outbox handler discovery (`src/outbox/dispatch.js`, owned by U1-OUTBOX).** The dispatcher
   reads `src/outbox/handlers/*.js` at startup; each file exports `{ type, handle(payload, ctx) }`.
   Feature units own individual handler files, so no shared registry file is ever edited twice.
3. **Client route discovery (`client/src/App.jsx`, owned by U5-SHELL).** Routes are collected with
   Vite's `import.meta.glob('./features/*/routes.jsx', { eager: true })`, which is valid with zero
   matches. Wave-6 feature units add their own `routes.jsx` and are auto-mounted.

---

## 2. Commands

| Purpose | Command |
|---|---|
| install | `npm install && npm --prefix client install` |
| infra | `docker compose up -d` (PostgreSQL 5432, Redis 6379, MinIO 9000/9001) |
| migrate | `npm run migrate` (applies `db/migrations/*.sql` in order, records them in `schema_migrations`) |
| seed | `npm run seed` / `npm run seed:volume` (NFR-02 scale for LT-02) |
| build | `npm run build` (client production bundle) |
| test | `npm test` (Jest: `src/**` + `tests/**`; client suite: `npm run test:client`) |
| lint | `npm run lint` (ESLint + Prettier over server and client) |
| dev | `docker compose up -d && npm run dev` (API + outbox worker + Vite client concurrently) |
| load | `npm run test:load` (k6, LT-01/LT-02) |

TLS for local development: `scripts/gen-dev-certs.sh` writes a self-signed cert into `certs/`
(git-ignored). The server binds HTTPS with `minVersion: 'TLSv1.2'` and refuses plain HTTP with
`403 HTTPS required`; Supertest exercises the Express app directly with transport enforcement
switched off by an explicit config flag that fails closed when `NODE_ENV=production`.

---

## 3. Waves

A wave is a dependency layer: wave *N* may assume waves *1…N-1* exist on disk. Within a wave, units
are file-disjoint and independently buildable — no unit's tests import a sibling's files.

### Wave 1 — Foundation (6 units)

| Unit | Title | Requirements | Owns |
|---|---|---|---|
| U1-CONFIG | Config + locale/AB 626 caps | NFR-13, FR-11, FR-12, NFR-12 | `src/config/{index,schema,locale}.js`, `.env.example`, `tests/unit/config.test.js` |
| U1-DB | Schema, migrations, DB/Redis clients, cache helper | NFR-02, NFR-13, NFR-11, NFR-01 | `db/migrations/0001_core_schema.sql`, `db/migrations/0002_indexes_constraints.sql`, `scripts/{migrate,seed}.js`, `src/db/{pool,tx,redis}.js`, `src/lib/cache.js`, `tests/unit/db.test.js` |
| U1-OBS | Logging, errors, correlation IDs, resilience + HTTP client | NFR-08, NFR-09 | `src/lib/{logger,errors,resilience,httpClient}.js`, `src/middleware/{requestContext,errorHandler}.js`, `tests/unit/observability.test.js` |
| U1-VALID | Input validation and sanitization layer | NFR-11, AB-06 | `src/middleware/validate.js`, `src/lib/sanitize.js`, `src/schemas/common.js`, `tests/unit/validation.test.js` |
| U1-HTTP | Express app, TLS/HTTPS enforcement, route registry | NFR-03, NFR-08, AB-05 | `src/app.js`, `src/server.js`, `src/middleware/security.js`, `src/routes/index.js`, `scripts/gen-dev-certs.sh`, `tests/unit/app.test.js` |
| U1-OUTBOX | Transactional outbox + worker skeleton | FR-13, NFR-09, NFR-08 | `db/migrations/0003_outbox.sql`, `src/outbox/{outbox,dispatch,worker}.js`, `scripts/worker.js`, `tests/unit/outbox.test.js` |

**U1-DB owns the whole SRS §3.4 schema** — `users`, `host_profiles`, `email_verification_tokens`,
`listings`, `bookings`, `reviews`, `messages`, `safety_alerts`, `moderation_decisions`,
`moderation_queue`, `notification_attempts`, `media_objects`, `data_requests`, `access_log` —
plus the invariants downstream units depend on: unique `users.email`; unique
`(host_id, local_date)` on non-cancelled listings (FR-11/AB-07); `CHECK (seats_remaining >= 0
AND seats_remaining <= seat_capacity)` (FR-12/FR-14); `CHECK (rating BETWEEN 1 AND 5)`;
moderation-status enums defaulting to `pending` for listings and reviews.
U1-OUTBOX owns its own migration (`outbox_jobs` with `type, payload jsonb, dedupe_key,
available_at, attempts, status, last_error`) so the two units never touch the same file.

### Wave 2 — Platform services and external adapters (5 units)

| Unit | Title | Requirements | Owns |
|---|---|---|---|
| U2-IDENTITY | Auth, sessions, login rate limiting, registration, email verification, profile | FR-10, NFR-04, NFR-05, NFR-06, AB-05, AB-07 | `src/modules/auth/{passwords,sessions,rateLimit,middleware,service,routes}.js`, `src/modules/users/{repo,service,tokens,routes}.js`, `tests/unit/identity.test.js` |
| U2-ELIGIBILITY | The single eligibility policy interface | FR-09, NFR-06 | `src/modules/eligibility/{policy,repo,middleware}.js`, `tests/unit/eligibility.test.js` |
| U2-ADAPTERS-COMMS | SendGrid + FCM adapters (timeout/retry/fallback) | FR-13, FR-07, NFR-09 | `src/adapters/{sendgrid,fcm}.js`, `tests/unit/adapters-comms.test.js` |
| U2-ADAPTER-MAPS | Google Maps/Places adapter + Redis geo/result cache | FR-01, NFR-01, NFR-09 | `src/adapters/maps.js`, `tests/unit/adapter-maps.test.js` |
| U2-MEDIA-LLM | Object-storage adapter (per-object delete) + LLM moderation adapter + media service | FR-02, FR-03, FR-05, FR-08, NFR-10, NFR-12 | `src/adapters/{objectStorage,llmModeration}.js`, `src/modules/media/{repo,service}.js`, `tests/unit/adapters-media-llm.test.js` |

Registration and login live in **one** unit because registration needs the password hasher and the
session issuer; splitting them would make one unit's tests depend on a concurrently-built sibling.
Adapters are pure library code with no Express routes — nothing here is reachable from a request
handler except through the worker (ADR-001).

### Wave 3 — Core marketplace (4 units)

| Unit | Title | Requirements | Owns |
|---|---|---|---|
| U3-LISTINGS | Listing create/update/cancel with MEHKO caps; meal detail | FR-11, FR-02, AB-01, AB-03, AB-07 | `src/modules/listings/{repo,rules,service,routes}.js`, `tests/unit/listings.test.js` |
| U3-SEARCH | Discovery by location/time/host/cuisine with Redis cache and degraded mode | FR-01, NFR-01, NFR-09 | `src/modules/search/{repo,service,routes}.js`, `tests/unit/search.test.js` |
| U3-HOSTS-MEDIA | Host profile page + media upload/delete API | FR-03, NFR-13, AB-08 | `src/modules/hosts/{repo,service,routes}.js`, `src/modules/media/routes.js`, `tests/unit/hosts-media.test.js` |
| U3-BOOKINGS | Atomic reservation, cancellation, completion lifecycle, notification enqueue | FR-12, FR-13, FR-14, FR-04, AB-02 | `src/modules/bookings/{repo,service,lifecycle,routes}.js`, `tests/unit/bookings.test.js` |

U3-BOOKINGS is the core loop (SPMP WA-3, never cut). It asserts the booking row and its outbox rows
commit in one transaction, that a rejected reservation leaves capacity untouched, and that no
adapter is called on the request path. `lifecycle.js` also owns the scheduled `pending → in progress`
transition at the listing's start time, run as a periodic worker job.

### Wave 4 — Trust, safety and data lifecycle (5 units)

| Unit | Title | Requirements | Owns |
|---|---|---|---|
| U4-REVIEWS-MESSAGING | Mutual reviews + booking-scoped messaging | FR-05, FR-06, AB-04 | `src/modules/reviews/{repo,service,routes}.js`, `src/modules/messaging/{repo,service,routes}.js`, `tests/unit/reviews-messaging.test.js` |
| U4-MODERATION | Two-stage pipeline, moderator queue, publication policy, IT-03 eval set | FR-08, NFR-10, AB-01, AB-03, AB-04 | `src/modules/moderation/{prefilter,pipeline,repo,service,routes}.js`, `src/outbox/handlers/moderationScan.js`, `tests/fixtures/moderation-eval/v1/*`, `tests/unit/moderation.test.js` |
| U4-SAFETY | Safety alerts with moderator notification and retried email delivery | FR-07 | `src/modules/safety/{repo,service,routes}.js`, `src/outbox/handlers/safetyAlert.js`, `tests/unit/safety.test.js` |
| U4-PRIVACY | Account deletion, media erasure by key, CCPA export, retention sweep | NFR-12, NFR-13, AB-08 | `src/modules/privacy/{repo,service,export,routes}.js`, `src/outbox/handlers/accountErasure.js`, `scripts/retention-sweep.js`, `tests/unit/privacy.test.js` |
| U4-NOTIFY | Worker dispatch paths for booking notifications and email verification | FR-13, NFR-08, NFR-09 | `src/outbox/handlers/{bookingNotification,emailVerification}.js`, `src/modules/notifications/{repo,service}.js`, `tests/unit/notifications.test.js` |

Producers (waves 2–3) assert that the outbox row is written; consumers (this wave) implement and
test delivery against mocked adapters. Each handler owns its own file inside
`src/outbox/handlers/`, so ownership stays exclusive while the dispatcher discovers them all.

### Wave 5 — Client foundation (3 units)

| Unit | Title | Requirements | Owns |
|---|---|---|---|
| U5-SHELL | Vite app, router with glob-based feature registry, layout, a11y baseline, test harness | NFR-07, SRS §2.1.2 | `client/package.json`, `client/vite.config.js`, `client/index.html`, `client/vitest.setup.js`, `client/src/{main.jsx,App.jsx,router.jsx}`, `client/src/styles/global.css`, `client/src/__tests__/app.test.jsx` |
| U5-API-AUTH | Typed API client, session/auth context, error + degraded-mode surfacing | NFR-03, NFR-09, AB-05 | `client/src/lib/{api.js,errors.js}`, `client/src/auth/{AuthProvider.jsx,useSession.js}`, `client/src/components/DegradedBanner.jsx`, `client/src/lib/__tests__/api.test.jsx` |
| U5-UI-KIT | Accessible primitives (form field, button, rating, gallery, pagination, skeleton) | NFR-07 | `client/src/components/ui/*.jsx`, `client/src/components/ui/__tests__/ui.test.jsx` |

### Wave 6 — Client features (4 units)

| Unit | Title | Requirements | Owns |
|---|---|---|---|
| U6-DISCOVERY | Search/browse, meal detail, host profile | FR-01, FR-02, FR-03, NFR-07, NFR-09 | `client/src/features/discovery/**` |
| U6-BOOKING | Reserve a seat, my bookings, cancel, dual completion confirmation | FR-12, FR-14, FR-04, FR-13, AB-02 | `client/src/features/booking/**` |
| U6-COMMUNITY | Reviews, booking chat, safety-alert trigger | FR-05, FR-06, FR-07, AB-04 | `client/src/features/community/**` |
| U6-ACCOUNT-MOD | Signup/verify/login, profile + host onboarding, data export/deletion, moderator queue | FR-10, FR-09, FR-08, NFR-06, NFR-12, NFR-13 | `client/src/features/account/**`, `client/src/features/moderation/**` |

Each feature directory contains its own `routes.jsx` exporting route objects, which the shell picks
up automatically.

---

## 4. Binding invariants every unit is checked against

1. **No inline adapter calls.** Request handlers may not import `src/adapters/*`. Only
   `src/outbox/handlers/*` and worker code may. (ADR-001/003; verified by the `adr-conformance` lane.)
2. **One transaction, no dual writes.** A business row and its outbox row commit together via
   `withTransaction`; the outbox payload carries IDs only, never names, emails or phone numbers.
3. **Pending until approved.** Listings and reviews default to `moderation_status='pending'` and are
   filtered out of every public read path. A moderation outage leaves them pending forever — it must
   never publish unreviewed content. Messages deliver immediately and are scanned asynchronously.
4. **One eligibility interface.** `canReserveSeat` / `canPublishListing` exist once, in
   `src/modules/eligibility/policy.js`. No module re-implements them.
5. **Media by key.** Listing/review/profile media live in object storage, referenced from PostgreSQL
   by key, deleted per-object during account erasure.
6. **Redis holds sessions and cache only.** No business state whose loss would change a booking,
   listing or moderation outcome.
7. **HTTPS/TLS 1.2+ only**, validation at the API boundary, no MFA / ID verification / payments.

---

## 5. Mapping to the SPMP work activities

| SPMP activity | Units |
|---|---|
| WA-1 Auth & eligibility | U2-IDENTITY, U2-ELIGIBILITY |
| WA-2 Discovery/listing + Maps | U3-LISTINGS, U3-SEARCH, U2-ADAPTER-MAPS |
| WA-3 Booking (outbox, atomic capacity) | U3-BOOKINGS, U1-OUTBOX |
| WA-4 Review & messaging | U4-REVIEWS-MESSAGING |
| WA-5 Safety alert | U4-SAFETY |
| WA-6 Data lifecycle | U4-PRIVACY |
| WA-7 Moderation integration | U4-MODERATION, U2-MEDIA-LLM (LLM adapter) |
| WA-8 Media storage adapter | U2-MEDIA-LLM, U3-HOSTS-MEDIA |
| WA-9 Web client | U5-*, U6-* |
| WA-10 Worker/outbox dispatcher + adapters | U1-OUTBOX, U2-ADAPTERS-COMMS, U4-NOTIFY |
| WA-11 Test suite vs SRS §4 | verification lanes (`tests/<lane>/`) |

---

## 6. Open questions for the team

Each is resolved here with the reading most faithful to the SRS. Items 2, 4, 5, 6 and 11 were
**decided by the team on 2026-08-12** and are now recorded as ADR-007 … ADR-011; the rest remain
provisional readings awaiting confirmation.

1. **React Native vs React web.** SPMP §5.2.1/§6.2 name React Native; SRS §2.1.2 mandates a single
   responsive React *web* app and states no native app ships in v1.0. **SRS wins — web only.**
   *Still open as a documentation defect: the SPMP should be corrected at CDR.*
2. ~~**AB 626 numeric caps are not in the SRS.**~~ **DECIDED — see [ADR-009](../../ADRs/#%20ADR-009%20MEHKO%20capacity%20limits.md).**
   Confirmed by the team as correct for California: 1 listing/host/day, 30 meals/day, 60 meals/week,
   day and week boundaries evaluated in `America/Los_Angeles`, enforced at one server-side point.
   Re-confirm at CDR before claiming regulatory compliance.
3. **Per-guest concurrent pending-booking limit (FR-12) has no stated value.** Default 3, configurable.
4. ~~**Notification channel.**~~ **DECIDED — see [ADR-011](../../ADRs/#%20ADR-011%20Notification%20channel.md).**
   Email via SendGrid is the v1.0 channel for FR-13, FR-14 and FR-07. The FCM adapter still ships but
   behind `notifications.push.enabled`, defaulting to false. Dev and the whole test suite use a mock
   transport that records NOTIFICATION_ATTEMPT rows rather than sending.
5. ~~**Moderation LLM provider is not free-tier.**~~ **DECIDED — see [ADR-007](../../ADRs/#%20ADR-007%20Moderation%20LLM%20provider.md).**
   Google Gemini's free tier is the configured provider, behind the existing provider-agnostic adapter.
   CI runs the mock; only the IT-03 measurement calls the live API.
   **Open action carried by ADR-007:** free tiers commonly permit provider use of submitted content,
   and the pipeline scans private messages (§3.4 PII register). Read Gemini's current free-tier data-use
   terms and record the finding in ST-06 *before* sending any real user content.
6. ~~**The >=200-item labelled evaluation set does not exist yet.**~~ **DECIDED — see [ADR-008](../../ADRs/#%20ADR-008%20Moderation%20evaluation%20set.md).**
   U4-MODERATION authors it as synthetic, balanced, versioned content under
   `tests/fixtures/moderation-eval/v1/`. **No NFR-10 pass may be claimed until a human reviews and
   signs off the labels**; the sign-off is recorded in the results file with the set and model versions.
7. **Encryption at rest (NFR-13).** Free-tier PostgreSQL offers no TDE. Plan: application-level
   AES-256-GCM for phone and emergency-contact columns with a key from the environment, plus a
   documented volume-encryption assumption for the rest. Confirm this satisfies ST-06.
8. **Backup expiry (NFR-12).** No managed backup service exists in the academic environment. Plan:
   `scripts/retention-sweep.js` plus a documented 30-day retention policy; ST-05 verifies it as
   configuration review, not as a live backup deletion.
9. **`pending → in progress` transition (FR-04/§3.4)** is not attached to a user action. Implemented
   as a periodic worker job at the listing's scheduled start (the outbox mechanism is event-driven;
   this is a scheduled sweep on the same worker process).
10. **Emergency contact is optional (§3.4).** If absent, FR-07 still persists the alert and notifies
    the moderator; delivery status is recorded as `no_channel` rather than failed.
11. ~~**Host address exposure.**~~ **DECIDED — see [ADR-010](../../ADRs/#%20ADR-010%20Host%20address%20disclosure.md).**
    Progressive disclosure: approximate area (coarsened coordinates, neighbourhood/city label) to
    everyone; exact street address only to a guest holding a `pending`/`in progress` booking on that
    listing, and to a moderator handling an FR-07 alert. The public serializer is the **default**, and
    the Redis cache stores public precision only, so a cache read cannot leak an exact location.
    Every public read path — search, listing detail, host profile, messaging, moderation views — must
    be asserted against the public shape by the `st-security` and `adr-conformance` lanes.
12. **NFR-01 at 200 concurrent users** cannot be honestly demonstrated on arbitrary laptop hardware.
    LT-01/LT-02 report measured numbers; a run that cannot reach 200 VUs is marked untestable with
    the achieved level, never reported as a pass.
13. **UT-01's 5-participant moderated usability study** is a human activity outside automation.
