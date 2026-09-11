# Implementation Increment + Code-Review Log — cumulative, waves 0–7 and the demo build

**Project:** Homeplate · **Increments:** Waves 0–2 (platform) through the demo build ·
**Team:** Group 6 (Lucya, Gaetan, Nam) · **Date:** 2026-09-11 · MSCS 2101, Module 6 (updated for the
final submission) · **Tree:** `667187e` on `main`, CI green (run `34498081525`), plus the uncommitted wave-7 measurement of 2026-09-11

This document supersedes the 2026-08-18 version, which covered wave 3 only. Every increment merged
since then is added below with the review findings it produced, and the quality-gate table reports
the state of the final tree. The wave-3 material is kept, and the waves 0–2 platform that preceded the Module 6 submission is added, so the log reads as one record.

---

## 1. Implementation increments

| Increment | Merged | What we built | Requirements | Architecture fit |
|---|---|---|---|---|
| **Waves 0–2 — Foundation, platform services, adapters** | 2026-08-14 | Config validation and logging, TLS-only HTTP layer, auth (argon2id, sessions, lockout), registration and email verification, eligibility policy, transactional outbox and worker, five external adapters with degraded modes, field encryption, full schema with integrity constraints. | FR-09 (eligibility), FR-10 (registration; later found broken, see finding 6); NFR-03 (sessions), NFR-05 (lockout), NFR-09 (degraded modes), NFR-13 (field encryption); AB-05 | ADR-001 modular monolith, ADR-003 outbox, ADR-004 storage, ADR-005 maps, ADR-006 sessions, ADR-011 notifications; 28 suites / 611 tests, 91 % statements at the time. |
| **Wave 3 — Core marketplace** | 2026-08-14 → 08-18 | Hosts create/edit/cancel listings under the MEHKO caps; guests search, read a meal and a host profile, reserve/cancel/complete bookings; media upload; scheduled pending→in-progress transition. | FR-01, 02, 03, 04, 11, 12, 13, 14; FR-10 repaired; NFR-01, 02, 08, 09, 11, 13; AB-02, 05, 07, 08 | Four modules (`listings`, `bookings`, `search`, `hosts`) as routes/service/repo/schema (ADR-001); provider work via the ADR-003 outbox; migration 0004 append-only; single MEHKO enforcement point (ADR-009). |
| **Wave 4 — Community, moderation, privacy** | 2026-08-21 | Two-stage moderation pipeline (pre-filter → LLM adapter → human queue), reviews on completed bookings, booking messaging, account erasure and data export, safety alerts in the unified queue. | FR-05, 06, 07, 08; NFR-12, 13; AB-01, 03, 04; NFR-08/11 clauses closed | Four modules (`moderation`, `reviews`, `messaging`, `privacy`); handlers `moderationScan`, `accountErasure`, `dataExport`; migrations 0005/0006 append-only; ADR-002 pipeline order; ADR-007 mock pinning in test. |
| **Wave 5 — Client foundation** | 2026-08-26 | React client as its own package: shell and routing, typed-error API client, session handling from the HttpOnly cookie, WCAG-AA token-only UI kit, axe-core + Playwright accessibility harness. | SRS §2.1.2; NFR-03, 07 (partial) | `client/` separate package and lockfile; CI installs, lints, builds and tests it as its own steps; a grep gate forbids `document.cookie` (ADR-006). |
| **Wave 6 — Seven client interfaces** | 2026-08-26 | Discovery, booking, community and account/moderation screens: all seven NFR-07 interfaces over the finished API. | NFR-07 (all interfaces present), AB-06 moved to Met | `client/src/features/**` only; no backend production file changed; feature trees pinned to exactly five by a scope guard. |
| **Post-wave-6 fixes and design pass** | 2026-08-26 → 08-27 | Session-aware navigation (the seven screens had no links), a double-fetch fix caught by CI, brand tokens, inline SVG icons, event cards, applied from the product design review. | NFR-07 (contrast, WCAG 1.4.1 colour-independence) | Frontend only; contrast pairs recomputed by the kit-contract test; no new dependency, no webfont CDN. |
| **Security hardening** | 2026-08-30 | Semgrep SAST first pass and OWASP review (Nam); AES-GCM decryption now declares the auth tag length explicitly. | NFR-13, AB-05 | One-line change in `src/db/fieldCrypto.js`; CI green. |
| **Wave 7 (partial) — NFR-10 live measurement** | 2026-09-11 | The one live IT-03 run ADR-007 sanctions: all 224 synthetic items through the real pre-filter → classifier pipeline against Gemini, rates recorded in `tests/fixtures/moderation-eval/v1/RESULTS.md`. The other two wave-7 items (seeded-route accessibility audits, UT-01 study) are **not done**. | NFR-10: measured, **not met** (FP 7.14 % vs < 5 %; FN 1.19 %) | No production code changed. Four guard tests that asserted "no results file" inverted to check the record's fields and internal consistency; 63 suites / 1400 tests green. |
| **Demo build** | 2026-09-10 | Design pass on every screen (home hero, sticky reservation panel, status badges, chat bubbles, allergen chips); `npm run seed:demo` loads 12 upcoming meals with photos, 6 hosts, reviews, bookings and a thread, with relative dates so the set never goes stale. | Demo readiness; fixes an FR-02 rendering defect | No new dependency; two client tests updated; demo accounts documented in the README, local only. |

