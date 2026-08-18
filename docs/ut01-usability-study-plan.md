# UT-01 — moderated usability study: declared position and study plan

**Requirement:** NFR-07 (usability / accessibility), SRS §4.5 · **Test ID:** UT-01
**Status:** **NOT RUN. The SRS §4.5 "triage before CDR" deadline is missed, and this document says so
on the record rather than letting it pass silently.**
**Written:** 2026-08-18 · **Decision:** option A (declare the miss, schedule for wave 5–6), taken by
the team 2026-08-18.

---

## 1. The statement for CDR

> **NFR-07 / UT-01 is not met, and its SRS §4.5 deadline is missed.**
>
> §4.5 requires a moderated usability study with at least five participants covering both roles, with
> findings triaged before the Critical Design Review. That has not happened and could not have: the
> study's subject is the React web client, which SRS §2.1.2 places in waves 5–6, and no client exists
> at this commit — no `client/` directory, no rendered interface, and no browser toolchain in
> `node_modules`. There is nothing for a participant to use.
>
> We are reporting this as **not implemented**, not as skipped or deferred, and no usability or
> accessibility claim appears anywhere in our evidence. `npm run test:a11y` is deliberately wired to
> fail and is kept out of CI, so its absence can never be misread as a passing check.
>
> The study is scheduled against a trigger rather than a wish: participants and a fixed date are
> named at this stand-up (build-plan action **A-NFR07-2**), and the session runs once wave 6 delivers
> the seven interfaces the NFR-07 acceptance enumerates. The protocol below is written and ready, so
> the remaining work is recruitment and moderation, not design.
>
> Two related NFR-07 items are blocked on the same missing client and are reported the same way: the
> axe-core WCAG 2.1 AA audit (no interface to audit) and the AB-06 ZAP scan's DOM-oriented passive
> rules (the scan reached all 24 API URLs, but there is no HTML).

**Why we are saying it this way.** A design review is where a missed deadline is cheapest to raise
and most expensive to hide. The honest version comes with a trigger, an owner and a written
instrument; the dishonest version is silence, or a claim resting on the fact that a11y tooling
"exists".

## 2. Why it is missed — the causal chain, not an excuse

| Fact | Evidence |
|---|---|
| The study's subject is the web client | NFR-07 acceptance names seven interfaces: search/browse, listing detail, host profile, booking flow, signup/login, messaging, moderator queue |
| The client is waves 5–6 work | SRS §2.1.2; `docs/_generated/build-plan.md` §4 roadmap |
| Waves 0–3 are what exists today | `docs/verification-report.md` — 23/35 requirements met, all wave 0–3 backend |
| So there is no subject | `ls -d client` → no such directory; repo-wide find for `*.jsx`/`*.tsx`/`*.html` → nothing; `curl localhost:5173` → exit 7 |
| CDR precedes waves 5–6 | CDR 2026-08-22 (SPMP §5.2.2); wave 4 is the next build |

The deadline was unmeetable from the moment the wave order put the client after CDR. That ordering
was itself deliberate — the SPMP protects the booking loop first — so the correct response is to
state the consequence, not to relitigate the plan four days before the review.

## 3. Trigger and owner

| Field | Value |
|---|---|
| Runs when | Wave 6 delivers the seven NFR-07 interfaces in a browsable build |
| Participants and date fixed | At the CDR stand-up, **2026-08-22** (build-plan action A-NFR07-2) |
| Owner | QA lead — **name assigned at that stand-up** |
| Blocks | NFR-07 cannot be reported met until §6 below is filled in |

## 4. Protocol — ready to run, no design work left

**Participants.** Five minimum, and the study must cover **both roles**: at least two participants
run the guest flow and at least two run the host flow, with the fifth assigned to whichever role
showed more trouble in piloting. Recruit people who have not built the system. Classmates outside the
team are legitimate participants for a course project; team members are not — they cannot be
surprised by their own design.

**Format.** Moderated, one participant at a time, think-aloud. Roughly 30 minutes each. One moderator
reads the script and does not help; one note-taker records. Record the session only with explicit
consent, and record no personal data beyond a participant number.

**Guest task set (booking flow).**

1. Find a meal available near you this week.
2. Open one and decide whether you would eat there — say aloud what you are looking for.
3. Reserve a seat.
4. Change your mind and cancel the reservation.

**Host task set (listing flow).**

1. Create an account and get to the point where you are allowed to publish.
2. Publish a meal for a specific day, with a seat count.
3. Try to publish a second meal on the same day. *(Expected: refused — one listing per host per day.
   The interest is whether the refusal is understandable, not whether it happens.)*
4. Cancel the meal you published.

**What to write down per task:** completed unaided / completed with a hint / not completed; time;
every point of hesitation, wrong turn or spoken confusion; and the participant's own words for any
error message they hit. Verbatim quotes beat paraphrase.

**Two things to watch for specifically**, because they are where this system's design is unusual and
where a bad interface would do real harm:

- **The eligibility gate (FR-09).** A host must verify email, complete a profile and accept the
  agreement before publishing. Does a blocked host understand *what* is missing and *how* to fix it,
  or do they just see a refusal?
- **The MEHKO caps (FR-11).** One listing per host per day, 30 meals per day, 90 meals per week over
  a Monday–Sunday Los Angeles week. When the cap refuses a host, can they tell which cap, and when it
  resets? This is a legal constraint expressed as an error message, which is a hard thing to get
  right.

## 5. Triage rubric — so findings are triaged, not merely collected

SRS §4.5 asks for triage, which means every finding leaves the study with a severity and a decision.

| Severity | Definition | Required action |
|---|---|---|
| **Critical** | A participant could not complete a core task, or completed it wrongly without noticing | Fix before the release the study gates |
| **Major** | Task completed, but with a wrong turn, a dead end, or a misread of what the system did | Fix or file with a named owner and a date |
| **Minor** | Friction, hesitation, or a cosmetic complaint that did not block the task | Backlog with a rationale |
| **Not a finding** | Participant preference contradicted by another participant or by a requirement | Record and dismiss, with the reason |

A finding raised by **two or more** participants is promoted one severity level: repetition is the
only signal a five-person study gives you about frequency.

## 6. Record of the study — UNFILLED until it runs

Per `docs/verification-report.md` §5, three things must be recorded or the study does not count as
evidence. Same discipline as the ADR-007 and ADR-008 sign-off blocks: an unfilled block means not
done, and no agent may fill it in.

| Field | Value |
|---|---|
| Date run | _unfilled_ |
| Participants (count and role coverage) | _unfilled_ |
| Moderator / note-taker | _unfilled_ |
| Findings raised (count by severity) | _unfilled_ |
| Triage outcome (what was fixed, deferred, dismissed) | _unfilled_ |
| Build under test (commit) | _unfilled_ |

**NFR-07 remains "not implemented" until this table is complete _and_ the axe-core audit reports zero
serious or critical violations across the seven interfaces.** Both halves are required; neither
substitutes for the other.
