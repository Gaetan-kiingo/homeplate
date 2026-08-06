# ADR-003: Deferred-work mechanism — PostgreSQL outbox/job table, in-process worker

- **Status:** Proposed
- **Date:** 2026-07-31
- **Deciders:** Lucya Chuang, Gaetan Rieben, Nam Tran
- **Related requirements:** FR-07 (safety alerts), FR-08 (moderation), FR-13 (provider failure), NFR-09 (degradation)

## Context
NFR-09 requires deferring non-critical actions (notifications, moderation) on external-service failure, without blocking the triggering request. FR-13 requires that a provider failure never roll back or delay the booking transaction it's attached to. FR-07 requires that a safety alert be persisted, the moderator notified, and delivery attempted to the emergency contact via email, with retry on failure. Four external services sit behind this mechanism: Google Maps/Places, Firebase Cloud Messaging, SendGrid, and the moderation LLM API. The SRS treats the concrete delivery technology as an open decision, not a requirement.

## Decision
Deferred work is implemented as a transactional outbox table in PostgreSQL, written in the same transaction as the triggering business change, and polled by a background worker running in the same codebase as the API. The worker calls per-service adapters with retry, backoff, and dead-letter visibility for anything that keeps failing. Job payloads carry IDs only, never raw personal data.

## Alternatives considered
- **Publishing to a separate cache or queue right after the database commit** — rejected: dual write; the two writes can disagree (one succeeds, the other fails), which breaks the guarantee FR-13 requires.
- **Introducing a dedicated message-broker service** — rejected for v1.0: another piece of infrastructure to provision and secure, with no clear capability gain at the scale the SRS targets (10,000 users, 1,000 bookings/day per NFR-02), on a six-week schedule.
- **Calling providers synchronously from the request handler** — rejected: a slow or failing provider would block or fail the booking itself, which violates FR-13 and NFR-09.

## Consequences
- **Positive:** The outbox commits atomically with the business record, so FR-13 holds without extra coordination logic; RT-02 (SRS §4.4) can test recovery and idempotency directly.
- **Negative:** Delivery happens on the order of seconds, not milliseconds; idempotency across every worker path must be maintained by discipline, since the structure doesn't enforce it on its own.
- **Neutral / follow-ups:** If future durability or throughput needs exceed what a polled table can comfortably provide, that would need its own follow-up decision.

## AI assistance & provenance
Per SRS Appendix A, AI assisted in researching relevant technologies and drafting the reliability/testing sections tied to this mechanism (RT-01, RT-02); the team reviewed and approved the content and made the underlying design choice — the outbox pattern — themselves, verifying it against FR-13's exact wording before adopting it.