# ADR-009: MEHKO capacity limits — AB 626 caps as configuration with one server-side enforcement point

- **Status:** Accepted — **with one open sub-decision: the shape of the weekly window (see “Weekly window shape — OPEN, not ratified”). The cap numbers, the single-enforcement-point rule and the boundary timezone below are settled; the weekly *window shape* is not.**
- **Date:** 2026-08-12 (amended 2026-08-14 — weekly window shape recorded as open, see Amendment log)
- **Deciders:** Gaetan Rieben (decided 2026-08-12; pending team ratification at the next stand-up)
- **Related requirements:** FR-11 (listing management), FR-12 (capacity), AB-03 (spam listings), AB-07 (MEHKO evasion), SRS §2.1.7 (site adaptation), SRS §2.4 (regulatory constraint)

## Context
SRS §2.4 makes California MEHKO limits under AB 626 a regulatory constraint, and §2.1.7 states that those limits are enforced *as configuration*, isolated so that operating in another jurisdiction requires a configuration change and legal review rather than a redesign. FR-11 requires the system to enforce the configured one-listing-per-host-per-day and meal/seat limits when a host creates or updates a listing. The SRS states the one-listing-per-day rule in §3.4 but gives no numeric meal caps, so the build plan could not proceed without values (`docs/_generated/build-plan.md`, open question 2).

## Decision
The v1.0 California configuration is:

| Setting | Value |
|---|---|
| Listings per host per day | 1 (stated in SRS §3.4) |
| Meals per host per day | 30 |
| Meals per host per week | 60 |
| Operating timezone for day/week boundaries | `America/Los_Angeles` |
| Weekly window shape — the span the 60 is summed over | **NOT DECIDED.** See “Weekly window shape — OPEN, not ratified” below before implementing, changing or relying on it. v1.0 ships a Monday-anchored `America/Los_Angeles` calendar week as an *implementation default*, not as a decision. |

These values are the AB 626 MEHKO limits and were confirmed by the team as correct for California. They live in the configuration module (`src/config/`) as jurisdiction data, never inline in a service, per SRS §2.1.7.

**Read the last table row before acting on the weekly number.** The 60 and the timezone are settled; the *window* the 60 is summed over is not, and this record deliberately does not settle it. A reader who takes only the Decision table and implements the stricter rolling 7-day window would contradict the v1.0 code and the tests that currently pin its behaviour — not because the rolling reading is wrong, but because the choice belongs to the team at CDR and must be made here first. The complete, re-verified list of what a ratification touches (one production file, one requirement file, six test files, of which four carry assertions that actually pin the anchor) is the **Impact inventory** below; work from that list, not from memory.

Enforcement is **one server-side check** consulted by every path that creates or modifies a listing — not a per-module reimplementation. Day and week boundaries are evaluated in the configured operating timezone, not in UTC and not in the browser's locale, so a host cannot gain a second daily listing by submitting near midnight from another timezone. Client-side display of remaining capacity is a convenience only; the server rejects independently of it.

## Weekly window shape — OPEN, not ratified

This ADR fixes the weekly **number** (60 meals per host per week) and the boundary **timezone**
(`America/Los_Angeles`). It has never fixed the **shape of the window that number is summed over**, and
neither does the SRS: SRS §2.1.7 and FR-11 speak only of "maximum meals per host per day" and
"one listing per host per day", so the SRS states no weekly cap at all. Two readings are available:

| Reading | Meaning | Behaviour |
|---|---|---|
| **Monday-anchored LA calendar week** (what v1.0 implements) | sum `seat_capacity` over the Mon–Sun LA week containing the listing's local date | the weekly ledger resets every Monday 00:00 PT |
| **Rolling 7-day window** (the stricter alternative) | sum `seat_capacity` over `[localDate − 6 days, localDate]` | no 7-day span can ever exceed the cap |

`src/modules/listings/mehko.js` (`weekRangeFor` / `assertWithinCaps`) implements the Monday-anchored
reading. **That choice is an implementation default, not a ratified decision**, and it is materially
weaker than the rolling reading: see the Consequences bullet below for the worked evasion.

**The team must ratify one reading at CDR.** Until it does, no AB 626 *weekly*-compliance claim may be
made from a TC-11 pass — TC-11 currently pins observed behaviour, not a ratified requirement. Either
way the change is made **here first, by an explicit decision record**, and the acceptance criterion
follows the ADR. Rewriting the criterion to match shipped code — which is what happened in build commit
`3136b91`, see the Amendment log — is not a valid way to settle this.

