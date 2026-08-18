---
output:
  pdf_document: default
  html_document: default
---
# Homeplate v1.0 — Build Plan

Derived from **SRS v3.2** (frozen baseline), **SPMP v1.0**, and **ADR-001…011**.
Companion artifact: `requirements-inventory.json` — all 14 FR + 13 NFR + 8 AB with executable
acceptance criteria, now carrying per-requirement `statusAt_f7f954c`, `statusAt_bc27199` and
`reverification` fields.

**Revision 2026-08-17 rev D — wave-3 CLOSE-OUT, determinism first.** Supersedes rev C
(2026-08-15), which is otherwise intact below. What changed:

1. **THE SUITE IS NONDETERMINISTIC, and that outranks everything else in this run.** Measured on
   unchanged code: full-suite run A = **5 failures**, run B = **1182/1182 pass**, and the same
   failing files pass **130/130 in 4.5 s** when run alone. Separately, jest **does not exit** after
   printing results (leaked handle), so every automated invocation looks hung — one run was killed
   at 8 m 20 s although the tests had finished in 91 s. A nondeterministic suite makes every other
   pass claim in this repository worthless, so wave **3R-0** (§4) now runs *before* any
   re-verification, and no unit downstream may report a pass until 3R-0's gate holds.
   Note for whoever fixes it: the hypothesis "jest runs 60 suites in parallel workers" does **not**
   survive contact with `jest.config.js`, which pins `maxWorkers: 1`. The mechanisms that do
   survive are (a) assertions over **global** state — a whole-table `SELECT` (e.g.
   `verify-adr-wave0-3.test.js:379`) or a whole-table row count (`st-security-verify.test.js:472`)
   — which see rows written by *earlier suites in the same run*, since the schema is reset once in
   `globalSetup` and never between suites; and (b) work that **outlives** the suite that started it
   (an unawaited request, a worker tick, an open pool or Redis client) mutating shared state during
   a later suite — which is very likely the same leak that keeps the process alive at the end.
   Confirm (b) with `--detectOpenHandles` before choosing a fix.
   **Re-measured by this coordinator on 2026-08-17 at `bc27199` — see §8.5.1 for the full table.**
   Two consecutive runs on one isolated lane failed *differently*: run 1 on the FR-12 40-concurrent
   probe (`refused` = 36, not 37 — one response was neither 201 nor 409 and its status was
   discarded), run 2 on TC-14 booking cancel with **`read ECONNRESET`**, a sixth mode not in the
   handoff's list of five. Both hung after printing results and had to be killed (`exit=143`).
   So the picture is worse than "run A vs run B": three different pictures of one commit now exist,
   and `.github/workflows/ci.yml` has no step timeout, so a push today hangs a runner for 6 hours.
2. **Baseline is `bc27199`** (clean tree; `.gitignore` modified only). `3136b91` built wave 3,
   `f7f954c` is verification repair round 1, `bc27199` added docs/tests only.
3. **CI has never run wave 3.** `origin/main` still ends at `af1a91a` (waves 0–2). Nothing is
   pushed until the suite is deterministic and exits on its own — that is unit **W3-CI-PUSH**.
4. **Nothing in repair round 1 has been independently re-verified.** Round 1 ran 8 lanes /
   264 checks and produced **40 findings** (3 blockers). Fixers claim **30 resolved**; that is a
   claim plus a green suite, and *the suite was green before those 40 findings were found* —
   including the FR-10 production blocker. Confirming those 30 is wave **3R-1**.
5. **Two things landed in `f7f954c` that are not wave-3 scope** and must be recorded as such:
   the FR-07 safety module (`src/modules/safety/**`, `src/outbox/handlers/safetyAlert.js`) and
   the ADR-008 evaluation set (`tests/fixtures/moderation-eval/v1/`, 224 synthetic items).
6. **The 10 never-repaired findings are classified, not re-opened** (§8.1). Four are out of scope
   for this run by construction — two are wave-4 work, one is a spec question only the team may
   settle, one is a host prerequisite. **COV-01 appears already fixed on disk** (the canary is now
   leaf-scoped in `tests/st-security/st-security-wave3.test.js`); it is therefore a
   confirm-or-reopen item, not a build item.

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
| Determinism gate (3R-0) | `for i in 1 2 3 4 5; do npm test 2>&1 \| tail -25; done` on ONE isolated lane — 5 identical results, each exiting on its own |
| Open-handle hunt | `npx jest <path> --detectOpenHandles` (never `--forceExit`: it hides the leak instead of closing it) |

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

