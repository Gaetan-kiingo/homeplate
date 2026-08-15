---
output:
  pdf_document: default
  html_document: default
---
# Homeplate v1.0 — Build Plan

Derived from **SRS v3.2** (frozen baseline), **SPMP v1.0**, and **ADR-001…011**.
Companion artifact: `requirements-inventory.json` — all 14 FR + 13 NFR + 8 AB with executable
acceptance criteria (requirement rows unchanged since 2026-08-12; the `buildRun` block now
records the measured wave-0…3 state).

**Revision 2026-08-14 rev B.** Supersedes the 2026-08-14 rev A plan. What changed:

1. **Waves 0–3 are BUILT and independently re-verified** on a clean tree at commit `3136b91`:
   `npm test` → **45 suites / 943 tests, 0 failures, 94.3 s**; `npm run lint` clean
   (eslint + prettier); `npm run build` → 83 files parse, `createApp()` boots; stub scan 0 hits.
   This plan is therefore an **increment**, not a green-field build.
2. The seven carried-over wave-3 findings were **re-derived against the current tree**. Five are
   fixed on disk (IT3-F1 promote re-enqueue, ADRC-W3-01 wire serialization, IT3-F2/ADRC-W3-02
   lint, COV-W3-02 dead export, COV-W3-07 coverage ignore). Two residuals survive, and this pass
   found a third, higher-value one: the ADR-010 maps-cache auditor fails on the wave-3
   `{areas:[…]}` cache shape, which makes `npm run test:coverage` red and leaves that shape
   unaudited (§6.1). All three are scheduled as a named wave-4 unit (§4, U4-W3-RESIDUALS)
   rather than left in a report. See §6.
3. **Waves 4–7 are decomposed into buildable units with exclusive file ownership** (§4), which
   the previous revision carried only as a one-line roadmap. Wave 7 (measurement close-out) is
   new: IT-03, LT-01/02 under k6, ST-01/04 scans and UT-01 are work items, not by-products.

---

## 1. Stack (on disk, unchanged)

| Concern | Choice | Why |
|---|---|---|
| API | Node.js 20+ / Express 4, CommonJS, stateless REST over HTTPS/JSON | SRS §2.4 |
| Source of truth | PostgreSQL 16 via `pg`, parameterized SQL only | SRS §2.4, NFR-11 |
| Cache / sessions | Redis 7 via `ioredis` — sessions and read cache only | ADR-001/006 |
| Media | S3-compatible object storage (MinIO locally), referenced by key | ADR-004 |
| Deferred work | `outbox_jobs` table + in-process polling worker (`FOR UPDATE SKIP LOCKED`, retry/backoff/dead-letter) | ADR-001/003 |
| Validation | `zod` schemas via `src/middleware/validate.js` | NFR-11 |
| Moderation LLM | Provider-agnostic adapter, Gemini free tier configured, deterministic mock in CI | ADR-007 |
| Maps | Google Maps/Places adapter, Redis cache at public precision only | ADR-005, ADR-010 |
| Email / push | SendGrid channel; FCM behind `notifications.push.enabled=false`; mock transport in dev/test recording NOTIFICATION_ATTEMPT rows | ADR-011 |
| Client (waves 5–6) | React 18 + Vite SPA under `client/`, responsive, WCAG 2.1 AA | SRS §2.1.2, NFR-07 |
| Tests | Jest 29 + Supertest; k6 (LT), axe-core (UT-01), ZAP baseline (ST-04) | SRS §4 |
| Package manager / infra | npm; Docker Compose (PostgreSQL 5432, Redis 6379, MinIO 9000/9001) | SPMP §5.1.3, free tier |

### Directory layout (repo-relative; **bold** = not yet on disk)

