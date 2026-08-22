# Homeplate v1.0 — Verification Report (waves 0–4)

**Prepared for:** Critical Design Review, 2026-08-22 · MSCS 2101, Group 6
**Requirements baseline:** SRS v3.2 (frozen). Where the SPMP or an ADR contradicts it on a
requirement, the SRS wins (SPMP §1.1.2). Where the SRS leaves a mechanism open (§2.4), ADR-001…011
bind.
**Scope of this report:** waves 0–4. Wave 4 (reviews, messaging, moderation, privacy, the FR-07
safety finish) received its **first** verification in this run — eight independent lanes re-executed
every acceptance clause; nothing below rests on the implementers' word. Waves 5–7 (the React
client, the live NFR-10 measurement) are **not built**, and this report never reports an unbuilt
requirement as a pass.

---

## 1. Status line

| Field | Value |
|---|---|
| Report date | 2026-08-21 |
| Commit (`git rev-parse --short HEAD`) | **`cca6787`** ("Build wave 4 — UNVERIFIED CHECKPOINT") |
| Working tree | **Contains the wave-4 verification repairs, UNCOMMITTED.** The repair round (units U-V4R-SAFETY-QUEUE, U-V4R-REVIEW-AUTHORSHIP, U-V4R-FINDINGS) sits on top of `cca6787` in the working tree: 21 modified files + 3 new files (`tests/adr-conformance/adr-wave4-invariants.test.js`, `tests/coverage/server-shutdown.test.js`, `docs/results/lt01-k6-summary-wave4.json`). The human team commits (house rule f). |
| Previous verified baseline | `eebd638` (waves 0–3: 23 met / 5 partial / 7 not implemented, pushed to `origin/main`) |
| CI state | **CI has NOT executed wave 4.** `origin/main` is at the wave-3 close-out. CI green on wave 4 requires the human team to commit and push this tree first. |
| Test framework | Jest 29 + Supertest against PostgreSQL 16, Redis 7 and MinIO (docker compose), `maxWorkers: 1`, `TEST_STRICT_HANDLES=1` |

### Commands run for this report, and their real output

These were executed by the report author on the final (repaired) tree, on an isolated lane
(`TEST_DATABASE_URL=…/homeplate_finalrpt4_test`, derived Redis db 8, derived MinIO bucket).
Complete output was captured to files and inspected in full — never piped to `tail` first.

| Command | Result |
|---|---|
| `TEST_STRICT_HANDLES=1 npx jest` (full suite, run **A**) | `Test Suites: 62 passed, 62 total` · `Tests: 1386 passed, 1386 total` · `Time: 93.714 s` · exit **0** · zero `✕`/`FAIL` lines |
| `TEST_STRICT_HANDLES=1 npx jest` (full suite, run **B**, back to back, same lane) | `Test Suites: 62 passed, 62 total` · `Tests: 1386 passed, 1386 total` · `Time: 93.737 s` · exit **0** · zero `✕`/`FAIL` lines (see §6 for the determinism record) |
| `npm run lint` (`eslint . && prettier --check .`) | exit **0** · `All matched files use Prettier code style!` |
| `npm run build` (`scripts/check-build.js`) | exit **0** · `6 file(s), naming and ordering valid` (migrations) · `111 file(s) parse cleanly` · `createApp() boots against the .env.example environment` · `all checks passed` |
| `k6 run … tests/load/smoke.js` (recorded artifact, `docs/results/lt01-k6-summary-wave4.json`) | k6 **v2.2.0**, 200 VUs, 30 s warm-up + 5 min steady against real TLS: **steady p(95) 123.26 ms**, p(99) 159.88 ms, error rate **0.00 %** over 1,131,196 steady requests |
| `npm run test:a11y` | exit **1 by design** — there is still no client to audit (NFR-07) |

The suite grew from **60 suites / 1345 tests** at the `cca6787` baseline (coordinator-measured,
three consecutive strict runs) to **62 / 1386** with the repair round's added conformance and
shutdown tests. No run hung; `--forceExit` was never used.

Additionally, the eight verification lanes each ran their own lane suites and one or two full-suite
passes on fully isolated resources (own `_test` database, own Redis db, own bucket); their per-lane
results are cited as evidence throughout §3 and were spot-checked — every cited test file exists on
disk (verified by an executed existence sweep over all 39 cited paths), and the lane files all
appear in runs A/B above with the same counts.

### Status vocabulary used in this report

| Status | Meaning |
|---|---|
| **Met** | Every acceptance clause was executed against the current tree and passed. A named test file proves it. |
| **Partial** | At least one acceptance clause has no implementing code, or is measured by an instrument the criterion does not name. |
| **Not implemented** | No implementing code. Proven absent by executing a probe, not by reading. Never a pass. |
| **Not verifiable here** | The evidence requires a human, a tool, or an environment this repository cannot supply. |

---

## 2. The FR-10 lesson — read this before trusting any pass in §3

Waves 1 and 2 reported **FR-10 (registration + email verification) as PASS**. It was not: the
verification email could only ever carry the SHA-256 **digest** of the token, and the tests passed
because they took the token from an in-process return value the production consumer never sees. No
registered user could have verified an email, and therefore none could have booked a meal — from an
all-green suite. The methodological rule it produced governs this report:

> **A test that asserts on a value the system handed it internally proves nothing about what the
> system delivers.** Assertions must be made on the persisted or transmitted artifact — the outbox
> row, the `notification_attempts` row, the rendered message body, the HTTP response — never on a
> convenient intermediate.

A corollary applied throughout wave-4 verification: **a green suite is not evidence that a defect
is fixed** — every repair in §4 was re-verified by re-executing the original failure scenario and
showing it no longer reproduces. The wave-4 instance of the lesson: the safety-alert unified-queue
clause (finding **W4-F1**) shipped as fully-implemented *write* machinery behind a contract gate
that evaluated to *off* — every implementer test passed while the acceptance clause was unmet. It
was caught only because verifiers executed the clause itself ("does an alert actually appear on
`GET /api/moderation/queue`?") rather than the machinery around it.

---

## 3. Traceability matrix (SRS Appendix B shape)

Design elements are quoted from **SRS Appendix B**. Test IDs are the SRS §4 identifiers; the "Test
file" column names the canonical file that actually executes them in this repository (the wave-3
`*-reverify`/`verify-*` probe files named in the previous report were consolidated into these
canonical lane files on 2026-08-21). Every evidence sentence below describes an **executed** test
in runs A/B or a lane run on this tree, not a code reading.

### 3.1 Functional requirements