## 4. Wave 3R — CLOSE-OUT (this run). 4 ordered sub-waves, 17 units, exclusive file ownership

Everything here assumes waves 0–3. **No unit in this wave may implement wave 4.** A requirement
with no wave-3 implementing code is reported `not_implemented` — never as a pass, and never as a
reason to start building. Sub-waves are strictly ordered: 3R-0 → gate → 3R-1 → 3R-2 → 3R-3.
Units inside one sub-wave share no file and may run in parallel.

**Ownership check (coordinator, 2026-08-17).** Every file path below was extracted and diffed for
collisions. Within any single sub-wave there is **no** shared path. Four paths are claimed by two
units in *different, strictly ordered* sub-waves, which is safe and intentional — the later unit
inherits the earlier one's tree: `src/adapters/sendgrid.js` and `src/adapters/fcm.js`
(3R-1 W3-RV-BOOKING → 3R-2 W3-COV-ADAPTERS), `src/modules/listings/service.js`
(3R-1 W3-RV-OBS-SAFETY → 3R-2 W3-FIX-REVIEWPAGE) and `src/outbox/handlers/safetyAlert.js`
(3R-1 W3-RV-OBS-SAFETY → wave 4 U4-SAFETY-COMPLETE). No unit may start before its predecessor
sub-wave has reported.

### 4.1 Wave 3R-0 — Suite determinism and clean exit (PRIORITY 0; blocks everything)

The binding rule for all four units: **fix the cause.** Scope each assertion to the rows and keys
the test itself created, or make a globally-scanning test run exclusively; close the leaked handle.
Deleting or weakening an assertion is not a fix, and neither is a retry, a `sleep`, a longer
timeout or a `--runInBand` workaround that hides the shared-state bug instead of removing it.

**Coordinator correction to the diagnosis, measured 2026-08-17 (binding on these units).**
The suite does **not** run suites in parallel workers: `jest.config.js` has carried
`maxWorkers: 1` since `3136b91` (verified with `git show 3136b91:jest.config.js`), so all 60
suites execute serially in one worker against the one lane database. The shared-state bleed is
therefore **serial accumulation**, not concurrency: `globalSetup` resets the schema exactly once
per run, so by the time a late suite runs a whole-table `SELECT`, the table holds every row that
every earlier suite wrote. What varies between runs is the **suite order** — Jest orders test files
by its cached per-file timings, so run B can execute the same files in a different sequence from
run A and a global-scan assertion then observes a different population. That is sufficient to
explain intermittent failures on unchanged code without any parallelism. Two consequences:
(a) do **not** "fix" this by pinning `--runInBand`/a custom sequencer — the ordering is legitimate
and the assertion is what is wrong; (b) a second simultaneous `npm test` on the **same lane** is a
real and separate hazard — the coordinator observed two concurrent runs contending on this lane,
and a subset run logged `postgres pool: idle client error … terminating connection due to
administrator command`, i.e. one run's bootstrap tearing down another's live connections. Always
give each lane its own `TEST_DATABASE_URL` and check `ps -eo pid,command | grep "[j]est"` first.

**Binding rule for the ADR-003 whole-table audit specifically.** "Every outbox payload is IDs
only" is a genuine *global* production invariant, and an intermittent failure of it may be a real
defect rather than a test-scoping bug. Before scoping the query, the unit MUST first capture the
actual offender string the assertion printed (`type#id: key="value"`). If a **production** handler
or service wrote that row, the fix belongs to the producer and the global assertion stays global.
Only if the offending row was fabricated by another test (e.g. a negative-path probe that enqueues
junk deliberately) may the audit be scoped — and then it must still assert over *every* row the
audit's own test produced, never a sample.