```
db/migrations/            0001 core schema, 0002 indexes, 0003 outbox, 0004 bookings.completed_at,
                          **0005 privacy/lifecycle, 0006 moderation queue**
scripts/                  migrate.js, seed.js, worker.js, dev.js, check-build.js, gen-dev-certs.sh,
                          **it03-eval.js (IT-03 measurement runner)**
src/config/               env schema, fail-fast loader, locale/AB 626 caps (ADR-009)
src/db/                   pool, withTransaction, redis, fieldCrypto
src/lib/                  logger, errors, resilience, httpClient, cache, sanitize, geoPrecision,
                          mediaUrls
src/middleware/           requestContext, errorHandler, security, validate
src/routes/index.js       route registry (KNOWN_MODULES already names every wave-4 module)
src/adapters/             maps, sendgrid, fcm, llmModeration(+mock), objectStorage, mockTransport
src/outbox/               outbox, dispatch, worker; handlers/{emailVerification, listingGeocode,
                          bookingNotifications, bookingPromote}.js,
                          **handlers/{moderationScan, safetyAlert, accountErasure, dataExport}.js**
src/modules/              auth, users, eligibility, media, notifications            (waves 0–2)
                          listings, bookings, search, hosts                         (wave 3)
                          **reviews, messaging, moderation, safety, privacy**       (wave 4)
src/schemas/              auth, common, bookings, hosts, listings, media, search,
                          **reviews, messaging, moderation, safety, privacy**
client/                   **React SPA (waves 5–6)**
tests/                    unit · tc-core · tc-booking · it-adapters · st-security ·
                          rt-lt-resilience · adr-conformance · mt-ut-quality · coverage ·
                          **fixtures/moderation-eval/v1 (ADR-008)** · **a11y (UT-01)**
docs/_generated/          SRS.txt, SPMP.txt, build-plan.md, requirements-inventory.json
docs/                     verification-report.md
```

### Conventions that make parallel work safe (binding)

1. **One file, one unit.** No two units in the same wave list the same path. A unit that needs a
   neighbour's behaviour imports its published interface (§5), never edits its file.
2. **Modules are self-mounting.** `src/routes/index.js` mounts `src/modules/<name>/routes.js` for
   every name in `KNOWN_MODULES`; that list already contains `reviews`, `messaging`, `moderation`,
   `safety`, `privacy`, so no wave-4 unit edits the registry.
3. **Outbox handlers are self-registering.** `src/outbox/dispatch.js` discovers every
   `src/outbox/handlers/*.js` exporting `{ type, handle }`. New deferred work = a new file.
4. **Migrations are append-only.** Never edit an applied migration; add `000N_*.sql`.
5. **Job types are declared as strings, not imports,** when a producer and a consumer live in
   different units (wave 3 already enqueues `moderation.scan` this way).
6. **Every module cites its requirement IDs** (FR-/NFR-/AB-) in a file header comment, so
   Appendix-B traceability stays greppable.

---

## 2. Commands

| Purpose | Command |
|---|---|
| Infrastructure | `docker compose up -d` (PostgreSQL 5432, Redis 6379, MinIO 9000/9001) |
| Install | `npm ci` (client, from wave 5: `npm --prefix client ci`) |
| Migrate | `npm run migrate` (append-only SQL runner; `npm run seed` / `npm run seed:volume`) |
| Build | `npm run build` (syntax + boot check; from wave 5 also `npm --prefix client run build`) |
| Test | `npm test` (Jest, `maxWorkers=1`, advisory-lock serialised) · `npm run test:coverage` |
| Lint | `npm run lint` (`eslint . && prettier --check .`) · `npm run lint:fix` |
| Dev | `npm run dev` (HTTPS API + worker) · from wave 5 `npm --prefix client run dev` |
| Load / a11y | `npm run test:load` (k6) · `npm run test:a11y` (axe-core CLI) |
| Worker only | `npm run worker` |

Parallel test lanes: `npm test` takes the `homeplate_test_suite` pg advisory lock in
`tests/helpers/globalSetup.js`, so concurrent runs queue instead of corrupting each other. For
real isolation give each lane its own `TEST_DATABASE_URL`, `TEST_REDIS_URL` and
`OBJECT_STORAGE_BUCKET`.

---

## 3. Waves 0–3 — BUILT (verified 2026-08-14, commit `3136b91`)