### Impact inventory — what a ratification touches

Re-verified against the working tree on 2026-08-17 (finding TCBV2-04 / ADRC2-05). This inventory
records consequences; it expresses no preference between the readings.

**If _Monday-anchored_ is ratified:** no code and no test changes. The Decision table's last row is
replaced by "Weekly window shape | Monday-anchored `America/Los_Angeles` calendar week", the FR-11
`specAmbiguity` block in `docs/_generated/requirements-inventory.json` becomes a resolved-decision
reference and its weekly clause drops the PROVISIONAL marking, and the week-boundary evasion quantified
in Consequences stays on the record as an **accepted residual risk with a named owner** — an accepted
risk, not a closed one.

**If _rolling 7-day_ is ratified:**

*Production code (1 file).* `src/modules/listings/mehko.js` — `weekRangeFor()` returns the inclusive
range `[localDate − 6, localDate]` instead of the Mon–Sun span; the `PROVISIONAL WINDOW SHAPE
(TCB-W3-05)` marker comment in that file sits on exactly that function, and the file header's
`OPEN SPEC QUESTION` block is removed with it. `assertWithinCaps` needs no other change: it already sums
`seat_capacity` over whatever range `weekRangeFor` hands it. Note that `weekStart` / `weekEnd` are
API-visible — they are returned in the `details` of the 422 `MEHKO_WEEKLY_MEAL_LIMIT` error — so
renaming them to `windowStart` / `windowEnd` is part of the same change, not a later tidy-up. Nothing
else in `src/` reads either name (`grep -rn "weekStart\|weekEnd\|weekRangeFor" src/` returns only
`mehko.js`).

*Requirement text (1 file).* `docs/_generated/requirements-inventory.json` — FR-11: restore the
rolling wording ("…enforced across the host's rolling 7-day window"), drop the PROVISIONAL marking and
replace the `specAmbiguity` block with a pointer to the ratification record below.

*Tests that pin the Monday anchor and must flip (5 tests in 4 files):*

| File | Test | What changes |
|---|---|---|
| `tests/unit/listings.test.js` | `weekRangeFor is Monday-anchored on the LA calendar` | expects Mon–Sun bounds for a Tuesday instant and puts Sun 23:00 PT / Mon 00:30 PT in different weeks; becomes trailing-7-day bounds, under which those two instants sit in overlapping windows |
| `tests/unit/listings.test.js` | `weekly seat cap is enforced over the Monday-anchored LA week; next week is fresh` | only the **closing** assertion flips: the next Monday (`2027-06-21`, 30 seats) is a 201 today but a 422 under rolling, because its trailing 7 days still hold the Tue+Wed 60 seats. The earlier Tue/Wed/Thu legs hold under both readings |
| `tests/tc-booking/tc11-listing-caps.test.js` | `TCB-01 (round 2): weekly cap is the Monday-anchored LA calendar week, NOT a rolling 7-day window` | written specifically to distinguish the two readings; inverts wholesale (Mon `2028-03-13` becomes 422) |
| `tests/tc-booking/tcb-w3-reverify.test.js` | `TCB-01 (SPEC AMBIGUITY, reproduced): the Monday-anchored week lets one host serve 120 meals in 4 consecutive days` | the third listing (Mon `2031-03-10`) becomes 422 and the 7-day seat sum becomes 60 |
| `tests/tc-booking/tcbv2-independent-reverify.test.js` | `TCB-W3-05 (OPEN, ADR-009 sub-decision): the Monday-anchored week admits 120 meals in 4 days` | same inversion. **This file post-dated the 2026-08-14 amendment and was missing from this list until 2026-08-17** — the omission is the reason this inventory now exists |

*Tests that touch the weekly cap but are anchor-**neutral** and must NOT be changed* — each asserts
only inside a span of ≤ 7 consecutive days, so it yields the same verdict under either reading. Listed
so a migration does not "fix" a test that was never broken:

