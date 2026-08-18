# Homeplate v1.0 — Verification Report (waves 0–3)

**Prepared for:** Critical Design Review, 2026-08-22 · MSCS 2101, Group 6
**Requirements baseline:** SRS v3.2 (frozen). Where the SPMP or an ADR contradicts it on a
requirement, the SRS wins (SPMP §1.1.2). Where the SRS leaves a mechanism open (§2.4), ADR-001…011
bind.
**Scope of this report:** waves 0–3 only. Waves 4–7 (reviews, messaging, moderation, privacy, the
React client) are **not built**, and this report never reports an unbuilt requirement as a pass.

---

## 1. Status line

| Field | Value |
|---|---|
| Report date | 2026-08-17 (amended 2026-08-18 — ADR-009 weekly window ratified, weekly cap corrected to 90 per AB 1325; see F-02) |
| Commit (`git rev-parse --short HEAD`) | **`8807117`** (wave-3 close-out); the 2026-08-18 AB 1325 amendment sits on top of it |
| Wave-3 baseline | `bc27199` (wave-3 code `3136b91`, repair round 1 `f7f954c`) |
| Working tree | **Clean and pushed.** All wave-3 work, the 2026-08-18 team ratifications and the CI hardening are committed and on `origin/main` at `155b810`. |
| CI state | **Green on wave 3.** `origin/main` is `155b810`; run 32187777816 passed 71 suites / 1302 tests on a cold runner in 2m54s under `TEST_STRICT_HANDLES=1` (F-09 closed 2026-08-18). |
| Test framework | Jest 29 + Supertest against a seeded PostgreSQL 16 database, Redis 7 and MinIO (docker compose), `maxWorkers: 1` |

### Commands run for this report, and their real output

| Command | Result |
|---|---|
| `npx jest` (full suite, run **A**, lane `homeplate_finalrpt_test`) | `Test Suites: 71 passed, 71 total` · `Tests: 1302 passed, 1302 total` · `Time: 93.078 s` · exit **0** |
| `npx jest` (full suite, run **B**, same lane, same code, back to back) | `Test Suites: 1 failed, 70 passed, 71 total` · `Tests: 2 failed, 1300 passed, 1302 total` · `Time: 93.526 s` · exit **1** |
| *(determinism defect found and fixed — see finding **F-01**)* | |
| `npx jest` (full suite, run **C**, after the fix) | `Test Suites: 71 passed, 71 total` · `Tests: 1302 passed, 1302 total` · `Time: 93.780 s` · exit **0** |
| `npx jest` (full suite, run **D**, after the fix) | `Test Suites: 71 passed, 71 total` · `Tests: 1302 passed, 1302 total` · `Time: 93.442 s` · exit **0** |
| `npx jest` (full suite, run **E**, final tree) | `Test Suites: 71 passed, 71 total` · `Tests: 1302 passed, 1302 total` · `Time: 94.589 s` · exit **0** |
| `npm run lint` (`eslint . && prettier --check .`) | `All matched files use Prettier code style!` · exit **0** |
| `npm run build` (`scripts/check-build.js`) | `4 file(s), naming and ordering valid` · `88 file(s) parse cleanly` · `createApp() boots against the .env.example environment` · `all checks passed` |
| `npm run scan:zap:report` | High 0 · Medium 0 · Low 0 · Informational 3 · **24 distinct URLs** · `PASS` · exit **0** |
| `k6 run … tests/load/smoke.js` (recorded artifact, `docs/results/lt01-k6-summary.json`) | k6 **v2.2.0**, 200 VUs, 5 min steady, 749,234 requests, **p(95) 254.93 ms**, error rate **0.00 %** |
| `npm run test:a11y` | exit **1 by design** — there is no client to audit (see NFR-07) |

**No run hung.** All five full-suite invocations returned their own exit code within ~93 s; none had
to be killed, and `--forceExit` was never used. The literal string *"Jest did not exit one second
after the test run has completed"* appears in **none** of the five logs. (Runs C, D and E do print the
harness's own leak *diagnostic*, which quotes that phrase in its explanatory text — see §6, residual
**R-1**; it is a warning about one auto-unref'd timer, not a hang.)

### Status vocabulary used in this report

| Status | Meaning |
|---|---|
| **Met** | Every acceptance clause was executed against the current tree and passed. A named test file proves it. |
| **Partial** | At least one acceptance clause has no implementing code, or is measured by an instrument the criterion does not name. |
| **Not implemented** | No implementing code in waves 0–3. Proven absent by executing a probe (404/registry check), not by reading. Never a pass. |
| **Not verifiable here** | The evidence requires a human, a tool, or an environment this repository cannot supply. |

---

## 2. The FR-10 lesson — read this before trusting any pass in §3

Waves 1 and 2 reported **FR-10 (registration + email verification) as PASS**. It was not.

The verification email could only ever carry the **SHA-256 digest** of the token, never the token
itself. The tests reported a pass because they took the token from the **in-process return value of
the service function** rather than from the message that was actually delivered. Every assertion was
true; the requirement was unmeetable in production. No registered user could have verified an email
address, and because `canReserveSeat` requires a verified email, **no user could have booked a
meal** — from an all-green suite.

This was caught in wave-3 verification as blocker **TCB-W3-01** and is now fixed and independently
re-verified three separate ways (§3, FR-10). The methodological rule it produced governs this
report:

> **A test that asserts on a value the system handed it internally proves nothing about what the
> system delivers.** Assertions must be made on the persisted or transmitted artifact — the outbox
> row, the `notification_attempts` row, the rendered message body, the HTTP response — never on a
> convenient intermediate the production consumer never sees.

A corollary, applied throughout: **a green suite is not evidence that a defect is fixed.** The suite
was green before every one of these 40 defects was found. Each claimed fix in this report was
re-verified by re-executing the original failure scenario and showing it no longer reproduces.

**One trap worth recording, because it nearly re-created the original mistake.** The obvious way to
verify FR-10 is "read what the ADR-011 mock transport delivered". That does **not** work: the mock
does not declare `requiresRenderContext`, so it never receives the render context and
`mockTransport.deliveries()` only ever records the **digest** — the very artifact that made the
original bug invisible. Proving FR-10 requires driving the real handler through the real transport
into an adapter that *does* declare the render-context contract (SendGrid, with the SDK substituted
by a double) and scraping the token out of the **composed message body**. Three independent lanes
reached that conclusion separately and all three now prove it that way
(`tests/it-adapters/it02b-fr10-delivered-email.test.js`,
`tests/rt-lt-resilience/rt02-fr10-delivered-token.test.js`,
`tests/tc-booking/fr10-verification-link.test.js`).

---

## 3. Traceability matrix (SRS Appendix B shape)

Design elements are quoted from **SRS Appendix B** verbatim. Test IDs are the SRS §4 identifiers;
the "Test file" column names the file that actually executes them in this repository.

### 3.1 Functional requirements