| Unit | Goal | Requirements | Exclusive files |
|---|---|---|---|
| **W3-DET-GLOBALSTATE** | The two assertions that scan **global** state must observe only what the test wrote. `verify-adr-wave0-3.test.js:379` selects the WHOLE `outbox_jobs` table for the ADR-003 IDs-only audit; `st-security-verify.test.js:472/480` counts the WHOLE `media_objects` table around the ST-04 SQLi probe. Scope both to rows this test created (tag by dedupe key / owner id / a run-scoped marker) — the ADR-003 property must still be asserted over *every* row the test produced, not a sample. | NFR-11, AB-08, ADR-003 | `tests/adr-conformance/verify-adr-wave0-3.test.js`, `tests/st-security/st-security-verify.test.js` |
| **W3-DET-CONCURRENCY** | `FR-12 seats_remaining=3, 40 concurrent distinct guests → 3×201, 37×409` must give the same answer on 5 consecutive full-suite runs. 40 simultaneous supertest requests against a `max: 10` pg pool is the first thing to measure: a pool-timeout 500 counts as neither 201 nor 409 and would fail the assertion without any capacity bug. Make the observation robust (assert on the outcome distribution *and* on `seats_remaining`, and treat a non-201/409 status as a hard failure with the body printed) without loosening the never-overbook invariant. **Measured 2026-08-17 (§8.5.1):** the failure is `created`=3 ✔, `refused`=**36**, i.e. exactly one of the 40 responses was neither 201 nor 409 and its status was discarded. Print it first; if it is a 5xx, that is a real NFR-09/AB-06 defect and this unit escalates rather than adjusting the test. This unit also owns the sixth, previously unrecorded mode found the same day: `tc12-tc14-booking-schema.test.js` → *FR-14/TC-14 guest cancels before start* failing with **`read ECONNRESET`** — a transport-level reset, to be diagnosed jointly with W3-DET-HANDLES. | FR-12, FR-14, AB-02, AB-06, NFR-09 | `tests/tc-booking/tcb-w3-reverify.test.js`, `tests/tc-booking/tc12-tc14-booking-schema.test.js` |
| **W3-DET-WORKERPATHS** | The two `IT3-F1 live dedupe` / `IT3-F1 spent dedupe` probes are timing-sensitive and read outbox state that other suites also write. Make them deterministic by construction — drive the worker step explicitly rather than waiting, and scope every query to the booking/dedupe key the probe created. | FR-13, FR-04, NFR-09, ADR-003 | `tests/it-adapters/it01-wave3-worker-paths.test.js`, `tests/rt-lt-resilience/rt02-it3f1-promote-selfdedupe.test.js` |
| **W3-DET-HANDLES** | Find and close the leaked handle behind `Jest did not exit one second after…`. Run `npx jest --detectOpenHandles` per lane to name it (open pg pool, ioredis client, worker timer, https server). Every suite must release what it opened; if a shared client is the design, `globalTeardown` must close it. Record what the handle actually was — it is the leading suspect for the cross-suite state bleed the other three units are patching. **Coordinator lead (2026-08-17, measured):** the shared clients are almost certainly it. `tests/helpers/redis.js` exports a module-scope ioredis client plus `closeTestRedis`, and `tests/helpers/db.js` exports `closeDb` — but **no `.test.js` file calls `closeTestRedis`** and 9 suites (`tests/unit/{validation,adapter-maps,bootstrap,config,observability,app}.test.js`, `tests/coverage/{migrate-cli,cov-verify-probes}.test.js`, `tests/fixtures/moderation-eval/set-integrity.test.js`) never call `closeDb`; `src/db/redis.js`'s app singleton is never quit by any suite either. An open ioredis socket keeps the process alive on its own. Prefer ONE `setupFilesAfterEnv` module holding a global `afterAll` that closes the shared pool and every Redis client, over 60 hand-written `afterAll`s — but confirm by naming the handle with `--detectOpenHandles` before changing anything. | NFR-08 (substrate) | `tests/helpers/db.js`, `tests/helpers/redis.js`, `tests/helpers/globalSetup.js`, `tests/helpers/globalTeardown.js`, `jest.config.js`, `src/db/pool.js`, `src/db/redis.js` |

### 4.2 Wave 3R-0-GATE — the determinism gate (one unit, blocks 3R-1)

| Unit | Goal | Requirements | Exclusive files |
|---|---|---|---|
| **W3-DET-GATE** | Run the full suite **5 consecutive times** on one isolated lane and record every run: suite count, test count, failures, wall time, and whether the process exited on its own without `--forceExit`. The gate passes only when all 5 runs are identical and all 5 exit unaided. Start the results file from the coordinator's 2-run baseline in §8.5.1 (both runs failed, differently, and neither exited) so the before/after is on the record. **A gate run must first check `ps -eo pid,command \| grep "[j]est"` is empty** — the coordinator observed two concurrent runs contending on one lane, which invalidates the measurement. If runs still differ, the gate FAILS and the numbers are published anyway — the report must state the disagreement honestly rather than quoting the best run. | all (precondition) | `docs/results/suite-determinism.md` |

### 4.3 Wave 3R-1 — Re-verification of the 30 claimed resolutions (PRIORITY 1)