| Req | Design element (SRS App. B) | Implementing file(s) | Test ID | Test file | Status | Evidence |
|---|---|---|---|---|---|---|
| **FR-01** | Search Service, Listing Service, Google Maps Adapter | `src/modules/search/{routes,service,repo}.js`, `src/adapters/maps.js`, `src/lib/cache.js` | TC-01, LT-01 | `tests/tc-core/tc01-search.test.js` | **Met** | Re-executed green on the wave-4 tree: every filter alone and combined returns exactly the expected ids; pending/rejected/past listings never returned; repeat query = zero adapter calls; Redis cache holds public precision only (ADR-010); Maps-outage behaviour proven in the three ratified cases (fresh page-cache 200 / stale-adapter `degraded:true` never cached / cold 503 `SEARCH_DEGRADED`). Disclosed: FR-01 carries the recorded acceptance correction **TCC-03** (self-contradictory degraded-flag clause, corrected 2026-08-14, no code change) — still awaiting team ratification at CDR. |
| **FR-02** | Meal Detail View | `src/modules/listings/{routes,service,serializers}.js`, `src/modules/hosts/repo.js`, `src/lib/mediaUrls.js` | TC-02 | `tests/tc-core/tc02-listing-detail.test.js`, `tc05-reviews.test.js` | **Met** | All fields present and equal to seed; pending/rejected 404 to strangers; ADR-010 disclosure matrix (exact address only to pending/in-progress guest or alert-handling moderator, access-logged). **New wave-4 clause executed:** a pending review is absent from `GET /api/listings/:id` and appears only after a human `POST /api/moderation/queue/:id/decision` approval. |
| **FR-03** | Host Profile Service | `src/modules/hosts/{routes,service,repo,serializers}.js` | TC-03 | `tests/tc-core/tc03-host-profile.test.js`, `tc05-reviews.test.js` | **Met** | Host page exactly the public allowlist; wave-4 addition executed: review lifecycle on the host page (pending→invisible, approved→visible with rating/author intact, rejected→never visible). |
| **FR-04** | Booking Service (completion confirmations) | `src/modules/bookings/{routes,service,repo}.js`, `db/migrations/0004` | TC-04 | `tests/tc-core/tc04-completion.test.js` | **Met** | Dual confirmation asserted in response AND database (one confirm → still `in_progress`, `completed_at` NULL; both → `completed` + timestamp); concurrent guest+host completes exactly once; 403/409/401/404 matrix. The 0001 CHECK `bookings_completed_requires_both_confirmations` enforces it at schema level (observed rejecting a bad fixture in MT-01). |
| **FR-05** | Review Service | `src/modules/reviews/{routes,service,repo}.js`, `src/schemas/reviews.js`, `src/outbox/handlers/moderationScan.js` | TC-05 | `tests/tc-core/tc05-reviews.test.js` (first verification) | **Met** ¹ | Only completed-booking participants, both directions, max two per booking (409 `REVIEW_EXISTS`, opposite direction still allowed); rating integer 1–5 (422 for 0/6/2.5/'5'/null); review born `moderation_status='pending'` with its `moderation.scan` outbox row in the **same transaction** (xmin equality) and IDs-only payload; invisible on all three read paths until human approval, rejected never visible; `imageKeys` become `media_objects` rows in the creating transaction; foreign-namespace key → 403, no row. ¹ Open spec question **W4-F2**: photo-only reviews are refused (comment required, min 1 char) — the SRS does not forbid them; team decision pending, not decided by verification. |
| **FR-06** | Messaging Service | `src/modules/messaging/{routes,service,repo}.js`, `src/schemas/messaging.js` | TC-06 | `tests/tc-core/tc06-messaging.test.js` (first verification) | **Met** | Participants only (moderator and third party 403), pending/in_progress/completed bookings, cancelled 409; message delivered and readable **while its scan is still pending** — re-proven under a forced provider outage (ADR-002 deliver-first); message row + scan row share one xmin, IDs-only payload; zero `src/adapters/*` modules loaded by any request (require.cache audit); flagged message → human queue → rejection hides it from both participants with decision rows persisted; blocklist message auto-rejected with `decided_by='pre_filter'`, zero LLM calls. Flag-vs-hide policy ratified as **W4-F4**. |
| **FR-07** | Safety Alert Service, SendGrid Adapter | `src/modules/safety/{routes,service,repo}.js`, `src/outbox/handlers/safetyAlert.js`, `src/adapters/sendgrid.js` | TC-07, IT-04 | `tests/tc-core/tc07-safety.test.js`, `tests/it-adapters/it04-safety-delivery.test.js` | **Met** | 201 persists `SAFETY_ALERT` + `safety.alert` outbox row in one transaction, zero adapters and zero notification attempts on the request path; `GET /api/moderation/alerts` lists from the instant of persistence; injected SendGrid failure → retrying with backoff; exhausted budget → dead-letter, alert `failed` but STILL listed; no emergency contact → `no_channel`, moderator notice still sent; emergency leg addressed to the decrypted contact, never the raiser; attempt rows carry user IDs, never an email address. **The wave-4 unified-queue clause, unmet at `cca6787` (found by five lanes independently), is now met after repair W4-F1:** a delivered alert files one idempotent `moderation_queue` row (`content_type='safety_alert'`), which the queue route serves filtered and unfiltered (executed in `tc08` + `unit/safety`). |
| **FR-08** | Moderation Module (pre-filter, LLM, human review, publication policy) | `src/modules/moderation/{prefilter,repo,service,routes}.js`, `src/adapters/llmModeration{,.mock}.js`, `src/outbox/handlers/moderationScan.js`, `db/migrations/0005+0006` | TC-08, IT-03 | `tests/tc-booking/tc08-moderation-substrate.test.js` (first verification) | **Met** | Two-stage pipeline real and executed on all three scanned surfaces: blocklist hit rejected with `decided_by='pre_filter'` and **zero** LLM calls (jest spy); benign content auto-approved (`decided_by='llm'`, `model_id` recorded); flagged / low-confidence content files exactly one queue item and stays pending; human APPROVE publishes, REJECT never does; provider outage → scans retry with backoff, content stays pending and off every read path, recovery approves the **same** jobs; dead letters recovered via `scripts/requeue-dead-letters.js` (`--dry-run` requeues nothing); scan payloads exactly `{contentType, contentId}` (ADR-003); duplicate scan delivery is decide-once (RT-02). Moderator queue is role-gated 403. Flagged-message visibility wording ratified (**W4-F4**). |
| **FR-09** | Eligibility Policy Service | `src/modules/eligibility/{policy,middleware,repo}.js` | TC-09 | `tests/tc-booking/tc09-eligibility.test.js` | **Met** | Both states over real routes (403 with all three reason codes → identical request succeeds after verify+profile); repo-wide grep test proves the policy is implemented **only** in `eligibility/policy.js` (ADR-006), wave-4 modules included. |
| **FR-10** | Registration & Email Verification Service | `src/modules/auth/{routes,service}.js`, `src/modules/users/tokens.js`, `src/outbox/handlers/emailVerification.js` | TC-10 | `tests/tc-booking/tc10-registration.test.js`, `fr10-verification-link.test.js`, `fr10-resend-verification.test.js` | **Met** | Token extracted from the **delivered** message body (the TCB-W3-01 observation point — see §2), verified end to end; argon2id hash; duplicate email 409; wrong/used/expired token 400; no persisted artifact carries the raw token. |
| **FR-11** | Listing Service (MEHKO and seat limits) | `src/modules/listings/{routes,service,repo,mehko}.js`, `src/config/locale.js` | TC-11 | `tests/tc-booking/tc11-listing-caps.test.js` | **Met** | 1 listing/host/LA-day (DB unique index + concurrency test), 30 meals/day, 90 meals/ratified-Monday-anchored-LA-week; 23:30 PT vs 00:30 PT same-UTC-day are different days; Tokyo-offset timestamps refused across the LA boundary; caps only in `src/config` (grep test), exactly one enforcement point; material edit resets to pending + fresh scan. |
| **FR-12** | Booking Service (atomic capacity transaction) | `src/modules/bookings/{service,repo}.js` | TC-12, LT-01 | `tests/tc-booking/tc12-tc14-booking-schema.test.js`, `tests/rt-lt-resilience/lt01-race.test.js` | **Met** | 50 concurrent POSTs on 1 seat → exactly 1×201 / 49×409, seats 0, sum(bookings)==capacity; DB CHECKs make overbooking impossible; rejected request changes nothing. |
| **FR-13** | Transactional Outbox, Worker, Notification Adapters | `src/outbox/{outbox,worker,dispatch}.js`, `src/outbox/handlers/*`, `src/modules/notifications/*`, `src/adapters/{sendgrid,fcm,mockTransport}.js` | TC-13, RT-02 | `tests/tc-booking/tc13-notifications.test.js`, `tests/rt-lt-resilience/rt02-outbox.test.js` | **Met** | One notify row per recipient in the booking's transaction (xmin; forced error rolls back both); transport failure → 201 in <500 ms and booking committed; attempt-per-try, backoff, dead-letter, exactly-once redelivery; IDs-only payload audit; push gate default-false (ADR-011). |
| **FR-14** | Booking Service (cancellation, capacity restore) | `src/modules/bookings/{service,repo}.js` | TC-14 | `tests/tc-booking/tc12-tc14-booking-schema.test.js` | **Met** | Seat restored exactly once incl. 10 concurrent cancels and guest+host simultaneous; idempotent repeat; at/after start 409; DB CHECK forbids `seats_remaining > seat_capacity`. |

