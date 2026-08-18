# Implementation Increment + Code-Review Log

**Project:** Homeplate · **Increment:** Wave 3 — Core Marketplace · **Team:** Group 6 ·
**Date:** 2026-08-18 · MSCS 2101, Module 6

---

## 1. Implementation increment

**What we built.** The core marketplace on top of the wave 0–2 platform: hosts create, edit and
cancel meal listings under the MEHKO caps; guests search listings, read a meal detail page and a host
profile, and reserve, cancel and complete bookings; media uploads; and the scheduled transition that
moves a booking from *pending* to *in progress*.

**Requirements satisfied.** FR-01 (search), FR-02 (meal detail), FR-03 (host profile), FR-04
(completion), FR-11 (listing management + MEHKO caps), FR-12 (reservation with atomic capacity),
FR-13 (notifications), FR-14 (cancellation with capacity restore) — plus FR-10 (registration and
email verification), which this increment **repaired** (see Finding 1). Non-functional: NFR-01
(latency), NFR-02 (scale), NFR-08 (audit logging), NFR-09 (degraded mode), NFR-11 (input validation),
NFR-13 (data protection). Misuse cases AB-02, AB-05, AB-07, AB-08.

**Architecture fit.** Four new modules — `listings`, `bookings`, `search`, `hosts` — each split into
`routes` / `service` / `repo` / schema, consistent with ADR-001 (modular monolith, layered) and the
existing wave 0–2 modules. No cross-layer shortcuts: routes never touch the database, services never
call an external provider inline. Provider work is deferred through the ADR-003 transactional outbox
— three new handlers (`listingGeocode`, `bookingNotifications`, `bookingPromote`) — so a provider
outage can never roll back a business write. One append-only migration (`0004_bookings_completed_at`)
adds the column the FR-04 acceptance requires; no applied migration was edited.

**Refactor.** MEHKO enforcement was extracted into a single `mehko.js` module with exactly one
definition and one call site, so every path that creates or modifies a listing consults the same
check — verified by a static test, not by convention (ADR-009). The cap *values* live only in
`src/config/locale.js`; a scan asserts no cap literal appears anywhere else in `src/`.

**How it was built.** Scaffolded with an AI assistant using a plan → implement → verify → repair
workflow: a coordinator planned from the frozen SRS v3.2 and the ADR set, implementers built units
with disjoint file ownership, then eight independent verifier lanes executed the SRS §4 test protocol
against the result. Every change was reviewed before merge; the log below is what that review caught.

---

## 2. Code-review log

We reviewed the AI-generated code against the SRS using the Code Review Checklist. Six findings are
listed; **Finding 1 is the one that would have shipped a broken product.** In total the verification
rounds raised 40 findings, all recorded in `docs/verification-report.md`.

| # | Checklist area | Finding (failure mode) | Severity | Resolution |
|---|---|---|---|---|
| 1 | **Correctness** — does it do what the requirement asks, not just something plausible | The verification email could only ever carry the token's **SHA-256 digest**, never the token. The delivered email read `tokenHash: 37c38c33…` — no link. **No user could ever verify their email, therefore no user could ever book or publish.** | **Blocker** | The worker now mints the deliverable link at send time (`resolveRenderContext`), so the outbox payload stays IDs-only per ADR-003. Added `POST /api/auth/resend-verification`. New test drains the outbox, reads the value the transport actually delivered, and verifies with *that*. |
| 2 | **Security** — no secrets in code, safe defaults | Production config **accepted the committed sample secrets**: `cp .env.example .env` plus `NODE_ENV=production` booted happily with `FIELD_ENCRYPTION_KEY=deadbeef…` and `minioadmin` storage credentials. Every encrypted PII column would have been protected by a key published in our own repository. | High | `validateEnv` now rejects, in production only, the known sample key (and any 64-hex key that is one 4-byte block repeated) and the default `minioadmin` credentials. Test asserts a freshly generated key is still accepted. |
| 3 | **Fit** — consistent with our architecture and ADRs | `POST /api/media` **constructed an S3 client on the request path**, violating ADR-001's rule that external adapters are worker-only. A storage outage would have blocked the API response. | High | Storage access moved behind the worker/repo boundary. A conformance test now asserts that the entire wave-3 request surface loads **zero** adapters. |
| 4 | **Security** — safe defaults | `NODE_ENV=test` did **not** pin the moderation LLM and Maps adapters to mock, so a stray `MAPS_MODE=live` in a developer's shell could send test data to a live provider — the exact risk ADR-007 exists to prevent. | High | `tests/helpers/env.js` now *force-assigns* mock mode rather than defaulting to it; a leftover shell variable cannot leak in. |
| 5 | **Correctness** — boundaries | Moving a listing's start time **earlier** never rescheduled the booking-promotion job, so bookings silently stayed *pending* past their start. Moving it later worked, which is why it read as correct. | Medium | Promotion is re-enqueued on any start-time change; the previously dead branch is now executed by a test. |
| 6 | **Verification** — tests echoing the same assumptions | An AB-08 privacy canary asserted `not.toContain('742')` — a bare substring that **matched random UUIDs**, so it passed for the wrong reason and would have missed a real leak. Separately, the whole suite was non-deterministic: one run failed 5 tests, the next passed all 1302. | Medium | Canary rewritten to assert on the actual field. Non-determinism fixed at its cause: assertions that scanned *global* state (e.g. every row in the outbox table) while 71 suites ran in parallel workers against one database. Suite is now serialized and green on five consecutive runs. |