**Requirement movement across the period:** waves 0–2 laid the platform with no marketplace requirement met end-to-end → 23 met / 5 partial / 7 not implemented after wave 3
→ 32 / 3 / 0 after wave 4 → **33 met / 2 partial / 0 not implemented** after wave 6, unchanged since.
The two partials are NFR-07 (six parameterized routes and the UT-01 study outstanding) and NFR-10
(pipeline built, accuracy not measured). Full traceability: `docs/verification-report.md` §3.

**How it was built.** Every wave used the same plan → implement → verify → repair workflow (spec in
`docs/ai-build-workflow-spec.md`): a coordinator planned from the frozen SRS v3.2 and the ADRs,
implementers built units with disjoint file ownership, independent verifier lanes re-executed the SRS
§4 protocol, and every repair was re-verified by an agent that had not written it. Wave 4 was built
unattended overnight and committed as an explicitly **unverified checkpoint**; nothing from it was
pushed until the verification round had run the next day.

---

## 2. Code-review log

We reviewed the AI-generated code against the SRS using the Code Review Checklist. The table lists
the findings we consider worth defending in a review; the verification rounds recorded many more
(2 plus 3 clean-checkout defects in waves 0–2, 40 in wave 3, 23 in wave 4, 5 in wave 5, 22 in wave 6, 3 in the wave-7 measurement), all in `docs/verification-report.md` and
`docs/_generated/wave6-verify/`.

### 2.1 Waves 0–2 (built 2026-08-14, findings F-1/F-2 and the first CI run)

| # | Checklist area | Finding (failure mode) | Severity | Resolution |
|---|---|---|---|---|
| 1 | **Verification** — shared state between runs | Two Jest runs against the same test database dropped the schema under each other's live queries: a second developer or lane starting the suite corrupted the first run (F-1). | High | `globalSetup` takes a session-scoped PostgreSQL advisory lock before resetting the schema and holds it until teardown; a second run blocks with a warning. Proven with two concurrent full-suite lanes both green, the second observed waiting. |
| 2 | **Correctness** — config honoured, not hard-coded | The bootstrap test hard-coded the Redis database index `/1`, so the documented `TEST_REDIS_URL` override failed the suite (F-2). | Low | Test asserts the index is non-zero (isolated from the dev database) instead of a literal; green under an override to db 5. |
| 3 | **Verification** — what a clean checkout proves | The first CI run showed an unanchored `coverage/` rule in `.gitignore` had silently kept the 24-test coverage lane out of every commit. CI ran 27 suites instead of 28 and the lane-directory check failed. Invisible locally because the file was on disk. | Medium | Rule root-anchored to `/coverage/`, lane tracked. Rule adopted: a push is the first independent execution of any wave. |
| 4 | **Security** — TLS in every environment | CI never generated the git-ignored dev TLS certificates, so both ST-01 TLS tests failed on the runner. | Medium | A certificate-generation step added to the workflow; the app stays TLS-only rather than gaining an HTTP fallback for CI. |
| 5 | **Correctness** — race in the race test | TC-11's concurrent-duplicate test attached its rejection handler to the blocked insert only after awaiting COMMIT; on CI hardware the 23505 rejection could arrive first and surface as an unhandled rejection. | Medium | Handler attached when the promise is created. The AB-07 unique-index guarantee itself was never in doubt; the test was. |