A claim plus a green suite is **not** confirmation. Each unit re-executes the *original*
`failureScenario` from `verification-findings-wave3.json` in a **new file it owns**, never by
re-reading the fixer's own test. Anything that cannot be reproduced-as-fixed is reported as **still
open**. Each unit also verifies its normal lane scope against the current tree using
`git diff 3136b91..bc27199` rather than re-deriving everything.

| Unit | Goal | Findings re-executed | Requirements | Exclusive files |
|---|---|---|---|---|
| **W3-RV-FR10** *(highest priority)* | Prove FR-10 end to end **from the delivered email**: register → drain the outbox → read the ADR-011 mock transport's recorded delivery → extract the verification URL/token from *that* → verify → `email_verified=true` → `canReserveSeat` true. Assert no persisted artefact (outbox payload, NOTIFICATION_ATTEMPT row, users row, log line) carries the usable raw token, and that a redelivery neither mints an unmailed credential nor invalidates a mailed link. If TCB-W3-01 still reproduces, this unit owns the fix. **There is no third outcome: FR-10 is proven from the delivered email, or FR-10 is reported not met.** | TCB-W3-01 | FR-10, FR-09, NFR-06, ADR-003, ADR-011 | `tests/tc-booking/w3rv-fr10-delivered-email.test.js`, `tests/tc-booking/fr10-verification-link.test.js`, `src/modules/auth/service.js`, `src/outbox/handlers/emailVerification.js`, `src/adapters/mockTransport.js` |
| **W3-RV-BOOKING** | Booking/notification claims: promote reschedules when a listing moves **earlier**; `pending → in_progress` enqueues a notification; every template id an outbox handler emits exists in the SendGrid subject registry (assert the registry lookup, not just that a send happened); neither notification adapter can reach a live provider under `NODE_ENV=test`; `lifecycle.isLivePendingJob`'s decisive branch is actually executed. | TCB-W3-02, TCB-W3-03, TCB-W3-04, IT-F4, COV-03, MTUT-W3-02 | FR-04, FR-13, FR-14, NFR-09, ADR-011 | `tests/tc-booking/w3rv-booking-notifications.test.js`, `src/modules/bookings/lifecycle.js`, `src/adapters/sendgrid.js`, `src/adapters/fcm.js` |
| **W3-RV-CORE** | Read-surface claims: a soft-deleted host's listings must not stay discoverable; the page-cache existence assertion must survive >512 keys in the index (full SCAN cursor loop or `EXISTS`, never single-pass SCAN); the corrected TCC-03 three-case degraded contract; the host-summary fallback; the ADR-010 public serializer on search, detail and host page, including reading the cached value directly. | TCC-01, TCC-02, TCC-03, TCC-05, COV-02 | FR-01, FR-02, FR-03, NFR-09, AB-01, AB-08, ADR-005, ADR-010 | `tests/tc-core/w3rv-core-detail-search.test.js`, `src/modules/search/repo.js`, `src/modules/search/service.js`, `src/modules/listings/serializers.js` |
| **W3-RV-SEC-CONFIG** | Security/config claims: production config must refuse the committed sample `FIELD_ENCRYPTION_KEY` and the `minioadmin` credentials; `NODE_ENV=test` must pin the LLM and Maps adapters to mock (`LLM_MODERATION_MODE=live` must not be honourable); `serializeUser` must not 500 the owner on a non-canonical `*_enc` column; the two ST-06 documentation clauses. Re-execute ST-01/02/03 by execution against a real `https.Server`. | STS-W3-01, STS-W3-02, STS-W3-05, W3-ADR-02, COV-04 | NFR-03, NFR-04, NFR-05, NFR-13, AB-05, AB-06, ADR-006, ADR-007 | `tests/st-security/w3rv-security-config.test.js`, `src/config/schema.js`, `src/modules/users/repo.js`, `docs/adr007-data-use-review.md` |
| **W3-RV-ADR-MEDIA** | ADR-001 claims: `POST /api/media` must not load the object-storage adapter or construct an S3 client on the request path (assert the loaded-module set after exercising the route, not before); the precise-location deny-by-default guards are executed; the maps-cache assertion is order-independent; no dead exports. | W3-ADR-01, IT-F3, W3-ADR-03, COV-08 | NFR-11, NFR-13, AB-08, ADR-001, ADR-004, ADR-010 | `tests/adr-conformance/w3rv-adr-round1.test.js`, `src/modules/media/service.js`, `src/lib/mediaUrls.js`, `src/modules/listings/access.js` |
| **W3-RV-OBS-SAFETY** | Observability + FR-07 claims: the listing audit record carries the `YYYY-MM-DD` America/Los_Angeles calendar day, not a stringified JS `Date`; the worker-initiated `booking.promoted` record names an actor; MT-01's records, correlation-ID propagation and PII sweep; and the safety module that landed in `f7f954c` end to end (201 with no inline send → worker → emergency-contact email through the mock transport → NOTIFICATION_ATTEMPT rows → injected failure → retrying/backoff/dead-letter still visible → `no_channel`). FR-07 stays **partial**: the moderator-queue route is wave 4. | MTUT-W3-01, COV-05, TCB-W3-06, IT-F2, RTLT-01, TCB-W3-07, RTLT-03, MTUT-W3-03 | FR-07, FR-11, NFR-08, AB-03, AB-07, ADR-009, ADR-011 | `tests/mt-ut-quality/w3rv-audit-and-safety.test.js`, `tests/it-adapters/w3rv-safety-delivery.test.js`, `src/modules/listings/service.js`, `src/modules/safety/service.js`, `src/outbox/handlers/safetyAlert.js` |

