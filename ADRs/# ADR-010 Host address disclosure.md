# ADR-010: Host address disclosure — approximate area publicly, exact address only to a confirmed guest

- **Status:** Accepted
- **Date:** 2026-08-12
- **Deciders:** Gaetan Rieben (decided 2026-08-12; pending team ratification at the next stand-up)
- **Related requirements:** FR-01 (search), FR-02 (meal detail), FR-03 (host profile), FR-12 (booking), NFR-13 (data minimization), AB-01 (fake listing), AB-08 (scraping)

## Context
Two requirements pull against each other. FR-01 requires location-based discovery and FR-03 requires the host's page to show the dining location, so location must be visible to someone deciding whether to book. NFR-13 requires collecting and exposing only the personal data enumerated in SRS §3.4, and AB-08 names automated harvesting of host addresses as an abuse case whose stated v1.0 mitigation is session-authenticated access plus *data minimization in API responses* — with read-API rate limiting explicitly deferred to v2.0. A host's home address is also a safety matter, not only a privacy one: hosts are private individuals cooking in their own homes, and AB-01 describes luring guests to an unsafe location as a threat in the other direction.

## Decision
Address disclosure is **progressive**, keyed to booking state:

| Viewer | Sees |
|---|---|
| Unauthenticated or browsing user | Approximate area only — neighbourhood/city label and coarsened coordinates sufficient for map placement and distance filtering |
| Guest with a booking on that listing in `pending` or `in progress` | Exact street address and precise coordinates |
| Moderator handling a safety alert (FR-07) on that booking | Exact street address, access logged per NFR-08/NFR-13 |
| Guest whose booking is `cancelled` or `completed` | Reverts to approximate area |

PostgreSQL stores the full address; the API decides what leaves the boundary. Concretely: two serializers for a listing, with the public one as the **default**, so that a new read path is minimal unless it deliberately opts into the privileged view. Coarsened coordinates are computed and cached; the Redis cache (ADR-005) stores only the public precision, so a cache read can never leak an exact location. The address is deleted with the host's account under NFR-12.

## Alternatives considered
- **Publishing the exact address on the listing** — rejected: it hands AB-08 a scraping target with no rate limiting in v1.0, exposes a private individual's home address to unauthenticated traffic, and is not minimal in the sense NFR-13 requires.
- **Hiding location entirely until booking** — rejected: it breaks FR-01's location search and FR-03's requirement to show the dining location, and no guest can reasonably book a dinner without knowing roughly where it is.
- **Releasing the address at booking request rather than confirmation** — rejected: a request that fails the capacity check or eligibility gate would still have disclosed the address, making reservation attempts a free harvesting channel.

## Consequences
- **Positive:** discovery and the booking decision both work, while the address is exposed only to the one person with a reason to be at the door, and only while that reason holds.
- **Positive:** it strengthens AB-08's mitigation without the read-API rate limiting that v1.0 defers.
- **Negative — the obvious failure mode:** this is a safety property enforced by *every* read path agreeing. One forgotten serializer in search results, listing detail, host profile, the messaging thread, or a moderation view leaks the address silently and with no error. The `st-security` and `adr-conformance` verification lanes must assert the public shape on every public read path, not only on the listing endpoint.
- **Negative:** map precision pre-booking is deliberately coarse, so distance filtering is approximate near boundaries, and the client must not silently present coarse coordinates as exact.
- **Neutral / follow-ups:** the coarsening radius is configuration, not a constant, and should be reviewed alongside the ADR-009 jurisdiction settings. If v2.0 adds identity verification, the disclosure point could move earlier for verified guests — a new decision, not an extension of this one.

## AI assistance & provenance
The FR-01 / NFR-13 tension was surfaced by the AI-assisted build-planning run on 2026-08-11 (`docs/_generated/build-plan.md`, open question 11), which proposed progressive disclosure. The team agreed with that reading on 2026-08-12. This record was drafted by Claude Code from that decision and is subject to team review.
