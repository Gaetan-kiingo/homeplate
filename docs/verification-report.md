# Homeplate v1.0 — Verification Report (waves 0–6)

**Prepared for:** Critical Design Review, 2026-08-22 · MSCS 2101, Group 6
**Requirements baseline:** SRS v3.2 (frozen). Where the SPMP or an ADR contradicts it on a
requirement, the SRS wins (SPMP §1.1.2). Where the SRS leaves a mechanism open (§2.4), ADR-001…011
bind.
**Scope of this report:** waves 0–6. Waves 0–4 (the complete backend) were verified in the wave-4
round — eight independent lanes re-executed every acceptance clause — and wave 5 (the client
foundation: shell and routing, typed-error API client, session handling, WCAG-AA UI kit) in the
wave-5 round; both are committed, pushed and CI-green at `e8a610d`. **Wave 6 added the client
feature screens**: all seven NFR-07 interfaces now exist as real screens over the finished
waves-0–4 API, built by four units on the wave-5 foundation, verified by five independent
verify-only lanes (findings JSONs under `docs/_generated/wave6-verify/`), repaired in one round
(U6R-FIX, `wave6-verify/repairs.json`), and re-gated (§3.6). Every backend suite cited in §3
re-ran green inside this round's full-suite runs on the wave-6 tree. After the round's first
report stamp, two previously-outstanding instruments were executed and recorded on this tree:
a fresh **k6 LT-01/LT-02 run** (steady p95 **120.07 ms**, 0.00 % errors —
`docs/results/lt01-k6-summary-wave6.json`, §7) and the **AB-06 OWASP ZAP baseline over the
rendered client** (**0 High** across 30 URLs, gate exit 0 — `docs/results/zap-baseline-RUN.md`,
§3.3/§4), so AB-06 moves to Met. **Wave-7 addendum (2026-09-11):** the live NFR-10 measurement **was run** — one IT-03 pass of the
224-item set through `gemini-3.5-flash-lite` with `moderation-prompt-v1`: **FP 7.14 % (4/56), FN 1.19 %
(2/168)**, so the FN bound is met and the FP bound is **not**; NFR-10 stays Partial, now with a measured
number (`tests/fixtures/moderation-eval/v1/RESULTS.md`, §7). The wave-7 seeded-id accessibility
audits and the UT-01 five-participant study are still **not run**, and this report never reports an
unrun activity as a pass. **Same-day addendum (evening):** the team closed **OBS-B3** by shipping host
listing management in the client (ADR-013: create, edit, cancel, "Your meals" over a new owner-only
`GET /api/listings/mine`), added a **price per seat** beyond the frozen SRS (ADR-012, migration 0007),
and a header **Sign out** control; the accessibility harness now audits **13 of 13** non-parameterized
routes clean with **7** parameterized routes still unaudited (the owner edit page joined the list). The
FR-11 client column is now an exercised flow: the daily listing cap was triggered through the UI during
the rehearsal. Details and the six rehearsal findings: `docs/implementation-increment-code-review-log.md` §2.8.

---

## 1. Status line

| Field | Value |
|---|---|
| Report date | 2026-08-26 |
| Commit (`git rev-parse --short HEAD`) | **`e8a610d`** ("Ratify FR-05: a review comment is required" — waves 0–5 committed, pushed, CI green) |
| Working tree | **Contains wave 6 and its verification round, UNCOMMITTED** on top of `e8a610d`: five new feature trees `client/src/features/{discovery,booking,community,account,moderation}` (38 source files + 15 vitest spec files); the five lane findings JSONs and the repair record under `docs/_generated/wave6-verify/`; two **re-baselined** backend guard files (`tests/coverage/coverage-lane.test.js`, `tests/adr-conformance/adr-wave5-client-invariants.test.js` — findings W6-G1/W6-G2, §4); the regenerated in-suite latency artifact `docs/results/lt01-in-suite-latency.json`; the two new instrument records — the wave-6 k6 run (`docs/results/lt01-k6-summary-wave6.json` + `.provenance.json`) and the AB-06 ZAP baseline (`docs/results/zap-baseline-RUN.md` + `.html/.json/.md`, URL list, summary); the keyboard spot-check script `tests/mt-ut-quality/ut01-keyboard-spotcheck.js` (plain node + playwright — not a jest suite, backend counts untouched); four further lane-edited canonical backend test files (`tests/tc-core/tc05-reviews.test.js` +1 test, `tests/coverage/migrate-cli.test.js` +2 tests, `tests/it-adapters/it01c-adapter-depth.test.js` title-only, `tests/st-security/st-security-wave3.test.js` count-neutral hardening — §1, COV-W6-11); and this report + inventory + build-plan revision. **No backend production file (`src/`, `db/`, `scripts/`) changed in wave 6** — verified by `git status`; the backend-suite contract moved 63/1397 → **63/1400** through the round's own repair lanes (three canonical tests added — §1, COV-W6-11). The human team commits (house rule f). |
| Previous verified baseline | `e8a610d` itself (waves 0–5: **32 met / 3 partial / 0 not implemented**, pushed to `origin/main`) |
| CI state | **Green at `e8a610d`** (the waves-0–5 gates: backend 63/1397, client 17/218 at that tree, both builds, lint). CI has NOT executed wave 6: the feature trees are uncommitted. No workflow change is needed — the existing client steps pick up the new specs on commit. |
| Test framework | Backend: Jest 29 + Supertest against PostgreSQL 16, Redis 7 and MinIO (docker compose), `maxWorkers: 1`, `TEST_STRICT_HANDLES=1`. Client: Vitest 2 + Testing Library (jsdom) in the separate `client/` package. A11y: `scripts/a11y-audit.js` — axe-core (wcag2a+wcag2aa) via `@axe-core/playwright` over the built client. |

### Commands run for this report, and their real output

The post-repair wave-6 gate ladder, **re-executed in full by the report author on the final tree
on 2026-08-26** (after U6R-FIX), independently of the two identical post-repair runs recorded in
`wave6-verify/repairs.json`. Complete output was captured to files and inspected in full — never
piped to `tail` first.

| Command | Result |
|---|---|
| `TEST_STRICT_HANDLES=1 npm test` (full backend suite) | **Round-final re-stamp (2026-08-26, COV-W6-11):** `Test Suites: 63 passed, 63 total` · `Tests: 1400 passed, 1400 total` · `Time: 96.133 s` · exit **0** · zero `✕`/`FAIL` lines, no open-handle warning. **Independently re-executed once more for this final revision (2026-08-26): `63 passed, 63 total` / `1400 passed, 1400 total` · 95.663 s · exit 0** — the count is now confirmed by two consecutive independent full runs. Earlier in the round, three consecutive green runs measured 63/1397 on this tree (U6R-FIX twice post-repair at 95.2 s / 97.4 s, report author at 94.261 s) before concurrent repair lanes added three canonical tests (§1); every run included the two re-baselined guards and `st-security-wave3` under full contention (the W6-G3 flake did not reproduce). |
| `npm --prefix client test` (vitest run) | `Test Files 32 passed (32)` · `Tests 344 passed (344)` · exit **0** (re-run for this final revision: 32/344 in 3.30 s) — baseline was 17/218; wave 6A added 15 spec files / 119 tests and the repair round 7 more specs |
| `npm run lint` (`eslint . && prettier --check .`) | exit **0** · `All matched files use Prettier code style!` — the `client/**` override (`react`/`react-hooks`/`jsx-a11y`) is active on every wave-6 file; client source is **linted**, not ignored |
| `npm run build` (`scripts/check-build.js`) | exit **0** · `6 file(s), naming and ordering valid` (migrations — 0006 highest, wave 6 added none) · `112 file(s) parse cleanly` · `createApp() boots against the .env.example environment` |
| `npm --prefix client run build` (Vite 5) | exit **0** · `127 modules transformed` · `dist/` built (index.html 0.49 kB · css 16.91 kB · js 313.66 kB, gzip 96.98 kB) |
| `npm run test:a11y` (`scripts/a11y-audit.js`) | exit **1 by design — the honest wave-6 end-state**: **7 of the 7 NFR-07 interfaces exist on this tree**; all **11 non-parameterized routes audited CLEAN** (0 serious/critical wcag2a+wcag2aa violations on `/`, the 404 catch-all, `/login`, `/signup`, `/verify-email`, `/account`, `/bookings`, `/bookings/new`, `/search`, `/moderation`, `/moderation/alerts`); keyboard checks pass (first Tab reaches the skip link; activating it focuses `#main`); the 6 blocking items are **exactly** the parameterized routes awaiting wave-7 seeded fixture ids (`/listings/:id`, `/hosts/:id`, `/bookings/:bookingId`{`,/messages`,`/review`,`/safety-alert`}). The script itself prints the reminder that even at 7/7 green, NFR-07 additionally requires the recorded UT-01 study. |
| Grep gates (re-executed for this report) | `document.cookie` under `client/src`: **0** hits (opaque HttpOnly session intact, NFR-03/ADR-006) · hex colour literals in `client/src/App.css` and every feature `*.css`: **0** (token-only styling, NFR-07 contrast gate) · MEHKO cap literals (1/30/90) in the booking error rendering: **0** — every cap number and reset boundary comes from the server error payload (FR-11/ADR-009) |
| `k6 run … tests/load/smoke.js` (**re-run on the wave-6 tree this round** — `docs/results/lt01-k6-summary-wave6.json` + `.provenance.json`) | k6 v2.2.0, 200 VUs, 30 s warm-up + 5 min steady, real TLS, isolated api+worker over a throwaway NFR-02 volume DB (10,000 users / 1,000 approved listings / 1,000 bookings): **steady p(95) 120.07 ms**, error rate **0.00 %** over 1,028,672 steady requests (3,413.9 req/s); per-endpoint p95 search 2.86 / listingDetail 109.05 / hostPage 129.2 / hostReviews 68.11 ms — all thresholds passed. Run with sibling lanes active (load avg 4.87), so the pass is conservative. The prior wave-4 artifact (p95 123.26 ms) stays on record. The in-suite regression gate (`lt-volume-latency.test.js`) also re-ran green inside this round's full-suite runs. |
| `npm run scan:zap` (**run this round** — record `docs/results/zap-baseline-RUN.md`) + `npm run scan:zap:report` (gate re-executed for this revision) | ZAP 2.17.0 (docker, digest pinned) over the served wave-6 production build (`vite preview`, HTTPS, `/api` proxied to the real server; dedicated DB/Redis/bucket): `FAIL-NEW: 0` · **High: 0** · Medium: 2 · Low: 2 · Info: 4 · **30 distinct URLs** (floor 8) · gate exit **0**. Every Medium/Low is the same finding four ways — the `vite preview` scaffold sends no CSP/HSTS/XCTO/anti-clickjacking headers on static documents; not one instance is on an `/api/*` response (the Express API sends all four). Triaged accepted-with-reason in the run record, with the deployment follow-up named (whatever edge serves `client/dist/` in production must send them). |

