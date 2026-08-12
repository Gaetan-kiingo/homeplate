# ADR-007: Moderation LLM provider — Google Gemini free tier behind the provider-agnostic adapter

- **Status:** Accepted
- **Date:** 2026-08-12
- **Deciders:** Gaetan Rieben (decided 2026-08-12; pending team ratification at the next stand-up)
- **Related requirements:** FR-08 (moderation), NFR-09 (degradation), NFR-10 (moderation accuracy), NFR-13 (data protection), SRS §2.4 (free-tier constraint)

## Context
ADR-002 fixed the moderation approach — deterministic pre-filter, then a hosted LLM returning a structured `{category, confidence}` result — but deliberately left the runtime configuration open, consistent with SRS §2.4's separation of fixed technology constraints from open decisions. Build planning surfaced the gap as a hard conflict: SRS §2.4 requires that any API use stay within its free-tier rate limits, and the SPMP (§1.1.2, §5.1.3) states there is no project budget, yet the moderation provider assumed during planning has no free tier. FR-08 cannot be satisfied by the pre-filter alone — the requirement names an automated moderation flow with confidence-based routing to human review — so dropping the LLM stage is not available.

## Decision
The moderation LLM stage will call the **Google Gemini API free tier**, using a Google AI Studio key held by the team. The call sits behind the provider-agnostic adapter already specified in the build plan (`LLM_MODERATION_BASE_URL`, `LLM_MODERATION_API_KEY`, `MODERATION_MODEL`), so the provider is one environment change rather than a code change. The concrete model id is pinned in configuration at implementation time against whatever model the free tier currently offers, and recorded alongside the IT-03 results so a measurement can be tied to the model that produced it.

CI and the automated test suite run against a deterministic mock adapter; only the IT-03 measurement run calls the live API. A moderation-provider outage or quota exhaustion is handled exactly as ADR-002 requires — public content stays pending, never publishes unreviewed.

## Alternatives considered
- **A paid API tier** — rejected: there is no budget (SPMP §5.1.3), and SRS §2.4 makes free-tier operation a constraint rather than a preference.
- **A self-hosted small open-weights model** — rejected: it moves the cost from money to hardware and team hours, and the SPMP's ≈8-week window with three people (§5.1.1) has no room for model serving.
- **Pre-filter only, no LLM stage** — rejected: FR-08 requires confidence-based routing to human review, which a blocklist cannot produce, and NFR-10 would have nothing to measure.

## Consequences
- **Positive:** The free-tier constraint in SRS §2.4 is satisfied without weakening FR-08. Because the adapter is provider-agnostic, a later move to a paid or different provider costs one environment variable, not a rewrite.
- **Negative — privacy, and the most important consequence of this decision:** free tiers of consumer AI APIs commonly reserve the right to use submitted content for product improvement and human review, on terms that differ from paid tiers. The moderation pipeline scans private host–guest messages, and the SRS §3.4 PII register already lists the LLM API as an external recipient of message content. **Before any real user content is sent, the team must read Gemini's current free-tier data-use terms and record the finding as part of ST-06.** If the terms permit retention or training on submitted content, the options are (a) restrict the demo to synthetic content, (b) pseudonymize or strip identifiers before the call, or (c) move to a paid tier. This ADR does not assume the answer.
- **Negative — dependency concentration:** Google now serves both discovery (ADR-005, Maps/Places) and moderation. A Google-side outage or a billing/quota problem degrades two subsystems at once, which widens the blast radius RT-01 must exercise under NFR-09.
- **Negative — throughput:** free-tier rate limits constrain IT-03's ≥200-item evaluation run, which will need batching and backoff and is not safe to run in CI on every commit.
- **Neutral / follow-ups:** IT-03 (SRS §4.2) remains the gate on NFR-10. Per ADR-002, a failed bound is answered by measurement and prompt work first, not by reaching for a more complex classifier.

## AI assistance & provenance
The conflict between SRS §2.4's free-tier constraint and the moderation provider was surfaced by the AI-assisted build-planning run on 2026-08-11 (see `docs/_generated/build-plan.md`, open question 5), which flagged it rather than resolving it. The choice of Gemini's free tier was made by the team on cost grounds. This record was drafted by Claude Code from that decision and must be reviewed by the team before it is treated as ratified; the privacy consequence above is an open action item, not a resolved question.