| Wave | Units | Requirements now exercised by tests |
|---|---|---|
| 0 — Bootstrap | U0-BOOTSTRAP (toolchain, jest config, CI, docker compose, `.env.example`) | — (substrate) |
| 1 — Foundation | U1-CONFIG · U1-SCHEMA · U1-DB · U1-HTTP (errors/logging/validation/TLS) · U1-OUTBOX | NFR-03, NFR-08, NFR-11, ADR-001/003/009 |
| 2 — Platform services | U2-AUTH · U2-IDENTITY · U2-ELIGIBILITY · U2-ADAPTERS · U2-MEDIA | FR-09, FR-10, FR-13 (mechanism), NFR-04, NFR-05, NFR-06, NFR-09 |
| 3A — Marketplace write core | U3-LISTINGS · U3-BOOKINGS | FR-11, FR-12, FR-14, FR-04, FR-13 (end-to-end), AB-02, AB-03, AB-07 |
| 3B — Marketplace read surface | U3-SEARCH · U3-HOSTS-MEDIA | FR-01, FR-02, FR-03, AB-08, NFR-01/NFR-02 (measured), ADR-004/005/010 |

Evidence and per-requirement status: `docs/verification-report.md` (rev 2026-08-14).

---

## 4. Waves 4–7 — planned

### Wave 4 — Trust, safety, data lifecycle (6 units, all independently buildable)

Everything here may assume waves 0–3. No unit edits another's files; all five new modules mount
themselves through the existing registry, and all four new outbox handlers self-register.

| Unit | Goal | Requirements | Exclusive files |
|---|---|---|---|
| **U4-MODERATION** | The FR-08 pipeline: deterministic pre-filter → LLM stage via the provider-agnostic adapter → decision record → human Moderator queue; owns the `moderation.scan` handler and **requeues the wave-3 dead letters on landing**; authors the ADR-008 synthetic ≥200-item evaluation set | FR-08, NFR-10, AB-01, AB-03, AB-04, ADR-002/007/008 | `src/modules/moderation/{prefilter,repo,service,queue,routes}.js`, `src/schemas/moderation.js`, `src/outbox/handlers/moderationScan.js`, `db/migrations/0006_moderation_queue.sql`, `scripts/it03-eval.js`, `tests/fixtures/moderation-eval/v1/**`, `tests/unit/moderation.test.js`, `tests/tc-booking/tc08-moderation.test.js`, `tests/it-adapters/it03-moderation-eval.test.js` |
| **U4-REVIEWS** | FR-05 mutual reviews (rating + text + photos) on completed bookings only, born `pending`, published only after moderation; takes over the review-authorship lookup currently inline in the media routes | FR-05, FR-08 (consumer), AB-04, NFR-11, ADR-004 | `src/modules/reviews/{repo,service,routes}.js`, `src/schemas/reviews.js`, `src/modules/media/routes.js` (authorship SELECT → reviews repo), `tests/unit/reviews.test.js`, `tests/tc-core/tc05-reviews.test.js`, `tests/tc-core/tc05-07-wave4-status.test.js` (retire/split the wave-4 absence probe) |
| **U4-MESSAGING** | FR-06 host↔guest thread, opened only for a participant of a `pending`/`in_progress` booking; delivers immediately and enqueues an async scan | FR-06, FR-08 (async path), AB-04, NFR-11, NFR-13 | `src/modules/messaging/{repo,service,routes}.js`, `src/schemas/messaging.js`, `tests/unit/messaging.test.js`, `tests/tc-core/tc06-messaging.test.js` |
| **U4-SAFETY** | FR-07 safety alert: persist → notify moderator → attempt emergency-contact email through the worker, with retry and permanent visibility of failures | FR-07, FR-13, NFR-08, NFR-09, ADR-011 | `src/modules/safety/{repo,service,routes}.js`, `src/schemas/safety.js`, `src/outbox/handlers/safetyAlert.js`, `tests/unit/safety.test.js`, `tests/tc-core/tc07-safety.test.js`, `tests/it-adapters/it04-safety-delivery.test.js` |
| **U4-PRIVACY** | NFR-12 deletion/anonymisation within 30 days incl. media by key and backup expiry policy; NFR-13 CCPA export; 24-month inactivity sweep | NFR-12, NFR-13, AB-08, ADR-004 | `src/modules/privacy/{repo,service,routes}.js`, `src/schemas/privacy.js`, `src/outbox/handlers/{accountErasure,dataExport}.js`, `db/migrations/0005_privacy_lifecycle.sql`, `tests/unit/privacy.test.js`, `tests/st-security/st05-st06-privacy.test.js` |
| **U4-W3-RESIDUALS** | Close the three reproduced wave-3 residuals (§6.1–§6.3): the ADR-010 maps-cache auditor must unwrap the wave-3 `{areas:[…]}` cache shape (today it fails the run and leaves that shape unaudited), audit records must carry the LA calendar date as `YYYY-MM-DD`, and standalone lane scripts must take the suite advisory lock before touching the test database | ADR-010 (verification integrity), NFR-08 (MT-01), test-infrastructure integrity | `tests/adr-conformance/adr-invariants.test.js`, `src/modules/listings/service.js`, `tests/helpers/suiteLock.js`, `tests/rt-lt-resilience/lt01-run.js`, `tests/mt-ut-quality/mt01-listing-audit.test.js` |