**The canonical backend-suite contract is re-stamped: 63 suites / 1400 tests, exit 0 under
`TEST_STRICT_HANDLES=1`** (fresh full run, 2026-08-26, 96.1 s — closing finding COV-W6-11). Wave 6
itself added no backend suite and touched no backend production file; the verification round's own
concurrent repair lanes moved the count 1397 → 1400 after the three consecutive 63/1397 runs:
`tests/tc-core/tc05-reviews.test.js` **+1** (the ratified FR-05 comment-REQUIRED refusal matrix)
and `tests/coverage/migrate-cli.test.js` **+2** (CLI error-path coverage); the `it01c-adapter-depth`
edit (title only) and the `st-security-wave3` hardening are count-neutral. The static diff vs
`e8a610d` corroborates the arithmetic: +6/−3 `test(` declarations, net **+3**.
The two wave-5 scope-guard files were re-baselined **in place** (W6-G1/W6-G2, §4) without changing
the suite or test counts. **The client contract is restated: 32 files / 344 tests** supersedes the
wave-5 statement of 17/218 (the same re-baselining rule as ADRC-W5-01: the wave-6A screen specs
plus 7 repair-round specs are canonical; no gate may pin 17/218 any longer). The root `npm test`
still means exactly the backend suite. No run hung; `--forceExit` was never used.

The wave-4 round's evidence base is unchanged and remains on record: its eight verification lanes
each ran on fully isolated resources (own `_test` database, own Redis db, own bucket), every cited
test file exists on disk, and every one of those lane files appears in this round's 63/1397 runs
with its wave-4 assertions passing. The wave-5 evidence base likewise: all 218 wave-5 client tests
re-ran green inside this round's 344.

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
canonical lane files on 2026-08-21). Every evidence sentence below describes an **executed** test,
not a code reading: the wave-0–4 rows were established by the wave-4 round's lanes and its runs
A/B (62 suites / 1386 tests on that tree), and every cited backend suite re-ran green inside this
round's 63 / 1397 full-suite runs on the wave-6 tree (three consecutive post-repair runs, §1).
The wave-6 **client surfacing** of the requirements is verified separately in **§3.6** — the
rows below remain the server-side truth the screens consume.

### 3.1 Functional requirements