| Req | Design element (SRS App. B) | Implementing file(s) | Test ID | Test file | Status | Evidence |
|---|---|---|---|---|---|---|
| **FR-01** | Search Service, Listing Service, Google Maps Adapter | `src/modules/search/{routes,service,repo}.js`, `src/adapters/maps.js`, `src/lib/cache.js` | TC-01, LT-01 | `tests/tc-core/tc01-search.test.js`, `tc01-04-acceptance-gaps.test.js`, `tcc-w3-reverify.test.js` | **Met** | Each filter (location, time, host, cuisine) alone and all four combined return exactly the expected ids; pending/rejected/cancelled/past listings are never returned; the result page lands in Redis under `hp:cache:search:page:<32 hex>` with ttl 60 and a repeat identical query makes **zero** `maps.searchArea` calls; the cached value holds **public precision only** (ADR-010); unauthenticated is 401. A soft-deleted host's listings are excluded from search and count (`src/modules/search/repo.js` erasure predicate, NFR-12). Degraded behaviour under a Maps outage is proven in three distinct cases (fresh page-cache hit → normal 200; stale adapter answer → `degraded: true` and **never** page-cached; cold location query → typed 503 `SEARCH_DEGRADED`). **Disclosed: this FR carries an acceptance-criterion correction (TCC-03).** The original wording required a page-cache-served query during a Maps outage to carry a degraded flag; that is unsatisfiable, because the same criterion requires such a query to make *zero* adapter calls, and a request that never calls the provider cannot observe that it is down. The criterion was corrected — no production code changed — and the decision, its reasoning and the SRS sections consulted (§2.1.6, §2.5, NFR-09, none of which require the flag) are recorded in `docs/_generated/requirements-inventory.json` under `FR-01.acceptanceCorrection`. **The team should ratify this correction at CDR**, since a verification run corrected a criterion rather than the code. |
| **FR-02** | Meal Detail View | `src/modules/listings/{routes,service,serializers}.js`, `src/modules/hosts/repo.js`, `src/lib/mediaUrls.js` | TC-02 | `tests/tc-core/tc02-listing-detail.test.js`, `tc02-host-summary-fallback.test.js`, `tccrv02-erasure-read-paths.test.js` | **Met** | Dish, ingredients, allergens, seats, storage-key-derived image URLs, host summary and approved reviews in ONE response; pending/rejected 404 to non-owners and visible with `moderationStatus` to the owner; frozen key allowlist with no email/phone/street address; the full ADR-010 disclosure matrix (pending/in-progress booking → precise; cancelled/completed → public; moderator holding an FR-07 alert → precise **plus** an `access_log` row). Host summary never `null` when the host row is soft-deleted or has no `host_profiles` row (TCC-01, fixed and re-verified), and the erased name is not resurfaced. *Note:* the `reviews` array is a bounded 5-item preview; it is now **self-describing** on the wire (`reviewsTotal`, `reviewsPageSize`) and the full paged list is `GET /api/hosts/:id/reviews` (TCC-04 closed). |
| **FR-03** | Host Profile Service | `src/modules/hosts/{routes,service,repo,serializers}.js` | TC-03 | `tests/tc-core/tc03-host-profile.test.js` | **Met** | Self-introduction, example dishes (approved listings only), reviews with numeric ratings + average, kitchen/dining image URLs from object-storage keys; anonymised authors render a neutral name; frozen key allowlist with no email/phone/emergency contact/password hash; ADR-010 coarse coordinates + area label only; 401 unauthenticated on both routes; unknown host and profile-less user are a structured 404; a deleted account is a 404 and its media never resurface. |
| **FR-04** | Booking Service (completion confirmations) | `src/modules/bookings/{routes,service,repo}.js` | TC-04 | `tests/tc-core/tc04-completion.test.js`, `tc01-04-acceptance-gaps.test.js` | **Met** | After exactly ONE confirmation the response is 200 `awaitingOtherParty` and the row is still `in_progress` with `completed_at` NULL — **in both orderings**; after both, `status='completed'` with `completed_at` set; repeat confirmation and confirming an already-completed booking are idempotent 200 no-ops; a third party is 403 with no flag written; pending and cancelled are 409; unauthenticated is 401. Concurrent dual confirmation is covered. |
| **FR-05** | Review Service | *(none)* | TC-05 | `tests/tc-core/tc05-07-wave4-status.test.js`, `tcc-w3-reverify.test.js` | **Not implemented** | Proven by execution: `src/modules/reviews` does not exist; `POST /api/bookings/<uuid>/reviews` with a valid session returns **404 `NOT_FOUND`**. The `reviews` table exists as substrate only. Wave 4 (U4-REVIEWS). Not built here. |
| **FR-06** | Messaging Service | *(none)* | TC-06 | `tests/tc-core/tc05-07-wave4-status.test.js`, `tcc-w3-reverify.test.js` | **Not implemented** | Proven by execution: `src/modules/messaging` does not exist; `GET /api/bookings/<uuid>/messages` returns **404 `NOT_FOUND`**. The §3.4 substrate is proven separately (a `messages` row persists FK-bound to its booking with `moderation_status` defaulting to `pending`, the ADR-002 async-scan state). Wave 4 (U4-MESSAGING). |
| **FR-07** | Safety Alert Service, SendGrid Adapter | `src/modules/safety/{routes,service,repo}.js`, `src/outbox/handlers/safetyAlert.js`, `src/adapters/sendgrid.js` | TC-07, IT-04 | `tests/tc-core/tc07-safety.test.js`, `tests/it-adapters/it04-safety-delivery.test.js`, `it-w3rv-reverify.test.js`, `tests/mt-ut-quality/mt01-w3rv-safety-audit.test.js` | **Met** | `POST /api/bookings/:id/safety-alerts` → 201 with `deliveryStatus 'pending'`, `notification_attempts` count **unchanged** across the request (nothing inline — ADR-001/003), exactly one outbox row whose payload keys are exactly `['alertId','bookingId']`; the alert is in `GET /api/moderation/alerts` **before** any delivery (403 to an ordinary session, 401 unauthenticated). After a real worker drain: attempts `safety-alert-emergency:sent` + `safety-alert-moderator:sent`, `delivery_status 'delivered'`. Raiser with no emergency contact → `no_channel`. Injected transport failure → `attempt_count 1`, future `available_at`, `retrying`, still queued; budget exhausted → job `dead` at `attempt_count 8` = `config.outbox.maxAttempts`, alert `failed`, **still visible in the queue**. The address handed to the adapter is the *contact's*, not the raiser's own. |
| **FR-08** | Moderation Module (pre-filter, LLM, human review, publication policy) | *(none)* | TC-08, IT-03 | `tests/tc-booking/tc08-moderation-substrate.test.js`, `tests/tc-booking/tcbv2-independent-reverify.test.js`, `tests/adr-conformance/verify-adr-wave0-3.test.js` | **Not implemented** | Proven by execution: `src/modules/moderation` does not exist; `loadHandlers().types()` = `[booking.promote, email.verification, listing.geocode, notify.booking, safety.alert]` — **no `moderation.scan`**; no pre-filter/blocklist module anywhere in `src/`. (`/api/moderation/alerts` is the FR-07 safety queue, not FR-08.) **The safe failure direction IS in place and is proven:** a listing is created `moderation_status='pending'`, is 404 on `GET /api/listings/:id`, 404 on `POST /api/bookings`, invisible in search, `seats_remaining` untouched — and nothing anywhere in `src/` can write `moderation_status`, so no listing can leave the pending queue in this tree. Wave 4 (U4-MODERATION). |
| **FR-09** | Eligibility Policy Service (`canReserveSeat` / `canPublishListing`) | `src/modules/eligibility/{policy,middleware,repo}.js` | TC-09 | `tests/tc-booking/tc09-eligibility.test.js`, `tcbv2-independent-reverify.test.js` | **Met** | **Both** states asserted, as §4.1 requires for state-driven requirements. Restricted: `email_verified=false` → 403 `NOT_ELIGIBLE` `[EMAIL_UNVERIFIED]`; `full_name=null` → `[NAME_MISSING]`; `phone_enc=null` → `[PHONE_MISSING]`; `seats_remaining` unchanged across all three. Permitted: complete guest → 201, seats 5→4. Publish restricted: no `host_profiles` row → `[HOST_PROFILE_INCOMPLETE]`; `host_agreement_accepted_at=null` → `[HOST_AGREEMENT_MISSING]`; permitted → 201. Repository-wide grep for a `canReserveSeat` definition returns **exactly one file**: `src/modules/eligibility/policy.js`. |
| **FR-10** | Registration & Email Verification Service | `src/modules/auth/{routes,service}.js`, `src/modules/users/tokens.js`, `src/outbox/handlers/emailVerification.js`, `src/modules/notifications/transport.js`, `src/adapters/sendgrid.js` | TC-10 | `tests/tc-booking/tc10-registration.test.js`, `fr10-verification-link.test.js`, `fr10-resend-verification.test.js`, `tests/it-adapters/it02b-fr10-delivered-email.test.js`, `tests/rt-lt-resilience/rt02-fr10-delivered-token.test.js` | **Met** | **The wave-1/2 blocker is closed, proven through the delivered artifact.** Register → 201, `email_verified=false`, exactly one `email.verification` outbox row whose payload keys are exactly `['tokenHash','userId']` (ADR-003 intact). The real handler runs through the real transport into the real SendGrid `deliver()` (SDK substituted by a double); the token is extracted from the **rendered body text** via `/https?:\/\/\S*[?&]token=([A-Za-z0-9._~+/=-]+)/`. The recorded delivery contains `https://localhost:3000/api/auth/verify-email?token=0jhR3Tufgm6hQUxBvG22xc5pShtsZXULixygdiPpjZ8` — **not** a 64-hex digest. Posting exactly that value → 200, `users.email_verified = true`. Negative control: posting the digest the pre-fix email carried → **400**, flag stays false. The raw token appears in **no** persisted row (outbox payload, `notification_attempts.params`, token row all asserted). Consequence chain closed: the same account's `POST /api/bookings` goes 403 `[EMAIL_UNVERIFIED]` → 201 after verifying. Single-use (replay → 400) and exactly-once under redelivery. |
| **FR-11** | Listing Service (MEHKO and seat limits) | `src/modules/listings/{routes,service,repo,mehko}.js`, `src/config/` | TC-11 | `tests/tc-booking/tc11-listing-caps.test.js`, `tcb-w3-reverify.test.js`, `tcbv2-independent-reverify.test.js` | **Met** | **All acceptance clauses executed and passing since the 2026-08-18 ratification (F-02).** `config.mehko === {listingsPerHostPerDay:1, maxMealsPerDay:30, maxMealsPerWeek:90, timezone:'America/Los_Angeles'}`, `Object.isFrozen === true`; two listings on the same **LA calendar day** (20:00Z and 21:30Z) → second is 409 `MEHKO_DAILY_LISTING_LIMIT`, one row at that `local_date`; `seatCapacity=31` → 422 `MEHKO_DAILY_MEAL_LIMIT`, `30` → 201; filling the week with config-derived full-cap days then +1 seat → 422 `MEHKO_WEEKLY_MEAL_LIMIT`; **exactly one** definition (`src/modules/listings/mehko.js`) and **exactly one** call site (`listings/service.js`); no cap-shaped literal outside `src/config/`. The weekly window shape was **ratified 2026-08-18** (Monday–Sunday LA calendar week) and the cap corrected to 90 per AB 1325 — see **F-02**, now closed. |
| **FR-12** | Booking Service (atomic capacity transaction) | `src/modules/bookings/{service,repo}.js` | TC-12, LT-01 | `tests/tc-booking/tc12-tc14-booking-schema.test.js`, `tcbv2-independent-reverify.test.js`, `tests/rt-lt-resilience/lt01-race.test.js` | **Met** | `seats_remaining=3`, **40 concurrent distinct guests** → status distribution exactly `{201:3, 409:37}`, every 409 carries `NO_CAPACITY`, `seats_remaining=0`, `COUNT(bookings WHERE status<>'cancelled')=3`. LT-01's variant: `seats_remaining=1`, **50 concurrent** → exactly 1×201 / 49×409. Every refusal path moves **no** capacity: full listing (409, seats 0), own listing (409 `OWN_LISTING`), already-started (409 `LISTING_STARTED`), ineligible guest (403) — and zero booking rows over those listings. The decrement is the mandated conditional `SET seats_remaining = seats_remaining - 1 WHERE … seats_remaining > 0`. Configurable per-guest pending cap (`config.booking.maxConcurrentPending = 3`): 8 simultaneous bookings by one guest → exactly 3×201 / 5×409 `BOOKING_LIMIT`, and the 5 refusals consumed capacity nowhere. |
| **FR-13** | Transactional Outbox, Worker, Notification Adapters | `src/outbox/{outbox,worker,dispatch}.js`, `src/outbox/handlers/*.js`, `src/modules/notifications/*`, `src/adapters/{sendgrid,fcm,mockTransport}.js` | TC-13, RT-02 | `tests/tc-booking/tc13-notifications.test.js`, `tests/rt-lt-resilience/rt02-*.test.js`, `tests/it-adapters/it01-wave3-worker-paths.test.js` | **Met** | Adapter hard-down (20 injected failures + 1 hang) and `POST /api/bookings` still returns 201 in well under `config.adapters.timeoutMs` (3000 ms) with `mockTransport.deliveries()` empty — the request path never touches the transport. **Same-transaction proof:** `SELECT DISTINCT xmin` over the booking row and every outbox row for that booking returns ONE value. Full status coverage: created, **started** (TCB-W3-03 fixed and re-verified) and completed each produce exactly one row per participant. Every emitted template id resolves in the SendGrid subject registry — no message renders the neutral fallback (TCB-W3-04 fixed and re-verified). Worker-side outage: the handler throws so the retry budget applies, `notification_attempts` are `failed`, and the booking is unchanged. Static check: no `require('…adapters/…')` anywhere under `src/modules/bookings` or `src/modules/listings`. |
| **FR-14** | Booking Service (cancellation, capacity restore) | `src/modules/bookings/{service,repo}.js` | TC-14 | `tests/tc-booking/tc12-tc14-booking-schema.test.js`, `tcbv2-independent-reverify.test.js` | **Met** | Guest cancel → 200, `status='cancelled'`, `seats_remaining` 3→4 **exactly**, and `cancelled_by_guest` notify rows exist for **both** parties. Concurrency: 4 simultaneous cancels on one booking all return 200 and seats return to exactly 4 — never 5 (no double restore). After `scheduled_start`: 409 `CANCEL_TOO_LATE`, seats untouched. Non-participant: 403 `NOT_PARTICIPANT`, seats untouched. |

