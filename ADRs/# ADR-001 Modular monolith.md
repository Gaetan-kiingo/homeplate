# ADR-001: Modular monolith with a transactional outbox, PostgreSQL as source of truth

- **Status:** Accepted
- **Date:** 2026-07-31
- **Deciders:** Lucya Chuang, Gaetan Rieben, Nam Tran
- **Related requirements:** FR-08 (moderation), FR-09 (eligibility gate), FR-12 (atomic capacity), FR-13 (provider failure), NFR-01 (latency), NFR-02 (scalability), NFR-09 (degradation), NFR-10 (moderation accuracy), NFR-12 (data deletion)

## Context
The SRS fixes React (responsive web client), Node.js/Express, PostgreSQL, and Redis as the technology stack but leaves the deferred-work mechanism, media storage, and moderation runtime configuration as open decisions rather than requirements. FR-13 requires that a provider failure never roll back or delay a booking; FR-12 requires an atomic, race-free capacity check. NFR-09 requires that on external-service failure the system show an appropriate error, serve cached data, and defer non-critical work. The proposal describes a three-person team, each holding more than one role, building this within approximately 6 weeks — so operational complexity is a real risk to the deadline, not just to the running system.

## Decision
We will build one modular Node.js/Express codebase. Deterministic, synchronous modules handle eligibility, listing rules, capacity, and booking state. PostgreSQL is the single source of truth. A booking's record and a corresponding outbox record commit in the same PostgreSQL transaction. A background worker, part of the same codebase, polls the outbox and performs deferred work — moderation calls, notifications, safety-alert delivery — through per-service adapters, with retry, backoff, and dead-letter handling. Only worker code may call these adapters; request handlers may not call them inline. Redis is used for sessions and read caching only.

## Alternatives considered
- **Splitting the backend into independently deployed services** — rejected: it would multiply the number of trust boundaries and places personal data can live, working against NFR-09's dependency-isolation intent and NFR-12's 30-day deletion requirement, and adds operational overhead a three-person team cannot safely absorb in six weeks.
- **Storing the booking lifecycle as an append-only event log** — rejected: gives a strong audit trail but an immutable log is in tension with NFR-12's erasure requirement, and is more architectural complexity than the timeline supports.
- **Writing the business record to PostgreSQL, then separately publishing to a queue or cache** — rejected: this is a dual write; the database can commit while the second write fails, which directly contradicts the guarantee FR-13 exists to provide.

## Consequences
- **Positive:** FR-13's guarantee holds by construction rather than by convention; one deployable and one trust boundary keep the attack surface small; in-process calls keep NFR-01's latency target comfortable.
- **Negative:** The team must maintain worker idempotency and retry discipline by hand, since nothing in the structure enforces it; deferred work is delivered on the order of seconds, not milliseconds.
- **Neutral / follow-ups:** RT-02 (SRS §4.4) tests outbox recovery, duplicate-delivery handling, and dead-letter behavior directly and should be run before this decision is considered validated.

## AI assistance & provenance
Per SRS Appendix A, AI tools (Claude, Gemini, Cursor, GitHub Copilot) assisted with drafting technical SRS sections and researching relevant technologies; the team reviewed and approved all generated content. The proposal states the team also uses AI coding assistants (Claude Code, Cursor, GitHub Copilot) to scaffold the application and accelerate development. This architectural decision — how to satisfy FR-13 and NFR-09 given the fixed technology stack — is recorded as a team decision, consistent with the SRS's own statement that fixed constraints (§2.4) are separate from open decisions the team must make and own.