| Req | Design element (SRS App. B) | Implementing file(s) | Test ID | Test file | Status | Evidence |
|---|---|---|---|---|---|---|
| **FR-01** | Search Service, Listing Service, Google Maps Adapter | `src/modules/search/{routes,service,repo}.js`, `src/adapters/maps.js`, `src/lib/cache.js` | TC-01, LT-01 | `tests/tc-core/tc01-search.test.js` | **Met** | Re-executed green on the wave-4 tree: every filter alone and combined returns exactly the expected ids; pending/rejected/past listings never returned; repeat query = zero adapter calls; Redis cache holds public precision only (ADR-010); Maps-outage behaviour proven in the three ratified cases (fresh page-cache 200 / stale-adapter `degraded:true` never cached / cold 503 `SEARCH_DEGRADED`). Disclosed: FR-01 carries the recorded acceptance correction **TCC-03** (self-contradictory degraded-flag clause, corrected 2026-08-14, no code change) — still awaiting team ratification at CDR. |
| **FR-02** | Meal Detail View | `src/modules/listings/{routes,service,serializers}.js`, `src/modules/hosts/repo.js`, `src/lib/mediaUrls.js` | TC-02 | `tests/tc-core/tc02-listing-detail.test.js`, `tc05-reviews.test.js` | **Met** | All fields present and equal to seed; pending/rejected 404 to strangers; ADR-010 disclosure matrix (exact address only to pending/in-progress guest or alert-handling moderator, access-logged). **New wave-4 clause executed:** a pending review is absent from `GET /api/listings/:id` and appears only after a human `POST /api/moderation/queue/:id/decision` approval. |
| **FR-03** | Host Profile Service | `src/modules/hosts/{routes,service,repo,serializers}.js` | TC-03 | `tests/tc-core/tc03-host-profile.test.js`, `tc05-reviews.test.js` | **Met** | Host page exactly the public allowlist; wave-4 addition executed: review lifecycle on the host page (pending→invisible, approved→visible with rating/author intact, rejected→never visible). |
| **FR-04** | Booking Service (completion confirmations) | `src/modules/bookings/{routes,service,repo}.js`, `db/migrations/0004` | TC-04 | `tests/tc-core/tc04-completion.test.js` | **Met** | Dual confirmation asserted in response AND database (one confirm → still `in_progress`, `completed_at` NULL; both → `completed` + timestamp); concurrent guest+host completes exactly once; 403/409/401/404 matrix. The 0001 CHECK `bookings_completed_requires_both_confirmations` enforces it at schema level (observed rejecting a bad fixture in MT-01). |
| **FR-05** | Review Service | `src/modules/reviews/{routes,service,repo}.js`, `src/schemas/reviews.js`, `src/outbox/handlers/moderationScan.js` | TC-05 | `tests/tc-core/tc05-reviews.test.js` (first verification) | **Met** ¹ | Only completed-booking participants, both directions, max two per booking (409 `REVIEW_EXISTS`, opposite direction still allowed); rating integer 1–5 (422 for 0/6/2.5/'5'/null); review born `moderation_status='pending'` with its `moderation.scan` outbox row in the **same transaction** (xmin equality) and IDs-only payload; invisible on all three read paths until human approval, rejected never visible; `imageKeys` become `media_objects` rows in the creating transaction; foreign-namespace key → 403, no row. ¹ **W4-F2 closed 2026-08-26:** photo-only reviews are refused (comment required, min 1 char) by **ratified team decision**, not by an unexamined default — the SRS leaves it open and the team chose. Recorded in the FR-05 `specDecision` and the `src/schemas/reviews.js` header. |
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
| **NFR-01** | REST API, Redis Cache | `src/app.js`, `src/routes/index.js`, `src/lib/cache.js` | LT-01 | `tests/load/smoke.js` (k6) → `docs/results/lt01-k6-summary-wave6.json`; in-suite gate `tests/rt-lt-resilience/lt-volume-latency.test.js` | **Met** | **Re-measured on the wave-6 tree this round**: steady-phase p95 **120.07 ms** against the 500 ms budget at 200 VUs sustained 5 minutes, error rate **0.00 %** over 1,028,672 steady requests — full numbers and provenance in §7. Per-endpoint p95 all under 130 ms (`hostReviews` 68.11 ms). The wave-4 measurement (p95 123.26 ms) stays on record as the prior instrument run. |
| **NFR-02** | Backend System, PostgreSQL | `db/migrations/0002`, `src/modules/search/repo.js`, `scripts/seed.js --set volume` | LT-02 | `tests/rt-lt-resilience/lt-volume-latency.test.js` + the k6 artifact | **Met** | Re-executed this round: the wave-6 k6 run was made against a freshly seeded volume DB at the NFR-02 floor (10,000 users / 1,000 approved active listings on one America/Los_Angeles day / 1,000 bookings; the harness refuses to start below 1,000 listings) and still measured steady p95 120.07 ms; the in-suite LT-02 blocks re-verified the dataset floors, the required-index inventory, and EXPLAIN ANALYZE of the exact production search SQL — 0.03–0.77 ms across all six filter shapes, **no sequential scan** on listings. |
| **NFR-03** | Network Security Layer (TLS) | `src/server.js`, `src/middleware/security.js` | ST-01 | `tests/st-security/st-security.test.js` | **Met** | Live `https.Server` negotiates TLS 1.2/1.3 and refuses 1.0/1.1; plain HTTP never answered with app content; `enforceTls` 403 + HSTS ≥ 15552000; production config fails closed. Certificate validity needs a deployment (§5). |
| **NFR-04** | Authentication Service | `src/modules/auth/passwords.js` | ST-02 | `tests/st-security/st-security.test.js` | **Met** | Argon2id (memoryCost 19456 KiB, timeCost 2 — OWASP floor); plaintext in no column; per-user salt; no logger/serializer emits a raw password field (repo-wide grep test). |
| **NFR-05** | Authentication Service (rate limiting) | `src/modules/auth/rateLimit.js`, `src/config/` | ST-03 | `tests/st-security/st-security.test.js` | **Met** | Exact 5-failures-in-600 s boundary executed — numbers in §7. |
| **NFR-06** | Eligibility Policy, Email Verification | `src/modules/eligibility/policy.js`, `src/modules/auth/service.js` | IT-02 | `tests/it-adapters/it02-verification-eligibility.test.js` | **Met** | register → outbox → worker → transport → delivered body URL → `email_verified` flips → eligibility recomputed; outage leaves the job queued, delivery completes on recovery. |
| **NFR-07** | Web UI (React) | `client/`: wave-5 foundation (`src/{main,App,routes}.jsx`, `src/layout/**`, `src/api/**`, `src/session/**`, `src/ui/**`, `src/styles/**`) **+ wave-6 screens** (`src/features/{discovery,booking,community,account,moderation}/**`) | UT-01 | client vitest suite (32 files / 344 tests) + `npm run test:a11y` (axe-core harness, exit 1 by design) + the four wave-6 lane JSONs (§3.6) | **Partial** (progressed: all seven interfaces now exist) | **Wave 6 landed all seven NFR-07 interfaces as real screens** — search/browse `/search`, listing detail `/listings/:id`, host profile `/hosts/:id`, booking flow `/bookings`(+`/new`,`/:bookingId`), signup/login `/login`+`/signup`, messaging `/bookings/:bookingId/messages`, moderator queue `/moderation` — on the wave-5 kit (landmarks + one `h1` per screen via `usePageTitle`, `FormField`-labelled controls, `Img`-enforced alt, `StatusAnnouncer` aria-live announcements, token-only contrast, visible focus). Executed evidence: **all 11 non-parameterized routes audit CLEAN** at wcag2a+wcag2aa (0 serious, 0 critical — §1 ladder) and the keyboard checks pass; each lane re-verified the checkable clauses per screen (landmarks/heading order, labels, focus, alt, aria-live wiring, token-only styling — `wave6-verify/{discovery,booking,community,account-mod}.json`). **NFR-07 stays OPEN, deliberately:** (1) the 6 parameterized routes are PRESENT but unaudited until wave 7 seeds fixture ids — the harness exits 1 naming exactly those, so partial coverage can never read as closure; (2) the recorded **5-participant UT-01 study is a human activity that has not run** (protocol ready at `docs/ut01-usability-study-plan.md`; the interfaces it needs now exist). A 7/7-clean harness alone does not close this row. |
| **NFR-08** | Logging & Monitoring Service | `src/lib/logger.js`, `src/middleware/{requestContext,errorHandler}.js`, audit sites across `src/modules/*` and `src/outbox/handlers/*` | MT-01 | `tests/mt-ut-quality/mt01-log-completeness.test.js`, `mt01-wave3-booking-audit.test.js` | **Met** (was Partial) | All four named actions now audit-verified by execution: registration, booking create, cancellation, and — newly performable in wave 4 — the **human moderation decision** (one `moderation.decision` record with decider/entity/decision id; `moderation_decisions` row `decided_by='human'`; queue item resolved; non-moderator attempt 403 with failure record). Correlation IDs proven on both sides of every wave-0–4 outbox handler incl. `moderationScan`/`dataExport`; error records structured with stack server-side only; two full captured log corpora show **zero** PII (no email-shaped bytes, no §3.4 field, no message/review content, no street address). Wave-4 events `review.created`, `message.sent`, `privacy.export_requested/_completed`, `privacy.deletion_requested`, `safety.alert_raised/_delivered` all executed. |
| **NFR-09** | External Service Adapters, Deferred-Work Mechanism | `src/lib/resilience.js`, `src/adapters/*`, `src/outbox/worker.js` | RT-01, RT-02 | `tests/rt-lt-resilience/rt01-degradation.test.js`, `rt01-provider-outage-drill.test.js`, `rt02-outbox.test.js` | **Met** (mechanisms) | Ten per-service outage drills incl. the **new drill 10** on wave-4 surfaces: under LLM outage a review stays pending and invisible while the message still delivers; recovery completes the *same* jobs. Crash-recovery/exactly-once/backoff/dead-letter/concurrent-workers all executed; operator recovery via `scripts/requeue-dead-letters.js` proven end to end. The 99 % availability *figure* needs a deployment (§5). |
| **NFR-10** | Moderation accuracy (FP and FN < 5 %) | pipeline: FR-08 files; eval set `tests/fixtures/moderation-eval/v1/`; harness `scripts/it03-eval.js` | IT-03 | `tests/it-adapters/it03-moderation-eval.test.js` (mechanics only) | **Partial — MEASURED 2026-09-11, NOT MET** | **FP 7.14 % (4/56 benign) — fails the < 5 % bound; FN 1.19 % (2/168 violating) — meets it.** One live IT-03 run, off-suite, through the real pipeline order (pre-filter answered 2 items, the model 222), `gemini-3.5-flash-lite`, `moderation-prompt-v1`, claimability preconditions all satisfied (label sign-off Gaetan Rieben 2026-08-21, live model id, prompt version). Record: `tests/fixtures/moderation-eval/v1/RESULTS.md` + `it03-live-run.json`. A second model measured in parallel (`gemini-3.1-flash-lite`) gave FP 5.36 % / FN 0.60 % — same verdict, same failing items. All false positives are benign items that mention cash payment; see §7 for why that is a prompt/label boundary question for the team, not model noise. The suite still pins the mock (`NODE_ENV=test`, re-verified); no rate is ever computed from it. |
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
| **AB-06** Injection attacks (SQLi / XSS) | Input Validation Module | `src/middleware/validate.js`, `src/schemas/*`, `.github/zap/baseline-plan.yaml` | ST-04 | `tests/st-security/st-security.test.js`; ZAP record `docs/results/zap-baseline-RUN.md` | **Met** | Both halves now executed. **In-suite (re-run green this round):** hostile payloads at **every** API boundary incl. all wave-4 surfaces: typed 422, no 500, tables intact, stored/returned text escaped, no concatenated SQL, all routes schema'd; an independent grep confirms every user filter value is bound as `$N` — no string-concatenated SQL anywhere in `src/`. **ZAP baseline (run this round, closing STSEC-01):** ZAP 2.17.0 over the served wave-6 production build with `/api` proxied to the real server — **0 High** / 2 Medium / 2 Low / 4 Info across **30 distinct URLs** (floor 8), `npm run scan:zap:report` gate exit **0** (re-executed for this revision). Every Medium/Low instance is the `vite preview` static-file scaffold omitting standard security headers on documents it serves — **not one is on an `/api/*` response** (the Express API sends CSP, HSTS, XCTO and X-Frame-Options on every response, verified during the run). Triaged accepted-with-reason in the run record; the named deployment follow-up (the production edge that serves `client/dist/` must send those headers) is a wave-7 close-out item, disclosed, not a defect in repo-owned code. |
| **AB-07** MEHKO evasion via duplicate accounts | Registration/Email Verification, Listing Service, Logging | `src/modules/auth/service.js`, `src/modules/listings/mehko.js` | TC-10, TC-11, MT-01 | `tests/st-security/st-security.test.js`, `st-security-wave3.test.js` | **Met** | Duplicate email 409 (unique constraint, audited); unverified host with profile+agreement still 403; daily cap server-side in one place backed by the DB unique index. |
| **AB-08** Scraping of personal data | Session auth, Eligibility Policy, data minimization | `src/modules/auth/middleware.js`, `src/modules/{listings,hosts}/serializers.js`, `src/modules/listings/access.js` | ST-06, ST-04 | `tests/st-security/st-security-wave3.test.js` | **Met** | Every endpoint 401 unauthenticated; search/host/listing payloads exactly the public allowlists; exact address only to a pending guest, reverting on cancel; export owner-only; wave-4 additions: moderation queue excerpts leak no street/coordinate/email (deep JSON scan), message payload is the exact allowlist. |

### 3.4 Summary count

