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

**Read the last table row before acting on the weekly number.** The 60 and the timezone are settled; the *window* the 60 is summed over is not, and this record deliberately does not settle it. A reader who takes only the Decision table and implements the stricter rolling 7-day window would contradict the v1.0 code and the tests that currently pin its behaviour (`tests/unit/listings.test.js`, `tests/tc-booking/tc11-listing-caps.test.js`, `tests/tc-booking/tcb-w3-reverify.test.js`) — not because the rolling reading is wrong, but because the choice belongs to the team at CDR and must be made here first.

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

**The team must ratify one reading at CDR.** Until it does:

- No AB 626 *weekly*-compliance claim may be made from a TC-11 pass — TC-11 currently pins observed
  behaviour, not a ratified requirement.
- If **Monday-anchored** is ratified, this section becomes the decision, the Decision table gains a
  "Weekly window shape | Monday-anchored LA calendar week" row, and the evasion consequence below stays
  on the record as an accepted residual risk.
- If **rolling 7-day** is ratified, `weekRangeFor`/`assertWithinCaps` change to sum over
  `[localDate − 6, localDate]`, the requirements-inventory FR-11 wording reverts to the rolling
  phrasing, and the tests that currently pin the Monday anchor
  (`tests/unit/listings.test.js`, `tests/tc-booking/tc11-listing-caps.test.js`,
  `tests/tc-booking/tcb-w3-reverify.test.js`) flip to expect a 422 on the boundary-crossing listing.

Either way the change is made **here first, by an explicit decision record**, and the acceptance
criterion follows the ADR. Rewriting the criterion to match shipped code — which is what happened in
build commit `3136b91`, see the Amendment log — is not a valid way to settle this.

## Alternatives considered
- **Hardcoding the numbers inside the listing service** — rejected: it contradicts SRS §2.1.7's explicit requirement that locale-specific policy be isolated in configuration, and would make a jurisdiction change a code change.
- **Enforcing the cap in the client** — rejected: AB-03 and AB-07 are attacks by users who control the client, so a client-side cap enforces nothing.
- **Deriving day boundaries from the guest's browser locale** (as displayed times are, per §2.1.7) — rejected: display locale and legal-compliance boundary are different concerns, and using the caller's timezone for the latter creates the midnight-hopping evasion described above.
- **A rolling 7-day weekly window instead of a calendar week** — *not decided either way*; see "Weekly window shape — OPEN, not ratified". It is the stricter option and closes the week-boundary evasion, at the cost of a cap that is harder for a host to reason about ("this Monday you may serve 0 more meals because of listings you posted last Wednesday"). Recorded as an open question, not as a rejected alternative.

## Consequences
- **Positive:** FR-11's cap enforcement and AB-07's single-enforcement-point mitigation are satisfied by construction; another jurisdiction is a configuration file plus legal review.
- **Positive:** a single check is a single thing for TC-11 to test and a single thing to get wrong, rather than a condition scattered across listing creation, update and duplication paths.
- **Negative (weekly window, unratified):** with the Monday-anchored week that v1.0 implements, the weekly cap is **evadable across a week boundary**. Worked example, reproduced by `tests/tc-booking/tcb-w3-reverify.test.js` — one eligible host creates 30-seat listings on Sat 2031-03-08 and Sun 2031-03-09 (week Mon 03-03 … Sun 03-09, 60/60) and again on Mon 2031-03-10 and Tue 2031-03-11 (next week, 60/60). All four are accepted, so `sum(seat_capacity)` over `local_date` 2031-03-08 … 2031-03-14 is **120 — twice the stated 60-meals-per-week cap inside a single 7-day span**, served on four consecutive days. Under the rolling reading the third listing is refused. This is the substance of the open sub-decision above, and it is why no weekly-compliance claim may rest on the current implementation.
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

## AI assistance & provenance
The missing numeric caps were surfaced by the AI-assisted build-planning run on 2026-08-11, which used these values as defaults and flagged them for confirmation rather than treating them as settled. The team confirmed the values as correct under California law on 2026-08-12. This record was drafted by Claude Code from that confirmation; the legal reading is the team's, and per the follow-up above it warrants a documented re-check at CDR.
