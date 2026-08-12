# ADR-009: MEHKO capacity limits — AB 626 caps as configuration with one server-side enforcement point

- **Status:** Accepted
- **Date:** 2026-08-12
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

These values are the AB 626 MEHKO limits and were confirmed by the team as correct for California. They live in the configuration module (`src/config/`) as jurisdiction data, never inline in a service, per SRS §2.1.7.

Enforcement is **one server-side check** consulted by every path that creates or modifies a listing — not a per-module reimplementation. Day and week boundaries are evaluated in the configured operating timezone, not in UTC and not in the browser's locale, so a host cannot gain a second daily listing by submitting near midnight from another timezone. Client-side display of remaining capacity is a convenience only; the server rejects independently of it.

## Alternatives considered
- **Hardcoding the numbers inside the listing service** — rejected: it contradicts SRS §2.1.7's explicit requirement that locale-specific policy be isolated in configuration, and would make a jurisdiction change a code change.
- **Enforcing the cap in the client** — rejected: AB-03 and AB-07 are attacks by users who control the client, so a client-side cap enforces nothing.
- **Deriving day boundaries from the guest's browser locale** (as displayed times are, per §2.1.7) — rejected: display locale and legal-compliance boundary are different concerns, and using the caller's timezone for the latter creates the midnight-hopping evasion described above.

## Consequences
- **Positive:** FR-11's cap enforcement and AB-07's single-enforcement-point mitigation are satisfied by construction; another jurisdiction is a configuration file plus legal review.
- **Positive:** a single check is a single thing for TC-11 to test and a single thing to get wrong, rather than a condition scattered across listing creation, update and duplication paths.
- **Negative:** the daily and weekly caps are per *account*. AB-07 notes that a host operating several accounts evades them, and that phone-number uniqueness and identity verification are deferred to v2.0 — so this decision mitigates the constraint, it does not close the abuse case. Log-based anomaly review (NFR-08) remains the only v1.0 detection for multi-account evasion.
- **Neutral / follow-ups:** these values are the team's reading of AB 626 for an academic project and are not legal advice. They should be re-confirmed at CDR, and the confirmation recorded, before any claim of regulatory compliance is made in the final presentation.

## AI assistance & provenance
The missing numeric caps were surfaced by the AI-assisted build-planning run on 2026-08-11, which used these values as defaults and flagged them for confirmation rather than treating them as settled. The team confirmed the values as correct under California law on 2026-08-12. This record was drafted by Claude Code from that confirmation; the legal reading is the team's, and per the follow-up above it warrants a documented re-check at CDR.