### 4.4 Wave 3R-2 — The four actionable never-repaired findings (PRIORITY 3)

| Unit | Goal | Requirements | Exclusive files |
|---|---|---|---|
| **W3-FIX-REVIEWPAGE** | **TCC-04** — FR-02 detail truncates the host's approved reviews to 5 with no total and no cursor, so a client cannot tell a 5-review host from a 500-review host and the rest are unreachable from that payload. Emit a total and a documented paging route so the preview is honestly labelled. Reproduce first: the tree may already carry a `reviewCount` + `GET /api/hosts/:id/reviews?page=N` shape. | FR-02, FR-03, NFR-01 | `src/modules/listings/service.js`, `src/modules/hosts/repo.js`, `src/modules/hosts/routes.js`, `src/modules/hosts/serializers.js`, `tests/tc-core/tc02-listing-detail.test.js` |
| **W3-FIX-MEDIASQL** | **W3-ADR-04 + COV-07 (one defect)** — `src/modules/media/routes.js:81` runs `SELECT author_id FROM reviews WHERE id = $1`, putting DB access in the route layer. Move it into **`src/modules/media/repo.js`** — deliberately *not* a new `src/modules/reviews/`, which would redden the live coverage-lane scope guard and collide with U4-REVIEWS. The statement stays parameterized (NFR-11); U4-REVIEWS takes it over later. | NFR-11, ADR-001 | `src/modules/media/routes.js`, `src/modules/media/repo.js`, `tests/unit/hosts-media.test.js` |
| **W3-COV-ADAPTERS** | **COV-06** — the two production notification adapters' delivery bodies never execute (sendgrid.js 58 %, fcm.js 40 % statements), so the code that would run in a live send is unexercised, including the NFR-09 retryable/non-retryable classification. Cover them through an injected fake client seam. **Never make a live provider call** (ADR-011): dev and the whole suite stay on the mock transport and every attempt still writes a NOTIFICATION_ATTEMPT row. | FR-07, FR-13, NFR-09, ADR-011 | `src/adapters/sendgrid.js`, `src/adapters/fcm.js`, `tests/unit/adapters-comms.test.js` |
| **W3-FIX-CANARY** | **COV-01** — the AB-08 leak canary used a bare `not.toContain('742')`, which matches by chance inside random UUIDs (~1 run in 100). The working tree already looks rewritten to leaf-scoped assertions. **Confirm by execution** (drive the documented UUID collision through the current assertion and show it does not redden), then close it — or reopen it with a reproduction. Do not churn a file that is already correct. | AB-08, NFR-13, ADR-010 | `tests/st-security/st-security-wave3.test.js` |

### 4.5 Wave 3R-3 — CDR evidence and release readiness