### 2.2 Wave 3 (2026-08-18 log, kept)

| # | Checklist area | Finding (failure mode) | Severity | Resolution |
|---|---|---|---|---|
| 6 | **Correctness** — does it do what the requirement asks | The verification email could only ever carry the token's **SHA-256 digest**, never the token. No user could verify an email, so none could book or publish. Waves 1–2 had reported FR-10 as PASS because the tests took the token from an in-process return value. | **Blocker** | The worker mints the link at send time (`resolveRenderContext`); outbox payload stays IDs-only (ADR-003). The acceptance test now drives the flow from the value the transport actually delivered. |
| 7 | **Security** — no secrets in code, safe defaults | Production config accepted the committed sample secrets (`FIELD_ENCRYPTION_KEY=deadbeef…`, `minioadmin`). | High | `validateEnv` rejects the sample key, any repeated-block key and the default storage credentials in production. |
| 8 | **Fit** — ADRs | `POST /api/media` constructed an S3 client on the request path (ADR-001: adapters are worker-only). | High | Storage moved behind the worker/repo boundary; a conformance test asserts the request surface loads zero adapters. |
| 9 | **Security** — safe defaults | `NODE_ENV=test` did not pin the LLM and Maps adapters to mock; a stray shell variable could reach a live provider (ADR-007). | High | `tests/helpers/env.js` force-assigns mock mode. |
| 10 | **Correctness** — boundaries | Moving a listing's start time **earlier** never rescheduled the promotion job. | Medium | Promotion re-enqueued on any start-time change; the dead branch is now executed by a test. |
| 11 | **Verification** — tests echoing assumptions | AB-08 privacy canary asserted `not.toContain('742')`, which matched random UUIDs; suite non-deterministic (5 failures one run, all green the next). | Medium | Canary asserts on the actual field; global-state assertions scoped; suite serialized. |

### 2.3 Wave 4 (verified 2026-08-21)

| # | Checklist area | Finding (failure mode) | Severity | Resolution |
|---|---|---|---|---|
| 12 | **Correctness** — the clause, not the machinery | Safety alerts **never reached the unified moderation queue**: the filing code was complete but gated behind a content-type list that did not include `safety_alert`, so every implementer test passed while the FR-07/AB-04 acceptance clause was unmet. Force-inserting the row the handler would have written made the unfiltered queue page return **500**. Five lanes raised it independently. | Major | `safety_alert` added to `CONTENT_TYPES` with a separate `SCANNED_CONTENT_TYPES` so alerts are queued but never fed to the LLM; queue page gained an excerpt branch; status change is a recorded no-op for the type. Re-verified by driving a real alert through the worker and reading it back on the queue route, filtered and unfiltered. |
| 13 | **Correctness** — spec ambiguity escalated | A review **required** a comment because empty text made the moderation adapter throw and permanently dead-letter the scan. The SRS does not forbid a photo-only review. Six lanes raised it; none decided it. | Spec question | **Team decision 2026-08-26:** comment required, minimum one character; a photo-only review is a 422 by design. Recorded in the FR-05 spec-decision block and the schema header. Relaxing it later requires the empty-text pipeline branch in the same change, never the schema alone. |
| 14 | **Correctness** — acceptance wording vs behaviour | The inventory said a message later flagged is "hidden and queued"; the code queues on flag and hides only on human rejection. | Minor | Ratified the implemented policy (queue-on-flag, hide-on-rejection): hide-on-flag would let an unreviewed LLM false positive censor live communication. Consequence disclosed in the report. |
| 15 | **Verification** — accidental coverage | `scripts/backup.js` hid its entire `main()` behind one `istanbul ignore`, so the sweep/prune dispatch and the connection-close discipline were untested and invisible to coverage. | Minor | `main(argv, io, deps)` exported and injectable; both branches covered; the ignore narrowed to process wiring. Same treatment applied to `wireShutdown` in `src/server.js`. |
| 16 | **Verification** — intermittent with lost identity | One implementer run in seven failed one test whose name was lost to output truncation. | Watch item, still open | Standing rule: capture complete output on every run. Every later failure has a preserved identity (see finding 24). Not declared fixed because the original failure was never identified. |