**Wave-4 acceptance highlights** — pending-until-approved holds on every public read path;
messages deliver immediately and are scanned asynchronously; a moderation-provider outage leaves
public content pending forever and never publishes it; `POST /api/safety-alerts` returns before
any adapter is touched and the delivery attempt is a NOTIFICATION_ATTEMPT row; account deletion
erases PostgreSQL PII **and** the media objects by key, leaving reviews anonymised.

### Wave 5 — Client foundation (3 units)

| Unit | Goal | Requirements | Exclusive files |
|---|---|---|---|
| **U5-SHELL** | Vite + React 18 SPA skeleton: routing, layout, responsive breakpoints, error boundary, degraded-mode banner | SRS §2.1.2, NFR-09 | `client/{package.json,vite.config.js,index.html,.eslintrc.json}`, `client/src/{main.jsx,App.jsx,routes.jsx}`, `client/src/layout/**` |
| **U5-API-CLIENT** | One typed fetch layer: HTTPS-only base URL, session cookie handling, structured error mapping, retry/degraded surfaces | NFR-03, NFR-09, NFR-11 | `client/src/api/**`, `client/src/session/**`, `client/tests/api/**` |
| **U5-UI-KIT** | Accessible primitives (button, field, dialog, toast, pagination, map placeholder) with axe-clean markup, focus management and 4.5:1 contrast tokens | NFR-07 | `client/src/ui/**`, `client/src/styles/**`, `client/tests/a11y/ui-kit.test.jsx` |

### Wave 6 — Client features (4 units)

| Unit | Goal | Requirements | Exclusive files |
|---|---|---|---|
| **U6-DISCOVERY** | Search/browse with filters + map, listing detail (dish, ingredients, allergens, reviews, host summary), host profile page | FR-01, FR-02, FR-03, ADR-010 (never presents coarse coordinates as exact) | `client/src/features/discovery/**` |
| **U6-BOOKING** | Reserve a seat, my-bookings, cancel, dual completion confirmation, notification states | FR-04, FR-12, FR-13, FR-14 | `client/src/features/booking/**` |
| **U6-COMMUNITY** | Reviews with photos, booking-scoped messaging thread, safety-alert action | FR-05, FR-06, FR-07 | `client/src/features/community/**` |
| **U6-ACCOUNT-MOD** | Signup/verification/login, profile + host onboarding and agreement, eligibility messaging, privacy self-service (export/delete), moderator queue view | FR-09, FR-10, FR-08 (human review UI), NFR-12, NFR-13 | `client/src/features/account/**`, `client/src/features/moderation/**` |

### Wave 7 — Measurement and close-out (3 units)

| Unit | Goal | Requirements | Exclusive files |
|---|---|---|---|
| **U7-MODERATION-MEASURE** | Run IT-03 against the live Gemini free tier over the ADR-008 v1 set, record model id, prompt version, item counts, FP/FN rates **and the human label sign-off**; no pass claimed without it | NFR-10, ADR-007/008 | `docs/results/it03-*.md`, `tests/fixtures/moderation-eval/v1/RESULTS.md` |
| **U7-PERF-SEC** | LT-01/LT-02 under k6 at 200 VUs against NFR-02 volumes; ST-01 TLS scan; ST-04 ZAP baseline + targeted SQLi/XSS | NFR-01, NFR-02, NFR-03, NFR-11, AB-06 | `tests/load/{lt01.js,lt02.js}`, `docs/results/{lt,st}-*.md` |
| **U7-A11Y-UX** | UT-01: axe-core audit over key interfaces + 5-participant moderated usability study, findings triaged before CDR | NFR-07 | `client/tests/a11y/**`, `docs/results/ut01-*.md` |

---

## 5. Published interfaces later waves rely on