| Unit | Goal | Requirements | Exclusive files |
|---|---|---|---|
| **W3-DEFERRED-EVIDENCE** | Turn the four fenced-off items into *evidence*, not assertions: executable absence proofs (structured-404 probes, module-absence checks) for **IT-F1** (NFR-10) and **STS-W3-03** (NFR-12 erasure, NFR-13 export); a written statement of **TCB-W3-05** presenting *both* ADR-009 readings and choosing neither; **RTLT-02** recorded untestable (k6 absent — do not vendor k6). | NFR-10, NFR-12, NFR-13, NFR-01, NFR-02, FR-08, FR-11 | `tests/coverage/w3-deferred-classification.test.js`, `docs/results/wave3-closeout-open-items.md` |
| **W3-REPORT** | Overwrite `docs/verification-report.md` with a **waves 0–3** report. The file on disk is a PRE-REPAIR DRAFT — do not trust or transcribe it. Per requirement: met (naming the test that proves it), partial (naming the missing clause), not implemented (naming the absence proof), or unverifiable here (naming why). Carries the **FR-10 lesson** (§8.4) explicitly and the **suite-determinism status** honestly — if runs still differ, the numbers go in. Updates the inventory statuses to `met` only where 3R-1 re-executed the scenario. Depends on every unit above. | all | `docs/verification-report.md`, `docs/_generated/verification-findings-wave3-round2.json`, `docs/_generated/requirements-inventory.json`, `docs/wave3-verification-handoff.md` |
| **W3-CI-PUSH** | CI has never run wave 3 (`origin/main` ends at `af1a91a`). Make the workflow replay exactly what 3R-0-GATE proved locally — same invocation, same isolation, no `--forceExit` masking a leak — and record the readiness state. **Measured 2026-08-17:** `.github/workflows/ci.yml` step 47 runs `npm test -- --coverage` with **no job or step timeout**, and both coordinator runs hung after printing results, so today a wave-3 push would occupy a runner until GitHub's 6-hour cap and report failure with a green-looking test summary in the log. Add an explicit step timeout so a future leak fails fast and visibly instead of hanging, and treat `--coverage` as its own risk: the pre-repair report recorded that coverage mode reorders suites and reddened an ADR assertion (W3-F1). **Do not `git commit` or `git push`**: the human team pushes. The deliverable is a workflow that would pass plus a written statement of what has and has not been proven about CI. | NFR-08 (substrate), all (gate) | `.github/workflows/ci.yml`, `docs/results/ci-readiness.md` |

**Wave-3R acceptance (the wave is done when all of these hold):**

1. Five consecutive full-suite runs are identical and the process exits without `--forceExit`;
   the numbers are published in `docs/results/suite-determinism.md`. If they are not identical,
   that is stated as the headline finding of the run.
2. Every one of the 30 claimed-resolved findings has either a re-executed reproduction showing it
   no longer reproduces, or is reported **still open** with its scenario. No claim is accepted on
   a fixer's word.
3. FR-10 is proven from the delivered email, or FR-10 is reported **not met**.
4. The four fenced-off items are classified with evidence and **no wave-4 code was written**.
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
| 7 — Measurement close-out | **U7-MODERATION-MEASURE** (IT-03 live run + **human label sign-off**, `tests/fixtures/moderation-eval/v1/RESULTS.md`) · **U7-PERF-SEC** (LT-01/02 under k6, ST-01 TLS scan, ST-04 ZAP baseline, `tests/load/{lt01,lt02}.js`, `docs/results/**`) · **U7-A11Y-UX** (axe-core audit of the seven NFR-07 interfaces + the 5-participant study, spec under `tests/mt-ut-quality/` driving the Vite preview build; see **§8.6** for the two dated actions) |

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
  (W3-FIX-MEDIASQL) rather than carried, and U4-REVIEWS takes it over afterwards.

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
   exists. All three are wave-7 work items with owners, not silent gaps. For axe/UT-01 the gap is
   larger than tooling — there is no interface to audit and no study booked: see **§8.6**, which
   carries the probe evidence and the two dated actions (A-NFR07-1, A-NFR07-2) NFR-07 stays open
   against.
6. **ADR-007…011 ratification** is still recorded as pending team sign-off at a stand-up.

### 8.4 The FR-10 lesson (carry it into the report)

Waves 1–2 reported FR-10 as **PASS**. The delivered email carried only the token's SHA-256 digest,
so no real user could ever verify an email — and therefore no real user could ever become eligible
to book or publish. The suite was green throughout, because the tests took the token from the
**in-process return value** instead of from the **delivered message**. The general rule this run
adopts: *verify a user-facing outcome at the boundary the user actually observes.* A test that
observes an internal value proves the internal value, nothing more.

### 8.5 Suite determinism — the second lesson of this run

The FR-10 lesson says a green test can prove the wrong thing. This one says a green *suite* can
prove nothing at all. On unchanged code the same command produced 5 failures and then 1182/1182,
and the failing files passed in isolation — so on any given day a reviewer could be shown either
picture and neither would be a lie. Two structural causes, both worth carrying into wave 4:

