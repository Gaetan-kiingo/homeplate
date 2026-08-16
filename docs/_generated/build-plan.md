---
output:
  pdf_document: default
  html_document: default
---
# Homeplate v1.0 — Build Plan

Derived from **SRS v3.2** (frozen baseline), **SPMP v1.0**, and **ADR-001…011**.
Companion artifact: `requirements-inventory.json` — all 14 FR + 13 NFR + 8 AB with executable
acceptance criteria, now carrying a per-requirement `statusAt_f7f954c` field.

**Revision 2026-08-15 rev C — the wave-3 CLOSE-OUT plan.** Supersedes rev B (2026-08-14).
What changed:

1. **Baseline moved to `f7f954c`** (clean tree). `3136b91` built wave 3; `f7f954c` is
   verification **repair round 1**. Fixer-measured gates: `npm test` → 60 suites / 1182 tests,
   91 s; `npm run lint` clean; `npm run build` clean.
2. **Nothing in repair round 1 has been independently re-verified.** Round 1 ran 8 lanes /
   264 checks and produced **40 findings** (3 blockers). Fixers claim **30 resolved**; that is a
   claim plus a green suite, and *the suite was green before those 40 findings were found* —
   including the FR-10 production blocker. Confirming those 30 is the primary work of this run
   and is scheduled as **wave 3R** (§4).
3. **Two things landed in `f7f954c` that are not wave-3 scope** and must be recorded as such:
   the FR-07 safety module (`src/modules/safety/**`, `src/outbox/handlers/safetyAlert.js`) and
   the ADR-008 evaluation set (`tests/fixtures/moderation-eval/v1/`, 224 synthetic items).
   Wave 4's unit definitions in §5 are adjusted accordingly.
4. **The 10 never-repaired findings are classified, not re-opened** (§6). Four are out of scope
   for this run by construction — two are wave-4 work, one is a spec question only the team may
   settle, one is a host prerequisite.

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
                          bookingNotifications, bookingPromote, safetyAlert}.js,
                          **handlers/{moderationScan, accountErasure, dataExport}.js**
src/modules/              auth, users, eligibility, media, notifications            (waves 0–2)
                          listings, bookings, search, hosts                         (wave 3)
                          safety                                    (pre-landed in repair round 1)
                          **reviews, messaging, moderation, privacy**               (wave 4)
src/schemas/              auth, common, bookings, hosts, listings, media, safety, search,
                          **reviews, messaging, moderation, privacy**
client/                   **React SPA (waves 5–6)**
tests/                    unit · tc-core · tc-booking · it-adapters · st-security ·
                          rt-lt-resilience · adr-conformance · mt-ut-quality · coverage ·
                          fixtures/moderation-eval/v1 (ADR-008, 224 items) · **a11y (UT-01)**
docs/_generated/          SRS.txt, SPMP.txt, build-plan.md, requirements-inventory.json,
                          verification-findings-wave3.json