| Status | FR | NFR | AB | Total |
|---|---|---|---|---|
| **Met** | **14** | 11 | **8** | **33 / 35** |
| **Partial** | 0 | 2 (NFR-10 — **measured 2026-09-11, not met**: FP 7.14 % against the 5 % bound, FN 1.19 % within it; NFR-07 — all seven interfaces built and audited clean where auditable, seeded-id audits + UT-01 study outstanding) | 0 | **2 / 35** |
| **Not implemented** | 0 | 0 | 0 | **0 / 35** |

Movement since the `e8a610d` waves-0–5 baseline (32 / 3 / 0): **one status changed — AB-06
Partial → Met**, on the strength of an executed instrument, not a re-reading: the OWASP ZAP
baseline over the rendered wave-6 client was run this round (0 High, 30 URLs, gate exit 0 —
record `docs/results/zap-baseline-RUN.md`, closing STSEC-01). Wave 6 was scoped to land the
seven NFR-07 interfaces, and it did (7/7 present, all 11 non-parameterized routes audited clean,
§3.6); but NFR-07's acceptance also names the seeded-id audits of the six parameterized routes
(wave 7) and the recorded 5-participant UT-01 study (human), so it stays **Partial** — materially
progressed, not closed. NFR-10 stays Partial (the live IT-03 measurement is wave 7; no number
exists and none is quoted). Movement history for waves 0–5 is preserved in the `e8a610d` report
revision.

### 3.5 Wave-5 client foundation (SRS §2.1.2) — verified in the wave-5 round

Wave 5 carries no requirement row of its own — it is the foundation NFR-07 and the wave-6 screens
stand on — so its verification is recorded here. All of the following was **executed** in the
wave-5 round's gate ladder (218 client tests, the 9-test ADR-conformance suite inside the backend
run, the axe harness), not read from source — and every one of those checks re-ran green inside
this round's ladder (the 218 are a subset of the 344; the conformance suite was re-baselined by
W6-G2 without losing its ADR-010 direction, §4):

- **SRS §2.1.2 — responsive React WEB app, not React Native (WA-9):** `client/` is a Vite 5 +
  React 18 + react-router 6 **web** package (jsdom-tested, browser-linted); it ships as its own
  npm package so the root backend contracts are untouched.
- **Shell and routing:** `/` renders the landmark shell and the skip link works end to end (axe
  keyboard check); unknown paths render the 404 catch-all; feature routes glob-mount from
  `client/src/features/*/routes.jsx`, so wave 6 adds screens without editing shared shell files
  (`routes.test.jsx`).
- **API client:** typed error envelopes surface the stable **code** (`NOT_ELIGIBLE` with reason
  codes, `MEHKO_DAILY_LISTING_LIMIT`, `NO_CAPACITY`, `SEARCH_DEGRADED`, …), never a stringified
  body, so wave-6 screens can render a real message per code and announce it via the aria-live
  channel; NFR-09 degraded search — 200 + `degraded: true` **and** typed 503 `SEARCH_DEGRADED` —
  is modelled as a first-class result state, not an exception; the endpoint map mirrors the real
  mounted surface of `src/routes/index.js`, none invented (`http.test.js`, `search.test.js`,
  `endpoints.test.js`).
- **Session (ADR-006):** authentication state is inferred from API responses (401 handling) with
  credentials sent on every request; the opaque HttpOnly cookie is never read — no client file
  touches `document.cookie` (`SessionProvider.test.jsx` plus the executed conformance grep).
- **UI kit, WCAG-2.1-AA by construction:** the NFR-07 row above itemizes the shipped and tested
  accessibility machinery (landmarks, labels, focus management, alt enforcement, announcer,
  measured contrast and focus tokens).
- **ADR conformance (`tests/adr-conformance/adr-wave5-client-invariants.test.js`, 9 tests, runs
  inside the backend suite):** no `document.cookie` read anywhere under `client/src` (ADR-006); no
  TLS-verification bypass in client config, client source or the a11y harness, and the Vite dev
  proxy verifies the self-signed dev certificate via an explicit CA — never `secure: false`
  (NFR-03); `client/src/api/types.js` documents **exactly** the backend PUBLIC wire shape —
  coarse coordinates + area label, every precise-address key absent — and no non-test client
  module dereferences a privileged address key unconditionally (ADR-010/NFR-13); no provider,
  model id or key literal under `client/` (ADR-007); no import under `client/src` resolves into
  the server tree, adapters included — the client talks HTTP only (ADR-001).

**Deliberately not claimed at the wave-5 round** (state then; §3.6 records what wave 6 changed):
no wave-6 screen existed (the harness proved 0/7 interfaces at `e8a610d`); NFR-07 remained open;
no ZAP run over the rendered client was recorded; no UT-01 study occurred.

### 3.6 Wave-6 feature screens — first verification, this round

Wave 6 built the four client feature units on the wave-5 foundation (no second kit, API layer or
session store — re-verified by lane grep and by lint), each verified by its own verify-only lane
with zero source edits, then repaired in one round. Evidence files, all under
`docs/_generated/wave6-verify/`: `discovery.json`, `booking.json`, `community.json`,
`account-mod.json` (per-clause verdicts), `gates.json` (full ladder + a11y coverage record),
`repairs.json` (U6R-FIX, per-finding cause → fix → re-execution). Everything below was
**executed** — by the lanes on the built tree, and re-executed after repair in the §1 ladder.