### 2.4 Wave 5 (verified 2026-08-26)

| # | Checklist area | Finding (failure mode) | Severity | Resolution |
|---|---|---|---|---|
| 17 | **Verification** — a gate that passes without checking | The first accessibility script would have exited 0 without auditing anything; it also installed its tooling with `npx --yes` at run time (unpinned). | Medium | `npm run test:a11y` is a real axe-core + Playwright audit with both pinned as root devDependencies. It audits what exists, then **exits 1 and names** every missing interface. It stays red by design until all seven interfaces are audited. |
| 18 | **Correctness** — hand-derived numbers | `App.css` carried hand-written contrast annotations that drifted from the true WCAG ratios (documented 14.6:1 / 6.8:1, computed 14.76:1 / 6.67:1) on colour literals outside the machine-checked gate. | Minor | `App.css` is token-only (zero hex literals, executed grep); the contrast table is recomputed from the hex on every run by `ui/kit-contract.test.js`. |

### 2.5 Wave 6 (verified 2026-08-26)

| # | Checklist area | Finding (failure mode) | Severity | Resolution |
|---|---|---|---|---|
| 19 | **Reality check** — invented API contract | The NFR-05 lockout copy on the login screen was **dead code**: the client matched `err.code === 'RATE_LIMITED'` but the server emits `LOGIN_RATE_LIMITED`. The spec masked it by stubbing the invented code. Same class on the resend throttle. | Major | Throttle detection now keys on the **429 status family**, which a code rename cannot bypass; the spec stubs the server's real shape; copy centralized. |
| 20 | **Reality check** — invented API contract | Every session-gated route returns 401 `NO_SESSION`, but the shared error maps keyed only `AUTHENTICATION_REQUIRED`, so the "go sign in" copy was unreachable on all four feature trees. | Medium | Both codes mapped; one 401 spec per screen asserts the copy renders and is announced. |
| 21 | **Correctness** — claims the code cannot back | The listing detail said the address is disclosed on a "confirmed reservation"; the real trigger is pending or in-progress (`listings/access.js`, ADR-010). A pending booking with an unparseable start rendered "the meal has started". | Low | Copy corrected to the truth and pinned by spec; the "started" claim renders only on verifiable state. |
| 22 | **Verification** — stale guards | Two wave-5 scope guards reddened the backend gate the moment wave 6 landed (they asserted no feature route files exist). | Gate | Re-baselined **keeping the direction** of each invariant: the guard now pins exactly five feature trees, and privileged address keys are confined to the one booking-gated screen. No assertion deleted. |
| 23 | **Correctness** — usability, not existence | Found by opening the front door, which no lane had done: the home page had **two links**, the seven screens were reachable only by typed URL, and no sign-in link existed. Root cause was an ownership gap: wave 5 shipped a link-free header and handed the job forward; wave 6 units owned `features/**` and nobody owned `layout/`. Every lane tested its screen *at* its route. | High | Session-aware primary nav and a rewritten home page. The "no dead links" guard was inverted, not deleted: it now asserts the right destinations per session state **and** that every href resolves to a real route. Verified in a browser by signing in through the nav. |
| 24 | **Verification** — CI caught what local runs could not | CI run `33027709007` failed one client test that passed locally. Root cause: the bookings list re-ran its fetch when session status moved from `unknown` to `authenticated`, flashing the rendered list behind a spinner and fetching twice on every visit. | Medium | The effect now depends on the one value that changes its behaviour (`anonymous`). The guard pins the cause, not the symptom: exactly **one** GET across hydration, proven to fail on the restored bug. |