### Detail on Finding 1 — the one that would have shipped

Registration enqueues the verification email through the transactional outbox. Per ADR-003 the
payload carries IDs only, which is correct — but the raw token was dropped there and never recovered:

```js
// AI-generated (broken): the payload carries the DIGEST, and the mailer renders the params verbatim,
// so the recipient receives a SHA-256 hash instead of a link. Submitting it returns 400.
await outbox.enqueue(client, {
  type: EMAIL_VERIFICATION_JOB_TYPE,
  payload: { userId: created.id, tokenHash: token.hash },
});

// After review: the payload still carries IDs only (ADR-003 intact), but the WORKER mints the
// deliverable link at send time and hands it to the adapter as non-persisted render context.
resolveRenderContext: async () => {
  const link = await authService.createVerificationLink(userId, { log });
  return { verificationUrl: link.url, expiresAt: link.expiresAt.toISOString() };
},
```

**Why it survived two earlier waves.** The code compiled, read cleanly, honoured the ADR it cited,
and **passed its own tests** — because those tests took the token from the function's in-process
return value, never from the email a real recipient would receive. Waves 1–2 reported FR-10 as
**PASS** on that evidence.

The checklist question that caught it was *"does it do what the requirement asks — not just something
plausible?"* FR-10 asks that a user can verify their email. The tests proved that a *token* verifies;
nobody had asked whether the token ever reaches the user. Our rule now: **a green suite proves the
tests, not the requirement** — so the acceptance test drives the flow from the value the transport
actually delivered.

---

## 3. Quality gates

Our team's gates, and this increment's result against each:

| Gate | Standard | This increment |
|---|---|---|
| **Human review** | SPMP §7.4 — at least one peer review, *without exception for AI-assisted work* | ✔ Eight independent verifier lanes re-executed the original failure scenario behind every claimed fix; 29 of 30 confirmed, 1 closed by a documented design decision. **No fix was accepted on the author's word.** Every specification and legal question was decided by the team, not the agent (§4). |
| **Tests** | Full suite green, deterministic | ✔ **71 suites / 1302 tests pass.** Coverage on CI: statements **93.95 %**, branches **83.96 %**, functions **97.69 %**, lines **94.74 %**. Determinism proven by five consecutive green runs plus two under coverage. |
| **Linter** | `eslint` + `prettier --check`, zero errors | ✔ 0 errors, 0 warnings, all files conform. |
| **Security scan** | OWASP ZAP baseline, no high-severity findings | ✔ **High 0 · Medium 0 · Low 0 · Informational 3** across 24 distinct URLs — the entire API surface. |
| **CI** | Green on a clean checkout | ✔ Runs `32187777816` and `32188110892` on GitHub Actions: green in ~2m50s on a cold runner, with a leaked-handle gate (`TEST_STRICT_HANDLES=1`) and explicit timeouts. |

**Result: merged to `main`.** ✅

**Performance evidence (NFR-01):** k6, 200 virtual users, **749,234 requests**, p95 **250.8 ms**
against a 500 ms requirement, 0 % errors.

**What we do *not* claim.** 23 of 35 requirements are met, 5 partial, 7 not implemented — the latter
all wave 4+ scope, each proven absent by an executed probe rather than by reading code. We make no
moderation-accuracy figure (NFR-10 requires a human label sign-off we have not done), no
accessibility result (the client ships in waves 5–6), and no availability figure. The SRS §4.5
usability study deadline is **missed**, declared openly, with a protocol written and ready.

---

## 4. AI assistance & provenance

This increment was produced with Claude Opus 5 driving a multi-agent workflow: a coordinator planned
from the SRS and ADRs, implementers built units with exclusive file ownership, verifier lanes tested
against the SRS §4 protocol, and fixer agents applied repairs — each fix then re-verified by an agent
that had not written it.

**What the team decided, and the AI did not.** The agents were instructed to escalate specification
and legal questions rather than resolve them, and they did:

- **The AB 626 weekly MEHKO window.** The SRS states no weekly cap at all, and the code had quietly
  settled the question by implementing a Monday-anchored week. The agent flagged it as an unratified
  sub-decision and refused to choose. The team ratified a Monday–Sunday calendar week — and in doing
  so found that our cap value was **wrong**: AB 626 set 60 meals per week, but **AB 1325** raised it
  to 90. We had been over-restricting hosts for six days.
- **The moderation provider's data-use terms.** The agent read the terms and wrote the analysis; the
  *ratification* was a human act, recorded with a named reviewer and date. The peer countersignature
  is still outstanding and is tracked as such.
- **The usability-study deadline.** The agent reported it missed; the team chose how to respond.

**Honesty about the artefacts.** Some documents in this repository were drafted by the AI and are
labelled as such; sign-off blocks are left `_unsigned_` until a human fills them, and an unsigned
block fails closed. We can explain and defend every line of this increment, and the code-review log
above is the evidence that we read it rather than trusted it.