### 3.2 Non-functional requirements

| Req | Design element (SRS App. B) | Implementing file(s) | Test ID | Test file | Status | Evidence |
|---|---|---|---|---|---|---|
| **NFR-01** | REST API, Redis Cache | `src/app.js`, `src/routes/index.js`, `src/lib/cache.js` | LT-01 | `tests/load/smoke.js` (k6) → `docs/results/lt01-k6-summary-wave4.json`; in-suite gate `tests/rt-lt-resilience/lt-volume-latency.test.js` | **Met** | Re-measured **on the wave-4 tree**: steady-phase p95 **123.26 ms** against the 500 ms budget at 200 VUs, 0.00 % errors — full numbers in §7. The wave-4 review read path (`hostReviews`) is inside the measured mix at p95 79.95 ms. |
| **NFR-02** | Backend System, PostgreSQL | `db/migrations/0002`, `src/modules/search/repo.js`, `scripts/seed.js --set volume` | LT-02 | `tests/rt-lt-resilience/lt-volume-latency.test.js` + the k6 artifact | **Met** | k6 run executed against 10,050 users / 1,002 approved listings / 1,002 bookings / 1,001 approved reviews (verified by direct SQL; the harness refuses to start below the 1,000-listing floor); EXPLAIN ANALYZE over the real search queries at volume: 0.03–0.90 ms, no sequential scan on listings, required indexes asserted present. |
| **NFR-03** | Network Security Layer (TLS) | `src/server.js`, `src/middleware/security.js` | ST-01 | `tests/st-security/st-security.test.js` | **Met** | Live `https.Server` negotiates TLS 1.2/1.3 and refuses 1.0/1.1; plain HTTP never answered with app content; `enforceTls` 403 + HSTS ≥ 15552000; production config fails closed. Certificate validity needs a deployment (§5). |
| **NFR-04** | Authentication Service | `src/modules/auth/passwords.js` | ST-02 | `tests/st-security/st-security.test.js` | **Met** | Argon2id (memoryCost 19456 KiB, timeCost 2 — OWASP floor); plaintext in no column; per-user salt; no logger/serializer emits a raw password field (repo-wide grep test). |
| **NFR-05** | Authentication Service (rate limiting) | `src/modules/auth/rateLimit.js`, `src/config/` | ST-03 | `tests/st-security/st-security.test.js` | **Met** | Exact 5-failures-in-600 s boundary executed — numbers in §7. |
| **NFR-06** | Eligibility Policy, Email Verification | `src/modules/eligibility/policy.js`, `src/modules/auth/service.js` | IT-02 | `tests/it-adapters/it02-verification-eligibility.test.js` | **Met** | register → outbox → worker → transport → delivered body URL → `email_verified` flips → eligibility recomputed; outage leaves the job queued, delivery completes on recovery. |
| **NFR-07** | Web UI (React) | *(none — `client/` does not exist)* | UT-01 | *(none — `npm run test:a11y` fails by design)* | **Not implemented** | `ls client` → no such directory; zero `.jsx/.tsx` outside `node_modules`; `npm run test:a11y` exits 1 **by design** so its presence is never read as coverage. Waves 5–6. Unchanged. |
| **NFR-08** | Logging & Monitoring Service | `src/lib/logger.js`, `src/middleware/{requestContext,errorHandler}.js`, audit sites across `src/modules/*` and `src/outbox/handlers/*` | MT-01 | `tests/mt-ut-quality/mt01-log-completeness.test.js`, `mt01-wave3-booking-audit.test.js` | **Met** (was Partial) | All four named actions now audit-verified by execution: registration, booking create, cancellation, and — newly performable in wave 4 — the **human moderation decision** (one `moderation.decision` record with decider/entity/decision id; `moderation_decisions` row `decided_by='human'`; queue item resolved; non-moderator attempt 403 with failure record). Correlation IDs proven on both sides of every wave-0–4 outbox handler incl. `moderationScan`/`dataExport`; error records structured with stack server-side only; two full captured log corpora show **zero** PII (no email-shaped bytes, no §3.4 field, no message/review content, no street address). Wave-4 events `review.created`, `message.sent`, `privacy.export_requested/_completed`, `privacy.deletion_requested`, `safety.alert_raised/_delivered` all executed. |
| **NFR-09** | External Service Adapters, Deferred-Work Mechanism | `src/lib/resilience.js`, `src/adapters/*`, `src/outbox/worker.js` | RT-01, RT-02 | `tests/rt-lt-resilience/rt01-degradation.test.js`, `rt01-provider-outage-drill.test.js`, `rt02-outbox.test.js` | **Met** (mechanisms) | Ten per-service outage drills incl. the **new drill 10** on wave-4 surfaces: under LLM outage a review stays pending and invisible while the message still delivers; recovery completes the *same* jobs. Crash-recovery/exactly-once/backoff/dead-letter/concurrent-workers all executed; operator recovery via `scripts/requeue-dead-letters.js` proven end to end. The 99 % availability *figure* needs a deployment (§5). |
| **NFR-10** | Moderation accuracy (FP and FN < 5 %) | pipeline: FR-08 files; eval set `tests/fixtures/moderation-eval/v1/`; harness `scripts/it03-eval.js` | IT-03 | `tests/it-adapters/it03-moderation-eval.test.js` (mechanics only) | **Partial — NOT MEASURED** | **No number exists and none is quoted, provisional or otherwise.** Change since the last report: the pipeline and scoring harness now exist and are exercised (mock-scored runs are labelled NOT-A-MEASUREMENT and carry no rate fields — asserted key-by-key), and the ADR-008 **label** sign-off is recorded (Gaetan Rieben, 2026-08-21, set v1, 224 items: 56 offensive / 56 spam / 56 fraudulent / 56 benign, balanced, ≥200). Still missing for any claim: the live IT-03 run (wave 7) with model id + prompt version recorded and a `RESULTS.md` with both rates < 0.05. No `RESULTS.md` exists anywhere in the tree (executed `find`), and no live provider call was made in this run — ADR-007/ADR-011 pin the mock under `NODE_ENV=test`, re-verified by executed tripwires. `claimability()===true` means **preconditions only**. |
| **NFR-11** | Input Validation Module | `src/middleware/validate.js`, `src/schemas/*.js` (12 schemas incl. `reviews`, `messaging`, `moderation`, `privacy`), `src/lib/sanitize.js` | ST-04 | `tests/st-security/st-security.test.js`, `st-security-wave3.test.js` | **Met** (was Partial) | The previously-missing surfaces exist and are boundary-verified: every malformed input at review/messaging/moderation/privacy routes returns a typed 422 envelope with no row written and never a 500; SQLi/XSS payload sweeps at all boundaries incl. the new moderation decision-note ($-parameterized, DROP inert, HTML-escaped); route-enumeration test asserts **every** mounted route declares a schema; static grep proves no concatenated SQL. |
| **NFR-12** | Data Lifecycle Service (deletion, retention, media) | `src/modules/privacy/{routes,service,repo}.js`, `src/outbox/handlers/accountErasure.js`, `src/modules/media/service.js`, `scripts/backup.js` | ST-05, RT-02 | `tests/st-security/st05-st06-privacy.test.js`, `tests/rt-lt-resilience/rt02-outbox.test.js`, `tests/adr-conformance/adr-wave4-invariants.test.js` (first verification) | **Met** (was Not implemented) | `DELETE /api/users/me` → 202 + `data_requests` row + `account.erasure` job **due at exactly `now()+30 days`** (timestamp equality, same transaction — xmin). Real handler run at the simulated due instant via clock injection: §3.4 columns emptied/anonymized, media deleted **by key** from real MinIO (subsequent GET 404s), whole-database scan finds zero PII rows; reviews retained anonymized; session dead immediately (401). Idempotent redelivery leaves rows byte-identical. Backup pruning covered in-process (`scripts/backup.js main()`, both branches — finding W4-F5 repaired). See §7 for the window-coverage argument. |
| **NFR-13** | Data Protection (encryption, access control, export) | `src/db/fieldCrypto.js`, `src/modules/users/{repo,service}.js`, `src/modules/privacy/*`, `src/outbox/handlers/dataExport.js` | ST-06, RT-02 | `tests/st-security/st05-st06-privacy.test.js`, `tests/rt-lt-resilience/rt02-outbox.test.js` (first verification of export) | **Met** (was Partial) | AES-256-GCM field encryption verified in the DB (phone, emergency contact ciphertext); users table carries exactly the §3.4 register; `GET /api/users/me` is an allowlist; moderator precise-location read role-gated and access-logged only with an FR-07 alert; **export now exists**: `POST /api/users/me/export` → 202, worker-assembled copy contains every §3.4 class from 9 real tables, owner-only (foreign id → 404), IDs-only job payload (content never rides the outbox), idempotent redelivery serves the stored copy unchanged; production refuses the committed sample key. |