| Unit | Screens (routes) | Client surface verified (lane, all clauses PASS post-repair) |
|---|---|---|
| **U6-DISCOVERY** | `/search`, `/listings/:id`, `/hosts/:id` | **FR-01** search: every `src/schemas/search.js` filter and nothing invented; ISO-instant datetimes (never zoneless); filters and paging live in the URL (shareable, back-button-safe, bounded pages); client-side validation via ErrorSummary without firing an invalid request. **FR-02** detail: every serializer field rendered (cross-checked one-to-one against `PUBLIC_KEYS`/`DETAIL_CONTEXT_KEYS`/`HOST_SUMMARY_KEYS` — none invented), LA-wall-clock schedule, honest allergen-absent copy, typed 404 state, owner sees pending **and** rejected moderation notices (rejected spec added as repair D-02), Reserve CTA only while seats remain, cross-feature navigation by URL string only. **FR-03** host page: exactly `HOST_PAGE_KEYS`, honest empty states, review paging with announced failures. **NFR-09** all three search states executed: `ok`, `degraded` (stale results under a visible **and announced** explanation), `unavailable` (typed 503 `SEARCH_DEGRADED` with the server's message + retry) — never a bare spinner or crash. **AB-08/ADR-010**: coarse `areaLabel` only on every public view; precise coordinates never rendered; the exact address renders **only** when the server's booking-gated serializer included it, with presence-guard (the disclosure-note copy corrected by repair D-01 to the real pending/in-progress trigger). (`discovery.json`; specs `SearchPage/ListingDetailPage/HostProfilePage.test.jsx`) |
| **U6-BOOKING** | `/bookings`, `/bookings/new`, `/bookings/:bookingId` | **FR-09 — the flagship error surface**: all five eligibility reason codes (`EMAIL_UNVERIFIED`, `NAME_MISSING`, `PHONE_MISSING`, `HOST_PROFILE_INCOMPLETE`, `HOST_AGREEMENT_MISSING`, plus `USER_NOT_FOUND`) render distinct WHAT + HOW copy with working fix links to real routes; the email fix is an **action** (resend-verification POST with announced outcome), not just a link. **FR-12**: `NO_CAPACITY` and the pending-limit refusal are distinct, human, announced. **FR-11/ADR-009**: cap refusals name WHICH cap and WHEN it resets **from the error payload's `details`** (`limit`, `localDate`, `weekStart`/`weekEnd`, `alreadyScheduled`) — grep-proven zero 1/30/90 literals in client code (see the OBS-B3 caveat below). **FR-14**: cancel gated by start time, honest neutral copy on an unparseable start (repair F-B2 — the client never claims "the meal has started" on data it cannot verify). **FR-04**: dual-confirmation state rendered truthfully (one confirm ≠ completed). **FR-13**: booking status changes surfaced with the honest statement that notifications go by email (ADR-011 — no in-app feed endpoint exists, and none was invented). (`booking.json`, clauses C1–C7) |
| **U6-COMMUNITY** | `/bookings/:bookingId/messages`, `…/review`, `…/safety-alert` | **FR-05**: the ratified comment-required rule (W4-F2) is marked on the form **before** submit; a photo-only review is blocked client-side with an explanation and **zero outbound requests**; `REVIEW_EXISTS`/`BOOKING_NOT_COMPLETED`/`VALIDATION_FAILED` render per-code copy into the assertive live region; the success state says **born pending — not public until approved** and never "published" (FR-08). **FR-06**: a sent message's 201 body renders immediately with **no moderation state ever displayed** (ADR-002 deliver-first); `NOT_PARTICIPANT`/`BOOKING_CANCELLED` mapped on both load and send paths; 15 s poll with correct aria-live etiquette. **FR-07**: raising an alert demands an explicit kit-Dialog confirmation (open and cancel provably send nothing); the outcome reports the truthful three-part FR-07 result; the no-emergency-contact path is surfaced both before raising and in the outcome, with `/account` links. Backend contracts consumed by these screens were re-executed on this tree, not assumed: TC-05, TC-06, TC-07, TC-08 + the wave-4 status suite — 5 suites / 60 tests green. (`community.json`, 12/12 checks) |
| **U6-ACCOUNT-MOD** | `/login`, `/signup`, `/verify-email`, `/account`, `/moderation`, `/moderation/alerts` | **FR-10**: register → unverified → check-your-email → resend (always-202 anti-enumeration copy); token redeemed exactly once from the mailed link; wrong/used/expired rendered honestly. **NFR-05**: the 429 lockout renders the honest lockout copy with the retry horizon from `details.retryAfterSeconds` — **this was dead code at the built tree** (finding AMV-W6-01, the round's one major: the client matched `RATE_LIMITED` where the server emits `LOGIN_RATE_LIMITED`) and is repaired to match on the 429 status family, with the spec stubbing the server's real shape. **FR-09/NFR-06**: the eligibility panel renders both flags and all five reason codes with fix paths; profile updates flow back into recomputed flags. **NFR-12**: deletion behind an explicit confirm dialog that names the 30-day erasure; cancel sends nothing; post-202 the screen renders the server's own `dueAt`. **NFR-13**: export request → 202 with SLA due date → status check (incl. the worker's `processing` state, humanized by repair AMV-W6-03) → completed copy rendered. **FR-08**: the queue renders **all four** content types incl. `safety_alert`, with operable approve/reject; non-moderator 403 screen; the roles gate is UX-only — server enforcement re-executed (queue 401/403/200 matrix, `NOT_MODERATOR` on alerts: 3 backend suites / 72 tests green). **FR-07** moderator view: full delivery lifecycle incl. the dead-lettered terminal state, alert always visible. (`account-mod.json`, 12 of 14 clause verdicts PASS at the built tree; the one FAIL — AMV-W6-01 — repaired and re-executed; the fourteenth, the overall NFR-07 verdict, is OPEN by design) |

**Cross-cutting contract checks (all lanes + gates lane, re-executed post-repair):** every error
surface renders a typed code as a real human message into the aria-live regions — a stringified
body appears nowhere; the round's recurring defect class was **client code matching error codes
the server never emits** (AMV-W6-01/-02 on throttles, U6VC-F1 on 401 `NO_SESSION` vs
`AUTHENTICATION_REQUIRED` across all four trees), found by the lanes precisely because they
re-read the server's emitting code instead of trusting the client's specs — the specs had stubbed
the invented shapes. All repaired to the shapes the server actually emits, with the specs
corrected to stub reality (the FR-10 lesson of §2, in client form). Session stays opaque
(0 `document.cookie`); styling stays token-only (0 hex literals); no cap literal, no invented
endpoint or field (endpoint surface cross-checked against `src/routes/index.js` and each module's
`routes.js`); no cross-feature import (navigation by URL string only); no wave-5 file edited by
any 6A unit.

**The honest accessibility statement (NFR-07, measured):** `npm run test:a11y` on the final tree
finds **7 of 7 interfaces present**, audits **all 11 non-parameterized routes clean** (0 serious,
0 critical, wcag2a+wcag2aa — route list in §1), passes the keyboard checks, and **exits 1 by
design** naming exactly the 6 parameterized routes (`/listings/:id`, `/hosts/:id`,
`/bookings/:bookingId`, `…/messages`, `…/review`, `…/safety-alert`) that cannot be audited
without seeded fixture ids — wave-7 work. This is the exact end-state build-plan rev G.1
prescribed. **NFR-07 is not moved to Met on this basis**: the seeded-id audits and the UT-01
study remain (§3.2, §5).

**Known limitation, disclosed (OBS-B3):** FR-11's client surfacing is complete **as a rendering
contract only** — `bookingErrors.js` renders every cap refusal from the payload and is
unit-tested, but no wave-6 unit owned a listing-create/manage screen, so no live UI path can
trigger a MEHKO cap yet. The server remains the sole enforcement point (TC-11, re-executed green).
The coordinator decides whether v1.0 ships a host listing-management screen or documents host
listing flows as API-driven; FR-11's *client* column must not be read as fully exercised until
one exists.

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

### W4-F2 — CLOSED 2026-08-26 by team decision: comment-required is the ratified FR-05 reading

- **Severity:** was minor. **Requirement:** FR-05. (Raised independently as TCC-W4-02, TCB-W4-03, STS-W4-02, RTLT-W4-02, F-ADR4-02, COV-W4-02 — six lanes, none of which decided it, which is the correct behaviour.)
- **The decision — option (a):** a review comment is **REQUIRED (min 1 character)**. A photo-only review (`{rating, imageKeys}` with no text) is a **422 by design**, and this is the team's ratified reading of FR-05 for v1.0. SRS §3.1 FR-05 neither mandates text nor forbids a photo-only review, so this was a choice the specification left open; it is now made and recorded, in `docs/_generated/requirements-inventory.json` (FR-05 `specDecision`) and in the header of `src/schemas/reviews.js`.
- **Why (b) was rejected for v1.0:** relaxing the schema requires making the scan pipeline empty-text-safe *in the same change*, and that means reopening the moderation pipeline — the newest and least-exercised subsystem in the tree, verified once — in the same period its live IT-03 measurement is still outstanding. The feature has no demand behind it yet, so the destabilisation is not bought by anything.
- **No code changed.** The behaviour was already correct; what was missing was the decision behind it. The 422 is now intentional rather than an unexamined default.
- **How to revisit, if it ever matters:** relax `min:1` **only** together with the pipeline branch that skips the LLM stage for empty text and routes the image-bearing item to the human moderator queue — ADR-002-consistent, since the v1.0 pipeline is a *text* classifier that cannot inspect images regardless. Never relax the schema alone: that reintroduces the permanent dead-letter. The natural trigger is **UT-01** — a study participant reaching for a photo-only review and failing is real evidence, and turns the change from speculative into justified.

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
- **State on the final tree:** runs A and B of the wave-4 round (62/1386 on that tree), the lanes' final runs, the CI cold-runner run at `0270a01`, the wave-5 round's full-suite run, and this round's three consecutive post-repair wave-6 runs (63/1397, strict handles) are consecutive green. The committed-tree evidence streak has begun (wave 4 is committed, pushed and CI-green). Static sweeps found no remaining fixed-budget or unscoped outbox drains (house rule b; the last two were re-scoped in W4-F1's repair).
- **What keeps it open / next step:** the team should keep capturing complete output on every CI and local full-suite run; if any failure appears, its identity is now guaranteed to be preserved. Close after a sustained streak on the **committed** tree (CI, cold runners) — see §9.

### W4-F7 — CLOSED by judgment (non-blocking recommendation recorded): pre-filter knobs live as frozen module constants, not in `src/config`

- **Severity:** advisory. (Flagged item 5, judged independently by five lanes with the same verdict.)
- **Judgment: acceptable as shipped.** `src/modules/moderation/prefilter.js` `RATE_LIMIT`/`BLOCKLIST` are `Object.freeze`'d, documented with the rationale (the shared `src/config/schema.js` was owned by no wave-4 unit — a real parallel-edit hazard at build time), and exported for tests, which pin `{windowMinutes: 60, maxSubmissionsPerWindow: 15}` so a silent change fails a test. They are **not** ADR-009 caps — those verifiably live only in `src/config/locale.js` (the executable capScan passed; `90` is also max latitude and is handled). No ADR binds non-cap tunables to `src/config`. **Recommendation (non-blocking):** migrate them into `src/config` in a wave that owns `schema.js`, for operator consistency.

### Wave-5 verification findings (all minor) — disposition

The wave-5 verification lanes raised five findings of their own; none blocks the wave. Their
state on this tree, re-checked at report time:

- **STSEC-01 — CLOSED (executed this round).** The AB-06 ZAP baseline was run over the served
  wave-6 production build (ZAP 2.17.0, docker, digest-pinned; `vite preview` over HTTPS with
  `/api` proxied certificate-verified to the real server on a dedicated DB/Redis/bucket):
  **0 High** / 2 Medium / 2 Low / 4 Informational across **30 distinct URLs** (coverage floor 8),
  `npm run scan:zap:report` exit **0** — re-executed independently for this revision. Record with
  full triage: `docs/results/zap-baseline-RUN.md` (+ `.html/.json/.md`, URL list, summary). All
  Medium/Low alerts are the `vite preview` scaffold's missing static-document security headers —
  none on an `/api/*` response — accepted with reason and a named deployment follow-up (§4,
  AB-06 row).
- **MTUT-W5-01 — CLOSED (repaired).** `client/src/App.css` carried hand-derived contrast
  annotations that drifted from the true WCAG values (documented 14.6:1 / 6.8:1 vs computed
  14.76:1 / 6.67:1) on colour literals outside the machine-checked gate. Re-verified on this
  tree: App.css now uses **only** `var(--hp-color-*)` tokens (zero hex literals — executed grep)
  and its header defers to the `tokens.css` table that `ui/kit-contract.test.js` recomputes on
  every run, so the file can no longer drift silently.
