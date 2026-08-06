# ADR-004: Media storage — object storage with per-object deletion

- **Status:** Proposed
- **Date:** 2026-07-31
- **Deciders:** Lucya Chuang, Gaetan Rieben, Nam Tran
- **Related requirements:** FR-02 (meal detail), FR-03 (host profile), FR-05 (reviews), NFR-12 (data deletion)

## Context
Listings, host profiles, and reviews all carry images (FR-02, FR-03, FR-05). NFR-12 requires that a deleted user's personal data — including anything they've uploaded — be erased or anonymized within 30 days. The SRS treats the concrete storage mechanism as an open decision.

## Decision
Listing and review media are stored in dedicated object storage, referenced from PostgreSQL by key, behind an adapter that supports per-object deletion. Deleting an account triggers deletion of the user's media objects by key, alongside the deletion of their PostgreSQL rows.

## Alternatives considered
- **Storing media directly in PostgreSQL** — rejected: bloats the primary transactional database with large binary payloads and works against the NFR-01 latency target for the discovery path, for no benefit over a purpose-built store.
- **Storing media on the application server's local filesystem** — rejected: doesn't survive redeployment or scale past a single instance, and gives no clean way to delete a specific user's files on request.

## Consequences
- **Positive:** Media deletion is a simple, key-based operation that composes cleanly with the account-deletion job required by NFR-12.
- **Negative:** Introduces a second storage system the team must configure and secure alongside PostgreSQL.
- **Neutral / follow-ups:** ST-05 (SRS §4.3) verifies NFR-12 erasure and should be checked against media deletion specifically, not just database rows.

## AI assistance & provenance
Per SRS Appendix A, AI assisted with drafting the data-lifecycle and privacy sections of the SRS; the team reviewed and approved the content. This specific storage decision — object storage with per-object deletion — was made and verified by the team against NFR-12's exact wording.