### 3.3 Abuse / misuse cases (SRS §3.5)

| Req | Design element | Implementing file(s) | Test ID | Test file | Status | Evidence |
|---|---|---|---|---|---|---|
| **AB-01** Fake host / fake listing | Eligibility Policy, Moderation Module, Review Service, Safety Alert Service | `src/modules/eligibility/policy.js`, `src/modules/listings/service.js`, `src/modules/moderation/*` | ST-05, TC-08, TC-09, TC-10 | `tests/st-security/st-security-wave3.test.js`, `tests/tc-booking/tc08-moderation-substrate.test.js` | **Met** (was Partial) | The previously-missing moderation half is now executed: no listing publishes unreviewed (born pending; only the moderation repo flips status — single-writer grep test); fraud fixtures escalate to human review; fraud blocklist pre-filter-rejects with zero LLM calls; a host without profile/agreement cannot publish (403 before any listing work); mutual reviews attributable to completed bookings only (TC-05). |
| **AB-02** Fraudulent / hoarding bookings | Eligibility Policy, Booking Service, Logging | `src/modules/bookings/service.js`, `src/config/` | TC-12, ST-04 | `tests/tc-booking/tc12-tc14-booking-schema.test.js`, `tests/st-security/st-security-wave3.test.js` | **Met** | Cap 3 concurrent pending, sequential AND concurrent enforcement (cap+5 simultaneous → exactly cap); ineligible guest 403 before any capacity work; refusals audited. |
| **AB-03** Spam / scripted listings | Listing Service (MEHKO), Moderation Module, Input Validation, rate limiting | `src/modules/moderation/prefilter.js`, `src/modules/listings/mehko.js`, `db/migrations/0002` | TC-08, TC-11, ST-04 | `tests/tc-booking/tc08-moderation-substrate.test.js`, `tests/st-security/st-security-wave3.test.js` | **Met** (was Partial) | Executed: 16th listing by one author in the 60-min window → escalated with `{decided_by:'pre_filter', category:'spam'}`, queue reason `rate_limited`, stays pending (never auto-rejected), zero LLM calls; link-farm and bulk-promo blocklist rules fire; 10 same-day creations → exactly 1 persisted + 9×409 (DB unique index). |
| **AB-04** Abusive content in chat or reviews | Moderation Module, Safety Alert Service, Logging | `src/modules/moderation/*`, `src/modules/messaging/repo.js`, `src/modules/safety/*` | TC-05, TC-06, TC-08, IT-04 | `tests/st-security/st-security.test.js`, `tests/tc-core/tc06-messaging.test.js`, `tests/tc-booking/tc08-moderation-substrate.test.js` | **Met** (was Not implemented) | Abusive review born pending → flagged → human-rejected → never publicly visible; abusive message delivered immediately (ADR-002) then blocklist-auto-rejected or human-rejected and hidden from **both** participants; `MODERATION_DECISION` rows logged for both surfaces; moderator escalation `POST /api/moderation/alerts` follows the full FR-07 delivery path (IT-04) and — post-repair — the alert also appears on the unified moderation queue (W4-F1). Flag-vs-hide policy ratified as W4-F4. |
| **AB-05** Account takeover | Authentication Service, Network Security Layer | `src/modules/auth/{passwords,rateLimit,sessions}.js`, `src/server.js` | ST-01..03 | `tests/st-security/st-security.test.js` | **Met** | 50-attempt brute force locked from attempt 6 (correct password refused throughout); opaque ≥128-bit HttpOnly+Secure+SameSite session; logout kills the Redis session; deletion kills the session immediately (wave-4 MT-01 check). |
| **AB-06** Injection attacks (SQLi / XSS) | Input Validation Module | `src/middleware/validate.js`, `src/schemas/*`, `.github/zap/baseline-plan.yaml` | ST-04 | `tests/st-security/st-security.test.js` | **Partial** | Every executable clause is met — hostile payloads at **every** API boundary incl. all wave-4 surfaces: typed 422, no 500, tables intact, stored/returned text escaped, no concatenated SQL, all routes schema'd. The one open sub-clause is environmental: the OWASP ZAP baseline over a **rendered client** cannot run until waves 5–6 deliver one (the scan machinery exists and fails a thin crawl by design). |
| **AB-07** MEHKO evasion via duplicate accounts | Registration/Email Verification, Listing Service, Logging | `src/modules/auth/service.js`, `src/modules/listings/mehko.js` | TC-10, TC-11, MT-01 | `tests/st-security/st-security.test.js`, `st-security-wave3.test.js` | **Met** | Duplicate email 409 (unique constraint, audited); unverified host with profile+agreement still 403; daily cap server-side in one place backed by the DB unique index. |
| **AB-08** Scraping of personal data | Session auth, Eligibility Policy, data minimization | `src/modules/auth/middleware.js`, `src/modules/{listings,hosts}/serializers.js`, `src/modules/listings/access.js` | ST-06, ST-04 | `tests/st-security/st-security-wave3.test.js` | **Met** | Every endpoint 401 unauthenticated; search/host/listing payloads exactly the public allowlists; exact address only to a pending guest, reverting on cancel; export owner-only; wave-4 additions: moderation queue excerpts leak no street/coordinate/email (deep JSON scan), message payload is the exact allowlist. |