1. **Assertions over global state.** A whole-table `SELECT` or `count(*)` is a statement about the
   entire database, and the database accumulates rows from every suite that ran before it in the
   same process (the schema is reset once, in `globalSetup`). An invariant worth asserting globally
   — e.g. ADR-003's "every outbox payload is IDs-only" — must still be *scoped to rows this test
   produced*, or the test is measuring its neighbours.
2. **Work that outlives its suite.** An unawaited request, a worker tick or an unclosed client
   keeps mutating shared state after the suite that started it reported green, and keeps the
   process alive at the end. `--forceExit` would hide both symptoms and fix neither.

Standing rule adopted here: **a test owns the rows and keys it creates and asserts on nothing
else, and every suite closes what it opened.**

### 8.5.1 Coordinator baseline, measured 2026-08-17 (the numbers 3R-0 must beat)

Two consecutive full-suite runs, same command, same isolated lane
(`TEST_DATABASE_URL=postgres://…/homeplate_coord_test`, Redis db 13, bucket
`homeplate-media-homeplate-coord-test`), unchanged tree at `bc27199`, nothing else running:

| Run | Suites | Tests | Failure | Wall | Exited on its own? |
|---|---|---|---|---|---|
| 1 | 1 failed / 59 passed / 60 | 1 failed / 1181 passed / 1182 | `tcb-w3-reverify.test.js` — *FR-12 seats_remaining=3, 40 concurrent guests*: `created` = 3 ✔ but `refused` = **36, expected 37** | 91.07 s | **No** — killed after ~110 s idle |
| 2 | 1 failed / 59 passed / 60 | 1 failed / 1181 passed / 1182 | `tc12-tc14-booking-schema.test.js` — *FR-14 / TC-14 guest cancels before start*: **`read ECONNRESET`** | 90.31 s | **No** — killed |

**The two runs did not reproduce each other's failure, and neither matched the five modes recorded
in the handoff. Determinism status: FAILING. Three separate pictures of the same commit now exist.**

Three things this baseline pins down that the earlier diagnosis did not:

1. **FR-12's capacity invariant was never violated.** 3 bookings were created and `seats_remaining`
   reached 0; the arithmetic that broke is `3 + 36 = 39 ≠ 40` — **one response was neither 201 nor
   409**. The test throws away that response's status and body, so the run says nothing about what
   it was. W3-DET-CONCURRENCY's first job is to print it. If it is a 500 (pg pool `max: 10`
   exhausted by 40 simultaneous requests is the leading candidate) that is a genuine NFR-09 /
   AB-06 "no unhandled 5xx" defect hiding behind a flaky-test label, not a test bug.
2. **`read ECONNRESET` is a sixth failure mode, previously unrecorded.** A socket reset inside
   supertest is transport-level, not assertion-level: something reset a connection under a request
   that a booking test was making. That is the signature of state outliving its suite, which makes
   the leaked handle a *correctness* problem, not only an untidy exit. W3-DET-HANDLES and
   W3-DET-CONCURRENCY should be run by people who talk to each other.
3. **The hang is total and reproducible.** Both runs printed `Jest did not exit one second after
   the test run has completed` and then sat at 0 % CPU indefinitely; both had to be killed
   (`exit=143`). `.github/workflows/ci.yml` runs `npm test -- --coverage` with no job timeout, so
   **CI would hang on the runner's default 6-hour limit on the first wave-3 push.** Nothing may be
   pushed until this is closed.

Corroborating prior evidence: the pre-repair `docs/verification-report.md` already recorded that
"under `--coverage` jest reorders suites and one ADR-conformance assertion fails (W3-F1)" — the
same order-sensitivity, seen at `3136b91`, before repair round 1. This has been mis-filed as a
coverage-mode quirk once already.

### 8.6 NFR-07 / UT-01 cannot be closed at CDR — finding MTUT-RV-04

**Status: NOT IMPLEMENTED.** This is scope, not a defect: NFR-07 (Must) is delivered by waves 5–6
plus wave-7 unit **U7-A11Y-UX**. It is recorded here, and must be stated plainly in
`docs/verification-report.md`, so a Must-priority requirement is never left silently unmentioned at
CDR.

**Evidence — four probes, re-run 2026-08-17 on the clean tree at `bc27199`:**