docs/                     verification-report.md, wave3-verification-handoff.md,
                          adr007-data-use-review.md, **results/**
```

### Conventions that make parallel work safe (binding)

1. **One file, one unit.** No two units in the same wave list the same path. A unit that needs a
   neighbour's behaviour imports its published interface (§7), never edits its file.
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
7. **A verifier proves a claim by re-executing the original failure scenario**, in a NEW test file
   it owns, not by re-reading the fixer's test. A fix confirmed only by the test the fixer wrote
   is not confirmed.

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
| Load / a11y | `npm run test:load` (k6 — **not installed on this host**) · `npm run test:a11y` (fails on purpose until `client/` exists) |
| Security scan | `npm run scan:zap` (Docker OWASP ZAP baseline; never yet run) |
| Worker only | `npm run worker` |

**Parallel lanes.** `npm test` takes the `homeplate_test_suite` PostgreSQL advisory lock in
`tests/helpers/globalSetup.js`, so concurrent runs queue rather than corrupt each other. For real
isolation give each lane its own `TEST_DATABASE_URL` **and** `TEST_REDIS_URL` **and**
`OBJECT_STORAGE_BUCKET` — isolating only the database lets one lane's `FLUSHDB` wipe a sibling's
live sessions (finding RTLT-01; `tests/helpers/env.js` now derives the Redis index and bucket
from the database name, and `globalSetup` refuses to start when another lane holds them).
The full suite is ≈95 s; prefer scoped `npx jest <path>` runs while iterating.
After killing any run: `pkill -f "node_modules/.bin/jest"; pkill -f "homeplate/scripts/worker.js"`.

---

## 3. Waves 0–3 — BUILT

| Wave | Units | Requirements exercised |
|---|---|---|
| 0 — Bootstrap | U0-BOOTSTRAP (toolchain, jest config, CI, docker compose, `.env.example`) | — (substrate) |
| 1 — Foundation | U1-CONFIG · U1-SCHEMA · U1-DB · U1-HTTP (errors/logging/validation/TLS) · U1-OUTBOX | NFR-03, NFR-08, NFR-11, ADR-001/003/009 |
| 2 — Platform services | U2-AUTH · U2-IDENTITY · U2-ELIGIBILITY · U2-ADAPTERS · U2-MEDIA | FR-09, FR-10, FR-13 (mechanism), NFR-04, NFR-05, NFR-06, NFR-09 |
| 3A — Marketplace write core | U3-LISTINGS · U3-BOOKINGS | FR-04, FR-11, FR-12, FR-13, FR-14, AB-02, AB-03, AB-07 |
| 3B — Marketplace read surface | U3-SEARCH · U3-HOSTS-MEDIA | FR-01, FR-02, FR-03, AB-08, NFR-01/02 (measured, not k6), ADR-004/005/010 |

Status per requirement is in `requirements-inventory.json` (`statusAt_f7f954c`). Summary:
23 requirements `met_pending_reverify`, 7 `partial`, 5 `not_implemented`.

---

## 4. Wave 3R — CLOSE-OUT (this run). 9 units, exclusive file ownership

Everything here assumes waves 0–3. **No unit in this wave may implement wave 4.** A requirement
with no wave-3 implementing code is reported `not_implemented` — never as a pass, and never as a
reason to start building.

| Unit | Goal | Requirements | Exclusive files |
|---|---|---|---|
| **U3R-FR10-PROOF** *(highest priority)* | Prove FR-10 end to end **from the delivered email**: register → drain the outbox → read the ADR-011 mock transport's recorded delivery → extract the verification URL/token from *that* → verify → `email_verified=true` and `canReserveSeat` true. Also assert no persisted row/log carries the usable raw token (ADR-003), and that a retry/redelivery neither mints an unmailed credential nor invalidates a mailed link. If the original TCB-W3-01 scenario still reproduces, this unit owns the fix. | FR-10, NFR-06, ADR-003, ADR-011 | `tests/tc-booking/fr10-delivered-email-e2e.test.js`, `src/outbox/handlers/emailVerification.js`, `src/modules/auth/service.js`, `src/modules/notifications/transport.js` |
| **U3R-REVERIFY-CORE** | Re-execute the original failure scenarios of the claimed-fixed core-flow findings — TCC-01, TCC-02, TCC-03, TCC-05, TCB-W3-02, TCB-W3-03, TCB-W3-04, TCB-W3-06, TCB-W3-07 — in new files. Any claim that cannot be reproduced-as-fixed is reported as still open. | FR-01, FR-02, FR-03, FR-04, FR-11, FR-13, FR-14, NFR-08 | `tests/tc-core/w3r-core-reverify.test.js`, `tests/tc-booking/w3r-booking-reverify.test.js` |
| **U3R-REVERIFY-PLATFORM** | Same, for the platform/ADR findings — STS-W3-01, STS-W3-02, STS-W3-04, STS-W3-05, W3-ADR-01, W3-ADR-02, W3-ADR-05, IT-F2, IT-F3, IT-F4 — plus an independent confirmation of **W3-ADR-03** (maps-cache shape assertion order-independence), which was fixed in-lane and never re-checked. FR-07 (IT-F2) is re-verified as far as wave-3 allows: persist → worker → email attempt → retry/dead-letter; the moderator-queue clause is reported PARTIAL because that route is wave 4. | FR-07, NFR-03, NFR-04, NFR-09, NFR-11, NFR-13, AB-05, AB-06, ADR-001/002/007/010/011 | `tests/st-security/w3r-security-reverify.test.js`, `tests/adr-conformance/w3r-adr-reverify.test.js`, `tests/it-adapters/w3r-adapters-reverify.test.js` |
| **U3R-REVERIFY-OPS** | Same, for the ops/observability/coverage findings — RTLT-01, RTLT-03, MTUT-W3-01, MTUT-W3-02, MTUT-W3-03, COV-02, COV-03, COV-04, COV-05, COV-08. Also: identify the test leaking the handle behind the single `Jest did not exit` warning if it can be done cheaply, and report it. | NFR-01, NFR-02, NFR-08, NFR-09, ADR-003/005/010 | `tests/rt-lt-resilience/w3r-ops-reverify.test.js`, `tests/mt-ut-quality/w3r-observability-reverify.test.js`, `tests/coverage/w3r-coverage-reverify.test.js` |
| **U3R-FIX-CANARY** | **COV-01** — the AB-08 leak canary asserts `not.toContain('742')`, a bare street-number substring that matches by chance inside random UUIDs (~1 run in 100 reddens CI). Make the assertion address-shaped and deterministic without weakening what it detects. **Verify before changing**: the working tree already contains an address-shaped `\b742\s` form; if the original scenario no longer reproduces, confirm and report — do not churn. | AB-08, NFR-13, ADR-010 | `tests/st-security/st-security-wave3.test.js` |
| **U3R-FIX-FR02-REVIEWS** | **TCC-04** — FR-02 detail truncates the host's approved reviews to 5 with no total and no cursor, so a client cannot tell a 5-review host from a 500-review host and the rest are unreachable from that payload. Emit a total (and a documented paging route) so the preview is honestly labelled. Same rule: reproduce first — the tree shows a `reviewCount` + `GET /api/hosts/:id/reviews?page=N` shape that may already close it. | FR-02, FR-03, FR-05 (read side), NFR-01 | `src/modules/listings/service.js`, `src/modules/listings/serializers.js`, `src/modules/hosts/repo.js`, `src/modules/hosts/routes.js`, `src/modules/hosts/serializers.js`, `tests/tc-core/tc02-listing-detail.test.js` |
| **U3R-FIX-MEDIA-REPO** | **W3-ADR-04 + COV-07 (one defect)** — `src/modules/media/routes.js` runs its own `SELECT author_id FROM reviews WHERE id = $1`, putting DB access in the route layer. Move it behind `src/modules/media/repo.js` (the statement stays parameterized — NFR-11). The reviews module does not exist yet; that is *why* it lives in the media repo now, and U4-REVIEWS takes it over later. | NFR-11, ADR-001 | `src/modules/media/routes.js`, `src/modules/media/repo.js`, `tests/unit/hosts-media.test.js` |
| **U3R-COV-ADAPTERS** | **COV-06** — the two production notification adapters' delivery bodies are never executed (sendgrid.js 58 %, fcm.js 40 % statements), so the code that would run in a live send is unexercised. Cover them by injecting a fake client/transport seam. **Never make a live provider call** — ADR-011 keeps dev and the whole suite on the mock transport, and every attempt must still write a NOTIFICATION_ATTEMPT row. | FR-13, FR-07, NFR-09, ADR-011 | `src/adapters/sendgrid.js`, `src/adapters/fcm.js`, `tests/unit/adapters-comms.test.js` |
| **U3R-DEFERRED-EVIDENCE** | Turn the four out-of-scope open items into *evidence*, not assertions: executable absence proofs (structured-404 probes / module-absence checks) for **IT-F1** (NFR-10) and **STS-W3-03** (NFR-12 erasure, NFR-13 export); a written statement of **TCB-W3-05** as an ADR-009 open sub-decision awaiting CDR ratification, presenting *both* readings and choosing neither; and **RTLT-02** recorded untestable (k6 absent — do not vendor k6). | NFR-10, NFR-12, NFR-13, FR-08, FR-11 | `tests/coverage/w3r-deferred-classification.test.js`, `docs/results/wave3-closeout-open-items.md` |
| **U3R-REPORT** | Regenerate `docs/verification-report.md` for **waves 0–3** — the file on disk is a pre-repair draft and is overwritten, not amended. Must state per requirement: met (with the test that proves it), partial (with the missing clause), not implemented (with the absence proof), or unverifiable here (with why). Must carry the **FR-10 lesson** explicitly. Depends on every unit above. | all | `docs/verification-report.md`, `docs/_generated/verification-findings-wave3-round2.json`, `docs/wave3-verification-handoff.md` |

**Wave-3R acceptance (the wave is done when all of these hold):**

1. Every one of the 30 claimed-resolved findings has either a re-executed reproduction showing it
   no longer reproduces, or is reported **still open** with its scenario. No claim is accepted on
   a fixer's word.
2. FR-10 is proven from the delivered email, or FR-10 is reported **not met**. There is no third
   outcome.
3. `npm test`, `npm run lint`, `npm run build` all clean on a clean tree, and the suite's green
   state is stated as a *precondition*, never as evidence for any individual requirement.
4. The four out-of-scope items are classified with evidence and **no wave-4 code was written**.
5. `docs/verification-report.md` covers waves 0–3 and is accurate enough to hand a reviewer at CDR
   without a verbal correction.

---

## 5. Wave 4 — Trust, safety, data lifecycle (5 units)

Everything here may assume waves 0–3R. All modules mount themselves through the existing registry;
all outbox handlers self-register.

| Unit | Goal | Requirements | Exclusive files |
|---|---|---|---|
| **U4-MODERATION** | The FR-08 pipeline: deterministic pre-filter → LLM stage via the provider-agnostic adapter → MODERATION_DECISION record → human Moderator queue; owns the `moderation.scan` handler and **requeues the wave-3 dead letters on landing**. The ADR-008 set already exists (v1, 224 synthetic items), so this unit owns the *scoring harness and results file*, not the authoring. | FR-08, NFR-10, AB-01, AB-03, AB-04, ADR-002/007/008 | `src/modules/moderation/{prefilter,repo,service,queue,routes}.js`, `src/schemas/moderation.js`, `src/outbox/handlers/moderationScan.js`, `db/migrations/0006_moderation_queue.sql`, `scripts/it03-eval.js`, `tests/unit/moderation.test.js`, `tests/tc-booking/tc08-moderation.test.js`, `tests/it-adapters/it03-moderation-eval.test.js` |
| **U4-REVIEWS** | FR-05 mutual reviews (rating + text + photos) on completed bookings only, born `pending`, published only after moderation; takes over the review-authorship lookup from the media repo | FR-05, FR-08 (consumer), AB-04, NFR-11, ADR-004 | `src/modules/reviews/{repo,service,routes}.js`, `src/schemas/reviews.js`, `tests/unit/reviews.test.js`, `tests/tc-core/tc05-reviews.test.js` |
| **U4-MESSAGING** | FR-06 host↔guest thread, opened only for a participant of a `pending`/`in_progress` booking; delivers immediately and enqueues an async scan | FR-06, FR-08 (async path), AB-04, NFR-11, NFR-13 | `src/modules/messaging/{repo,service,routes}.js`, `src/schemas/messaging.js`, `tests/unit/messaging.test.js`, `tests/tc-core/tc06-messaging.test.js` |
| **U4-SAFETY-COMPLETE** | FR-07 finish: the module landed early in `f7f954c`; this unit wires the moderator-queue entry to the real U4-MODERATION queue and closes IT-04's remaining clauses (alert visible in `GET /api/moderation/alerts`, dead-lettered alerts still visible) | FR-07, FR-13, NFR-08, NFR-09, ADR-011 | `src/modules/safety/{repo,service,routes}.js`, `src/schemas/safety.js`, `src/outbox/handlers/safetyAlert.js`, `tests/unit/safety.test.js`, `tests/tc-core/tc07-safety.test.js`, `tests/it-adapters/it04-safety-delivery.test.js` |
| **U4-PRIVACY** | NFR-12 deletion/anonymisation within 30 days incl. media by key and backup expiry policy; NFR-13 CCPA export; 24-month inactivity sweep. Closes STS-W3-03. | NFR-12, NFR-13, AB-08, ADR-004 | `src/modules/privacy/{repo,service,routes}.js`, `src/schemas/privacy.js`, `src/outbox/handlers/{accountErasure,dataExport}.js`, `db/migrations/0005_privacy_lifecycle.sql`, `tests/unit/privacy.test.js`, `tests/st-security/st05-st06-privacy.test.js` |

**Wave-4 acceptance highlights** — pending-until-approved holds on every public read path;
messages deliver immediately and are scanned asynchronously; a moderation-provider outage leaves
public content pending forever and never publishes it; account deletion erases PostgreSQL PII
**and** the media objects by key, leaving reviews anonymised. Per the ADR-007 data-use review, the
live provider receives **synthetic content only** until the team signs that review off.

## 6. Waves 5–7

| Wave | Units |
|---|---|
| 5 — Client foundation | **U5-SHELL** (`client/{package.json,vite.config.js,index.html}`, `client/src/{main,App,routes}.jsx`, `client/src/layout/**`) · **U5-API-CLIENT** (`client/src/api/**`, `client/src/session/**`) · **U5-UI-KIT** (`client/src/ui/**`, `client/src/styles/**`) |
| 6 — Client features | **U6-DISCOVERY** (`client/src/features/discovery/**`, FR-01/02/03) · **U6-BOOKING** (`client/src/features/booking/**`, FR-04/12/13/14) · **U6-COMMUNITY** (`client/src/features/community/**`, FR-05/06/07) · **U6-ACCOUNT-MOD** (`client/src/features/{account,moderation}/**`, FR-08/09/10, NFR-12/13) |
| 7 — Measurement close-out | **U7-MODERATION-MEASURE** (IT-03 live run + **human label sign-off**, `tests/fixtures/moderation-eval/v1/RESULTS.md`) · **U7-PERF-SEC** (LT-01/02 under k6, ST-01 TLS scan, ST-04 ZAP baseline, `tests/load/{lt01,lt02}.js`, `docs/results/**`) · **U7-A11Y-UX** (axe-core + 5-participant study, `client/tests/a11y/**`) |

Wave 7 exists because IT-03, LT-01/02 under k6, the ZAP baseline and UT-01 are **work items with
host prerequisites**, not by-products of writing code. None of them can be closed by an agent
alone: two need software installed on the host, one needs a human sign-off, one needs five human
participants.

---

## 7. Published interfaces later waves rely on

| Owner | Interface |
|---|---|
| U1-OUTBOX | `outbox.enqueue(client, {type, payload, dedupeKey, availableAt})` (IDs-only payloads enforced), `outbox.requeueDeadLetter(jobId)`; handler contract `{type, handle(payload, ctx)}` |
| U2-ELIGIBILITY | `policy.canReserveSeat / canPublishListing`, `requireEligibility(action)` middleware — the single policy interface (ADR-006) |
| U2-ADAPTERS | `maps`, `sendgrid`, `fcm`, `llmModeration(+mock)`, `objectStorage`, `mockTransport` — worker-only except the Maps read adapter (§8.4) |
| U2-IDENTITY | `authService.createVerificationLink(userId)` — mints the **mailable** FR-10 link worker-side; the outbox payload stays IDs/digest-only (ADR-003) |
| U3-LISTINGS | `serializers.publicListing/privilegedListing`, `access.canViewPreciseLocation`, `mehko.assertWithinCaps`, `repo.findById/findApprovedByHost`; job types `listing.geocode`, `moderation.scan` |
| U3-BOOKINGS | `repo.findParticipantBooking(bookingId, userId)` — the wave-4 gate for messaging, reviews and safety alerts; job types `notify.booking`, `booking.promote`; `lifecycle.enqueueBookingNotifications` |
| U3-HOSTS-MEDIA | `GET /api/hosts/:id`, `/reviews`; `POST /api/media/uploads`, `POST /api/media`, `DELETE /api/media/:id`; `mediaUrls.urlForKey/createUploadTarget` |
| U3-SAFETY (pre-landed) | `POST /api/bookings/:id/safety-alerts`; job type `safety.alert` |
| U4-MODERATION | `service.submitForReview(contentType, contentId)`, decision writer, moderator queue routes — reviews/messaging depend on the **job-type string only** |

---

## 8. Open items, residuals and questions

### 8.1 The four items this run classifies but does NOT fix

| Finding | Requirement | Classification | Why it is not actioned here |
|---|---|---|---|
| **IT-F1** | NFR-10 | **wave 4** — report `not_implemented` with evidence | The eval set exists, but there is no pre-filter, no LLM stage, no `moderation.scan` handler and no results file. Scoring the set through the ADR-007 *mock* is not a measurement: the mock is a fixture-pattern matcher that scores unseen abusive text as benign at 0.99. **No FP/FN number may be quoted.** |
| **STS-W3-03** | NFR-12, NFR-13 | **wave 4** — report `not_implemented` with evidence | No deletion endpoint, no erasure job, no backup-expiry config, no CCPA export. Building it is U4-PRIVACY, not wave-3 close-out. |
| **TCB-W3-05** | FR-11 | **human ratification at CDR** | The weekly MEHKO window *shape* was never decided: ADR-009 fixes the number (60) and the timezone; the SRS states no weekly cap at all. `mehko.js` implements a Monday-anchored LA calendar week, under which 30-seat listings on Sat/Sun then Mon/Tue put **120 meals into one 7-day span**. A rolling 7-day window is the stricter alternative. **No agent picks a reading.** Present both; the team ratifies one in ADR-009, then code, inventory wording and the anchor-pinning tests follow. |
| **RTLT-02** | NFR-01, NFR-02 | **host prerequisite — untestable here** | k6 is not installed. Do not vendor it. The recorded 200-VU run (p95 253.7 ms over 791,709 requests, 0 errors, against NFR-02 volumes) is **evidence, not a pass**, because the instrument the criterion names was not the instrument used. |

### 8.2 Carried decisions (unchanged)

- **8.2.1 Maps on the search request path.** Deferred-work adapters (SendGrid, FCM, LLM, object
  storage) are worker-only without exception; the Maps **read** adapter is callable from the search
  service via call-time require — ADR-005 puts it on the FR-01 read path by design, and NFR-09's
  degraded mode is meaningless otherwise. App boot still loads no adapter. Team to ratify.
- **8.2.2 `moderation.scan` dead-letters until wave 4.** Wave 3 enqueues the jobs transactionally;
  with no handler the worker retries then dead-letters, so content **stays pending** — FR-08's
  required failure direction. U4-MODERATION's acceptance includes requeueing those dead letters.
- **8.2.3 The review-authorship SELECT** in `src/modules/media/routes.js` is now scheduled
  (U3R-FIX-MEDIA-REPO) rather than carried, and U4-REVIEWS takes it over afterwards.

### 8.3 Open questions for the team (none blocking)

1. **Weekly MEHKO window anchor — DECIDE AT CDR, both readings still open.** See §8.1. The FR-11
   weekly clause in `requirements-inventory.json` is marked **PROVISIONAL** with a `specAmbiguity`
   block; ADR-009 carries a "Weekly window shape — OPEN, not ratified" section and a **NOT
   DECIDED** Decision-table row. Note for the record that the FR-11 acceptance text was once
   rewritten *inside build commit `3136b91`* from the rolling wording to the Monday wording —
   moving the criterion to fit the code is not a valid way to settle a spec question.
2. **ADR-007 free-tier data-use terms** are read and recorded (`docs/adr007-data-use-review.md`),
   but the sign-off block is **unsigned**. Until a human signs it, the conservative default
   governs: synthetic content only to the live provider.
3. **ADR-008 human label sign-off** is a human act. No agent may record it, and no NFR-10 pass
   exists without it — the set being present changes nothing about that.
4. **ADR-009 cap values** are the team's reading of AB 626 and are due a documented CDR re-check.
5. **k6, ZAP and axe** are host prerequisites. `npm run test:load` needs k6; `npm run scan:zap`
   needs Docker and a running dev server; `npm run test:a11y` fails on purpose until `client/`
   exists. All three are wave-7 work items with owners, not silent gaps.
6. **ADR-007…011 ratification** is still recorded as pending team sign-off at a stand-up.

### 8.4 The FR-10 lesson (carry it into the report)

Waves 1–2 reported FR-10 as **PASS**. The delivered email carried only the token's SHA-256 digest,
so no real user could ever verify an email — and therefore no real user could ever become eligible
to book or publish. The suite was green throughout, because the tests took the token from the
**in-process return value** instead of from the **delivered message**. The general rule this run
adopts: *verify a user-facing outcome at the boundary the user actually observes.* A test that
observes an internal value proves the internal value, nothing more.

---

## 9. Mapping to the SPMP work activities

| SPMP activity | Status |
|---|---|
| WA-1 Auth & eligibility | built (wave 2); re-verification in U3R-REVERIFY-PLATFORM / U3R-FR10-PROOF |
| WA-2 Discovery/listing + Maps | built (waves 2–3); re-verification in U3R-REVERIFY-CORE |
| WA-3 Booking — the never-cut core loop (SPMP §5.3.2) | built (wave 3); re-verification in U3R-REVERIFY-CORE |
| WA-5 Safety alert | pre-landed in `f7f954c`; completed by U4-SAFETY-COMPLETE |
| WA-8 Media storage | built (waves 2–3); U3R-FIX-MEDIA-REPO closes the last route-layer SQL |
| WA-10 Worker/dispatcher + adapters | built; U3R-COV-ADAPTERS closes the untested delivery bodies |
| WA-4 Reviews & messaging | wave 4 (U4-REVIEWS, U4-MESSAGING) |
| WA-6 Data lifecycle | wave 4 (U4-PRIVACY) |
| WA-7 Moderation integration | wave 4 (U4-MODERATION) |
| WA-9 Web client — **responsive React web, not React Native** (SRS §2.1.2 wins over SPMP §5.2.1) | waves 5–6 |
| WA-11 Test suite vs SRS §4 | continuous; wave 3R is its close-out for waves 0–3; measurement close-out in wave 7 |

Per SPMP §5.2.2 this is Week 6–7 work with **CDR on Aug 22** next. Wave 3R produces the CDR
evidence; wave 4 is the CDR-critical remainder.