### 2.6 Security hardening and demo build (2026-08-30 → 09-10)

| # | Checklist area | Finding (failure mode) | Severity | Resolution |
|---|---|---|---|---|
| 25 | **Security** — SAST | Semgrep flagged 24 issues. Triage with the AI's help: 16 false positives (suppressions, not fixes), 6 unpinned GitHub Actions, one missing CSRF middleware, one AES-GCM decrypt without an explicit auth-tag length. | Medium | GCM tag length patched (`createDecipheriv(…, { authTagLength: TAG_LENGTH })`, commit `12ec681`, Nam Tran). The session cookie is `HttpOnly; Secure; SameSite=Lax`, which is the CSRF mitigation in place (AB-05); a dedicated CSRF token middleware and SHA-pinning of the Actions are **open**, tracked in the security report. |
| 26 | **Correctness** — data rendered raw | The listing detail rendered ingredients as one run-together word: a Postgres `text[]` was joined without a separator. Visible only with real seed data, which no verification lane had loaded. | Low | Fixed in the demo pass; demo seed set added so screens are exercised with real data. |
| 27 | **Verification** — intermittent, identity preserved | CI run `34447951709` (a docs-only commit, 2026-09-10 00:01 Pacific) failed **1 of 1400**: `tc08-moderation-substrate` hit `duplicate key value violates unique constraint "listings_host_local_date_key"`. The next run on the same code was green. | Watch item, open | Identity preserved per the wave-4 rule. The test derives listing dates from `Date.now()` and the constraint is on the host's *local* date (ADR-009), so a local-midnight boundary is the leading hypothesis; **not yet confirmed or repaired**. Stays on the finding 16 watch list. |

### 2.7 Wave 7 — the NFR-10 live measurement (2026-09-11)

| # | Checklist area | Finding (failure mode) | Severity | Resolution |
|---|---|---|---|---|
| 28 | **Correctness** — the spec the prompt encodes vs the spec the labels encode | The measured false-positive rate, **7.14 %**, fails the 5 % bound, and every false positive sits on one boundary: benign hosts asking for **cash** (the app has no payments) scored *fraudulent* because the AI-written prompt defines fraud as "attempts to move payment off the platform". A second model failed on the **same** items. The prompt clause contradicts the ADR-008 label rules for a product without a payment feature; the false-negative rate, 1.19 %, is within bound. | High (NFR-10 not met) | **Escalated, not decided.** The number is recorded as a fail. The team chooses between rewriting the fraud clause (new `PROMPT_VERSION`, fresh run) and a label set `v2/`; v1 is immutable after a recorded run. Two false negatives scored 0.85, above the 0.8 routing threshold, so they would have published unreviewed — recorded for the same decision. |
| 29 | **Reality check** — a config value nobody had exercised live | The worker's per-attempt adapter budget, `ADAPTER_TIMEOUT_MS=3000`, was tuned against the mock. The live provider took **4 to 47 s** per answer under load; the first live attempt failed on that timeout within five items. A live worker with the shipped value would time out and dead-letter every scan. | High (deployment blocker) | Measurement made with a 90 s per-attempt budget in the off-suite runner, pipeline and prompt unchanged. The production value is **open** for the team to raise before any live deployment; named in the verification report §9. |
| 30 | **Fit** — an ADR assumption the provider no longer honours | ADR-007 assumes the Gemini **free tier**. The planned model is retired for new keys, and the flagship model's free tier allows **20 requests per day**: a first run stopped at item 13. Only the lite models could complete 224 items. | Medium | Model chosen during the run and disclosed as an agent decision in `RESULTS.md`; the number is valid for that exact model id. ADR-007's tier assumption needs a team update: either the lite models are the sanctioned production models, or the key moves to a paid tier. |