| Owner | Interface |
|---|---|
| U1-OUTBOX | `outbox.enqueue(client, {type, payload, dedupeKey, availableAt})` (IDs-only payloads enforced), `outbox.requeueDeadLetter(jobId)`; handler contract `{type, handle(payload, ctx)}` |
| U2-ELIGIBILITY | `policy.canReserveSeat / canPublishListing`, `requireEligibility(action)` middleware — the single policy interface (ADR-006) |
| U2-ADAPTERS | `maps`, `sendgrid`, `fcm`, `llmModeration(+mock)`, `objectStorage`, `mockTransport` — worker-only except the Maps read adapter (§6.4) |
| U3-LISTINGS | `serializers.publicListing/privilegedListing`, `access.canViewPreciseLocation`, `mehko.assertWithinCaps`, `repo.findById/findApprovedByHost`; job types `listing.geocode`, `moderation.scan` |
| U3-BOOKINGS | `repo.findParticipantBooking(bookingId, userId)` — the wave-4 gate for messaging, reviews and safety alerts; job types `notify.booking`, `booking.promote`; `lifecycle.enqueueBookingNotifications` |
| U3-HOSTS-MEDIA | `GET /api/hosts/:id`, `/reviews`; `POST /api/media/uploads`, `POST /api/media`, `DELETE /api/media/:id`; `mediaUrls.urlForKey/createUploadTarget` |
| U4-MODERATION | `service.submitForReview(contentType, contentId)`, decision writer, moderator queue routes — reviews/messaging depend on the **job-type string only** |

---

## 6. Decisions, residuals and open questions

Items 1–13 of the 2026-08-12 plan stand (2, 4, 5, 6, 11 decided as ADR-007…011). New or updated:

**6.1 NEW, confirmed — the ADR-010 maps-cache audit fails on the wave-3 cache shape, and
`npm run test:coverage` is red.** `tests/adr-conformance/adr-invariants.test.js:273` asserts every
`hp:cache:maps:*` value has exactly the keys `{areaLabel, lat, lng}`. Wave-3 location search
caches the Places result as the wrapper `{areas: [{lat, lng, areaLabel}, …]}` (`src/adapters/maps.js`
`liveSearchArea`/`mockSearchArea`), so the assertion receives `["areas"]` and fails. Deterministic
repro: `npx jest tests/unit/search.test.js tests/adr-conformance/adr-invariants.test.js` with the
search suite first (a custom sequencer, or simply `npx jest --coverage`, which reorders suites) →
**1 failed / 942 passed**. Plain `npm test` is green only because the default ordering happens to
run the auditor before any location search. Two consequences, both real: (a) the documented
`npm run test:coverage` command fails at `3136b91`; (b) the `{areas: […]}` entries are never
audited, which is exactly the "one forgotten read path" failure mode ADR-010 names — the values
*are* coarsened today (`coarsen()` is applied per area before caching, verified by reading
`liveSearchArea`), so this is a **verification gap, not a disclosure leak**. Fix: unwrap the
wrapper and assert public precision per element. Scheduled as U4-W3-RESIDUALS.

**6.2 Residual — audit records stringify a JS Date (reproduced).** `src/modules/listings/service.js`
logs `localDate: String(row.local_date)` on create/update/cancel. `node-postgres` returns a SQL
`DATE` as a JS `Date` at process-local midnight, so the NFR-08 record reads
`"Wed Aug 12 2026 00:00:00 GMT-0700 (…)"` instead of `2026-08-12`, and the rendered day shifts by
one on a server east of UTC. **The wire format is correct** — `serializers.isoCalendarDate` emits
`YYYY-MM-DD` — so this is a log-quality/MT-01 defect, not a client-visible one. Scheduled as
U4-W3-RESIDUALS.

**6.3 Residual — standalone lane scripts bypass the suite lock (reproduced).**
`tests/helpers/globalSetup.js` takes the `homeplate_test_suite` advisory lock, but
`tests/rt-lt-resilience/lt01-run.js` run from the CLI only loads `tests/helpers/env.js`, then
seeds volume data into the same `*_test` database. A CLI measurement run launched next to
`npm test` still corrupts both. Scheduled as U4-W3-RESIDUALS.