### 3.4 Summary count

| Status | FR | NFR | AB | Total |
|---|---|---|---|---|
| **Met** | **14** | 11 | 7 | **32 / 35** |
| **Partial** | 0 | 1 (NFR-10 — pipeline built, accuracy **not measured**) | 1 (AB-06 — ZAP-over-client clause only) | **2 / 35** |
| **Not implemented** | 0 | 1 (NFR-07 — no client) | 0 | **1 / 35** |

Movement since the `eebd638` waves-0–3 baseline (23 / 5 / 7): FR-05, FR-06, FR-08, NFR-12, NFR-13
and AB-04 moved from *not implemented* to **Met**; NFR-08, NFR-11, AB-01 and AB-03 closed their
previously-unperformable clauses and moved from *Partial* to **Met**; NFR-10 moved from *not
implemented* to *Partial* (the pipeline now exists; the measurement still does not). NFR-07 and
AB-06's client clause are unchanged, waiting on waves 5–6.

---

## 4. Findings

Wave-4 verification produced findings from eight lanes; duplicates are consolidated here under one
id each. "Closed" findings name the re-executed failure scenario that no longer reproduces —
a green suite alone was never accepted as closure (§2).

### W4-F1 — CLOSED (repaired this run): safety alerts never reached the unified moderation queue, and a filed row would have 500'd it

- **Severity:** major (was reported blocker/major by five independent lanes: TCC-W4-01, TCB-W4-01, ITA4-F1, STS-W4-01, RTLT-W4-01, plus F-MT-02/F-ADR4-01).
- **Requirements:** FR-07, FR-08, AB-04 (the U4-SAFETY-COMPLETE acceptance clause).
- **What was wrong at `cca6787`:** `src/modules/moderation/repo.js` declared `CONTENT_TYPES = ['listing','review','message']`; `safetyRepo.unifiedQueueSupported()` therefore returned `false` and the worker filed **no** `moderation_queue` row for any delivered alert — the clause "alert appears as a moderation_queue row on the queue route" was unmet while every implementer test passed (the filing machinery was complete but gated off). Worse, reproduced by execution: force-inserting the exact row the handler would write made the **unfiltered** `GET /api/moderation/queue` return 500 `INTERNAL_ERROR` (`loadContentForQueuePage` hard-asserts the type list) and `?contentType=safety_alert` 422. A disabled feature is not a passing acceptance clause.
- **Repair (unit U-V4R-SAFETY-QUEUE, in the working tree):** `'safety_alert'` added to `CONTENT_TYPES` (with `SCANNED_CONTENT_TYPES` kept separate for the FR-08 pipeline); `loadContentForQueuePage` gained a safety_alert excerpt branch that synthesizes an IDs-only excerpt from the `safety_alerts` row; `setModerationStatus` is a recorded no-op for the type (an alert has no publication state); the `src/schemas/moderation.js` filter enum widened. `unifiedQueueSupported()` re-reads the contract per delivery, so filing switched on with **zero** safety-module changes. The two sibling suites that drained the whole outbox and then read the unfiltered queue were re-scoped with `tests/helpers/outboxScope.js` (`adr-wave3-invariants` ~1466, `mt01-wave3-booking-audit`) so the newly-filed rows cannot redden them.
- **Re-verified by execution on the final tree (runs A/B green):** `tests/unit/safety.test.js` asserts `unifiedQueueSupported() === true` on the real tree (and `false` under a narrowed contract — both directions); `tests/tc-booking/tc08-moderation-substrate.test.js` drives a raised alert through the **real worker** and reads it back on `GET /api/moderation/queue` both filtered (`contentType=safety_alert`) and **unfiltered** (the mixed page serializes — the former 500 no longer reproduces); filing is idempotent on redelivery and survives dead-lettering (IT-04).

### W4-F2 — OPEN (spec question, escalated to the team — deliberately NOT decided by verification): photo-only reviews are impossible