### Detail on Finding 23 — the one that would have shipped this period

Wave 6 was verified by five lanes, repaired, re-gated, and all seven interfaces audited clean. Then
someone opened the home page:

```jsx
// AppLayout.jsx as shipped by wave 5 and inherited unchanged by wave 6. The header's only
// destination was the brand link pointing at "/", on this note:
/** Login-state display for the header nav (5C: display only — auth screens are wave 6). */

// After review: destinations derive from the resolved session and only ever point at
// routes that exist; rendered once status is known so no wrong state flashes first.
{status !== 'unknown' && (
  <ul className={styles.navList}>
    <li><Link to="/search">Find a meal</Link></li>
    {status === 'authenticated' && (
      <>
        <li><Link to="/bookings">Your bookings</Link></li>
        <li><Link to="/account">Account</Link></li>
        {isModerator(user) && <li><Link to="/moderation">Moderation</Link></li>}
      </>
    )}
  </ul>
)}
{status === 'anonymous' && <Link className={styles.navAuth} to="/login">Sign in</Link>}
```

**Why every gate was green.** Each verifier lane tested its screen *at its route*. The suite proved
the screens exist, not that a person could reach them. This is the same shape as the wave-3 FR-10
blocker, where tests proved a token verified but never that it reached the user, and it is why our
rule now reads: **a green suite proves the tests, not the requirement.** The structural cause was
disjoint file ownership, which makes parallel agents safe and also means work in the seams belongs
to nobody unless someone assigns it. The workflow spec now names the shell as an owned unit.

---

## 3. Quality gates

Our team's gates (SPMP §7.4, SQAP) and the final tree's result against each:

