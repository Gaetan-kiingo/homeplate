# ADR-005: Location discovery — third-party mapping and geocoding service

- **Status:** Proposed
- **Date:** 2026-07-31
- **Deciders:** Lucya Chuang, Gaetan Rieben, Nam Tran
- **Related requirements:** FR-01 (search), NFR-01 (latency), NFR-09 (degradation)

## Context
FR-01 requires that users be able to search for meals by location, time, host, or cuisine — the load-bearing read path, bound by NFR-01's 500 ms latency target and reused as part of NFR-09's degraded-mode fallback (serving cached results when a dependency fails). Both the SRS and the proposal already name the Google Maps/Places API as the service used for geocoding and location-based discovery; neither document treats this as an open question, but it still shapes the architecture — a dedicated adapter, caching, and free-tier rate limits (SRS §2.4) are all consequences of this choice, so it is worth recording as an explicit decision.

## Decision
We will use the Google Maps/Places API for geocoding host addresses and for location-based search, rather than building geocoding or spatial matching in-house. Search results and geocoded coordinates are cached in Redis, so the same cache that serves NFR-01's latency target also serves as the NFR-09 fallback when the API is degraded or unavailable. All calls go through a dedicated adapter with timeout, retry, and fallback behavior, staying within the API's free-tier limits.

## Alternatives considered
- **Building location matching and geocoding in-house** — rejected: it would require the team to design and maintain geospatial logic from scratch under a six-week deadline, with no corresponding requirement asking for it, and no third-party rate limits to work within — a self-built solution trades a documented, budgeted constraint for an open-ended engineering effort.

## Consequences
- **Positive:** No custom geocoding or spatial-matching logic to build and maintain; reuses the same cache already needed for NFR-01, so the NFR-09 fallback comes at no extra structural cost.
- **Negative:** Discovery is bounded by the API's free-tier rate limits and availability; a sustained outage degrades search to whatever's cached rather than serving fresh results.
- **Neutral / follow-ups:** LT-01 (SRS §4.4) load-tests browse/search against the 500 ms budget and should specifically confirm cache behavior under the Maps/Places rate limit.

## AI assistance & provenance
Per SRS Appendix A, AI assisted with researching relevant technologies during SRS drafting. The choice to rely on a third-party API rather than build in-house was a team judgment based on the six-week timeline, verified against FR-01 and NFR-09's stated behavior before being recorded here.