---
output:
  pdf_document: default
  html_document: default
---
# Homeplate v1.0 — Build Plan

Derived from **SRS v3.2** (frozen baseline), **SPMP v1.0**, and **ADR-001…011**.
Companion artifact: `requirements-inventory.json` (all 14 FR + 13 NFR + 8 AB with executable
acceptance criteria).

**Revision 2026-08-12.** Supersedes the 2026-08-11 plan. Two changes of substance:

1. ADR-007…011 are now recorded, so five items that were open questions are decided and folded into
   the acceptance criteria (moderation provider, evaluation set, MEHKO caps, address disclosure,
   notification channel).
2. **This build run implements waves 0–2 only** — repository bootstrap, foundation, and platform
   services / external adapters. Waves 3–6 (marketplace features, trust & safety, React client) are
   kept below as the roadmap but are explicitly **not built in this run**.

Repository state at planning time: **still green-field for application code**. `git ls-files` shows
only `ADRs/`, `Weekly Report/`, `.claude/workflows/homeplate-build.js` and `docs/_generated/`. There
is no `package.json`, `src/`, `client/`, migration or test file. Everything below is a new build.

---

## 1. Stack

| Concern | Choice | Why |
|---|---|---|
| Client (wave 5+, not this run) | React 18 + Vite, responsive single-page web app | SRS §2.1.2 (SPMP §5.2.1's "React Native" loses to the SRS) |
| API | Node.js 20+ / Express 4, stateless REST over HTTPS/JSON | SRS §2.4 fixed constraint |
| Language | JavaScript, CommonJS on the server (ESM in the client later) | No transpile step; Jest + Supertest work out of the box (SRS §4.1) |
| Source of truth | PostgreSQL 16 via `pg` connection pool, parameterized SQL only | SRS §2.4, NFR-11 |
| Cache / sessions | Redis 7 via `ioredis` — **sessions and read cache only** | SRS §2.4, ADR-001, ADR-006 |
| Media | S3-compatible object storage (MinIO locally) via `@aws-sdk/client-s3`, referenced by key | ADR-004 |
| Deferred work | PostgreSQL outbox table + in-process polling worker, per-service adapters | ADR-001 / ADR-003 |
| Validation | `zod` schemas at the API boundary + shared sanitizer | NFR-11, ADR-006 |
| Passwords | Argon2id via `@node-rs/argon2` (prebuilt binaries). Documented fallback: `bcryptjs` cost 12 if no prebuilt binary exists on the build host — record it as a deviation in the ST-02 notes | NFR-04 |
| Sessions | Opaque 256-bit token in an HttpOnly/Secure/SameSite=Lax cookie; session record in Redis with TTL | ADR-006 |
| Moderation LLM | Provider-agnostic HTTPS adapter (`LLM_MODERATION_BASE_URL`, `LLM_MODERATION_API_KEY`, `MODERATION_MODEL`); **Google Gemini free tier** is the configured provider, returning `{category, confidence}`. Model id pinned in config and recorded with IT-03 results. Deterministic mock in CI | **ADR-007**, ADR-002, FR-08 |
| Maps | Google Maps/Places Geocoding + Places behind one adapter, results cached in Redis at **public precision only** | ADR-005, **ADR-010** |
| Email / push | SendGrid (`@sendgrid/mail`) is the v1.0 channel; FCM (`firebase-admin`) ships behind `notifications.push.enabled = false`. Both worker-only, both mocked in dev and test | **ADR-011**, FR-13, FR-07 |
| Server tests | Jest 29 + Supertest against a seeded test database; k6 (load), axe-core (a11y), OWASP ZAP baseline (ST-04) | SRS §4 |
| Package manager | npm (Node 20+) | SPMP §5.1.3 free tier |
| Local infra | Docker Compose: PostgreSQL, Redis, MinIO | SPMP §5.1.3, ADR-004 |

### Directory layout

```
db/migrations/            numbered .sql migrations (source of truth for the §3.4 schema)
scripts/                  migrate.js, seed.js, worker.js, check-build.js, gen-dev-certs.sh
src/config/               env schema, fail-fast loader, locale/AB 626 caps (SRS §2.1.7, ADR-009)
src/db/                   pg pool, withTransaction, redis client, field-level encryption
src/lib/                  logger, errors, resilience, httpClient, cache, sanitize, geoPrecision
src/middleware/           requestContext, errorHandler, security (TLS/HSTS), validate
src/routes/               router registry that mounts src/modules/*/routes.js
src/adapters/             maps, sendgrid, fcm, llmModeration, objectStorage (worker-side only)
src/outbox/               outbox.enqueue, dispatch registry, worker; handlers/*.js
src/modules/              auth, users, eligibility, media, notifications        (waves 0-2)
                          listings, search, hosts, bookings, reviews, messaging,
                          moderation, safety, privacy                          (waves 3-4)
client/                   React + Vite responsive web app                       (waves 5-6)
tests/unit/               implementer-written unit/integration tests
tests/helpers/            shared test env, DB/Redis harness
tests/<lane>/             verifier lanes (tc-core, tc-booking, it-adapters, st-security,
                          rt-lt-resilience, mt-ut-quality, adr-conformance, coverage)
tests/fixtures/           seed data + the versioned >=200-item moderation eval set (IT-03)
docs/_generated/          this plan, the requirement inventory, extracted SRS/SPMP text
```

### Conventions that make parallel work safe

1. **File ownership is exclusive.** No two units in the same wave own the same path. A unit may
   *import* a sibling's module through the `publicInterface` declared for that sibling, but must
   never edit a file it does not own. Where a wave-mate's contract is needed before it exists
   (e.g. `src/config`), the contract in this document is the specification; the implementer codes
   against it.
2. **Route registry (`src/routes/index.js`, owned by U1-HTTP).** It resolves a known list of
   `src/modules/<name>/routes.js` paths, mounts each that exists, and logs a startup warning for
   each that does not. Real logic, no stub — later waves drop a router in and it is mounted with no
   edit to a shared file. After wave 2 the mounted set is auth + users only, and that is expected.
3. **Outbox handler discovery (`src/outbox/dispatch.js`, owned by U2-OUTBOX).** The dispatcher reads
   `src/outbox/handlers/*.js` at startup; each file exports `{ type, handle(payload, ctx) }`.
   Feature units own individual handler files, so no shared registry file is ever edited twice.
4. **Client route discovery (`client/src/App.jsx`, owned by U5-SHELL, wave 5).** Routes are collected
   with `import.meta.glob('./features/*/routes.jsx', { eager: true })`, valid with zero matches.

---

## 2. Commands

| Purpose | Command |
|---|---|
| install | `npm install` (client added in wave 5: `npm --prefix client install`) |
| infra | `docker compose up -d` (PostgreSQL 5432, Redis 6379, MinIO 9000/9001) |
| migrate | `npm run migrate` (applies `db/migrations/*.sql` in order, records them in `schema_migrations`) |
| seed | `npm run seed` / `npm run seed:volume` (NFR-02 scale, for LT-02) |
| build | `npm run build` → `node scripts/check-build.js`: loads and validates the env schema, parses every migration for ordering/duplicate version, syntax-checks every `src/**/*.js`, and boots the Express app factory when it exists. There is no transpile step for the CommonJS server; the client bundle joins this command in wave 5 |
| test | `npm test` (Jest over `tests/**`; `npm run test:unit` for the unit subset) |
| lint | `npm run lint` (ESLint + Prettier check over `src`, `scripts`, `tests`) |
| dev | `docker compose up -d && npm run dev` (API + outbox worker concurrently) |
| load | `npm run test:load` (k6, LT-01/LT-02 — meaningful from wave 3 on) |

TLS for local development: `scripts/gen-dev-certs.sh` writes a self-signed cert into `certs/`
(git-ignored). The server binds HTTPS with `minVersion: 'TLSv1.2'` and refuses plain HTTP with
`403 HTTPS required`; Supertest exercises the Express app directly with transport enforcement
switched off by an explicit config flag that fails closed when `NODE_ENV=production`.

---

## 3. Waves built in this run

A wave is a dependency layer: wave *N* may assume waves *1…N-1* exist on disk.

### Wave 0 — Repository bootstrap (1 unit)

| Unit | Title | Requirements | Owns |
|---|---|---|---|
| U0-BOOTSTRAP | npm project, Docker Compose infra, Jest/ESLint/CI, build check | NFR-02, NFR-08, NFR-11 (toolchain only) | `package.json`, `.nvmrc`, `.gitignore`, `docker-compose.yml`, `jest.config.js`, `.eslintrc.json`, `.eslintignore`, `.prettierrc`, `.github/workflows/ci.yml`, `scripts/check-build.js`, `tests/helpers/env.js`, `tests/unit/bootstrap.test.js`, `README.md` |

Split out of wave 1 because every other unit's tests need `package.json` and the Jest configuration
to exist before they can run — it is a hard ordering dependency, not a parallel peer. Jest is
configured **without** `passWithNoTests`, so an empty suite fails rather than passing vacuously.

### Wave 1 — Foundation (5 units)

| Unit | Title | Requirements | Owns |
|---|---|---|---|
| U1-CONFIG | Config module, env schema, locale/AB 626 caps | NFR-13, NFR-12, NFR-05, NFR-09, FR-11, FR-12, FR-13, FR-08 | `src/config/{index,schema,locale}.js`, `.env.example`, `tests/unit/config.test.js` |
| U1-DB | SRS §3.4 schema, migrations, pool/tx/Redis clients, field encryption, cache helper | NFR-02, NFR-13, NFR-11, NFR-01, NFR-12, FR-11, FR-12, AB-07 | `db/migrations/0001_core_schema.sql`, `db/migrations/0002_indexes_constraints.sql`, `scripts/{migrate,seed}.js`, `src/db/{pool,tx,redis,fieldCrypto}.js`, `src/lib/cache.js`, `tests/helpers/{db,redis}.js`, `tests/fixtures/seed/base.json`, `tests/unit/db.test.js` |
| U1-OBS | Structured logging, error taxonomy, correlation IDs, resilience + HTTP client | NFR-08, NFR-09 | `src/lib/{logger,errors,resilience,httpClient}.js`, `src/middleware/{requestContext,errorHandler}.js`, `tests/unit/observability.test.js` |
| U1-VALID | Input validation and sanitization layer | NFR-11, AB-06 | `src/middleware/validate.js`, `src/lib/sanitize.js`, `src/schemas/common.js`, `tests/unit/validation.test.js` |
| U1-HTTP | Express app factory, HTTPS/TLS enforcement, security headers, route registry | NFR-03, NFR-08, NFR-11, AB-05 | `src/app.js`, `src/server.js`, `src/middleware/security.js`, `src/routes/index.js`, `scripts/gen-dev-certs.sh`, `tests/unit/app.test.js` |

**U1-CONFIG is the only home for jurisdiction and policy numbers** (ADR-009, SRS §2.1.7): 1 listing
per host per day, 30 meals/host/day, 60 meals/host/week, day and week boundaries evaluated in
`America/Los_Angeles`; plus `booking.maxConcurrentPending = 3`, `privacy.erasureDays = 30`,
`privacy.inactivityMonths = 24`, `privacy.coarsenRadiusMeters`, `auth.loginMaxAttempts = 5` /
`auth.loginWindowSeconds = 600`, `adapters.timeoutMs = 3000`, `notifications.push.enabled = false`,
and the moderation provider variables. Loading is fail-fast: a missing required secret aborts start-up
rather than defaulting.

**U1-DB owns the whole SRS §3.4 schema** — `users`, `host_profiles`, `email_verification_tokens`,
`listings`, `bookings`, `reviews`, `messages`, `safety_alerts`, `moderation_decisions`,
`moderation_queue`, `notification_attempts`, `media_objects`, `data_requests`, `access_log` — plus
the invariants downstream units depend on: unique `users.email`; unique `(host_id, local_date)` on
non-cancelled listings (FR-11/AB-07); `CHECK (seats_remaining >= 0 AND seats_remaining <=
seat_capacity)` (FR-12/FR-14); `CHECK (rating BETWEEN 1 AND 5)`; moderation-status enums defaulting
to `pending` for listings and reviews. Tables whose services arrive in waves 3–4 are still created
now — the schema is one migration surface, and creating it once avoids a later unit editing an
earlier unit's migration.

### Wave 2 — Platform services and external adapters (6 units)

| Unit | Title | Requirements | Owns |
|---|---|---|---|
| U2-OUTBOX | Transactional outbox, dispatcher, worker with retry/backoff/dead-letter | FR-13, NFR-09, NFR-08 | `db/migrations/0003_outbox.sql`, `src/outbox/{outbox,dispatch,worker}.js`, `src/outbox/handlers/.gitkeep`, `scripts/worker.js`, `tests/unit/outbox.test.js` |
| U2-IDENTITY | Passwords, sessions, login rate limiting, registration, email verification, profile | FR-10, NFR-04, NFR-05, NFR-06, NFR-03, NFR-08, AB-05, AB-07 | `src/modules/auth/{passwords,sessions,rateLimit,middleware,service,routes}.js`, `src/modules/users/{repo,service,tokens,routes}.js`, `src/schemas/auth.js`, `src/outbox/handlers/emailVerification.js`, `tests/unit/identity.test.js` |
| U2-ELIGIBILITY | The single eligibility policy interface | FR-09, NFR-06, AB-01, AB-02, AB-08 | `src/modules/eligibility/{policy,repo,middleware}.js`, `tests/unit/eligibility.test.js` |
| U2-ADAPTERS-COMMS | SendGrid + FCM adapters, mock transport, notification-attempt recording | FR-13, FR-14, FR-07, NFR-09, NFR-08 | `src/adapters/{sendgrid,fcm,mockTransport}.js`, `src/modules/notifications/{transport,repo}.js`, `tests/unit/adapters-comms.test.js` |
| U2-ADAPTER-MAPS | Google Maps/Places adapter, Redis geo/result cache, coordinate coarsening | FR-01, NFR-01, NFR-09, NFR-13, AB-08 | `src/adapters/maps.js`, `src/lib/geoPrecision.js`, `tests/unit/adapter-maps.test.js` |
| U2-MEDIA-LLM | Object-storage adapter (per-object delete), media service, moderation LLM adapter + mock | FR-02, FR-03, FR-05, FR-08, NFR-09, NFR-10, NFR-12 | `src/adapters/{objectStorage,llmModeration,llmModeration.mock}.js`, `src/modules/media/{repo,service}.js`, `tests/unit/adapters-media-llm.test.js` |

Notes on the boundaries:

- **The outbox moved from wave 1 to wave 2.** Its tests need real PostgreSQL transaction and
  `FOR UPDATE SKIP LOCKED` semantics against the wave-1 pool and applied migrations, so it cannot be
  built in parallel with the unit that creates them.
- **Registration and login are one unit.** Registration needs the password hasher and the session
  issuer; splitting them would make one unit's tests depend on a concurrently-built sibling.
- **`src/outbox/handlers/emailVerification.js` belongs to U2-IDENTITY** rather than waiting for the
  wave-4 notification unit, so FR-10 is end-to-end after this run: register → outbox row → worker →
  recorded delivery attempt. It codes against the transport contract published by U2-ADAPTERS-COMMS.
- **Adapters are library code with no Express routes.** Nothing in `src/adapters/` is reachable from
  a request handler; only `src/outbox/handlers/*` and worker code may import them (ADR-001/003).
- **ADR-010 starts here, not in wave 3.** `src/lib/geoPrecision.js` produces the coarsened
  coordinates and area label, and the Maps adapter writes **only public precision** into Redis, so no
  later cache read can leak an exact location even if a serializer is forgotten.

### Public interfaces other units may rely on

| Unit | Contract |
|---|---|
| U1-CONFIG | `require('../config')` → frozen `config` object with the sections listed above; throws on invalid/missing env at load |
| U1-DB | `src/db/pool.js` → `{ query(text, params), getClient() }`; `src/db/tx.js` → `withTransaction(fn)` passing a client; `src/db/redis.js` → `{ redis, key(ns, ...parts) }`; `src/db/fieldCrypto.js` → `{ encrypt(plaintext), decrypt(ciphertext) }` (AES-256-GCM); `src/lib/cache.js` → `{ get, set, wrap(key, ttl, fn), del }` |
| U1-OBS | `logger.child({ correlationId })` with `.info/.warn/.error`; `AppError` subclasses carrying `status` + `code`; `withResilience(fn, { timeoutMs, retries, backoff, onFallback })`; `httpClient.request()` |
| U1-VALID | `validate({ body, query, params })` Express middleware returning 422 with field errors; `sanitize.text/html/identifier` |
| U1-HTTP | `createApp()` → configured Express app; route registry mounting `src/modules/*/routes.js` |
| U2-OUTBOX | `enqueue(client, { type, payload, dedupeKey, availableAt })` — **must be called with the same client as the business write**; handler shape `{ type, handle(payload, ctx) }` |
| U2-IDENTITY | `requireSession` middleware setting `req.auth = { userId, sessionId, roles }`; `authService.register/login/logout/verifyEmail` |
| U2-ELIGIBILITY | `policy.evaluate(userId, action)` → `{ allowed, reasons[] }`; `canReserveSeat(user)`, `canPublishListing(user)`; `requireEligibility(action)` middleware reading `req.auth.userId` |
| U2-ADAPTERS-COMMS | `transport.send({ userId, channel, template, params, idempotencyKey })` → records a NOTIFICATION_ATTEMPT row and returns `{ status }`; resolves to the mock in dev/test and honours `notifications.push.enabled` |
| U2-ADAPTER-MAPS | `geocode(address)`, `searchArea(query)`; `geoPrecision.coarsen(lat, lng)` → `{ lat, lng, areaLabel }` |
| U2-MEDIA-LLM | `objectStorage.put/get/deleteByKey(key)`; `mediaService.attach/list/deleteForUser(userId)`; `llmModeration.classify(text)` → `{ category, confidence, model }` |

---

## 4. Roadmap — waves 3–6 (NOT built in this run)

Retained from the 2026-08-11 plan so the team keeps the full picture; unchanged in content.

| Wave | Units |
|---|---|
| 3 — Core marketplace | U3-LISTINGS (FR-11, FR-02, AB-01/03/07) · U3-SEARCH (FR-01, NFR-01, NFR-09) · U3-HOSTS-MEDIA (FR-03, NFR-13, AB-08) · U3-BOOKINGS (FR-12, FR-13, FR-14, FR-04, AB-02) |
| 4 — Trust, safety, data lifecycle | U4-REVIEWS-MESSAGING (FR-05, FR-06, AB-04) · U4-MODERATION (FR-08, NFR-10, incl. the ADR-008 evaluation set) · U4-SAFETY (FR-07) · U4-PRIVACY (NFR-12, NFR-13) · U4-NOTIFY (FR-13 booking handlers) |
| 5 — Client foundation | U5-SHELL · U5-API-AUTH · U5-UI-KIT (NFR-07, SRS §2.1.2) |
| 6 — Client features | U6-DISCOVERY · U6-BOOKING · U6-COMMUNITY · U6-ACCOUNT-MOD |

U3-BOOKINGS is the core loop (SPMP WA-3, never cut per SPMP §5.3.2). `lifecycle.js` there owns the
scheduled `pending → in progress` transition, run as a periodic job on the wave-2 worker.

---

## 5. Binding invariants every unit is checked against

1. **No inline adapter calls.** Request handlers may not import `src/adapters/*`. Only
   `src/outbox/handlers/*` and worker code may (ADR-001/003; `adr-conformance` lane).
2. **One transaction, no dual writes.** A business row and its outbox row commit together via
   `withTransaction`; the outbox payload carries IDs only — never names, emails or phone numbers.
3. **Pending until approved.** Listings and reviews default to `moderation_status = 'pending'` and
   are filtered out of every public read path. A moderation outage leaves them pending forever; it
   must never publish unreviewed content. Messages deliver immediately and are scanned async.
4. **One eligibility interface.** `canReserveSeat` / `canPublishListing` exist once, in
   `src/modules/eligibility/policy.js`. No module re-implements them.
5. **One MEHKO enforcement point**, reading caps from `src/config`, evaluating day/week boundaries in
   `America/Los_Angeles` (ADR-009).
6. **Public serializer by default** (ADR-010). Exact address and precise coordinates only to a guest
   holding a `pending`/`in progress` booking on that listing, or a moderator handling an FR-07 alert
   (access-logged). Redis caches public precision only.
7. **Media by key.** Listing/review/profile media live in object storage, referenced from PostgreSQL
   by key, deleted per object during account erasure (ADR-004, NFR-12).
8. **Email is the channel; push is off** (ADR-011). Dev and the entire test suite use the mock
   transport and assert on persisted NOTIFICATION_ATTEMPT rows.
9. **Redis holds sessions and cache only.** No business state whose loss would change a booking,
   listing or moderation outcome.
10. **HTTPS/TLS 1.2+ only**, validation at the API boundary, no MFA / ID verification / payments.
11. **No secrets in code.** Every key comes from the environment and is documented in `.env.example`.

---

## 6. Verification expectations for this run

The lanes still run, but most FR-level lanes have nothing to exercise yet. Rules for this run:

- A check whose implementing code belongs to waves 3–6 is reported **`not_implemented`**, never
  skipped and never counted as a pass or a failure.
- The **`adr-conformance`** and **`coverage`** lanes are the primary signal at this stage. Conformance
  checks that are already meaningful after wave 2: no request-path import of `src/adapters/*`;
  outbox enqueue only inside `withTransaction`; outbox payloads free of PII; caps present in
  `src/config` and absent as inline literals in `src/`; `notifications.push.enabled` false by default;
  Redis cache values carrying no exact coordinates; no hardcoded provider/model/key in the LLM
  adapter; sessions/rate-limit state in Redis, business state in PostgreSQL.
- Requirements fully verifiable after wave 2: **FR-10, FR-13** (mechanism), **NFR-03, NFR-04, NFR-05,
  NFR-06, NFR-08, NFR-09** (adapter-level), **NFR-11, NFR-13** (field encryption, allowlists),
  **FR-09, AB-05, AB-06**.
- **NFR-10 cannot be claimed at all** until the ADR-008 evaluation set exists (wave 4) *and* a human
  has signed off its labels. **NFR-01/NFR-02** need wave-3 read paths before LT-01/LT-02 mean
  anything; a load run before then is not evidence.

---

## 7. Mapping to the SPMP work activities

| SPMP activity | Units (this run in bold) |
|---|---|
| WA-1 Auth & eligibility | **U2-IDENTITY, U2-ELIGIBILITY** |
| WA-2 Discovery/listing + Maps | **U2-ADAPTER-MAPS**, U3-LISTINGS, U3-SEARCH |
| WA-3 Booking (outbox, atomic capacity) | **U2-OUTBOX**, U3-BOOKINGS |
| WA-4 Review & messaging | U4-REVIEWS-MESSAGING |
| WA-5 Safety alert | U4-SAFETY |
| WA-6 Data lifecycle | U4-PRIVACY |
| WA-7 Moderation integration | **U2-MEDIA-LLM** (LLM adapter), U4-MODERATION |
| WA-8 Media storage adapter | **U2-MEDIA-LLM**, U3-HOSTS-MEDIA |
| WA-9 Web client | U5-*, U6-* |
| WA-10 Worker/outbox dispatcher + adapters | **U2-OUTBOX, U2-ADAPTERS-COMMS**, U4-NOTIFY |
| WA-11 Test suite vs SRS §4 | verification lanes (`tests/<lane>/`) |
| WA-12/13/14 Documentation, reviews, SPMP/SRS | team activities, outside this build |

Waves 0–2 cover the foundation of WA-1, WA-3 and WA-10 and the adapter halves of WA-2, WA-7, WA-8.
Per SPMP §5.2.2 that is Week 5–6 work; the schedule assumption is unchanged.

---

## 8. Open questions for the team

Items 2, 4, 5, 6 and 11 were **decided by the team on 2026-08-12** and are recorded as ADR-007…011.
The rest remain provisional readings — each is resolved here with the reading most faithful to the
SRS, and none blocks the build.

1. **React Native vs React web.** SPMP §5.2.1/§6.2 name React Native; SRS §2.1.2 mandates a single
   responsive React *web* app and states no native app ships in v1.0. **SRS wins — web only.** Still
   open as a documentation defect: the SPMP should be corrected at CDR.
2. ~~**AB 626 numeric caps are not in the SRS.**~~ **DECIDED — ADR-009.** 1 listing/host/day,
   30 meals/day, 60 meals/week, boundaries in `America/Los_Angeles`, one server-side enforcement
   point. Re-confirm at CDR before claiming regulatory compliance.
3. **Per-guest concurrent pending-booking limit (FR-12) has no stated value.** Default 3, configurable
   in `src/config`. Enforced from wave 3; the config key exists from wave 1.
4. ~~**Notification channel.**~~ **DECIDED — ADR-011.** Email via SendGrid for FR-13/FR-14/FR-07; FCM
   behind `notifications.push.enabled = false`; mock transport in dev and the whole test suite.
5. ~~**Moderation LLM provider is not free-tier.**~~ **DECIDED — ADR-007.** Google Gemini free tier
   behind the provider-agnostic adapter; CI runs the mock; only IT-03 calls the live API.
   **Open action carried by ADR-007:** free tiers commonly permit provider use of submitted content
   and the pipeline scans private messages (§3.4 PII register) — read the current free-tier data-use
   terms and record the finding in ST-06 *before* sending any real user content.
6. ~~**The >=200-item labelled evaluation set does not exist.**~~ **DECIDED — ADR-008.** U4-MODERATION
   authors it as synthetic, balanced, versioned content under `tests/fixtures/moderation-eval/v1/`.
   **No NFR-10 pass without a recorded human label sign-off.**
7. **Encryption at rest (NFR-13).** Free-tier PostgreSQL offers no TDE. Plan: application-level
   AES-256-GCM (`src/db/fieldCrypto.js`, U1-DB) for phone and emergency-contact columns with a key
   from the environment, plus a documented volume-encryption assumption for the rest. Confirm this
   satisfies ST-06.
8. **Backup expiry (NFR-12).** No managed backup service exists in the academic environment. Plan:
   a retention sweep script plus a documented 30-day policy; ST-05 verifies it as configuration
   review, not as a live backup deletion.
9. **`pending → in progress` (FR-04/§3.4)** is not attached to a user action. Implemented in wave 3 as
   a periodic job on the wave-2 worker at the listing's scheduled start.
10. **Emergency contact is optional (§3.4).** If absent, FR-07 still persists the alert and notifies
    the moderator; delivery status is recorded as `no_channel` rather than failed.
11. ~~**Host address exposure.**~~ **DECIDED — ADR-010.** Progressive disclosure, public serializer by
    default, public precision only in Redis.
12. **NFR-01 at 200 concurrent users** cannot be honestly demonstrated on arbitrary laptop hardware.
    LT-01/LT-02 report measured numbers; a run that cannot reach 200 VUs is marked untestable with
    the achieved level, never reported as a pass.
13. **UT-01's 5-participant moderated usability study** is a human activity outside automation.
14. **New — the ADRs are `Proposed`/single-decider.** ADR-001 and ADR-003…006 are still `Proposed`,
    and ADR-007…011 were decided by one member pending team ratification. The build treats all of
    them as binding; the team should ratify them at the next stand-up so the code and the record
    agree.