- **ADRC-W5-01 / COV-W5-02 — CLOSED (re-baselined by this report).** The frozen "62 suites /
  1386 tests" backend contract statement was stale once the verification lanes added canonical
  tests. This report restates the canonical contract as **63 suites / 1400 tests** (§1;
  63/1397 through the round's three consecutive runs, then +3 canonical tests from the repair
  lanes — COV-W6-11) — the
  same re-baselining every prior verification wave performed (1345 → 1386 at wave 4). No lane
  test file was deleted to preserve an old number.
- **COV-W5-01 — CLOSED (this document).** `docs/verification-report.md` previously covered
  waves 0–4 only and stated "client/ does not exist"; this revision covers waves 0–5 with the
  NFR-07 row rewritten to Partial and kept open.

### Wave-6 verification findings — disposition

The five wave-6 lanes produced 3 gate findings, 6 screen defects (1 major, 5 minor/low), 2
coverage gaps and a set of recorded observations. **Every confirmed defect was repaired by U6R-FIX and closed by re-executing
the original failure scenario** — never by a green suite alone (§2). Full record with per-finding
cause, fix and re-execution: `docs/_generated/wave6-verify/repairs.json`.

- **W6-G1 / W6-G2 — CLOSED (repaired): the backend gate went exit 1 on two stale wave-5 scope
  guards, not on a product defect.** `tests/coverage/coverage-lane.test.js:114` asserted no
  `client/src/features/*/routes.jsx` exists, and
  `tests/adr-conformance/adr-wave5-client-invariants.test.js:142` blanket-banned any privileged
  address-key dereference in client code — both written when no wave-6 screen existed, and both
  invalidated **by design** the moment wave 6 landed. Repair re-baselined each guard *keeping its
  invariant's direction*: the scope guard now pins the feature-directory list to **exactly** the
  five wave-6 trees (a sixth out-of-scope tree — payments, GPS, AI listing generation — still
  fails it); the ADR-010 guard now confines privileged address keys to the one booking-gated
  screen (`ListingDetailPage.jsx`) **and** requires its presence-guard, so any other module
  touching the keys, or the gated screen losing its guard, still fails. Re-executed: both files
  pass isolated and inside three consecutive 63/1397 exit-0 full-suite runs. No spec was weakened
  into silence; no assertion deleted.
- **W6-G3 — OPEN (watch, folded into the W4-F6 discipline): one non-reproducible
  contention flake.** `st-security-wave3.test.js:677` (AB-08 stranger-projection clause) got a 500
  once, in gates run 1 only, while the LT-01 volume suite saturated the same PostgreSQL server
  (an idle-pool "terminating connection" error is visible in that run's captured log). It passed
  gates run 2, passes in isolation (50/50), and passed under full contention in all three
  post-repair full-suite runs. Identity preserved per the W4-F6 rule; disposition: candidate
  hardening for a later wave (retry-once or serializing the volume suite), not a wave-6 blocker.
- **AMV-W6-01 — CLOSED (repaired): the round's one major.** The NFR-05 login-lockout copy was
  dead code: the client matched `err.code === 'RATE_LIMITED'` but the server emits
  `LOGIN_RATE_LIMITED` (`src/modules/auth/service.js`, pinned by `tests/unit/identity.test.js`) —
  and the spec masked it by stubbing the invented code. Repair detects throttles via the **429
  status family** (`isThrottleError`), which no future code rename can silently bypass, and the
  spec now stubs the server's real shape; re-executed: the honest lockout copy ("about 5
  minutes", from `details.retryAfterSeconds`) renders against the real code. **AMV-W6-02 —
  CLOSED**: same class on the resend throttle (`VERIFICATION_RESEND_RATE_LIMITED`), same repair
  shape, copy centralized.
- **U6VC-F1 — CLOSED (repaired across all four feature trees):** the live 401 code on every
  session-gated route is `NO_SESSION` (`src/modules/auth/middleware.js`), but the shared error
  maps keyed only `AUTHENTICATION_REQUIRED` (the class default, live only via the eligibility
  middleware), leaving the actionable go-sign-in copy unreachable. Repaired everywhere with both
  codes live; one 401 spec added per community screen asserting the copy renders **and** is
  announced assertively; the stubs that modeled the never-emitted code were corrected.
- **D-01 — CLOSED (repaired):** the listing-detail withheld-address note overstated the ADR-010
  disclosure trigger ("confirmed reservation" vs the real pending/in-progress release in
  `src/modules/listings/access.js`). Copy corrected to the truth; the spec now pins the truthful
  sentence.
- **F-B2 — CLOSED (repaired):** a pending booking with an unparseable `scheduledStart` rendered
  "the meal has started" untruthfully (unreachable via the real API, which always serializes an
  ISO instant). The claim now renders only on verifiable state; the neutral-copy path is pinned
  by a spec that re-executes the lane's reproduction.
- **AMV-W6-03 — CLOSED (repaired):** the export status screen rendered (and announced) the raw
  DB enum `processing`; now a human label, with the honest `|| row.status` fallback kept for any
  future unknown enum.
- **D-02 / AMV-W6-05 — CLOSED (coverage):** the rejected-listing owner notice and the
  `NAME_MISSING` reason code had no positive spec; both now do (part of the 344).
- **AMV-W6-04 — CLOSED (implemented the lane's suggestion):** the post-202 deletion state now
  also renders the server's own `request.dueAt` alongside the SRS-frozen "30 days" pre-202 copy.
  **U6VC-O1 — hardened:** one observed timing flake in `BookingsListPage.test.jsx` under
  full-suite contention; first content assertion's wait budget widened to 5 s (no assertion
  changed); green in 4 consecutive full client runs.
- **OBS-B3 — CLOSED 2026-09-11 by team decision (ADR-013):** host listing management now ships in
  the client (`client/src/features/host`); the daily listing cap was triggered through the UI during
  the demo rehearsal. As recorded at the time: no wave-6 unit owned a listing-create screen — see the
  disclosure in §3.6, kept for the record. **Recorded, deliberately not acted on:** D-OBS-1 (retry pushes a duplicate
  history entry — cosmetic, pinned specs, wave-7 UX pass), D-OBS-2 (host-review page size derived
  from preview length — exposing `pageSize` is a backend payload change outside wave-6
  ownership), U6VC-O2 (review upload-before-POST ordering is schema-forced; orphan-media
  lifecycle is server-owned).

### Final re-verification round (this report's re-stamp) — findings disposition

Eight further verification lanes re-executed the entire evidence base on the final wave-6 tree
(their consolidated results are the source of the §3 evidence sentences). Their findings:

- **ITV-W6-01 — OPEN (major, = the standing NFR-10 gap).** Reproduced by execution: the only
  runnable IT-03 lane (`node scripts/it03-eval.js`) emits a NOT-A-MEASUREMENT report with
  `claimable:false` and **no rate fields at all** (mock adapter, no live credentials —
  ADR-007 forbids the mock standing in). No `RESULTS.md` exists. Not a code fix: the wave-7
  human-supervised live run is the only closure (§5, §7 NFR-10).
- **ITV-W6-02 — CLOSED (repaired in-lane).** A stale test title in
  `tests/it-adapters/it01c-adapter-depth.test.js` ("no sign-off exist") contradicted its own
  body, which asserts the ADR-008 sign-off recorded 2026-08-21; title corrected, suite re-run
  green 25/25.
- **STS-V-01 — CLOSED.** Same subject as STSEC-01 (the unrun ZAP crawl); closed by the recorded
  run above.
- **STS-V-02 — OPEN (watch).** The same contention flake as **W6-G3** (one historical 500 at
  `st-security-wave3.test.js:677` under LT-01 database saturation); did not reproduce in the
  final lanes' isolated runs nor in this revision's two consecutive full-suite runs. Stays on
  the W4-F6 watch list.
- **COV-W6-10 — CLOSED (repaired).** `scripts/seed.js`'s child-process-only CLI paths (usage
  error, `seed().catch` exit-1) had no exercise record; two spawn tests were added beside the
  migrate ones in `tests/coverage/migrate-cli.test.js` (part of the 1400).
- **COV-W6-11 — CLOSED (this revision).** The canonical backend contract is re-stamped
  **63 suites / 1400 tests** and confirmed by two consecutive independent full runs on the final
  tree (96.133 s and 95.663 s, both exit 0 under `TEST_STRICT_HANDLES=1`).
- A full `--coverage` run by the coverage lane on an isolated DB measured **96.05 % lines /
  98.87 % functions (702/710) / 84.65 % branches** globally, no file below 80 % lines; the 8
  uncovered functions were individually audited (CLI-only callbacks and trivial lambdas — none
  an exported unit, none a stub). Static sweeps: zero `TODO`/`FIXME`/`not implemented` markers
  in `src/`, `scripts/`, `db/`, `client/src`; all 112 modules load with real exports; all 35
  requirement IDs cited in both implementing code and tests.