### 3.2 Non-functional requirements

| Req | Design element (SRS App. B) | Implementing file(s) | Test ID | Test file | Status | Evidence |
|---|---|---|---|---|---|---|
| **NFR-01** | REST API, Redis Cache | `src/app.js`, `src/routes/index.js`, `src/lib/cache.js`, `src/db/redis.js` | LT-01 | `tests/load/smoke.js` (k6) + `docs/results/lt01-k6-summary.json`; in-suite gate `tests/rt-lt-resilience/lt01-lt02-wave3.test.js` | **Met** | Measured with **the instrument the criterion names**: k6 v2.2.0, out of process, over real TLS, against the NFR-02 volume dataset. See §7 for the full number table. Headline: **p(95) = 254.93 ms** against a 500 ms budget over 704,698 steady-phase requests at 200 VUs for 5 minutes, **error rate 0.00 %**. |
| **NFR-02** | Backend System, PostgreSQL | `db/migrations/0002_indexes_constraints.sql`, `src/modules/search/repo.js`, `scripts/seed.js --set volume` | LT-02 | `tests/rt-lt-resilience/lt01-lt02-wave3.test.js`, `lt-volume-latency.test.js` | **Met** | Dataset verified directly: 10,027 users / 1,004 listings / 1,002 bookings / 1,001 approved reviews; the k6 script **refuses to start** below the 1,000-listing floor and logged `catalogue 1001 active approved listings`. The 200-VU run above **was** the at-scale run — no small-dataset number is passed off as a scale result. Index inventory asserted (`(scheduled_start)`, `(host_id, local_date)`, `(moderation_status)`, `(cuisine)`, `(coarse_lat, coarse_lng)`) and `EXPLAIN ANALYZE` over the **real production SQL** across six filter shapes shows no sequential scan on `listings`: `{bare.page 0.31, bare.count 0.72, cuisine.page 0.17, cuisine.count 0.14, host.page 0.03, host.count 0.02, window.page 0.25, window.count 0.73, geo.page 0.34, geo.count 0.80, combined.page 0.19, combined.count 0.17}` ms. |
| **NFR-03** | Network Security Layer (TLS) | `src/server.js`, `src/middleware/security.js` | ST-01 | `tests/st-security/st-security-verify.test.js`, `st-security.test.js` | **Met** | Executed against a **real** `https.Server` started through `src/server.js`, not a supertest stub: plain-HTTP bytes on the TLS port return no application content (`curl http://…` → *Empty reply from server*); TLS 1.0 and 1.1 handshakes are refused (`ERR_SSL_NO_PROTOCOLS_AVAILABLE` / `tlsv1 alert protocol version`); 1.2 and 1.3 accepted; the 403 `HTTPS_REQUIRED` refusal itself carries `Strict-Transport-Security: max-age=15552000; includeSubDomains`, `nosniff`, `X-Frame-Options: DENY`, and no `X-Powered-By`. `src/server.js` pins `minVersion: 'TLSv1.2'` and the process has no plain-HTTP listener. |
| **NFR-04** | Authentication Service | `src/modules/auth/passwords.js` | ST-02 | `tests/st-security/st-security.test.js` | **Met** | Executed, not read: the emitted hash prefix is `$argon2id$v=19$m=19456,t=2,p=1$…` — **Argon2id**, memoryCost 19456 KiB, timeCost 2, exactly the documented floor. `verify(correct)=true`, `verify(wrong)=false`, two hashes of the same password differ (per-user salt). `information_schema` over the live database returns only `users.password_hash` for any column matching `%password%` — **no plaintext column exists anywhere**. The registered plaintext appears in no column of `users`; the shared logger emits `[REDACTED]` for a password value and the validator strips password values out of 422 field errors. |
| **NFR-05** | Authentication Service (rate limiting) | `src/modules/auth/rateLimit.js`, `src/config/` | ST-03 | `tests/st-security/st-security.test.js` | **Met** | Scripted brute force against the **live HTTPS server**. See §7 for the measured behaviour table. Headline: attempts 1–5 → 401 `INVALID_CREDENTIALS`; attempt 6 → **429 `LOGIN_RATE_LIMITED` with `Retry-After: 600`**; the *correct* password during lockout → 429. Two Redis counters, both `val=5 ttl=594`: `hp:ratelimit:login:ip:…` (per source IP — AB-05 credential stuffing) and `hp:ratelimit:login:acct:<hash>` (per account, keyed by a hash, no email in the key). |
| **NFR-06** | Eligibility Policy Service, Email Verification | `src/modules/eligibility/policy.js`, `src/modules/auth/service.js` | IT-02 | `tests/it-adapters/it02-verification-eligibility.test.js` | **Met** | Register → **no** `notification_attempts` row until the worker polls → one `email.verification` attempt `sent`, whose row contains neither the address nor the raw token and whose `params.tokenHash` is a 64-hex digest → verify → `canReserveSeat` / `canPublishListing` flip in step, with the **persisted flags equal to `policy.evaluate` at every step** after every mutation. Degraded variant: with the provider out the job stays `pending` and delivery completes after recovery **reusing the same row**. |
| **NFR-07** | Web UI (React) | *(none)* | UT-01 | *(none — `npm run test:a11y` is a deliberate failure)* | **Not implemented** | `ls -d client` → *No such file or directory*. A repository-wide find for `*.jsx` / `*.tsx` / `*.html` (excluding `node_modules`) returns **nothing**. No `axe`, `playwright`, `puppeteer` or `jsdom` in `node_modules`. There is no interface to audit and no browser toolchain, so **no violation count is claimed** for any of the seven interfaces the acceptance enumerates. `npm run test:a11y` exits 1 on purpose so its presence can never be read as coverage, and it is deliberately excluded from CI so the honest failure does not redden the pipeline. Waves 5–6 + U7-A11Y-UX. See also §5 (the 5-participant study). |
| **NFR-08** | Logging & Monitoring Service | `src/lib/logger.js`, `src/middleware/{requestContext,errorHandler}.js`, audit sites across `src/modules/*` and `src/outbox/handlers/*` | MT-01 | `tests/mt-ut-quality/mt01-log-completeness.test.js`, `mt01-wave3-booking-audit.test.js`, `mt01-wave3-audit-gaps.test.js`, `mt01-w3rv-safety-audit.test.js` | **Partial** | **Met for every action performable in wave 3.** Registration, booking create/cancel/complete/promote, listing create/update/cancel, media attach/delete and safety-alert raise each emit exactly one structured record carrying event, correlation ID, actor, subject, outcome and an ISO timestamp; refusals are audited as `outcome: 'failure'` with a machine reason. The correlation ID propagates **request → outbox row → worker log line** and is asserted on **both** sides, carried in the `outbox_jobs.correlation_id` **column** so ADR-003 payloads stay IDs-only. Failing/dead-lettered jobs stay traceable to the originating request. Errors log message + stack + status + correlation ID server-side while the client body stays generic. Four independent captured corpora were swept: no email, password, name, phone, street address or postal code appears in any line, with the generic email regex returning `[]` while `guestId`/`alertId`/`bookingId` **are** present (so the sweep is not vacuous). Listing audit `localDate` is a `YYYY-MM-DD` LA calendar day, proven timezone-independently under `TZ=Asia/Tokyo` (MTUT-W3-01 fixed); the worker-initiated `booking.promoted` record now names an actor (`actor: 'system:outbox'`, `actorUserId: null` — MTUT-W3-02 fixed). **Not met:** SRS §4.6 requires MT-01 to also cover *moderation decisions* and "the records needed to audit IT-03 moderation decisions". That action cannot be performed — `GET /api/moderation/queue`, `POST /api/moderation/decisions`, `POST /api/moderation/items/:id/approve` and `POST /api/listings/:id/moderate` all 404/405 and zero `moderation.*` audit records exist. MT-01 is therefore **incomplete until FR-08 ships**. |
| **NFR-09** | External Service Adapters, Deferred-Work Mechanism | `src/lib/resilience.js`, `src/adapters/*.js`, `src/outbox/worker.js`, `src/modules/search/service.js` | RT-01 | `tests/rt-lt-resilience/rt01-degradation.test.js`, `rt01-wave3-degradation.test.js`, `rt01-provider-outage-drill.test.js`, `rt01-notification-contract.test.js` | **Met** | **Seven outage drills, each with recovery verified.** (1) **Maps**: cached data served with zero adapter calls; stale cache → 200 with a degraded indicator, and degraded pages are **never** written to the result cache; nothing cached → typed **503 `SEARCH_DEGRADED` / `MAPS_UNAVAILABLE`** with a user-facing message, never a 500. (2) **Notification provider**: the booking commits, both notify jobs defer with `failed` attempt rows, both deliver on recovery. (3) **Moderation LLM**: `POST /api/listings` succeeds, the listing stays `PENDING` and invisible, the scan work defers — **ADR-002's never-publish-unreviewed property holds under outage**. (4) **Object storage**: listing detail still renders 200 with locally-derived image URLs; a direct object fetch is a typed 503 after bounded retries; a genuinely missing object is a definitive 404 and is never masked as an outage. (5) **Combined Google-side outage** (Maps *and* LLM together): bookings still commit, new public content stays pending, non-location search still serves. (6) **SendGrid drilled as itself**: total outage → retryable `UpstreamServiceError` after exactly 3 attempts (retries=2) with delays `[5,10]`, recipient address absent from the error message; 401 → non-retryable, exactly 1 attempt; never-settling send → `TimeoutError` inside the per-attempt budget. (7) **FCM drilled as itself**: gate shut → `PUSH_DISABLED`, zero sends; `messaging/server-unavailable` → retryable, 3 bounded attempts; `messaging/invalid-argument` → permanent, 1 attempt. Policy asserted: `config.adapters.timeoutMs === 3000`, `retryMax === 2`, backoff grows geometrically. **No live provider was contacted in any run** — with the doubles released, both real SDKs are refused with `LIVE_PROVIDER_REFUSED_IN_TEST`. |
| **NFR-10** | AI Moderation Service | *(none)* | IT-03 | `tests/fixtures/moderation-eval/set-integrity.test.js` (set only), `tests/it-adapters/it-w3rv-reverify.test.js` (absence probe) | **Not implemented — and no number may be quoted** | **NO MEASUREMENT EXISTS AND NONE CAN BE TAKEN. This report states no false-positive or false-negative rate.** Executed: `src/modules/moderation` does not exist; `loadHandlers().has('moderation.scan') === false`; no pre-filter/blocklist module anywhere in `src/` (ADR-002 stage 1 absent); no results file in `tests/fixtures/moderation-eval/v1/`, `docs/results` or `docs/_generated/results`; `manifest.labelReview.status === 'unreviewed'` with reviewer and date `null`; the set's own `claimability()` returns `claimable: false` with a reason matching `/sign-off/i` (ADR-008). It is additionally proven **executably** that the ADR-007 deterministic mock cannot substitute — it scores unseen abusive, scam and link-spam text as *benign 0.99*, so any rate scored through it would be invented. **What does exist:** the ADR-008 v1 evaluation set — 224 synthetic items, exactly balanced 56 offensive / 56 spam / 56 fraudulent / 56 benign (above the 200 floor), `validateSet()` returns `[]`, provenance `synthetic: true, scraped: false, containsPersonalData: false`. That closes the *set* half of the criterion and nothing else. |
| **NFR-11** | Input Validation Module | `src/middleware/validate.js`, `src/schemas/*.js`, `src/lib/sanitize.js`, all `*/repo.js` | ST-04 | `tests/st-security/st-security-verify.test.js`, `tests/adr-conformance/route-layer-db-access.test.js` | **Met** | Payload suite executed at **every wave-0..3 boundary**: auth, `PATCH /api/users/me` (`fullName`, `emergencyContact.name`, `hostProfile.bio`), `POST /api/bookings`, search `cuisine`/`hostId`/`from`/`to` and the `location` string that reaches the Maps adapter, listing create/update text, `/api/hosts/:id`, and both media endpoints. No request returned 500; hostile values came back inert (no `<script`, no `<svg`, no `<img onerror`); tables intact; malformed JSON is a structured 4xx with no stack trace; a 2 MB body is 413/422, not a crash. A repo-wide grep for interpolation into SQL returns 13 hits, all read and all benign (column-list constants, internally-built predicate arrays, or `$n` placeholder *strings*). The suite enumerates the mounted router and **fails if any route lacks a schema**. The last raw SQL in a route file (`src/modules/media/routes.js`, findings W3-ADR-04 / COV-07) has been moved into `src/modules/media/repo.js` — **no DB access remains in any route file**, asserted by a dedicated test. *Caveat, recorded not hidden:* the chat / review / moderation-note boundaries the acceptance names do not exist in this tree (wave 4). |
| **NFR-12** | Data Lifecycle Service (deletion, retention, media) | *(none — only the ADR-004 primitive)* | ST-05 | `tests/st-security/st-security-verify.test.js` | **Not implemented** | Measured on a **real running server**, not inferred: `DELETE /api/users/me` → **405** with `Allow: GET, HEAD, PATCH`; `POST` and `GET /api/users/me/export` → 404; `GET /api/privacy` → 404. No erasure or retention job type is registered with the outbox dispatcher. `grep -rnE 'UPDATE users[^;]*SET[^;]*(anonymized_at|deleted_at)' src/` returns **nothing** — nothing in `src/` ever writes the erasure columns. `scripts/retention.js` and `scripts/backup.js` do not exist; `.env.example` carries **no** `BACKUP_RETENTION` key. **What does exist:** the columns (`users.deleted_at`, `anonymized_at`, `last_active_at`), the configuration (`config.privacy.erasureDays = 30`, `inactivityMonths = 24`), the read-path erasure predicates (a soft-deleted host's listings vanish from search and the host page 404s), and a working ADR-004 delete-by-key primitive proven against real MinIO (put two keys → `mediaService.deleteForUser` → both 404). **The primitive has zero production callers.** Wave 4 (U4-PRIVACY). See §7 for erasure-window coverage. |
| **NFR-13** | Data Protection (encryption, access control, export) | `src/db/fieldCrypto.js`, `src/modules/users/{repo,service}.js`, `src/modules/listings/access.js`, `src/config/schema.js` | ST-06 | `tests/st-security/st-security-verify.test.js` | **Partial** | **Met:** the `users` table carries **exactly** the SRS §3.4 register and no extra personal attribute; `fieldCrypto` **AES-256-GCM** ciphertext ≠ plaintext and round-trips; `GET /api/users/me` is an explicit allowlist with no `password_hash` and no raw ciphertext; `access_log` has **exactly one writer** (`src/modules/listings/access.js`) and a moderator handling an FR-07 alert gets the exact address **plus** one `access_log` row carrying actor, subject and purpose, while a moderator *without* an alert and a non-moderator get the public projection and write no row (role-restricted **and** logged); production config now **refuses** the committed sample `FIELD_ENCRYPTION_KEY` and the `minioadmin` credentials (STS-W3-02 fixed and re-verified with a five-case truth table); the owner can read and repair their own profile even when an `*_enc` column is a placeholder or was encrypted under a rotated key (STS-W3-01 fixed); README documents volume/disk encryption and 30-day backup retention. **Not met:** `POST /api/users/me/export` does **not exist** (404 on a live server), so the CCPA 30-day copy right has no implementation; and the ADR-007 free-tier data-use review, while recorded at `docs/adr007-data-use-review.md` with the terms URL and effective date, is explicitly `_unsigned_` for reviewer and date — ST-06 asks the **team** to record it. |

### 3.3 Abuse / misuse cases (SRS §3.5)

SRS Appendix B traces AB-01…AB-08 collectively to **ST-03, ST-04, ST-05, IT-03, TC-12**. The rows
below name, in addition, the file that executes each case.

| Req | Design element (SRS App. B) | Implementing file(s) | Test ID | Test file | Status | Evidence |
|---|---|---|---|---|---|---|
| **AB-01** Fake host / fake listing | Misuse cases §3.5 — Eligibility Policy, Moderation Module, Review Service, Safety Alert Service | `src/modules/eligibility/policy.js`, `src/modules/listings/service.js` | ST-05, IT-03, TC-09, TC-08, TC-07 | `tests/st-security/st-security-wave3.test.js` | **Partial** | A host without the profile / host-agreement gate is **403 before any listing work**; a freshly created listing is `moderation_status='pending'` and **invisible** in search until approved. The other half is absent by design in wave 3: nothing in `src/` can write `moderation_status`, so no listing can leave the pending queue, and mutual reviews (FR-05) do not exist. Moderation (FR-08) and reviews (FR-05) are wave 4. |
| **AB-02** Fraudulent / hoarding bookings | Misuse cases §3.5 — Eligibility Policy, Booking Service, Logging | `src/modules/bookings/service.js`, `src/config/` | TC-12, ST-04, LT-01 | `tests/st-security/st-security-wave3.test.js`, `tests/tc-booking/tcbv2-independent-reverify.test.js` | **Met** | Sequentially: the (cap+1)th booking for one guest is 409 `BOOKING_LIMIT`, creates no row and leaves `seats_remaining` unchanged. Concurrently: 8 simultaneous bookings by one guest across 8 listings → exactly 3×201 / 5×409, zero responses outside `{201,409}`, exactly 3 listings decremented and 5 untouched. An ineligible guest is 403 **before** any capacity work (the FR-09 ordering is asserted, not assumed). |
| **AB-03** Spam / scripted listings | Misuse cases §3.5 — Listing Service (MEHKO invariant), Moderation Module, Input Validation, Auth rate limiting | `db/migrations/0002_indexes_constraints.sql`, `src/modules/listings/mehko.js`, `src/middleware/validate.js` | IT-03, ST-04, ST-03, TC-11 | `tests/st-security/st-security-wave3.test.js` | **Partial** | 10 same-day creations for one host yield **exactly 1** persisted listing and 9×409 — the DB unique index on `(host_id, local_date)` is the enforcement, not application logic. Malformed and oversized payloads are 422 at the validation layer. Login rate limiting is proven under NFR-05. The moderation half ("spam samples are rejected or queued and never published") is wave 4 and cannot be executed; the weekly cap's window shape is now ratified (**F-02**, closed). |
| **AB-04** Abusive content in chat or reviews | Misuse cases §3.5 — Moderation Module, Safety Alert Service, Logging | *(none)* | IT-03, TC-08, TC-06, TC-05, TC-07 | `tests/st-security/st-security-verify.test.js` | **Not implemented** | Executed absence check: `src/modules/{reviews,messaging,moderation,privacy}` do not exist on disk and none of `reviews`/`messaging`/`moderation` appear in `app.locals.routes.mounted`. FR-05, FR-06 and FR-08 are all wave 4, so **AB-04 has no attack surface to test**. Reported as not implemented so its silence cannot be read as safety. |
| **AB-05** Account takeover | Misuse cases §3.5 — Authentication Service (hashing, rate limiting), Network Security Layer | `src/modules/auth/{passwords,rateLimit,sessions}.js`, `src/server.js` | ST-03, ST-02, ST-01 | `tests/st-security/st-security.test.js` | **Met** | A scripted 50-attempt brute force is locked from attempt 6 on, and the **correct** password is refused throughout the lockout. The per-source-IP counter locks out one origin cycling many *accounts* (credential stuffing). Lockout responses do not reveal whether an account exists. The session cookie is opaque with ≥128 bits of entropy and carries `HttpOnly` + `Secure` + `SameSite`; logout deletes the Redis session so the token is unusable afterwards. Combined with ST-01 (all login traffic over TLS 1.2+, plain HTTP refused) and ST-02 (Argon2id only). |
| **AB-06** Injection attacks (SQLi / XSS) | Misuse cases §3.5 — Input Validation Module | `src/middleware/validate.js`, `src/schemas/*.js`, `.github/zap/baseline-plan.yaml` | ST-04 | `tests/st-security/st-security-verify.test.js` + `docs/results/zap-baseline-RUN.md` | **Partial** | The targeted SQLi/XSS suite (NFR-11 above) passes and is what actually guards this today. The **OWASP ZAP baseline clause is now executed for the first time in this project** rather than merely scheduled: ZAP **2.17.0** (`ghcr.io/zaproxy/zaproxy:stable`, digest `sha256:781a2bd…`) against a live HTTPS server, reporting `FAIL-NEW: 0 · WARN-NEW: 3 · PASS: 58`; the project's own gate `npm run scan:zap:report` prints **High 0 / Medium 0 / Low 0 / Informational 3 across 24 distinct URLs** and exits 0. Report and provenance are committed under `docs/results/`. **Partial for two honest reasons:** (1) 24 URLs is the whole *API* surface — there is no HTML and no client bundle (waves 5–6), so the passive rules that matter for XSS-in-a-page had nothing to run against; (2) the acceptance names chat, review and moderation-note boundaries that do not exist in wave 3. |
| **AB-07** MEHKO evasion via duplicate accounts | Misuse cases §3.5 — Registration/Email Verification, Listing Service (single enforcement point), Logging | `src/modules/auth/service.js`, `src/modules/listings/mehko.js` | TC-10, TC-11, MT-01 | `tests/st-security/st-security-wave3.test.js` | **Met** *(with an accepted residual)* | A duplicate registration on an existing email returns **409** and creates no row (`users_email_key`). An unverified host that **has** a profile and the agreement is still 403 on `POST /api/listings` — an unverified email cannot publish. The single server-side daily enforcement point and the `(host_id, local_date)` unique index are proven under AB-03. **Accepted residual, per ADR-009:** phone uniqueness and identity verification are deferred to v2.0, so a determined attacker with N verified email addresses can still obtain N daily allowances. This is a *recorded decision*, not an untested gap. |
| **AB-08** Scraping of personal data | Misuse cases §3.5 — Session authentication, Eligibility Policy, Data minimization in API responses | `src/modules/auth/middleware.js`, `src/modules/listings/{serializers,access}.js`, `src/modules/hosts/serializers.js` | ST-06, ST-04 | `tests/st-security/st-security-wave3.test.js` | **Met** | Executed across **every** wave-3 read path (the ADR-010 property is only as strong as its weakest serializer). Every read/write endpoint is 401 unauthenticated and serves no data. Search results match the public allowlist **exactly** — no address, no precise coordinates, no contact data. Listing detail gives a stranger the public projection, a guest holding a *pending* booking the exact address, and **reverts to public once that booking is cancelled**. The host page matches `HOST_PAGE_KEYS` exactly. Booking payloads embed a public-fields-only listing reference. Another user's media id is 404 on DELETE, so existence is never confirmed. `canViewPreciseLocation` is **deny-by-default** when called directly with malformed ids, with a positive control proving the guard is not a blanket false. Redis caches public precision only, so a cache read cannot leak an exact location. |

### 3.4 Summary count

| Status | FR | NFR | AB | Total |
|---|---|---|---|---|
| **Met** | 11 | 8 | 4 | **23 / 35** |
| **Partial** | 0 | 2 (NFR-08, NFR-13) | 3 (AB-01, AB-03, AB-06) | **5 / 35** |
| **Not implemented** | 3 (FR-05, FR-06, FR-08) | 3 (NFR-07, NFR-10, NFR-12) | 1 (AB-04) | **7 / 35** |

Every "not implemented" is wave 4+ scope, is asserted absent by an executed probe rather than by
reading, and was **not** built during this verification run.

---

## 4. Open findings

Round-1 verification raised **40** findings across 8 lanes. Here is where all 40 stand, so nothing is
quietly dropped:

| Group | Count | Outcome |
|---|---|---|
| Claimed resolved by repair round 1 | 30 | **Independently re-verified** by re-executing each original failure scenario against the current tree. **29 confirmed fixed**; TCC-02's declared residual was closed by a documented design decision (**F-08**). No claim survived on the fixer's word alone. |
| Never repaired, but closed since | 5 | **COV-01** (flaky AB-08 canary — the bare `not.toContain('742')` that matched random UUIDs is gone from the tree and the coverage lane passes), **TCC-04** (FR-02 review preview now carries `reviewsTotal`/`reviewsPageSize`, with the paged list at `GET /api/hosts/:id/reviews`), **W3-ADR-04 + COV-07** (the last raw SQL in a route file moved into `src/modules/media/repo.js`; a dedicated test now asserts **no** DB access in any route layer), **COV-06** (both production notification adapters' `deliver()` bodies are now executed against substituted SDKs — no live provider call), **RTLT-02** (its premise is stale: k6 **is** installed at `/usr/local/bin/k6`, v2.2.0, and the NFR-01 acceptance run was executed with it). |
| Never repaired, still open | 2 | **IT-F1 → F-04**, **STS-W3-03 → F-03**. (**TCB-W3-05 → F-02** and **STS-W3-05 clause 1 → F-06** were both closed by team decision on 2026-08-18.) |
| Not re-checked in this run | 1 | **COV-08** (nine exported names referenced nowhere in `src/` or `tests/` — dead or premature exports). Minor and cosmetic; recorded here rather than silently marked resolved, because this run did not execute a check for it. |

The sections below are what remains open at `176ba39`, plus one new defect found during this run.

---

### F-01 — Suite nondeterminism: fixed-pass outbox drains against a globally-ordered claim
**Severity:** Major (it invalidates every other pass claim while open) · **Requirements:** all
worker-backed FRs (FR-07, FR-10, FR-13), NFR-08 · **Status: FIXED IN THIS RUN — runs C, D and E, three
consecutive 71-suite / 1302-test green runs, are the proof (§6)**

**Reproduction (observed, not theorised).** Two full-suite runs, back to back, on the *same* lane
(`homeplate_finalrpt_test`), on an *idle* machine, against *identical* code:

```
run A:  Test Suites: 71 passed, 71 total · Tests: 1302 passed, 1302 total · 93.078 s · exit 0
run B:  Test Suites: 1 failed, 70 passed  · Tests: 2 failed, 1300 passed  · 93.526 s · exit 1
```

Run B's two failures, both in `tests/mt-ut-quality/mt01-w3rv-safety-audit.test.js`:

```
● … › the worker log lines for that job carry the SAME correlation ID (both sides)
    expect(rows[0].delivery_status).toBe('delivered');
    Expected: "delivered"   Received: "pending"          (line 326)
● … › the NOTIFICATION_ATTEMPT rows are persisted and hold IDs only (ADR-011)
    expect(rows.length).toBeGreaterThanOrEqual(1);
    Expected: >= 1          Received: 0                  (line 360)
```

**Cause.** `src/outbox/worker.js` claims work with

```sql
SELECT * FROM outbox_jobs
 WHERE status = 'pending' AND available_at <= now()
 ORDER BY available_at, id
 FOR UPDATE SKIP LOCKED
 LIMIT $1          -- config.outbox.batchSize = 10
```

— oldest-first across the **whole table**. The failing test drained with `for (let i = 0; i < 8; …)`,
a hard ceiling of 8 × 10 = **80 rows**. Every suite that creates a booking or a listing and does not
drain leaves pending `notify.booking` / `listing.geocode` / `moderation.scan` rows behind, all
ordered *ahead* of this alert's job. Whether 80 passes is enough is therefore a function of how many
rows **sibling suites** happened to leave — global state this test does not own. Run A left fewer
than 80; run B left more. Note the failure mode is silent and misleading: the assertion that fires
is about *correlation IDs*, so the symptom points at observability while the cause is scheduling.

**Fix applied (cause, not symptom).** No assertion was deleted, weakened, retried or slept on. The
fixed pass budget was replaced by a drain that ends on the condition the test actually cares about —
this job has been processed, **or** nothing anywhere is claimable. Jobs that back off take a future
`available_at` and drop out of the claim, so the loop terminates; the remaining numeric cap is a
runaway guard that throws a diagnostic if it is ever reached, and is documented as such. Files:

- `tests/mt-ut-quality/mt01-w3rv-safety-audit.test.js` (the one that fired)
- `tests/mt-ut-quality/mt01-wave3-booking-audit.test.js`, `mt01-wave3-audit-gaps.test.js`,
  `mt01-log-completeness.test.js` (same shape, 25-pass budgets — latent, now closed)
- `tests/adr-conformance/verify-adr-wave0-3.test.js` (5 passes × batch 50, **no** early exit at all)

**Residual.** A handful of suites still use bounded loops of this family
(`tests/tc-booking/tc12-tc14-booking-schema.test.js`, `tests/st-security/st-security-wave3.test.js`,
`tests/unit/listings.test.js`). All of them carry a `claimed === 0` break and larger headroom, so
they are lower risk, but the pattern should be swept in wave 4. **The durable fix is a shared
`drainOutbox()` helper in `tests/helpers/` that every suite calls**, so this cannot be re-introduced
one file at a time.

**Also relevant:** the earlier hypothesis recorded in the wave-3 handoff — that "jest runs 60 suites
in parallel workers" — is **wrong**. `jest.config.js` sets `maxWorkers: 1`; suites run serially
within a run and share one database. The variance is cross-suite *residue*, not worker parallelism.

---

### F-02 — CLOSED 2026-08-18: the AB 626 weekly MEHKO window is ratified, and the cap corrected to 90
**Severity:** was Major (a legal-compliance claim rested on it) · **Requirements:** FR-11, AB-07,
ADR-009 · **Status: CLOSED by team decision.** Retained in full because the decision, and a wrong
number it uncovered, are both CDR-relevant.

**The decision.** The weekly cap is summed over a fixed **Monday–Sunday `America/Los_Angeles`
calendar week**, not a rolling 7-day window. California MEHKO weekly limits are calculated on a
standard calendar-week basis; state operational standards treat the week as a fixed 7-day calendar
block (commonly Sunday–Saturday or Monday–Sunday, with county health departments enforcing the
precise tracking), and this deployment pins Monday–Sunday. Recorded in ADR-009 §"Weekly window
shape — RATIFIED 2026-08-18" and its Amendment log; `requirements-inventory.json` FR-11 now carries
a `specDecision` block in place of the former `specAmbiguity`.

**A wrong number found while ratifying it.** The weekly cap was **60**; it is **90**. AB 626 set 60
and **Assembly Bill 1325** raised it to 90, but this project had carried 60 since 2026-08-12 and
ADR-009 asserted those values "are the AB 626 MEHKO limits". The error was *over*-restrictive — it
refused listings a host is legally entitled to post — so it created no compliance exposure, but the
claim was false. Corrected in `src/config/locale.js`, the one home of the numbers.

**What the correction exposed in the tests.** Six assertions pinned the literal 60, and — more
interesting — four tests encoded the cap in their *arithmetic*: they filled a week with two 30-seat
days because 2 × 30 was the old cap, and one packed `weekly − daily` seats into a single listing,
which at 90 exceeds the **daily** cap of 30 and returns 422. Those tests were rewritten to derive
the number of filling days from config, so a future amendment cannot silently void them again. The
ADR-009 "no cap literal outside src/config" scans also needed narrowing rather than loosening: **90
is the maximum latitude**, so the old bare `/\b60\b/` scan reported `src/schemas/common.js` and
`src/lib/geoPrecision.js` as offenders. The shared helper `tests/helpers/capScan.js` now strips
comments and skips geographic lines, keeping the invariant intact instead of retiring it.

**Accepted residual risk (unchanged behaviour, now a decision).** A calendar week is by construction
spreadable across its boundary: filling the trailing days of one week and the leading days of the
next places **twice the weekly cap** inside a single 7-day span. That follows from the statute's own
calendar-week basis and is accepted, not a defect. Two tests pin it so it stays visible
(`tcb-w3-reverify.test.js`, `tcbv2-independent-reverify.test.js`).

**Consequence:** a TC-11 pass is now evidence against a **ratified** requirement, so the FR-11
weekly clause **may** be cited as AB 626 / AB 1325 weekly-compliance evidence. Before 2026-08-18 it
could not.

**Verified after the change:** two consecutive full-suite runs, **71 suites / 1302 tests**, exit 0,
~95 s each; lint and build clean.

---

### F-03 — NFR-12 erasure and the NFR-13 export path do not exist
**Severity:** Major (a v1.0 user cannot delete their account or obtain their data) ·
**Requirements:** NFR-12, NFR-13, ST-05, ST-06, AB-01 · **Status: OPEN — wave-4 scope (U4-PRIVACY),
deliberately not built here** *(round-1 finding STS-W3-03)*

**Reproduction** (measured on a real running server): `DELETE /api/users/me` → **405**, `Allow: GET,
HEAD, PATCH`; `POST /api/users/me/export` → 404; `GET /api/privacy` → 404. No erasure or retention
job type is registered with the dispatcher. `grep -rnE 'UPDATE users[^;]*SET[^;]*(anonymized_at|deleted_at)' src/`
→ nothing. `scripts/retention.js`, `scripts/backup.js` and any `BACKUP_*` key in `.env.example` do
not exist. Migrations `0005_privacy` and `0006_moderation` are absent (`check-build` reports 4
migration files).

**Proposed fix (wave 4).** `src/modules/privacy/` with (a) `DELETE /api/users/me` writing
`deleted_at` and enqueuing an erasure job; (b) an outbox handler that anonymises the §3.4 columns,
calls the **existing, working** ADR-004 delete-by-key media primitive, and retains reviews in
anonymised form; (c) `POST /api/users/me/export` producing the CCPA copy within 30 days; (d) an
inactivity sweep at `config.privacy.inactivityMonths = 24` with notice; (e) a backup-retention script
plus a documented `BACKUP_RETENTION_DAYS` variable.

**Why it is still open:** it is not a defect in wave-3 code — the behaviour was never in wave-3
scope. It is recorded here because **the SRS promises it in v1.0** and CDR evidence must not imply
otherwise. The substrate is genuinely ready: the columns, the configuration, the read-path erasure
predicates and the media primitive all exist and are tested; **only the behaviour is missing.**

---

### F-04 — NFR-10 is unmeasured and unmeasurable in this tree
**Severity:** Blocker for NFR-10 · **Requirements:** NFR-10, FR-08 · **Status: OPEN — wave-4 scope
(U4-MODERATION), fenced off from this run** *(round-1 finding IT-F1)*

**Reproduction.** `fs.existsSync('src/modules/moderation') === false`;
`loadHandlers().has('moderation.scan') === false`; no pre-filter/blocklist module anywhere in `src/`;
no results file in `tests/fixtures/moderation-eval/v1/`, `docs/results` or `docs/_generated/results`;
`manifest.labelReview.status === 'unreviewed'`, reviewer and date `null`; `claimability(…)` returns
`claimable: false`.

**Proposed fix (wave 4).** Build the ADR-002 two-stage pipeline (deterministic pre-filter →
Gemini free tier through the provider-agnostic ADR-007 adapter), add the `moderation.scan` handler,
then run **IT-03** against `tests/fixtures/moderation-eval/v1/` with `ALLOW_LIVE_ADAPTERS_IN_TESTS=true`
for that one measurement run, record the model id with the result, and obtain the **ADR-008 human
label sign-off** (reviewer name, date, set version) before any pass is claimed.

**Why it is still open:** the pipeline it measures does not exist. Two traps are worth naming because
both are easy to fall into at CDR: scoring the set through the **deterministic mock** would produce a
number that is pure fiction (it scores unseen abusive, scam and link-spam text as *benign 0.99* —
proven executably), and a live run **without** the human sign-off yields provisional numbers only,
per ADR-008. **No FP/FN rate appears anywhere in this report.**

---

### F-05 — NFR-07 has no subject: there is no client, and the UT-01 study is unscheduled
**Severity:** Major (the SRS §4.5 triage deadline is *before* CDR and will be missed) ·
**Requirement:** NFR-07 · **Status: OPEN — waves 5–6 scope**

**Reproduction.** `ls -d client` → no such directory. A repository-wide find for `*.jsx`/`*.tsx`/
`*.html` returns nothing. No `axe`, `playwright`, `puppeteer` or `jsdom` in `node_modules`.
`curl http://localhost:5173` → exit 7.

**Proposed fix.** Wave 5 pins `@axe-core/playwright` plus a browser package as devDependencies in
**one** `npm install` that regenerates `package-lock.json` (never `npx --yes`, which resolves an
unpinned ChromeDriver against whatever browser the developer happens to have — that is exactly how
round-1 finding MTUT-W3-03 manifested), then adds a spec that boots the Vite preview server and
audits all seven interfaces the acceptance enumerates at `wcag2a`/`wcag2aa` with zero serious or
critical violations, plus keyboard-traversal checks. Separately, schedule the 5-participant moderated
study (§5 below).

**Why it is still open:** there is nothing to audit. Recorded as *not implemented* rather than
*skipped* specifically so its absence cannot be misread as coverage — which is why
`npm run test:a11y` is wired to fail on purpose and is kept out of CI.

**Position taken 2026-08-18 (team decision).** The §4.5 deadline is **declared missed at CDR**, not
quietly deferred. The statement to be read, the causal chain behind it, and a ready-to-run study
protocol — task sets for both roles, participant criteria, and a triage rubric — are in
[`docs/ut01-usability-study-plan.md`](ut01-usability-study-plan.md). Participants and a fixed date
are named at the CDR stand-up (build-plan action **A-NFR07-2**); the session runs when wave 6
delivers the seven interfaces. That file's §6 record block is `_unfilled_` and, like the ADR-007 and
ADR-008 sign-offs, may not be filled in by an agent. NFR-07 stays **not implemented** until both that
block is complete and the axe-core audit is clean.

---

### F-06 — CLOSED 2026-08-18: the ST-06 ADR-007 data-use review is signed
**Severity:** was Minor · **Requirements:** NFR-13, ST-06, ADR-007 · **Status: CLOSED by team
decision** *(round-1 finding STS-W3-05, clause 1)*

**What was open.** `docs/adr007-data-use-review.md` was substantive — terms URL, effective date,
verbatim quotes — but its sign-off block read `_unsigned_`, and ST-06 asks the *team*, not a tool, to
record the finding.

**The decision.** **Gaetan Rieben signed §7 on 2026-08-18, ratifying option (a) + (b):** only
non-personal content may reach the live free-tier provider, with identifier stripping as defence in
depth. Before recording it the terms were re-fetched from the live page: effective date **still
2026-03-23** and findings F1–F4 confirmed **verbatim**, so the analysis was current, not a stale
snapshot.

**The ratified rationale, which is what makes this cheap.** Homeplate v1.0 is a course prototype
exercised **solely with synthetic, team-authored data** — it holds no real user content at all. The
restriction is therefore satisfied *by construction*, and wave 4 can build and exercise the full
FR-08 confidence-routing path against the live provider without sending anything the terms forbid.
Real user content appears only if the project is marketed, and that is a **paid-tier plus
re-signature** event under the file's §7.2 re-review triggers — not a configuration change, and not a
model swap.

**Guard.** The lane test was inverted, not deleted: `st-security-verify.test.js` previously asserted
the `_unsigned_` placeholders were present so a signature could not be lost silently; it now asserts
a named reviewer and a parseable ISO date, plus that live mode for real user content is still **No**.
The clause is guarded in both directions.

**Residual, tracked not hidden:** the SPMP §7.4 **countersignature by Nam Tran is outstanding**. No
agent may record a second human's review, so the §7 table carries an explicit OUTSTANDING row. The
ST-06 clause is closed; the peer-review formality is not yet complete.

---

### F-07 — ST-05's backup-expiry clause has nothing executable to review
**Severity:** Minor (subsumed by F-03, but distinct: it is a *configuration* clause) ·
**Requirement:** NFR-12, ST-05 · **Status: OPEN — wave-4 scope**

**Reproduction.** `grep -in BACKUP .env.example` returns only prose comments; `scripts/retention.js`
and `scripts/backup.js` do not exist. The only artifact is a README sentence ("retention is capped at
30 days").

**Proposed fix.** Add `BACKUP_RETENTION_DAYS=30` to `.env.example` and the config schema, and a
`scripts/backup.js` that enforces it, so ST-06's "configuration review" has an object.

**Why it is still open:** ST-05's acceptance asks that "the backup-retention configuration/script
expires backups older than 30 days". Prose in a README is a *promise*, not a configuration. Recorded
separately from F-03 so the team does not mistake the documentation for the control.

---

### F-08 — Closed by decision, recorded for the record: the FR-02 detail read of a soft-deleted host
**Severity:** Informational · **Requirements:** FR-01, FR-02, NFR-12 · **Status: CLOSED by a
documented design decision** *(round-1 finding TCC-02)*

Round 1 reported that a soft-deleted host's approved listings stayed discoverable. The **discovery**
direction is fixed and re-verified: search excludes them (scalar-subquery erasure predicate in
`src/modules/search/repo.js`, applied to both the page and the count query), `GET /api/hosts/<deleted>`
is 404, and the example-dishes read is empty. The **detail-by-known-id** read still returns 200 —
*deliberately*: `src/modules/listings/repo.js` documents that adding a `deleted_at` predicate there
is "not a hardening, it is the opposite", because a guest holding a booking must still be able to
read the meal they booked. What NFR-12 actually requires is that **no erased personal data is
served**, and that is proven by `tests/tc-core/tccrv02-erasure-read-paths.test.js`: the payload
carries neither the erased name nor the email, whatever the listing status. Noted here so a reader of
the round-1 findings file does not conclude the item was quietly dropped.

---

### F-09 — CLOSED 2026-08-18: CI has now executed wave 3, and it is green
**Severity:** was Major · **Requirement:** none directly (evidence quality for all) ·
**Status: CLOSED.** Run [32187777816](https://github.com/Gaetan-kiingo/homeplate/actions/runs/32187777816)
on `155b810`: **71 suites / 1302 tests passed**, every step green, job **2m54s** (suite 125.6 s on the
runner). Coverage on the runner: statements **93.95 %**, branches **83.96 %**, functions **97.69 %**,
lines **94.74 %** — within a rounding step of the local figures, i.e. no environment-specific gap.
The suite **exited on its own** under `TEST_STRICT_HANDLES=1`, so the hang did not reappear on a cold
machine.

**Reproduction.** `origin/main` ends at `af1a91a` — waves 0–2 only, 28 suites, 611 tests. Every wave-3
number in this report was measured on one developer machine.

**Why that matters concretely, not theoretically.** The first CI run on waves 0–2 found three defects
a local run could not: an unanchored `coverage/` gitignore rule that had kept a whole 24-test lane out
of every commit, a missing TLS-certificate generation step, and a race in a test that only lost on
slower hardware. None was visible locally.

**Work done 2026-08-18 before pushing** (`docs/results/ci-readiness.md` — the W3-CI-PUSH deliverable,
which the verification run did not produce):

- CI runs `npm test -- --coverage`, which most local runs did **not** use, and coverage mode was a
  recorded risk (W3-F1: reorders suites, once reddened an ADR assertion). Run explicitly: **twice,
  both 71 suites / 1302 tests, exit 0**, ~97 s. The risk does not reproduce on this tree. Coverage:
  statements 94.01 %, branches 84.00 %, functions 97.69 %, lines 94.80 %.
- **Timeouts added** (`timeout-minutes: 25` job, `12` test step). The defended failure mode was
  observed here: Jest prints a green summary then never exits, which without a timeout burns a runner
  to GitHub's 6-hour cap and reports failure with a *passing* summary in the log.
- **`TEST_STRICT_HANDLES=1` enabled** on the test step, as this report recommended — verified safe
  first by a strict + coverage run (exit 0). A leaked handle now reddens the build instead of
  warning. `--forceExit` remains banned.

**What this now proves.** Every file the suite needs is genuinely committed; the run reproduces from
a cold checkout with no developer-machine state — no pre-existing database, no `.env`, no
certificates (CI generates them); and the toolchain resolves from `package-lock.json` on the pinned
Node. Wave 3's evidence is no longer single-machine.

**What it still does not prove**, and must not be read as proving: NFR-01 latency (k6 ran locally; a
shared runner is not a latency environment), AB-06's ZAP scan, anything requiring a deployment
(external TLS certificate validity, NFR-09 availability, backup expiry), and NFR-07/UT-01, which has
no client. See `docs/results/ci-readiness.md`.

---

## 5. Not verifiable in this environment

These are not failures. They are checks whose evidence a repository cannot produce, listed with what
a human must do.

| Check | Why it cannot be verified here | What the team must do |
|---|---|---|
| **UT-01 — 5-participant moderated usability study** (SRS §4.5) | A human activity by definition: "a moderated usability test with at least 5 participants covering both roles". No automation can produce it. | **Declared missed at CDR, on the record (team decision, 2026-08-18)** — SRS §4.5 requires triage *before* CDR, and with CDR on 2026-08-22 and the client in waves 5–6 there is no subject to test. The statement, the causal chain and a ready-to-run protocol (both role task sets, participant criteria, triage rubric) are in `docs/ut01-usability-study-plan.md`. Participants and date are named at the CDR stand-up (A-NFR07-2); the session runs when wave 6 delivers the seven interfaces; its §6 record block must then be filled in by a human. |
| **NFR-07 — axe-core WCAG 2.1 AA audit + keyboard/screen-reader spot checks** | There is no rendered interface and no browser toolchain in this repository (F-05). | Pin the harness in wave 5 in one `npm install`, then audit all seven named interfaces. Until then, **no violation count exists and none should be quoted.** |
| **NFR-10 — moderation FP/FN rates** | The pipeline that would be measured does not exist, and ADR-008 forbids a claim without human label sign-off (F-04). | Build the wave-4 pipeline, run IT-03 live once (recording the model id), and sign off the 224-item label set. |
| **NFR-12 — erasure within 30 days, and backup expiry** | The behaviour does not exist to be measured, and a 30-day window cannot be observed inside a test run regardless (F-03, F-07). | Build the wave-4 erasure job, then verify by **clock injection** rather than by waiting: assert that a deletion request schedules erasure at `now() + config.privacy.erasureDays` and that the job, run at that simulated instant, empties every §3.4 column. Backup expiry additionally needs a real backup target, i.e. a deployment. |
| **NFR-09 — "99 % availability during the demo period"** | Availability over a demo period is a *deployment* measurement over calendar time. This repository can only prove the mechanisms (typed degraded responses, cache fallback, deferred work, recovery) — and it does, thoroughly, in seven drills. | Record uptime during the actual demo window against the deployed instance. Do not present the RT-01 drill passes as a 99 % figure; they are the *design* evidence for it. |
| **ST-01 — external TLS configuration scan** | ST-01 is fully executed here against a real `https.Server` with the **dev certificate**. Certificate *validity* (chain, CA, expiry, hostname) cannot be checked without a deployed host and a real certificate. | Re-run the protocol sweep plus an external scanner (e.g. `testssl.sh` or SSL Labs) against the deployed host once a real certificate is issued. |
| **AB-06 — ZAP crawl over the rendered client** | The scan reached 24 URLs, which is the **entire** API surface — but there is no HTML and no client bundle, so the DOM-oriented passive rules had nothing to inspect (F-05). | Re-run `npm run scan:zap` after the wave 5–6 client ships and confirm the URL count rises accordingly. |

---

## 6. Suite determinism and process hygiene — measured, not asserted

**Priority 0 — determinism.** Five full-suite runs, all on one isolated lane
(`homeplate_finalrpt_test`, its own Redis index and MinIO bucket), on an otherwise **idle** machine
(orphaned jest processes from earlier sessions were killed first — one had been running since 18:54).

| Run | Code state | Result | Time | Exit | Hung? |
|---|---|---|---|---|---|
| **A** | before fix | 71 suites / **1302 passed**, 0 failed | 93.078 s | 0 | no |
| **B** | before fix (**identical code**) | 70 suites / **1300 passed, 2 failed** | 93.526 s | 1 | no |
| **C** | after fix | 71 suites / **1302 passed**, 0 failed | 93.780 s | 0 | no |
| **D** | after fix | 71 suites / **1302 passed**, 0 failed | 93.442 s | 0 | no |
| **E** | after fix + comment/format pass | 71 suites / **1302 passed**, 0 failed | 94.589 s | 0 | no |

Runs A and B are the honest evidence that the suite **was** nondeterministic: same lane, same code,
same machine, back to back, different results. The cause was found, fixed at the cause, and the fix
re-proved by runs C, D and E (finding **F-01**).

**How far this proves determinism, stated precisely.** **Three consecutive green full-suite runs**
after the fix (1302/1302 each, ~93–95 s each, all exit 0), against **one** red run before it whose
failure was diagnosed and repaired at its cause. That is strong evidence, not a statistical
guarantee. The defect class F-01 belongs to — assertions whose outcome depends on residue left by
sibling suites — is closed at the five sites that could reach it; the lower-risk residual sites are
named in F-01. The honest claim is: **"the one intermittent we reproduced is fixed at its cause, and
the suite then ran green three times in a row on an idle machine."** Since then it has also run green
under coverage twice, under `TEST_STRICT_HANDLES=1` once, and once on a cold CI runner (F-09).
Repeated CI runs over time are what will settle it for good.

**Residual R-1 — one ambient pending timer at teardown (not a hang).** Runs C, D and E printed:

```
globalTeardown: 1 resource(s) were still holding the event loop after the run:
  - 1 pending ref'd timer(s) (Timeout) — NOT releasable from here …
```

This is **ambient and pre-existing, not caused by the F-01 fix.** Probed directly: every lane that
touches the database reports it — including `tests/tc-core`, `tests/coverage` and `tests/unit`, none
of which this run edited — while lanes that touch no database (`tests/unit/config.test.js`,
`tests/fixtures/moderation-eval/set-integrity.test.js`) report **zero**. It also appears
intermittently in the same lane across runs, which is the signature of a timer racing teardown.
**Most likely owner:** the `pg` pool's `idleTimeoutMillis: 30_000` (`src/db/pool.js:22`) arming an
idle-client timer on a pool that had not been `end()`ed when teardown inspected the loop.
**Proposed fix (one line, for the team to accept, not applied here — it changes production database
behaviour and that is outside a verification run's scope):** add `allowExitOnIdle: true` to the Pool
options in `src/db/pool.js`, which unrefs idle clients so an otherwise-idle process can exit. The
long-running server and worker keep their own ref'd handles (the HTTPS listener; the poll loop), so
neither would exit early. **Impact today: none** — the harness's backstop unrefs the timer, so every
run exits, and no run in this report hung.

**Honesty note on earlier numbers.** Several per-lane determinism measurements taken earlier in this
verification effort are **not valid determinism data** and should not be quoted at CDR: up to eight
verifier lanes were editing test files in the same working tree and saturating the CPU
simultaneously, so suite counts changed *between* runs (1257 → 1260 tests) and LT-01's p95 gate
failed at 574 ms and 773 ms purely from contention. The runs in the table above were taken on an idle
machine against a frozen tree and are the ones to cite.

**Priority 0b — jest not exiting. Closed.** Earlier in this effort, runs hung after printing results
("Jest did not exit one second after the test run has completed"); one had to be killed at 8m20s
despite the tests finishing in 91 s. `--detectOpenHandles` named the cause: a `TCPWRAP` handle from
the ioredis client in `tests/coverage/cov-verify-probes.test.js`, the one Redis-using suite with no
`afterAll` close. **This is fixed and the fix is guarded:** that file now closes the client, and it
carries a meta-test — *"no test file opens the shared ioredis client without closing it in
`afterAll`"* — so the leak cannot be re-introduced one file at a time. Confirmed in this run: none of
the five full-suite invocations hung; each returned its own exit code in ~93–95 s. What remains is
residual **R-1** above: one auto-unref'd timer that produces a warning and no hang.

Two further hygiene notes worth carrying into CI. **(a)** Orphaned processes are real: this run began
by killing two jest processes left behind by earlier interrupted sessions, one alive for over an
hour, both consuming CPU. Any timing-sensitive measurement taken while those are alive is worthless —
check `ps aux | grep '[j]est'` before measuring. **(b)** `--forceExit` must never be used to make
this class of problem go away; it hides a leak rather than naming it. The harness supports
`TEST_STRICT_HANDLES=1` to **fail** a run on a leak instead of warning, which is the right setting to
turn on in CI once R-1 is fixed.

**Operational note for the team.** Parallel lanes must isolate `TEST_DATABASE_URL`,
`TEST_REDIS_URL` **and** `OBJECT_STORAGE_BUCKET` *together*. `tests/helpers/env.js` now **derives**
the Redis index and bucket from the database name, refuses a Redis URL resolving to DB 0, and claims
both with PostgreSQL advisory locks before any flush — so a lane can no longer half-isolate. This was
a real incident (round-1 finding RTLT-01): one lane's `FLUSHDB` deleted a sibling's live sessions
mid-run, which surfaced as a fabricated 99 % NFR-01 error rate. Redis has no eviction and raises no
error, so the damage was invisible until the number was disbelieved.

---

## 7. Measured numbers where the SRS demands them

### NFR-01 / NFR-02 — latency at scale (LT-01, LT-02)

**Instrument:** k6 **v2.2.0** (`darwin/arm64`), out of process, over real TLS against
`node src/server.js`. This is the instrument SRS §4.4 names. Raw artifact:
`docs/results/lt01-k6-summary.json`.

**Configuration:** `VUS=200 WARMUP=30s DURATION=5m SESSIONS=20 MIN_LISTINGS=1000`. Setup line:
`LT-01 setup: 20 sessions · catalogue 1001 active listings · 1000 listing ids · 1000 host ids · 200 VUs · warmup 30s · steady 5m`.

| Metric | Measured | Budget | Verdict |
|---|---|---|---|
| `http_req_duration{phase:steady}` **p(95)** | **254.93 ms** | < 500 ms | **PASS** |
| `http_req_duration{phase:steady}` p(99) | 468.36 ms | — | |
| `http_req_duration{phase:steady}` median / avg / max | 81.10 / 85.04 / 906.37 ms | — | |
| `http_req_failed{phase:steady}` | **0.00 %** (0 of 704,698) | — | **PASS** |
| `checks` | 749,183 / 749,183 succeeded (100.00 %) | > 99 % | **PASS** |
| Total requests / throughput | 749,234 at **2,261.2 req/s**, 4.9 GB received | — | |
| Concurrency | **200 VUs** sustained, 5 min steady + 30 s warm-up | ≥ 200 | **PASS** |

Per-endpoint p(95), steady phase:

| Endpoint | p(95) | p(99) | max | requests |
|---|---|---|---|---|
| search | **6.35 ms** | 11.51 | 705.00 | 280,743 |
| host reviews | **210.36 ms** | 303.17 | 655.51 | 106,197 |
| listing detail | **333.56 ms** | 477.07 | 823.26 | 176,745 |
| host page | **411.30 ms** | 576.49 | 906.37 | 141,013 |

**Every endpoint is inside the 500 ms p(95) budget**; the host page is the closest at 411 ms and is
the one to watch as the review corpus grows. Note p(99) on the host page is 576 ms — above the
budget, though NFR-01 specifies p(95).

**Scale (NFR-02):** the dataset behind that run was **10,027 users / 1,004 listings / 1,002 bookings
/ 1,001 approved reviews**, verified by direct `count(*)` before the run, and `smoke.js` refuses to
start below the 1,000-listing floor. This *is* the at-scale measurement; no small-dataset number is
being presented as one.

**In-suite regression gate** (not the acceptance instrument, recorded for CI): a Node in-process VU
loop over real loopback HTTP, 200 VUs / 45 s, measured **overall p95 107.4 ms, 0 errors over 172,102
requests** at 3,821 req/s. It is correctly labelled as a regression gate and its p95 assertion is
**not** enforced by default (`LT01_ENFORCE_P95` unset) — because a latency threshold measured on a
shared CI box is a flake generator, not a measurement. The **k6 run is the NFR-01 evidence.**

### NFR-05 — lockout behaviour (ST-03)

Scripted against the live HTTPS server, not supertest.

| Attempt | Credentials | Response |
|---|---|---|
| 1–5 | wrong password | **401 `INVALID_CREDENTIALS`** |
| 6 | wrong password | **429 `LOGIN_RATE_LIMITED`**, `Retry-After: 600` |
| 7 | wrong password | 429 |
| any, during lockout | **correct** password | **429** — lockout is not bypassable by knowing the password |

Configuration (from `src/config`, not inline literals): `auth.loginMaxAttempts = 5`,
`auth.loginWindowSeconds = 600`. Redis state after lockout: exactly two counters, both `val=5,
ttl=594` — `hp:ratelimit:login:ip:<addr>` (per source IP, the AB-05 credential-stuffing control) and
`hp:ratelimit:login:acct:<sha>` (per account, keyed by a **hash** so no email appears in a Redis
key). The counter stops at 5, so later failures do not extend the window. Window reset and
counter-reset-on-successful-login are both covered. A 50-attempt brute force is locked from attempt 6
onward. **Meets "5 failed attempts within 10 minutes" exactly.**

### NFR-10 — moderation false-positive / false-negative rates

| Quantity | Value |
|---|---|
| False-positive rate | **NOT MEASURED** |
| False-negative rate | **NOT MEASURED** |
| Labeled evaluation set | `tests/fixtures/moderation-eval/v1/` — **224 items**, balanced **56 offensive / 56 spam / 56 fraudulent / 56 benign**, above the SRS §4.2 floor of 200 |
| Set provenance | synthetic, team-authored; `scraped: false`, `containsRealUserContent: false`, `containsPersonalData: false` (ADR-008) |
| Set integrity | `validateSet()` → `[]`; 13 integrity tests pass |
| Human label sign-off | **`unreviewed`** — reviewer `null`, date `null` |
| Claimable per ADR-008 | **`false`** ("no sign-off") |
| Pipeline | **does not exist** — no pre-filter, no LLM stage, no `moderation.scan` handler |

**No number is quoted because none can be honestly produced.** The set is ready; nothing else is.

### NFR-12 — erasure window coverage

| Clause | Implementation | Coverage |
|---|---|---|
| User can delete their account | **none** — `DELETE /api/users/me` → 405 | **0 %** |
| Personal data erased/anonymised within 30 days | **none** — no job writes `anonymized_at`; `config.privacy.erasureDays = 30` exists but has no consumer | **0 %** |
| Reviews retained in anonymized form | reviews module is wave 4 | **0 %** |
| Inactive-account deletion after 24 months + notice | **none** — `config.privacy.inactivityMonths = 24` exists but has no consumer | **0 %** |
| Backups expire within 30 days | **none executable** — README prose only, no config key, no script | **0 %** |
| *(substrate)* media deleted by key on account deletion | `src/adapters/objectStorage.js` + `mediaService.deleteForUser` — **works**, proven against real MinIO (put two keys → delete → both 404, neighbouring key survives, re-delete idempotent) | primitive **100 %**, **production callers 0** |
| *(substrate)* erased identity never served on a read path | search excludes soft-deleted hosts; host page 404s; detail payload carries neither the erased name nor the email | **proven** |

**NFR-12 behavioural coverage is 0 %.** The substrate is genuinely ready and tested; the behaviour is
wave 4.

---

## 8. What this report does not claim

Stated plainly, because an overstated CDR document is worse than none:

1. **No NFR-10 accuracy number**, in any form, provisional or otherwise.
2. **No NFR-12 erasure guarantee.** No v1.0 user can currently delete their account.
3. **No NFR-13 CCPA export.** The endpoint does not exist.
4. **No NFR-07 accessibility result.** There is no client to audit.
5. **AB 626 / AB 1325 weekly compliance** may now be claimed from TC-11: the window shape was
   ratified 2026-08-18 and the cap corrected to 90 (F-02). Daily cap and single enforcement point
   were already proven. The claim is that the *ratified* rule is enforced — not legal advice.
6. **No 99 % availability figure.** Only the NFR-09 degradation *mechanisms* are proven.
7. **CI has now run wave 3 and is green** (F-09, run 32187777816: 71 suites / 1302 tests on a cold
   runner). That proves the tree is genuinely committed and reproduces without developer-machine
   state. It does **not** prove NFR-01 latency, AB-06's ZAP scan, or anything needing a deployment —
   those numbers were measured locally and are labelled as such.
8. **No claim that the reviews, messaging or moderation surfaces are safe** — they do not exist, so
   AB-04 has nothing to test and is reported as *not implemented* rather than silently omitted.

---

## 9. Recommended order of work before CDR (2026-08-22)

1. ~~**Commit and push the working tree** so CI executes wave 3 for the first time (F-09)~~ —
   **DONE 2026-08-18:** pushed with the workflow hardened (timeouts, strict handle gate) and coverage
   mode verified locally first. See `docs/results/ci-readiness.md`.
2. ~~**Ratify the ADR-009 weekly window** (F-02)~~ — **DONE 2026-08-18:** Monday–Sunday calendar week, cap corrected to 90 per AB 1325. ADR-009's impact inventory tells you exactly what each choice
   costs.
   **While you are at it, ratify the FR-01 acceptance correction (TCC-03)** recorded in §3.1 — a
   verification run corrected a requirement's acceptance wording rather than the code, and that
   should be a team decision on the record, not an inherited fact.
3. ~~**Sign `docs/adr007-data-use-review.md`** (F-06)~~ — **DONE 2026-08-18:** option (a) + (b) ratified. Remaining: Nam Tran's SPMP §7.4 countersignature.
4. ~~**Schedule the UT-01 study**~~ — **DONE 2026-08-18:** the miss is declared on the record and the
   protocol is written (`docs/ut01-usability-study-plan.md`). Remaining human action: name the five
   participants, the date and the owner at the CDR stand-up (A-NFR07-2), then run it when wave 6
   lands and fill in that file's §6 record block.
5. **Land a shared `drainOutbox()` test helper** and sweep the remaining bounded drain loops, so
   F-01's class of defect cannot return one file at a time. While there, accept or reject the
   one-line `allowExitOnIdle: true` fix for residual **R-1**, then turn on `TEST_STRICT_HANDLES=1`
   in CI so a future handle leak fails the build instead of warning.
6. **Wave 4 in this order:** privacy (F-03 — it is the largest *promised-but-absent* surface and the
   only one with a legal deadline attached), then moderation (F-04, which unblocks NFR-10, FR-08,
   AB-01, AB-03, AB-04 and completes MT-01/NFR-08), then reviews and messaging.

---

*Prepared by automated verification against the tree at `176ba39`. Every status in §3 was produced by
executing a test against the current working tree, not by reading code or transcribing a prior
claim. Where a claim could not be reproduced, it is recorded as an open finding.*