| Probe | Result |
|---|---|
| `ls -d client` | `ls: client: No such file or directory` |
| `find . -name '*.jsx' -o -name '*.tsx' -o -name '*.html'` (excluding `node_modules/`, `coverage/`) | only `docs/results/zap-baseline.html`, a scanner report — **no application interface** |
| `ls node_modules \| grep -iE 'axe\|playwright\|puppeteer\|jsdom'` | empty (exit 1) — no audit harness, no browser toolchain |
| `curl -m 5 http://localhost:5173` | HTTP `000` — nothing serving a UI |
| `npm run test:a11y` | exit **1** with the wave-5 message (MTUT-W3-03's fix) — an honest refusal, **not** coverage |

So NFR-07's acceptance — zero `serious`/`critical` axe violations across the seven interfaces at
`wcag2a`/`wcag2aa`, plus keyboard traversal with visible focus, alt text, labelled controls,
`aria-live` error announcement and ≥ 4.5:1 body contrast — **has no measurable subject in this
build**, and SRS §4.5's "Findings are triaged before the Critical Design Review" cannot be met for
CDR on **2026-08-22**. Nothing in wave 3 changes that, and no wave-3 code change is proposed:
adding `@axe-core/playwright` to `devDependencies` now would install a harness with nothing to
audit.

**Two dated team actions. NFR-07 stays OPEN until both artifacts exist.**

| # | Action | Owner | Dates |
|---|---|---|---|
| **A-NFR07-1** | **Harness.** In wave 5, add `@axe-core/playwright` **and a pinned browser package** to `devDependencies` in **one `npm install` that also regenerates `package-lock.json`** — never `npx --yes`, which resolves an unpinned ChromeDriver against whatever browser happens to be on the developer's machine (**that is the exact round-1 failure**). Then add a spec under `tests/mt-ut-quality/` that boots the Vite preview server, audits all seven NFR-07 interfaces (search/browse, listing detail, host profile, booking flow, signup/login, messaging, moderator queue) with `withTags(['wcag2a','wcag2aa'])`, **fails on any `serious` or `critical` violation**, and carries the keyboard-traversal assertions. It replaces `npm run test:a11y`'s placeholder script. | Client lead — **name assigned at the CDR stand-up, 2026-08-22** | Raised 2026-08-17. Due at wave-5 start; blocks wave-6 sign-off. |
| **A-NFR07-2** | **Study.** Schedule the moderated usability study SRS §4.5 requires: **≥ 5 named participants covering both roles** (guest booking flow *and* host listing flow), a **fixed date**, and a written **triage record** of the findings. This is a human activity — no agent may run it, record it, or stand in for a participant. | QA lead — **name assigned at the CDR stand-up, 2026-08-22** | Raised 2026-08-17. Participants + date fixed **at CDR, 2026-08-22**; session run once wave 6 delivers the seven interfaces; triage record filed before NFR-07 is closed. |

At CDR the honest statement is: *NFR-07 is a Must requirement with a known delivery wave, no
harness, no subject and no scheduled study as of 2026-08-17; SRS §4.5's triage-before-CDR clause
will not be satisfied on 2026-08-22, and the two actions above are how it gets closed.*

---

## 9. Mapping to the SPMP work activities

| SPMP activity | Status |
|---|---|
| WA-1 Auth & eligibility | built (wave 2); re-verification in W3-RV-SEC-CONFIG / W3-RV-FR10 |
| WA-2 Discovery/listing + Maps | built (waves 2–3); re-verification in W3-RV-CORE |
| WA-3 Booking — the never-cut core loop (SPMP §5.3.2) | built (wave 3); re-verification in W3-RV-BOOKING + W3-DET-CONCURRENCY |
| WA-5 Safety alert | pre-landed in `f7f954c`; completed by U4-SAFETY-COMPLETE |
| WA-8 Media storage | built (waves 2–3); W3-FIX-MEDIASQL closes the last route-layer SQL |
| WA-10 Worker/dispatcher + adapters | built; W3-COV-ADAPTERS closes the untested delivery bodies |
| WA-4 Reviews & messaging | wave 4 (U4-REVIEWS, U4-MESSAGING) |
| WA-6 Data lifecycle | wave 4 (U4-PRIVACY) |
| WA-7 Moderation integration | wave 4 (U4-MODERATION) |
| WA-9 Web client — **responsive React web, not React Native** (SRS §2.1.2 wins over SPMP §5.2.1) | waves 5–6 |
| WA-11 Test suite vs SRS §4 | continuous; wave 3R is its close-out for waves 0–3; measurement close-out in wave 7 |

Per SPMP §5.2.2 this is Week 6–7 work with **CDR on Aug 22** next. Wave 3R produces the CDR
evidence; wave 4 is the CDR-critical remainder.
