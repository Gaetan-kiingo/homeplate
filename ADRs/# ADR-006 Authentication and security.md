# ADR-006: Authentication and security boundary

- **Status:** Proposed
- **Date:** 2026-07-31
- **Deciders:** Lucya Chuang, Gaetan Rieben, Nam Tran
- **Related requirements:** NFR-03 (transport security), NFR-04 (password hashing), NFR-05 (rate limiting), NFR-06 (eligibility gate), NFR-11 (input validation)

## Context
NFR-03 requires TLS 1.2+ on all network transit; NFR-04 requires passwords stored with an approved hashing scheme; NFR-05 requires login-attempt rate limiting or temporary lockout; NFR-11 requires input validation and sanitization at every boundary; NFR-06 requires that listing and reservation actions be restricted to users who have completed email verification and profile-completeness checks. The SRS states that multi-factor authentication and government-ID identity verification are deferred to v2.0, alongside payments. Redis is a fixed constraint already designated for session storage (SRS §2.1.1, §3.2).

## Decision
We will implement one authentication service within the modular monolith (ADR-001), owning credentials, sessions (backed by Redis), and login rate-limiting. All client-server traffic is HTTPS-only (TLS 1.2+); plain HTTP is refused. Input validation is applied at the API boundary. Eligibility state (email-verified, profile-complete) is exposed through a single policy check that relevant flows consult, rather than each module implementing its own version of the check.

## Alternatives considered
- **Building multi-factor authentication or identity verification now** — rejected: no v1.0 requirement calls for it, and the SRS explicitly defers both to v2.0; building them now would spend limited team hours on capability not currently required.
- **Letting each module implement its own eligibility check independently** — rejected: it would leave verification state as a condition scattered across the codebase with no single authoritative source of truth, which is what NFR-06 is meant to prevent.

## Consequences
- **Positive:** One trust boundary and one auth layer keep the attack surface small; a single eligibility check is easier to test and reason about than scattered per-module logic.
- **Negative:** Without MFA, account-takeover risk is mitigated only by password hashing and rate-limiting — an accepted trade-off for v1.0 scope, not a claim the risk is eliminated.
- **Neutral / follow-ups:** ST-01 through ST-04 (SRS §4.3) verify TLS configuration, password handling, lockout behavior, and input validation respectively and should all pass before this decision is considered validated.

## AI assistance & provenance
Per SRS Appendix A, AI assisted with researching security standards and drafting the security-related NFRs; the SRS notes that NFR-03 specifically was further researched and verified without AI help. The team confirmed the v1.0/v2.0 scope split (MFA and identity verification deferred) against SRS §2.4 before finalizing this decision.