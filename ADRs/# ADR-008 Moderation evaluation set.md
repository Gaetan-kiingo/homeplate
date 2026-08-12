# ADR-008: Moderation evaluation set — team-authored, versioned, human-reviewed before any NFR-10 claim

- **Status:** Accepted
- **Date:** 2026-08-12
- **Deciders:** Gaetan Rieben (decided 2026-08-12; pending team ratification at the next stand-up)
- **Related requirements:** NFR-10 (moderation accuracy), FR-08 (moderation), NFR-13 (data protection)

## Context
NFR-10 bounds the moderation pipeline's false-positive and false-negative rates at under 5% each, and SRS §4.2 defines IT-03 as the protocol that measures it: a labelled evaluation set of at least 200 items — offensive, spam, fraudulent and benign in balanced proportions — scored through the pipeline, with the set and results versioned so the bound can be re-checked when the model or prompt changes. No such set exists. Without it NFR-10 is not merely unverified but unverifiable, and ADR-002 explicitly defers any move to a more capable classifier until an IT-03 result shows the simple approach failing — which presupposes a set to measure against.

## Decision
The evaluation set is a project deliverable, authored by the moderation work unit (U4-MODERATION) and checked into the repository at `tests/fixtures/moderation-eval/v1/`, versioned as a directory so a later revision is a new version rather than an edit to the measured one. Items are **synthetic — written by the team or generated for the purpose — never scraped from real users or third-party platforms**.

The binding rule: **no NFR-10 result may be reported as a pass until a human team member has reviewed and signed off the labels.** The sign-off — reviewer, date, and set version — is recorded in the IT-03 results file alongside the model id, prompt version, item counts and both measured rates. An IT-03 run against an unreviewed set reports its numbers marked provisional; it does not close NFR-10.

## Alternatives considered
- **An off-the-shelf public moderation benchmark** — rejected: licensing is uneven, and the label taxonomy of a general-purpose safety dataset does not match the categories FR-08 actually routes on for a meal-sharing marketplace, so a good score would not evidence the requirement.
- **Scraping real content from an existing platform** — rejected: it imports other people's personal data into a project whose own NFR-13 mandates data minimization, and would likely breach the source platform's terms.
- **Accepting the automated labels the pipeline itself produces** — rejected outright: measuring a classifier against its own output is not a measurement.
- **Deferring the set until after the pipeline is built** — rejected: it is the acceptance criterion for the pipeline, so building the pipeline first invites tuning the target to the result.

## Consequences
- **Positive:** NFR-10 becomes falsifiable, and the versioned set plus recorded model/prompt version means a future change can be re-checked against the same bar rather than re-argued.
- **Positive:** synthetic items keep the evaluation set inside NFR-13's data-minimization posture and outside the free-tier data-use question raised by ADR-007.
- **Negative:** measurement quality is bounded by label quality, and the labellers are the same three people who wrote the classifier prompt — a real bias risk. Balanced proportions and an explicit second-reader review are the mitigation, not a cure.
- **Negative:** authoring 200+ balanced items is genuine effort inside the SPMP's ≈8-week window (§5.1.1), and it lands on the moderation unit rather than being free.
- **Neutral / follow-ups:** if IT-03 fails the 5% bound, ADR-002's follow-up rule applies — investigate prompt and set quality first; a more capable classification approach needs its own decision record.

## AI assistance & provenance
The absence of the evaluation set was surfaced by the AI-assisted build-planning run on 2026-08-11 (`docs/_generated/build-plan.md`, open question 6). The team decided that a work unit authors the set and that human review gates any NFR-10 claim. This record was drafted by Claude Code from that decision and is subject to team review. The human sign-off required above is a control on AI-generated content and cannot itself be delegated to an agent.