**6.4 Carried, not a defect — the review-authorship SELECT in `src/modules/media/routes.js`.**
One parameterized statement lives in the routes file because the reviews module does not exist
yet; the header documents it and U4-REVIEWS owns its removal. Listed so it is not re-discovered.

**6.5 Maps on the search request path.** Deferred-work adapters (SendGrid, FCM, LLM, object
storage) are worker-only without exception; the Maps **read** adapter is callable from the search
service via call-time require (ADR-005 puts it on the FR-01 read path by design, and NFR-09's
degraded mode is meaningless otherwise). App boot still loads no adapter. Team to ratify.

**6.6 `moderation.scan` dead-letters until wave 4.** Wave 3 enqueues the jobs transactionally;
with no handler the worker retries then dead-letters, so content **stays pending** — FR-08's
required failure direction. U4-MODERATION's acceptance includes requeueing those dead letters.

**Open questions for the team (none blocking):**

1. **Weekly MEHKO window anchor — DECIDE AT CDR, both readings still open.** ADR-009 fixes the
   weekly *number* (60 meals/host/week) and the boundary *timezone*, but no document fixes the
   **window the 60 is summed over**, and the SRS states no weekly cap at all. `mehko.js`
   (`weekRangeFor`) implements a **Monday-anchored LA calendar week**; a **rolling 7-day window**
   is the stricter alternative and is still on the table. The shipped reading is evadable across a
   week boundary — 30 seats on each of Sat/Sun of one week and Mon/Tue of the next puts 120 meals,
   twice the cap, into a single 7-day span (reproduced by
   `tests/tc-booking/tcb-w3-reverify.test.js`). Because of that, no AB 626 *weekly*-compliance
   claim may rest on a TC-11 pass today. The FR-11 weekly clause in
   `docs/_generated/requirements-inventory.json` is marked **PROVISIONAL** with a `specAmbiguity`
   block (it was silently rewritten from the rolling wording to the Monday wording inside build
   commit `3136b91`, i.e. the criterion was moved to fit the code — not a valid way to settle it),
   and ADR-009 carries a “Weekly window shape — OPEN, not ratified” section plus a **NOT DECIDED**
   Decision-table row. The team ratifies **one** reading at CDR; the decision is recorded in
   ADR-009 first, and the code, the inventory wording and the anchor-pinning tests follow it.
   Flagged, not silently changed, and not chosen by any agent.
2. **ADR-007 free-tier data-use terms** must be read and recorded under ST-06 *before* any real
   user content reaches Gemini; until then IT-03 runs on synthetic items only.
3. **ADR-008 human label sign-off** is a human act. No agent may record it, and no NFR-10 pass
   exists without it.
4. **ADR-009 cap values** are the team's reading of AB 626 and are due a documented CDR re-check.
5. **LT-01/LT-02 harness.** k6 is not installed on the build host; the recorded 200-VU run used a
   Node loopback VU loop. Numbers are evidence, not an NFR-01 pass, until U7-PERF-SEC re-runs
   under k6.
6. **ADR-007…011 ratification** is still recorded as pending team sign-off at a stand-up.

---

## 7. Mapping to the SPMP work activities

| SPMP activity | Status |
|---|---|
| WA-1 Auth & eligibility | built (wave 2), verified |
| WA-2 Discovery/listing + Maps | built (waves 2–3), verified |
| WA-3 Booking — the never-cut core loop (SPMP §5.3.2) | built (wave 3), verified |
| WA-8 Media storage | built (waves 2–3), verified |
| WA-10 Worker/dispatcher + adapters | built (wave 2 + wave-3 handlers), verified |
| WA-4 Reviews & messaging | wave 4 (U4-REVIEWS, U4-MESSAGING) |
| WA-5 Safety alert | wave 4 (U4-SAFETY) |
| WA-6 Data lifecycle | wave 4 (U4-PRIVACY) |
| WA-7 Moderation integration | wave 4 (U4-MODERATION) |
| WA-9 Web client — **responsive React web, not React Native** (SRS §2.1.2 wins over SPMP §5.2.1) | waves 5–6 |
| WA-11 Test suite vs SRS §4 | continuous; measurement close-out in wave 7 |

Per SPMP §5.2.2 this is Week 6–7 work with CDR (Aug 22) next; wave 4 is the CDR-critical
remainder, and waves 5–7 carry the Weeks 8–10 allocation.