- `tests/unit/listings.test.js` — the Tue/Wed/Thu legs of the weekly-cap test above.
- `tests/tc-booking/tc11-listing-caps.test.js` — `weekly meal cap: 30 + 30 seats in one week fills it; a third listing that week → 422` (Wed/Thu/Fri `2028-03-14/15/16`; the test says so itself).
- `tests/tc-booking/tcbv2-independent-reverify.test.js` — `the weekly meal cap is enforced within one Monday-anchored LA week` (Mon/Tue/Wed; title rename only).
- `tests/adr-conformance/verify-adr-wave0-3.test.js` — the weekly leg of `daily and weekly meal caps come from config (boundary values, not hardcoded)` (Mon/Tue `2031-06-09`/`-10`, overflow Wed `2031-06-11`).
- `tests/adr-conformance/adr-wave3-invariants.test.js` — `weekly meal cap comes from config across a Monday-anchored LA week` (Tue/Wed/Thu `2029-06-05/06/07`; title rename only).

### Ratification record — TO BE COMPLETED BY THE TEAM AT CDR (2026-08-22)

**No agent may fill this in.** Recording a team decision is a human act, the same rule the build plan
applies to the ADR-008 human label sign-off: an agent may prepare the form, never sign it.

| Field | Value |
|---|---|
| Ratified window shape | *(blank — not ratified)* |
| Decided by | |
| Date | |
| Stand-up / minute reference | |
| Follow-up work items opened | |

While any row above is blank, all of the following hold:

- this record's Status line stays "Accepted — with one open sub-decision";
- the Decision table's weekly-window row stays **NOT DECIDED**;
- FR-11's weekly clause in `docs/_generated/requirements-inventory.json` stays PROVISIONAL; and
- `docs/verification-report.md` reports FR-11's weekly cap as **unverified**, in substantially these
  terms:

  > **FR-11 — partial.** The one-listing-per-host-per-day cap, the single server-side enforcement point
  > and the `America/Los_Angeles` day boundary are verified (TC-11). The weekly cap *is* enforced, but
  > over a Monday-anchored LA calendar week that the team has never ratified (ADR-009 open
  > sub-decision, finding TCB-W3-05), and that reading admits 120 meals inside a single 7-day span.
  > The weekly cap is therefore **unverified against any agreed criterion**, and no AB 626
  > weekly-compliance claim — for FR-11 or for **AB-07** — may rest on this pass.

## Alternatives considered
- **Hardcoding the numbers inside the listing service** — rejected: it contradicts SRS §2.1.7's explicit requirement that locale-specific policy be isolated in configuration, and would make a jurisdiction change a code change.
- **Enforcing the cap in the client** — rejected: AB-03 and AB-07 are attacks by users who control the client, so a client-side cap enforces nothing.
- **Deriving day boundaries from the guest's browser locale** (as displayed times are, per §2.1.7) — rejected: display locale and legal-compliance boundary are different concerns, and using the caller's timezone for the latter creates the midnight-hopping evasion described above.
- **A rolling 7-day weekly window instead of a calendar week** — *not decided either way*; see "Weekly window shape — OPEN, not ratified". It is the stricter option and closes the week-boundary evasion, at the cost of a cap that is harder for a host to reason about ("this Monday you may serve 0 more meals because of listings you posted last Wednesday"). Recorded as an open question, not as a rejected alternative.

## Consequences
- **Positive:** FR-11's cap enforcement and AB-07's single-enforcement-point mitigation are satisfied by construction; another jurisdiction is a configuration file plus legal review.
- **Positive:** a single check is a single thing for TC-11 to test and a single thing to get wrong, rather than a condition scattered across listing creation, update and duplication paths.
- **Negative (weekly window, unratified):** with the Monday-anchored week that v1.0 implements, the weekly cap is **evadable across a week boundary**. Worked example — one eligible host creates 30-seat listings on Sat 2031-03-08 and Sun 2031-03-09 (week Mon 03-03 … Sun 03-09, 60/60) and again on Mon 2031-03-10 and Tue 2031-03-11 (next week, 60/60). All four are accepted, so `sum(seat_capacity)` over `local_date` 2031-03-08 … 2031-03-14 is **120 — twice the stated 60-meals-per-week cap inside a single 7-day span**, served on four consecutive days. Under the rolling reading the third listing is refused. Reproduced independently by two lanes and still reproducing on the current tree: `tests/tc-booking/tcb-w3-reverify.test.js` ("TCB-01 (SPEC AMBIGUITY, reproduced)…") and `tests/tc-booking/tcbv2-independent-reverify.test.js` ("TCB-W3-05 (OPEN, ADR-009 sub-decision)…"), the latter asserting the 120-seat sum directly from the `listings` table. This is the substance of the open sub-decision above, and it is why no weekly-compliance claim may rest on the current implementation.
- **Negative:** the daily and weekly caps are per *account*. AB-07 notes that a host operating several accounts evades them, and that phone-number uniqueness and identity verification are deferred to v2.0 — so this decision mitigates the constraint, it does not close the abuse case. Log-based anomaly review (NFR-08) remains the only v1.0 detection for multi-account evasion.
- **Neutral / follow-ups:** these values are the team's reading of AB 626 for an academic project and are not legal advice. They should be re-confirmed at CDR, and the confirmation recorded, before any claim of regulatory compliance is made in the final presentation.