- **Severity:** minor. **Requirement:** FR-05. (Reported independently as TCC-W4-02, TCB-W4-03, STS-W4-02, F-ADR4-02.)
- **Reproduction:** on a completed booking, `POST /api/bookings/:id/reviews` with `{rating:5, imageKeys:[ownKey]}` and no comment → 422 `VALIDATION_FAILED`; `comment:''` and `comment:'   '` likewise. SRS §3.1 FR-05 ("reviews … including photos and a numerical rating") neither mandates text nor forbids a photo-only review.
- **Why the constraint exists (verified):** both moderation adapters' `classify()` throw `TypeError` on empty/whitespace text — not the typed retryable provider error — so an empty-bodied review's `moderation.scan` job would retry and then **permanently dead-letter**, stranding the review pending forever. The min-1-char comment is currently load-bearing for pipeline safety, and is documented as an open question in `src/schemas/reviews.js`.
- **The decision the team must make:** (a) ratify comment-required as the FR-05 interpretation and record it in the requirements inventory; or (b) allow comment-optional-with-images AND, **in the same change**, make the scan pipeline empty-text-safe (e.g. skip the LLM stage and route the image-bearing item to the human queue — images are unscannable by the v1.0 text pipeline anyway, so human review is the ADR-002-consistent direction). Do not relax the schema without the pipeline change.
- **Why still open:** it changes what FR-05 means; a verifier deciding it would be re-writing the frozen baseline.

### W4-F3 — CLOSED by recorded decision: `findReviewAuthorId` move-plus-delegate

- **Severity:** minor. **Requirements:** FR-05, AB-08 hygiene. (TCC-W4-03 / flagged item 3.)
- **Decision (taken by the ADR-conformance lane, its owning lane):** **keep the delegation.** The SQL lives once in its owning module (`src/modules/reviews/repo.js`); `src/modules/media/repo.js` re-exports the same function object so media routes depend only on their own repo facade (ADR-001 layering). `tests/adr-conformance/route-layer-db-access.test.js` was updated: the stale wave-3 comment ("src/modules/reviews/ must not exist") is gone and the test now **pins the delegation identity** (`mediaRepo.findReviewAuthorId === reviewsRepo.findReviewAuthorId`), so a silent re-implementation in the media module fails the lane. Both call paths are exercised (unit/reviews + route-layer tests). No runtime defect existed.

### W4-F4 — CLOSED by ratified wording (recorded, for CDR visibility): "a message later flagged is hidden and queued" did not match the implemented policy

- **Severity:** minor. **Requirements:** FR-08, AB-04. (TCB-W4-02.)
- **What was found:** an LLM-flagged message files a queue item but **remains readable** by the booking's participants until a human rejects it; only a pre-filter blocklist hit at submission or a human rejection hides it. The inventory's acceptance sentence read as hide-on-flag.
- **Ratified reading (recorded in `docs/_generated/requirements-inventory.json` FR-08/AB-04 and in the `src/modules/messaging/repo.js` header):** queue-on-flag, hide-on-rejection. The frozen SRS never mandates pre-decision hiding; ADR-002 both delivers private messages immediately and routes flagged content to a **human** reviewer — hide-on-flag would let an unreviewed LLM false positive censor live mid-transaction communication and make the LLM the effective decider. `tc08` pins the behaviour executably. The consequence is disclosed plainly: between LLM flag and human decision, content that beat the blocklist stays visible in its private thread.

### W4-F5 — CLOSED (repaired this run): `scripts/backup.js` hid its whole `main()` from coverage

- **Severity:** minor. **Requirement:** NFR-12 (operator lifecycle tooling). (ITA4-F2.)
- **What was wrong:** the `/* istanbul ignore next */` at the old line 124 covered the **entire** `main()` — the sweep-vs-prune dispatch, the `--limit` pass-through to `privacyService.runInactivitySweep`, and the pool/redis close discipline — and `main` was not exported, so real logic was untestable and invisible to coverage.
- **Repair:** `main(argv, io, deps)` is now exported and injectable (same pattern as `scripts/it03-eval.js`); both branches are covered in-process by `tests/unit/privacy.test.js` incl. the close-in-finally discipline; the ignore annotation is narrowed to the `require.main` process-wiring block only. The remaining six annotations across the three CLI scripts were audited by three lanes and cover genuinely suite-unreachable wiring (dotenv under `NODE_ENV!=='test'`; `require.main` blocks whose exported functions ARE executed in-process). In the same spirit, `src/server.js wireShutdown` — the only uncovered non-trivial function found by the coverage lane — was made injectable and is now exercised by the new `tests/coverage/server-shutdown.test.js` (drain, close-failure exit 1, hard-stop paths).

### W4-F6 — OPEN (watch item): intermittent full-suite variance, still without a confirmed cause on a committed tree

- **Severity:** minor (process), potentially masking something worse — which is why it stays open.
- **History:** one implementer full-suite run in seven failed one test whose identity was lost to output truncation at `cca6787`. Verification chased it under a standing rule: capture COMPLETE output on every run, never truncate before reading.
- **What this run captured:** across ~14 full-suite runs by 8 lanes plus the coordinator and this report (all with complete logs), **three** failures were observed, all with identity preserved: (1) `rt01-degradation` drill 10 `TypeError … reading 'map'` — the failing file was a sibling verifier's **mid-edit working-tree file** (mtime postdates the run's output; current version passes 26/26 scoped); (2) `adr-wave4-invariants` "benign review publishes ONLY after the worker approves" got 404 from a host-reviews read, and (3) `rt01` drill 10 again with a fixture check-constraint violation — (2) and (3) occurred in one run of the mt-ut lane while both files were being concurrently edited by their owning lanes, and neither reproduced running the suites alone, as a pair, or in a predecessor chain. All three are therefore attributable to verification-time concurrent editing, **not** to the committed tree — but the *original* baseline failure was never identified, so this cannot be declared the same defect.
- **State on the final tree:** runs A and B of this report (62/1386, strict handles) plus the lanes' final runs are consecutive green. Static sweeps found no remaining fixed-budget or unscoped outbox drains (house rule b; the last two were re-scoped in W4-F1's repair).
- **What keeps it open / next step:** the team should keep capturing complete output on every CI and local full-suite run; if any failure appears, its identity is now guaranteed to be preserved. Close after a sustained streak on the **committed** tree (CI, cold runners) — see §9.

### W4-F7 — CLOSED by judgment (non-blocking recommendation recorded): pre-filter knobs live as frozen module constants, not in `src/config`

- **Severity:** advisory. (Flagged item 5, judged independently by five lanes with the same verdict.)
- **Judgment: acceptable as shipped.** `src/modules/moderation/prefilter.js` `RATE_LIMIT`/`BLOCKLIST` are `Object.freeze`'d, documented with the rationale (the shared `src/config/schema.js` was owned by no wave-4 unit — a real parallel-edit hazard at build time), and exported for tests, which pin `{windowMinutes: 60, maxSubmissionsPerWindow: 15}` so a silent change fails a test. They are **not** ADR-009 caps — those verifiably live only in `src/config/locale.js` (the executable capScan passed; `90` is also max latitude and is handled). No ADR binds non-cap tunables to `src/config`. **Recommendation (non-blocking):** migrate them into `src/config` in a wave that owns `schema.js`, for operator consistency.

### Carried-forward open findings from waves 0–3