### Carried-forward open findings from waves 0–3

- **F-04 → NFR-10 not measured** — still true; see the NFR-10 row and §7. The *pipeline* half is now closed; the *measurement* half is wave 7.
- **F-05 → NFR-07 has no subject** — now substantially closed by waves 5–6: all seven interfaces exist and every auditable route audits clean (§3.6). What keeps NFR-07 open is no longer a missing subject but the wave-7 seeded-id audits of the six parameterized routes and the UT-01 human study. The harness still exits 1 by design until both audit halves are done, so partial coverage is never mistaken for closure.
- **TCC-03 (FR-01 acceptance correction)** — recorded, awaiting team ratification at CDR.
- F-01 (drain determinism), F-02 (AB 1325 weekly cap), F-03 (NFR-12/13 absent), F-06 (ADR-007 data-use review), F-07 (backup expiry unexecutable), F-08 (soft-deleted host decision), F-09 (CI) were closed in previous rounds and stay closed; F-03's subject is now built and verified (NFR-12/NFR-13 rows), and F-07's executable half (prune logic) is now covered in-process (W4-F5).

---

## 5. Not verifiable in this environment

Not failures — checks whose evidence this repository cannot produce, with what a human must do.

| Check | Why it cannot be verified here | What the team must do |
|---|---|---|
| **UT-01 — 5-participant moderated usability study** (SRS §4.5) | A human activity. **Its blocker is gone: wave 6 shipped every task interface the protocol needs.** | Declared missed at CDR, on the record (team decision 2026-08-18). Protocol ready in `docs/ut01-usability-study-plan.md`; the study can be scheduled **now** — name participants and dates, run it against the wave-6 screens (the FR-09 eligibility surface is a designed probe), and a human fills in its §6 record block. |
| **NFR-07 — the seeded-id half of the seven-interface audit** | The harness audited everything it can render without data: 11 routes clean at 7/7 interfaces present (§1). The six parameterized routes (`/listings/:id`, `/hosts/:id`, `/bookings/:bookingId{,/messages,/review,/safety-alert}`) need seeded fixture ids and a running backend to render real states — wave-7 harness work. | Wave 7: seed fixtures, audit the six parameterized routes, and record the 7/7-clean result. Then run UT-01 (above). Both are required before NFR-07 can move to Met. |
| **NFR-10 — live FP/FN measurement** | **DONE 2026-09-11** (human-initiated, off-suite, as ADR-007 requires; the suite still pins the mock). Recorded in `tests/fixtures/moderation-eval/v1/RESULTS.md` + `it03-live-run.json`. | Result: FP 7.14 %, FN 1.19 % — the FP bound is not met, so NFR-10 is **not** claimable as a pass. Closing it needs a prompt or threshold change (a new `PROMPT_VERSION`) and a fresh run; the four false positives are named in §7. |
| **NFR-09 — "99 % availability during the demo period"** | A deployment measurement over calendar time. | Record uptime during the demo window. The ten RT-01 drills are the *design* evidence, not the figure. |
| **NFR-12 — a real 30-day wall-clock erasure + backup expiry against a real backup target** | A 30-day window cannot elapse inside a test run; backup expiry needs a deployment's backup store. | The scheduling arithmetic, the due-instant execution and the prune logic are all proven by clock injection (§7); operationally, confirm the lifecycle cron (`scripts/backup.js`) is scheduled on the deployment and spot-check one real expiry. |
| **ST-01 — external TLS/certificate scan** | Protocol enforcement is fully executed here against a real `https.Server` with the dev certificate; certificate *validity* (chain, CA, expiry, hostname) needs a deployed host. | Run `testssl.sh`/SSL Labs against the deployed host once a real certificate is issued. |
| **CI on wave 6** | The wave-6 tree is uncommitted; CI runs `origin/main` (green at `e8a610d`, the waves-0–5 gates). | Human team commits and pushes, then confirms the cold-runner run is green: backend **63 suites / 1400 tests**, client **32 files / 344 tests**, both builds and lint. |

---

## 6. Suite determinism and process hygiene — measured, not asserted

- **Strict-handles discipline:** every run cited in this report ran under `TEST_STRICT_HANDLES=1`
  with `maxWorkers: 1`; the wave-4 runs A and B, the wave-5 round's run, and this round's three
  consecutive post-repair wave-6 runs (63/1397 each: two by U6R-FIX at 95.2 s / 97.4 s, one by the
  report author at 94.261 s) exited 0 with no open-handle warning and no `--forceExit`. Every suite closes what it opened in
  `afterAll` inside a `finally`, pairing `closeDb()` with `closeTestRedis()`; the globalTeardown
  150 ms settle window is untouched.
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
- **Intermittent watch:** see findings W4-F6 and W6-G3. The one full-suite failure observed
  during wave-6 verification (W6-G3, a stranger-GET 500 under LT-01 database contention) has a
  preserved identity and an evidenced cause; it did not reproduce in isolation, on rerun, or in
  three consecutive full-suite runs on the final tree. The complete-output rule held on every run.
- **Coverage (lane-measured in the wave-4 round on its `cca6787` baseline, `--coverage` full run,
  60/1345 green at that tree):** statements
  ≈ 94 %+, functions 97.7 %+ overall; **all four wave-4 modules at 100 % functions** (messaging
  additionally at 100 % branches); the 14 uncovered functions repo-wide were individually audited —
  after the W4-F5/`wireShutdown` repairs, the remainder are trivial callbacks (encode/header
  arrows, a rejection-swallow) hiding no product logic. Zero `TODO`/`FIXME`/`not implemented`
  markers in `src/` or `scripts/` (executed grep + the standing coverage-lane test).

---

## 7. Measured numbers where the SRS demands them

### NFR-01 / NFR-02 — latency at scale (LT-01, LT-02)

Measured **on the wave-6 tree, this round**, with k6 v2.2.0 (darwin/arm64), 200 VUs, 30 s
warm-up + 5 min steady, real TLS, against an isolated api+worker stack backed by a freshly
seeded throwaway NFR-02 volume database — **10,000 users / 1,000 approved active listings on one
America/Los_Angeles day / 1,000 bookings** (the harness refuses to start below the 1,000-listing
floor). Artifacts: `docs/results/lt01-k6-summary-wave6.json` +
`lt01-k6-summary-wave6.provenance.json` (k6 version, date, commit, dataset, host recorded).

| Metric (steady phase) | Value | Budget |
|---|---|---|
| `http_req_duration` p95 | **120.07 ms** | < 500 ms — **met** |
| Error rate | **0.00 %** (0 of 1,028,672 steady; 0 of 1,129,229 total) | < 1 % — met |
| Throughput | 3,413.9 req/s (1,129,229 requests total) | — |
| Per-endpoint p95 | search 2.86 ms · hostReviews 68.11 ms · listingDetail 109.05 ms · hostPage 129.2 ms | each < 500 ms — met |
| VUs | 200 sustained 5 m 0 s after 30 s warm-up; 1,129,178/1,129,178 checks succeeded | 200 ≥ 5 min — met |

The run was made on a host with sibling verifier lanes active (load average 4.87 at start), which
biases latency **up** — the pass is conservative. The prior wave-4 instrument run
(`lt01-k6-summary-wave4.json`: steady p95 123.26 ms, p99 159.88 ms, 0.00 % errors) stays on
record and is consistent. The in-suite regression gate (`lt-volume-latency.test.js`, node VU
loop, 200 VUs, 45 s) independently measured overall p95 **134.2 ms** / worst-endpoint p95
149.4 ms / 0 errors over 143,000 requests. EXPLAIN ANALYZE over the real search queries at
volume: 0.03–0.77 ms across all six filter shapes, no sequential scan on listings, required
indexes asserted present. FR-12's race is re-proven at load (50 concurrent guests, 1 seat →
exactly one 201).

*Caveat:* measured on a developer machine (M-series, local docker), not the deployment target.
The number is evidence of headroom (4× under budget), not a production SLA.

### NFR-05 — lockout behaviour (ST-03)

Config: `AUTH_LOGIN_MAX_ATTEMPTS=5`, `AUTH_LOGIN_WINDOW_SECONDS=600`. Executed at the exact
boundary: attempt 5 fails as invalid credentials; **attempt 6 returns 429 with `Retry-After`
even for correct credentials**; keys are account+IP in Redis with 600 s TTL, not extended by later
failures; successful login resets the counter; a 50-attempt brute force (AB-05) is locked from
attempt 6 throughout; IP-cycling across many accounts is also locked; the lockout response never
reveals whether the account exists.

Wave 6 adds the client half, verified post-repair: the login screen renders the honest lockout
copy (temporary lock, retry horizon from `details.retryAfterSeconds`, lifts by itself) from the
server's **real** 429 `LOGIN_RATE_LIMITED` shape. As built, that copy was dead code behind an
invented code string — finding AMV-W6-01, the wave-6 round's one major (§4).

### NFR-10 — moderation false-positive / false-negative rates

**Measured on 2026-09-11 — one live IT-03 run, as ADR-007 sanctions. NFR-10 is NOT met: the
false-positive rate fails the bound; the false-negative rate meets it.**