## Amendment log

**2026-08-14 — weekly window shape recorded as open (finding TCB-W3-05).** The wave-3 verification
lane found that the weekly cap's window shape had never been decided anywhere: this ADR named the
number and the timezone only, the SRS names no weekly cap at all, and `mehko.js` had quietly settled
the question by implementing a Monday-anchored week. Worse, the FR-11 acceptance criterion in
`docs/_generated/requirements-inventory.json` was *rewritten inside build commit `3136b91`* — from
"…enforced across the host's **rolling 7-day window**" to "…the host's **Monday-anchored**
America/Los_Angeles calendar week … NOT a rolling 7-day window"
(`git diff af1a91a 3136b91 -- docs/_generated/requirements-inventory.json`) — i.e. the criterion was
moved to fit the code. This amendment does **not** resolve the question in either direction. It
records the two readings, quantifies what the shipped reading permits, marks the inventory wording as
provisional, and escalates the decision to the team for ratification at CDR
(`docs/_generated/build-plan.md`, open question 1). No implementation behaviour was changed by this
amendment.

**2026-08-14 — open sub-decision surfaced in the Decision table (finding W3-ADR-05).** The amendment
above stated the open window shape in its own section, but the Decision table still listed only the
weekly *number* and the timezone, so a reader consulting the table alone — the normal way an ADR is
used — would see a settled-looking weekly cap and could implement either reading. The table now
carries an explicit “Weekly window shape … **NOT DECIDED**” row pointing at that section. This is a
visibility fix only: it decides nothing, adds no ratification date (no agent may record a team
decision — the same rule the build plan applies to the ADR-008 label sign-off), and changes no
behaviour. It stays in force until the team ratifies a reading at CDR, at which point the row is
replaced by the ratified shape and the ratification date.

**2026-08-17 — ratification form and complete impact inventory added (findings TCBV2-04, ADRC2-05).**
Round-2 re-verification reproduced the week-boundary evasion independently, in a *second* test file
(`tests/tc-booking/tcbv2-independent-reverify.test.js`), and confirmed that this record's documentary
obligations from the 2026-08-14 amendments were otherwise already met. Two real gaps remained, and only
those were fixed: (1) the "if rolling 7-day is ratified" migration list named three test files, but six
test files touch the weekly cap and the file that reproduced the finding in round 2 was not among the
three — a team executing the ratification from this record would have left it pinning the old shape,
producing a red suite and a half-migrated codebase. That list is replaced by the re-verified **Impact
inventory**, which additionally separates the 5 anchor-*pinning* assertions from the 5 anchor-*neutral*
ones so a migration changes neither too little nor too much, and flags that `weekStart`/`weekEnd` are
API-visible in the 422 `details`. (2) There was nowhere for the team to *record* the ratification, so
the **Ratification record** form was added, unsigned, with the standing constraints that apply while it
is blank — including the exact wording `docs/verification-report.md` must carry for FR-11 and AB-07.
This amendment **decides nothing**: no reading is chosen, no ratification date is recorded, no
acceptance criterion is moved, and no production code or test was touched. The Monday-anchored
implementation and the 120-meals-in-4-days behaviour were re-confirmed on the working tree by
`npx jest tests/tc-booking/tcbv2-independent-reverify.test.js tests/unit/listings.test.js -t "Monday-anchored"`
(4 passed) — the finding still reproduces exactly as described, which is the intended state until the
team rules.

## AI assistance & provenance
The missing numeric caps were surfaced by the AI-assisted build-planning run on 2026-08-11, which used these values as defaults and flagged them for confirmation rather than treating them as settled. The team confirmed the values as correct under California law on 2026-08-12. This record was drafted by Claude Code from that confirmation; the legal reading is the team's, and per the follow-up above it warrants a documented re-check at CDR.
