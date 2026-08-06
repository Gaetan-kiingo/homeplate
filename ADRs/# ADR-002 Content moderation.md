# ADR-002: Content moderation approach and publication policy

- **Status:** Accepted
- **Date:** 2026-07-31
- **Deciders:** Lucya Chuang, Gaetan Rieben, Nam Tran
- **Related requirements:** FR-08 (moderation), NFR-09 (degradation), NFR-10 (moderation accuracy)

## Context
FR-08 requires that user-generated content pass through a deterministic pre-filter and automated moderation flow, route flagged or low-confidence content to human review, and enforce a publication policy: public content (listings, reviews) stays pending until approved; private messages send immediately and are scanned asynchronously; a moderation-provider outage keeps public content pending rather than publishing it unreviewed. NFR-10 requires a measurable false-positive/false-negative bound (under 5%). The SRS scopes v1.0 to this one AI feature; AI-assisted listing generation and recommendation matching, both described in the proposal's product vision, are explicitly out of scope for v1.0.

## Decision
Moderation runs in two stages. A deterministic pre-filter (blocklists, regex, rate limits) runs first and blocks obvious violations instantly. Content that passes goes to a hosted LLM that classifies it against an embedded safety policy and returns a structured result (category, confidence); low-confidence or flagged content routes to a human reviewer (the Moderator role defined in the SRS). This runs as a worker path under ADR-001's deferred-work mechanism. Regardless of outcome, public content stays pending until approved, and stays pending — never publishes unreviewed — if the moderation provider is unavailable.

## Alternatives considered
- **Skipping the deterministic pre-filter and sending all content straight to the LLM** — rejected: removes a free, instant first line of defense, and adds unnecessary load and cost to every submission.
- **Publishing content immediately and moderating after the fact** — rejected: conflicts with FR-08's stated publication policy and would let unreviewed content reach guests and hosts.
- **A more capable classification approach (e.g., retrieval of past examples, or a custom-trained model)** — not adopted for v1.0: no measured evidence yet shows the simpler prompt-based approach falls short of NFR-10's bound; IT-03 (SRS §4.2) is the defined protocol (a labeled set of at least 200 items, false-positive/false-negative rate under 5%) for testing whether a more capable approach is actually needed.

## Consequences
- **Positive:** The publication-pending-on-outage rule means a moderation-provider failure never trades safety for availability; the pre-filter reduces load on the LLM stage.
- **Negative:** A prompt-based classifier may miss content patterns a simpler rule set can't anticipate, until IT-03 measurement shows a real gap.
- **Neutral / follow-ups:** Any move to a more sophisticated moderation approach should be justified by an IT-03 result showing the current approach fails the 5% bound, not adopted preemptively. AI listing generation and recommendation matching get their own decision when they return in scope.

## AI assistance & provenance
Per SRS Appendix A, AI assisted with drafting the moderation-related NFRs and verification strategy sections; the team reviewed and approved the content. The proposal's own description of AI use in the product (trust-and-safety moderation, LLM classification of listings and chat) matches what FR-08 formalizes for v1.0; the team confirmed the scope boundary (moderation only, not listing generation or matching) against SRS §1.2 before finalizing this decision.