| Metric | `gemini-3.5-flash-lite` (the recorded run) | Bound |
|---|---|---|
| False-positive rate (benign → violating) | **7.14 %** (4 of 56) | < 5 % — **not met** |
| False-negative rate (violating → benign) | **1.19 %** (2 of 168) | < 5 % — met |
| Misrouted (violating, wrong violating class) | 4 | informational |
| Exact-class accuracy | 95.54 % | informational |
| Answered by pre-filter / by the model | 2 / 222 | — |

Run facts: set v1 (224 items, 56 per class, label sign-off Gaetan Rieben 2026-08-21), prompt
`moderation-prompt-v1`, temperature 0, JSON response mode — the production adapter's own request,
built by `createLiveLlmModerationAdapter` and scored by `scripts/it03-eval.js` `runEval` in the
real pre-filter → classifier order. Started 15:03 UTC, finished 16:40 UTC. The record with every
required field is `tests/fixtures/moderation-eval/v1/RESULTS.md`; the raw report is
`it03-live-run.json` beside it. `claimable: true` — every precondition holds — and
`withinBound: false`, so the number is recorded and **no pass is claimed**. Four guard tests that
asserted "no results file exists" were inverted, not deleted (`set-integrity`, `it01c`, `it01`):
they now require the record to exist, to carry every field the manifest names, to name a live
model, and to state a `withinBound` that its own rates support.

**What the false positives are.** All four benign items the model called *fraudulent* or
*offensive* sit on one boundary:

- `ben-004` "Please bring $15 cash per seat … The app does not handle payments." → fraudulent 0.95
- `ben-021` "Bring cash if you can, $18 a seat covers ingredients …" → fraudulent 0.89
- `ben-052` a guest *warning others* about a scam they suffered → fraudulent 0.95
- `ben-055` a review *describing* insults from another guest → offensive 0.95

The prompt defines *fraudulent* as including "attempts to move payment off the platform" — but
Homeplate v1.0 has **no** payment feature (payments are out of scope, pinned by the wave-6
feature-tree guard), so a host asking for cash is ordinary marketplace content, exactly as the
label set says. The prompt clause and the ADR-008 boundary rules disagree, and the model sided
with the prompt. Two of the four are the same disagreement; the other two are the classic
"reporting abuse is not abuse" boundary. A second model measured in parallel
(`gemini-3.1-flash-lite`, FP 5.36 % = 3/56, FN 0.60 % = 1/168, `withinBound: false`) failed on the
**same** cash-payment items, which is why this reads as a prompt/label decision rather than model
noise. **This is a team decision, not an agent's:** either the prompt's fraud clause is rewritten
for a platform without payments (a new `PROMPT_VERSION`, then a fresh run), or the benign labels
are revised into a set `v2/` — ADR-008 forbids editing v1 after a recorded run.

The two false negatives (`fraud-015`, a request for someone else's emergency-contact number;
`fraud-041`, an admission that the kitchen photos are a hotel's) were scored *benign* at 0.85 —
above the 0.8 routing threshold, so they would have published without human review.

*Operational findings from making the run, recorded for the team (§8, §9):* the worker's
per-attempt adapter budget is `ADAPTER_TIMEOUT_MS=3000`, while the two current models answered in
4–47 s under the provider's load — a live worker with the shipped setting would time out every
scan and dead-letter it; and the provider's free tier caps the flagship model at **20 requests per
day** (a first attempt on `gemini-3.5-flash` stopped at item 13 on that cap), so ADR-007's
free-tier assumption holds only for the lite models.

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

1. **No NFR-10 pass.** The live measurement now exists (§7: FP 7.14 %, FN 1.19 %) and its
   false-positive rate fails the 5 % bound. The number is on record, valid for exactly the model
   and prompt version named in `RESULTS.md`; the fix is a team decision on the prompt's fraud
   clause versus the label boundary, followed by a fresh run — not a re-reading of this one.
2. **No NFR-07 pass and no UT-01 study.** All seven interfaces now exist and the 11 auditable
   routes audit clean — that is still not the complete seven-interface audit (six parameterized
   routes await wave-7 seeded-id audits) and the 5-participant study has not run. A harness at
   7/7-present is progress evidence, never closure. NFR-07 is Partial, not Met.
3. **No 99 % availability figure** — only the NFR-09 degradation mechanisms, proven in ten drills.
4. **The AB-06 ZAP result is a scaffold measurement, not a production one.** The recorded run
   (0 High, 30 URLs, gate exit 0) crawled the wave-6 build served by `vite preview` with the real
   API proxied behind it; its 2 Medium / 2 Low alerts are that scaffold's missing static-document
   headers, accepted with reason. The production edge that will serve `client/dist/` does not
   exist yet, so **no claim is made about production header posture** — that is a named wave-7
   deployment follow-up. The k6 LT-01/LT-02 instrument **was** re-measured on the wave-6 tree
   (§7); no gap remains there beyond the developer-machine caveat (item 6).
5. **The 30-day erasure window is proven by clock injection, not by 30 elapsed days** (§7) — the
   scheduling arithmetic, due-instant behaviour and idempotency are exact, but no calendar month
   has passed.
6. **NFR-01/NFR-02 numbers are developer-machine measurements**, labelled as such; they are not a
   production SLA.
7. **Nothing in this tree is committed or CI-verified for wave 6.** Waves 0–5 are committed,
   pushed and CI-green at `e8a610d`; the wave-6 feature screens and their verification round sit
   uncommitted on top and have been verified locally only. The human team commits (house rule f),
   and the CI cold-runner result (63/1400 backend + 32/344 client + builds + lint) is the
   remaining independence check.
8. **One spec-level decision remains pending and is NOT decided here:** the FR-01 degraded-flag
   acceptance correction (TCC-03), ratification due at CDR. Two others are now settled and
   disclosed with their consequences: photo-only reviews (**W4-F2**, ratified 2026-08-26 —
   comment required) and the FR-08 flagged-message wording (**W4-F4**).
9. **The intermittent-variance watch (W4-F6) is open.** Every observed failure has a preserved
   identity and an innocent explanation, but the original lost failure was never identified, so
   this report does not claim the suite has *always* been deterministic — only that the cited runs —
   including this round's three consecutive full-suite runs on the wave-6 tree — were green with
   complete captured output. The one wave-6 contention flake (W6-G3) is on the watch list with
   its identity and evidenced cause preserved.
10. **(Resolved 2026-09-11 — ADR-013.)** As stated at wave 6: **FR-11's client surfacing is a rendering contract, not an exercised flow** (OBS-B3, §3.6):
    no wave-6 unit owned a listing-create screen, so no UI path can yet trigger a MEHKO cap. The
    server-side single enforcement point remains the proof (TC-11, re-executed green).

---

## 9. Recommended order of work after this report

1. **Commit and push** (human team): the wave-6 working tree on top of `e8a610d`, then confirm CI
   green on a cold runner — expected: backend **63 suites / 1400 tests** (the round-final contract,
   §1; the two guard files were re-baselined in place and the repair lanes added three canonical
   tests), client **32 files / 344 tests** (the restated
   client contract), both builds, lint. This extends the W4-F6 committed-tree evidence streak.
2. **Schedule UT-01 now** (human): the interfaces exist, the protocol is ready
   (`docs/ut01-usability-study-plan.md`), and the study was already declared missed against its
   SRS §4.5 date — every week without named participants extends that miss. The FR-09 eligibility
   surface (§3.6) is a designed probe of the study.
3. **At CDR:** ratify TCC-03 (FR-01 degraded-flag correction, still the one pending spec
   decision); present the wave-6 outcome exactly as §3.6 states it (7/7 present, 11 routes clean,
   NFR-07 still open); decide OBS-B3 (host listing-management screen in v1.0, or host flows
   documented as API-driven).
4. **Wave 7 — the closure wave, the remaining instruments:** seed fixture ids and audit the six
   parameterized routes (`npm run test:a11y` to 7/7 **clean**, gate flips green — record it); run
   the UT-01 study (a human fills the record block). The **live IT-03 run is done** (2026-09-11,
   §7) and NFR-10 is not met; the team decides between a prompt revision (new `PROMPT_VERSION`)
   and a label set `v2/`, then re-runs once. Before any live deployment, raise
   `ADAPTER_TIMEOUT_MS` for the moderation adapter to fit the measured 4–47 s latency (§7). The ZAP baseline and the wave-6 k6 instrument run are **done and recorded** this
   round (§1, §7); what remains from them is the deployment follow-up — the production edge that
   serves `client/dist/` must send the four standard security headers (§8 item 4).
5. **Housekeeping (non-blocking):** consolidate the pre-filter knobs into `src/config` (W4-F7) in
   a wave that owns `schema.js`; harden the W6-G3 contention pair (retry-once in the AB-08 spec or
   serialize the volume suite); wave-7 UX pass items D-OBS-1 (retry history push) and U6VC-O2
   (review upload ordering); keep the complete-output rule for every full-suite run.