- **F-04 → NFR-10 not measured** — still true; see the NFR-10 row and §7. The *pipeline* half is now closed; the *measurement* half is wave 7.
- **F-05 → NFR-07 has no subject** — still true; there is no client and the UT-01 study is unschedulable until waves 5–6 (§5). The a11y harness still fails by design so absence is never mistaken for coverage.
- **TCC-03 (FR-01 acceptance correction)** — recorded, awaiting team ratification at CDR.
- F-01 (drain determinism), F-02 (AB 1325 weekly cap), F-03 (NFR-12/13 absent), F-06 (ADR-007 data-use review), F-07 (backup expiry unexecutable), F-08 (soft-deleted host decision), F-09 (CI) were closed in previous rounds and stay closed; F-03's subject is now built and verified (NFR-12/NFR-13 rows), and F-07's executable half (prune logic) is now covered in-process (W4-F5).

---

## 5. Not verifiable in this environment

Not failures — checks whose evidence this repository cannot produce, with what a human must do.

| Check | Why it cannot be verified here | What the team must do |
|---|---|---|
| **UT-01 — 5-participant moderated usability study** (SRS §4.5) | A human activity; and there is still no interface to test. | Declared missed at CDR, on the record (team decision 2026-08-18). Protocol ready in `docs/ut01-usability-study-plan.md`; name participants and date at the CDR stand-up; run when wave 6 ships the interfaces; a human fills in its §6 record block. |
| **NFR-07 — axe-core WCAG 2.1 AA audit** | No rendered interface, no browser toolchain. | Pin the harness in wave 5, audit all seven named interfaces. Until then no violation count exists and none should be quoted. |
| **NFR-10 — live FP/FN measurement** | ADR-007/ADR-011 forbid the automated suite from calling a live provider (`NODE_ENV=test` force-pins the mock — re-verified by executed tripwires); the measurement is a deliberate, human-initiated wave-7 run. | Run `scripts/it03-eval.js` **once, live**, off-suite: record the model id and `PROMPT_VERSION`, write `RESULTS.md` with both rates and the set version, claim a pass only if both < 0.05. The label sign-off (2026-08-21) already satisfies ADR-008's human-label gate. |
| **NFR-09 — "99 % availability during the demo period"** | A deployment measurement over calendar time. | Record uptime during the demo window. The ten RT-01 drills are the *design* evidence, not the figure. |
| **NFR-12 — a real 30-day wall-clock erasure + backup expiry against a real backup target** | A 30-day window cannot elapse inside a test run; backup expiry needs a deployment's backup store. | The scheduling arithmetic, the due-instant execution and the prune logic are all proven by clock injection (§7); operationally, confirm the lifecycle cron (`scripts/backup.js`) is scheduled on the deployment and spot-check one real expiry. |
| **ST-01 — external TLS/certificate scan** | Protocol enforcement is fully executed here against a real `https.Server` with the dev certificate; certificate *validity* (chain, CA, expiry, hostname) needs a deployed host. | Run `testssl.sh`/SSL Labs against the deployed host once a real certificate is issued. |
| **AB-06 — ZAP crawl over the rendered client** | No HTML/client bundle exists; the scan harness itself fails a thin crawl by design so it cannot produce a vacuous pass. | Re-run `npm run scan:zap` after waves 5–6; confirm the URL count rises accordingly. |
| **CI on wave 4** | The wave-4 tree (and this run's repairs) are uncommitted; CI runs `origin/main`. | Human team commits and pushes, then confirms the cold-runner run is green (62 suites / 1386 tests expected). |

---

## 6. Suite determinism and process hygiene — measured, not asserted

- **Strict-handles discipline:** every run cited in this report ran under `TEST_STRICT_HANDLES=1`
  with `maxWorkers: 1`; runs A and B exited 0 with no open-handle warning and no `--forceExit`.
  Every suite closes what it opened in `afterAll` inside a `finally`, pairing `closeDb()` with
  `closeTestRedis()`; the globalTeardown 150 ms settle window is untouched.
- **Drain hygiene (house rule b / finding F-01):** a static sweep this run found every remaining
  `pollOnce` caller either scoped via `tests/helpers/outboxScope.js` (`pollOnlyThese` /
  `withOnlyTheseDue`) or using a deliberate drain-until-`claimed===0` loop with a runaway guard.
  The last two unscoped whole-table drains (in `adr-wave3-invariants` and `mt01-wave3-booking-audit`)
  were re-scoped as part of W4-F1's repair — they would otherwise have reddened the moment
  safety-alert filing switched on, which is exactly the class of coupling F-01 documented.
- **Test placement (house rule a):** an executed `find` confirms zero `*-reverify`, `*-w3rv-*`,
  `verify-*`, `*-gaps`, `*-probes` files exist (19 such files were consolidated into canonical lane
  files on 2026-08-21, which is why this report's "Test file" column differs from the wave-3
  report's). All wave-4 verification tests were added to the canonical lane files; the two new files
  are canonical homes (`adr-wave4-invariants` for the wave-4 ADR surface, `server-shutdown` for the
  coverage lane), not probe files.
- **Isolation:** every lane, and this report, used its own `_test` database, derived Redis db and
  derived MinIO bucket per `tests/helpers/env.js`; migrations were applied fresh (6, append-only,
  0006 highest) on each lane database.
- **Intermittent watch:** see finding W4-F6. All full-suite failures observed during this
  verification have preserved identities and are attributable to concurrent lane editing; none
  reproduced on the final tree.
- **Coverage (lane-measured on the baseline, `--coverage` full run, 60/1345 green):** statements
  ≈ 94 %+, functions 97.7 %+ overall; **all four wave-4 modules at 100 % functions** (messaging
  additionally at 100 % branches); the 14 uncovered functions repo-wide were individually audited —
  after the W4-F5/`wireShutdown` repairs, the remainder are trivial callbacks (encode/header
  arrows, a rejection-swallow) hiding no product logic. Zero `TODO`/`FIXME`/`not implemented`
  markers in `src/` or `scripts/` (executed grep + the standing coverage-lane test).

---

## 7. Measured numbers where the SRS demands them

### NFR-01 / NFR-02 — latency at scale (LT-01, LT-02)

Measured **on the wave-4 tree** with k6 v2.2.0 (darwin/arm64), 200 VUs, 30 s warm-up + 5 min
steady, real TLS, against the dev server backed by the NFR-02 volume dataset — **10,050 users /
1,002 active approved listings / 1,002 bookings / 1,001 approved reviews** (verified by direct SQL;
the harness refuses to start below the 1,000-listing floor). Artifact:
`docs/results/lt01-k6-summary-wave4.json`.

| Metric (steady phase) | Value | Budget |
|---|---|---|
| `http_req_duration` p95 | **123.26 ms** | < 500 ms — **met** |
| `http_req_duration` p99 | 159.88 ms | — |
| Error rate | **0.00 %** (0 of 1,131,196) | < 1 % — met |
| Throughput | ~3,797 req/s (1,256,114 requests total) | — |
| Per-endpoint p95 | search 2.83 ms · hostReviews **79.95 ms** (the new wave-4 read path) · listingDetail 132.77 ms · hostPage 158.74 ms | each < 500 ms — met |

The in-suite regression gate (`lt-volume-latency.test.js`, node VU loop, 200 VUs, 45 s) recorded
overall p95 **143.2 ms** / 0 errors over 155,310 requests in run A of this report — consistent with
the k6 measurement. EXPLAIN ANALYZE over the real search queries at volume: 0.03–0.90 ms across six
filter shapes, no sequential scan on listings, required indexes asserted present. FR-12's race is
re-proven at load (50 concurrent guests, 1 seat → exactly one 201).

*Caveat:* measured on a developer machine (M-series, local docker), not the deployment target.
The number is evidence of headroom (4× under budget), not a production SLA.

### NFR-05 — lockout behaviour (ST-03)

Config: `AUTH_LOGIN_MAX_ATTEMPTS=5`, `AUTH_LOGIN_WINDOW_SECONDS=600`. Executed at the exact
boundary: attempt 5 fails as invalid credentials; **attempt 6 returns 429 with `Retry-After`
even for correct credentials**; keys are account+IP in Redis with 600 s TTL, not extended by later
failures; successful login resets the counter; a 50-attempt brute force (AB-05) is locked from
attempt 6 throughout; IP-cycling across many accounts is also locked; the lockout response never
reveals whether the account exists.

### NFR-10 — moderation false-positive / false-negative rates

**Not measured. No number exists, and this report quotes none — not even provisionally.**

What exists, verified by execution this run: the full ADR-002 pipeline (pre-filter → LLM adapter →
human queue) and the scoring harness `scripts/it03-eval.js`, which scores all items exactly once in
the real pipeline order, records model id + `PROMPT_VERSION`, labels mock-scored reports
NOT-A-MEASUREMENT and refuses to emit rate fields for them (asserted key-by-key). The evaluation
set is `tests/fixtures/moderation-eval/v1/`: **224 items, 56 per category** (offensive / spam /
fraudulent / benign — balanced, ≥ 200, synthetic per ADR-008), with the human label sign-off
recorded in its manifest (**Gaetan Rieben, 2026-08-21, set v1**) — the ADR-008 label gate is
closed. Still missing for any claim: the wave-7 **live** IT-03 run with model id and prompt version
recorded and a `RESULTS.md` with both rates < 0.05. No `RESULTS.md` exists anywhere in the tree
(executed `find`), and no live provider call was made in this verification (ADR-007/ADR-011;
`NODE_ENV=test` force-pins the mock — re-verified by executed tripwires in three lanes).

### NFR-12 — erasure window coverage

The SRS's 30-day erasure cannot be observed in wall-clock time inside a test run; it is proven by
**clock injection** across three independent lanes, all executed green on this tree:

1. **Scheduling arithmetic:** `DELETE /api/users/me` → 202; the `data_requests` row and the
   `account.erasure` outbox job commit in the **same transaction** as the `deleted_at` mark (xmin
   equality across all three), and the job's `available_at` **equals** `data_requests.due_at`
   = `now() + config.privacy.erasureDays` (default **30**, from `PRIVACY_ERASURE_DAYS`) —
   asserted as timestamp equality, not approximately.
2. **Execution at the due instant:** the real `accountErasure` handler run at the simulated
   instant (injected clock) empties/anonymizes every §3.4 column (`email='erased:<id>'`,
   `full_name` NULL, `phone_enc`/`emergency_*_enc` NULL, `password_hash='erased'`,
   `anonymized_at` = the simulated instant, SQL-exact), deletes media **by key** from real MinIO
   (subsequent adapter GET 404s; exactly one `deleteByKey` call per owned key — ADR-004), and a
   full-database scan across all public tables finds **zero** rows carrying the user's PII markers.
   Reviews are retained anonymized; sessions are destroyed immediately at request time (401).
3. **Idempotency:** redelivering the erasure job leaves the users row and the data_requests row
   byte-identical (full-row snapshot equality) — the 30-day guarantee cannot be corrupted by
   outbox redelivery.

Backup retention: `scripts/backup.js pruneBackups` expires dumps older than
`BACKUP_RETENTION_DAYS`, now covered in-process on both CLI branches (W4-F5). A real backup
target still needs a deployment (§5).

---

## 8. What this report does not claim

Stated plainly, because an overstated CDR document is worse than none:

1. **No NFR-10 accuracy number**, in any form. The pipeline exists; the measurement does not.
   `claimability()===true` in the harness answers "*if* a live run were made, could its numbers be
   claimed" — preconditions only, never a pass.
2. **No NFR-07 accessibility result and no UT-01 study.** There is no client to audit or test.
3. **No 99 % availability figure** — only the NFR-09 degradation mechanisms, proven in ten drills.
4. **No AB-06 ZAP result over a rendered client** — API-boundary injection defenses are proven;
   the client crawl waits for waves 5–6.
5. **The 30-day erasure window is proven by clock injection, not by 30 elapsed days** (§7) — the
   scheduling arithmetic, due-instant behaviour and idempotency are exact, but no calendar month
   has passed.
6. **NFR-01/NFR-02 numbers are developer-machine measurements**, labelled as such; they are not a
   production SLA.
7. **Nothing in this tree is committed or CI-verified for wave 4.** `cca6787` plus the working-tree
   repairs have been verified locally by 8 lanes and this report; CI has executed only the wave-3
   baseline. The human team commits (house rule f), and the CI cold-runner result is the remaining
   independence check.
8. **Two spec-level decisions are pending and are NOT decided here:** photo-only reviews (W4-F2)
   and the standing FR-01 acceptance correction TCC-03 (ratification due at CDR). The FR-08
   flagged-message wording (W4-F4) was ratified and is disclosed, including its consequence.
9. **The intermittent-variance watch (W4-F6) is open.** Every observed failure has a preserved
   identity and an innocent explanation, but the original lost failure was never identified, so
   this report does not claim the suite has *always* been deterministic — only that runs A and B
   and the lanes' final runs on this exact tree were green with complete captured output.

---

## 9. Recommended order of work after this report

1. **Commit and push** (human team): `cca6787` + the working-tree repair round, then confirm CI
   green on a cold runner (expected 62 suites / 1386 tests). This also starts the W4-F6 evidence
   streak on a committed tree.
2. **At CDR (2026-08-22):** ratify TCC-03 (FR-01 degraded-flag correction) and W4-F4 (FR-08
   queue-on-flag/hide-on-rejection) as recorded; decide W4-F2 (photo-only reviews) — if option (b),
   schedule the schema+pipeline change as one unit.
3. **Waves 5–6 (client):** unblocks NFR-07, the UT-01 study, and AB-06's ZAP clause — the only
   non-met rows left in §3.
4. **Wave 7 (one live IT-03 run):** off-suite, record model id + prompt version, write
   `RESULTS.md`; NFR-10 becomes claimable only if both rates < 0.05.
5. **Housekeeping (non-blocking):** consolidate the pre-filter knobs into `src/config` (W4-F7)
   in a wave that owns `schema.js`; keep the complete-output rule for every full-suite run.