| Gate | Standard | Final tree (`667187e`, 2026-09-10) |
|---|---|---|
| **Human review** | At least one peer review, *without exception for AI-assisted work* | ✔ Every wave verified by independent lanes that re-executed the original failure scenario behind each claimed fix (wave 4: 155 checks, 15 repairs confirmed, 2 rejected with evidence; wave 6: 22 findings, every confirmed defect closed by re-execution). Human-only decisions recorded with names and dates (§4). Security review and SAST triage by Nam. |
| **Tests** | Full suite green, deterministic, no `--forceExit` | ✔ Backend **63 suites / 1400 tests** (re-run 2026-09-11 after the four NFR-10 guard inversions), client **357 tests**, both exit 0 under `TEST_STRICT_HANDLES=1` with `maxWorkers: 1`. Coverage (wave-6 lane, full run): **96.05 % lines · 98.87 % functions · 84.65 % branches**, no file below 80 % lines. |
| **Linter** | `eslint` + `prettier --check`, zero errors; client linted with `react`, `react-hooks`, `jsx-a11y` | ✔ 0 errors, 0 warnings. |
| **Build gates** | Migrations ordered and append-only; every module loads; app boots against `.env.example`; Vite production build | ✔ 6 migrations valid, 112 modules parse, `createApp()` boots; client build clean. |
| **Security scan** | OWASP ZAP baseline, no High; Semgrep SAST triaged | ✔ ZAP 2.17.0 over the rendered client and API: **High 0 · Medium 2 · Low 2** across 30 URLs, gate exit 0 (the Medium/Low are missing static headers on the `vite preview` scaffold, none on `/api/*`). Semgrep: 24 flagged, 16 false positives, 1 patched, 2 open (§2.6 #25). |
| **Accessibility** | axe-core wcag2a + wcag2aa, 0 serious/critical | ✔ on the 11 non-parameterized routes; harness still **exits 1 by design** for the 6 parameterized routes it cannot audit without seeded ids. |
| **CI** | Green on a clean checkout | ✔ Run `34498081525` green in 3m18s on a cold runner. One red run in the period on a docs-only commit (finding 27), re-run green. |

**Result: every increment merged to `main`.** ✅

**Performance evidence (NFR-01/NFR-02):** k6, 200 virtual users, 5 min steady against a 10,000-user
/ 1,000-listing volume database: **1,129,229 requests, p95 120.07 ms** against a 500 ms budget,
0.00 % errors (wave-6 run; wave-3 run was p95 250.8 ms on a smaller dataset).

**What we do *not* claim.** No NFR-10 pass: the live IT-03 run was made on 2026-09-11 and its
false-positive rate, 7.14 %, fails the 5 % bound (finding 28); the number is recorded, valid for the
model and prompt version named in the record, and nothing is quoted as a pass. NFR-07 is Partial: seven
interfaces built and audited where auditable, but six parameterized routes are unaudited and the
UT-01 five-participant study, declared missed on 2026-08-18, has still not run. No availability
figure. The ZAP result is a scaffold measurement, not a production header posture. Latency numbers
are developer-machine measurements. The 30-day erasure is proven by clock injection, not by 30
elapsed days. Two intermittents (findings 16 and 27) are open with identities preserved. Two Semgrep
items are open, as are the adapter timeout (finding 29) and the ADR-007 tier assumption (finding 30). One spec correction (TCC-03, FR-01 degraded flag) awaits ratification.

---

## 4. AI assistance & provenance

Waves 3–6 and the post-wave-6 fixes were produced with Claude Opus 5 driving the multi-agent
workflow described in §1; the demo build with Claude Fable 5.1 in a single session. Every commit
carries the model as co-author. The SQAP, STP and slide decks were AI-drafted and corrected by the
team (hallucinated schedule sections; an assumed live demo at CDR). Multiple assistants (Gemini,
Claude, ChatGPT) were cross-referenced for the UI improvement list, treated as opinions, not facts.

**What the team decided, and the AI did not.** The agents were instructed to escalate specification
and legal questions rather than resolve them, and they did:

- **AB 626 weekly MEHKO window** (2026-08-18): the team ratified a Monday–Sunday week and found the
  cap value was wrong: AB 1325 raised it from 60 to **90** meals per week.
- **ADR-007 data-use terms** for the moderation provider: ratified 2026-08-18; peer countersignature
  by Nam Tran recorded 2026-08-21, with its second-hand provenance stated in the file.
- **ADR-008 label sign-off**: the 224 AI-proposed moderation labels were reviewed by Gaetan Rieben,
  2026-08-21, set v1. The agent is forbidden from performing or inventing this review, and the tests
  that guarded against a fake sign-off were inverted to check it is well-formed, not deleted.
- **FR-05 photo-only reviews** (2026-08-26): comment required, a choice the SRS left open.
- **FR-08 flagged-message policy**: queue-on-flag, hide-on-rejection, so the LLM never becomes the
  effective decider.
- **The design review** (2026-08-26): the AI's serif headings were rejected as institutional; the
  team's "no webfont CDN" rule was clarified to allow self-hosted faces.
- **Semgrep triage** (2026-08-30): which of the 24 findings were false positives was decided by
  Nam with the AI's analysis as input.
- **The usability-study deadline**: the agent reported it missed; the team chose how to respond.
- **The NFR-10 prompt-versus-label conflict** (2026-09-11): the agent measured, named the four failing
  items and the clause that caused them, and stopped. Which side gives way is the team's call.
- **Disclosed agent decision:** the model measured was picked during the run because the planned one
  was unavailable and the flagship one capped out (finding 30). It is stated in the record rather
  than smoothed over.

**Honesty about the artefacts.** Wave 4 was committed with "UNVERIFIED CHECKPOINT" in its title
until a verifier lane had seen it. Sign-off blocks are left `_unsigned_` until a human fills them,
and an unsigned block fails closed. The verification report quotes no number it did not measure on
the tree it describes. We can explain and defend every line of these increments, and the code-review
log above is the evidence that we read the output rather than trusted it.
