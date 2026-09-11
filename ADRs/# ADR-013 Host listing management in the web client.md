# ADR-013: Host listing management ships in the v1.0 web client — and the shell's seams have an owner

- **Status:** Accepted (team decision 2026-09-11; closes verification finding OBS-B3)
- **Date:** 2026-09-11
- **Deciders:** Gaetan Rieben (2026-09-11: "our product should be complete for the demo")
- **Related requirements:** FR-11 (listing management), FR-08 (pending until approved), FR-09 (publish eligibility gate), FR-10 (verified email), NFR-07 (accessibility of key interfaces), SRS §2.1.2 (hosts use the same web app for onboarding and listing management), SRS §4.5 (UT-01 "host listing flow" task), ADR-001, ADR-009, ADR-010

## Context
SRS §2.1.2 says hosts use the responsive web client "additionally for onboarding" and listing management, and the UT-01 usability protocol names the *host listing flow* as one of its two participant tasks. The API side of FR-11 — create, update, cancel, MEHKO caps — was built and verified in wave 3. Wave 6 built the seven NFR-07 interfaces as four units, each owning one folder under `client/src/features/`, and **no unit owned a host screen**. The verification round recorded it as **OBS-B3**: "no live UI path can trigger a MEHKO cap because no wave-6 unit owned a listing-create screen", and left the coordinator a choice — ship a host listing-management screen in v1.0, or document host flows as API-driven. The same ownership gap had already produced the missing navigation links (2026-08-27) and, found on 2026-09-11, a session store with a logout function that no screen ever offered.

## Decision
1. **v1.0 ships host listing management in the web client**, as a sixth feature tree `client/src/features/host`: **Host a meal** (create), **Edit** (owner-only, changed fields only), inline **Cancel** on the listing page, and **Your meals** (every upcoming listing in every moderation and status state, over an owner-only `GET /api/listings/mine`). The server remains the sole enforcement point for eligibility (FR-09) and the MEHKO caps (ADR-009); the screens render the typed refusals from the payload and invent nothing.
2. **The precise-address keys have exactly two readers** in the client (ADR-010): the booking-gated meal page and the owner's edit page, both presence-guarded on the payload; the adr-conformance guard pins that list.
3. **Seams have an owner.** Work that lives between feature trees — the navigation, the header's session controls (sign in, sign out, account), the route table, the accessibility audit's route discovery — is owned by the **shell** (`client/src/layout`, `client/src/routes.jsx`) and is part of the definition of done for any feature that adds a screen: a screen is not finished until it is reachable from the shell and the shell's tests say so. Disjoint file ownership is what makes parallel agents safe; this rule is what stops it from leaving the seams to nobody.
4. **Meal times are entered as America/Los_Angeles wall clock** (SRS §2.1.7) and converted to a timezone-explicit instant before they reach the API, whatever the host's browser zone.

## Alternatives considered
- **Document host flows as API-driven for v1.0** — rejected: it contradicts SRS §2.1.2 and makes the UT-01 host task impossible in the product; a demo that creates meals with `curl` is not "complete".
- **Put host screens under the discovery tree** — rejected: it hides a distinct role behind a guest-facing tree and would have let the scope guard drift instead of pinning a sixth tree deliberately.
- **A modal or inline form on the account page** — rejected: the form has fourteen fields, an address, photos and cap refusals to render; it needs a page with one h1 and a focused error summary (NFR-07).

## Consequences
- **Positive:** FR-11's client column is an exercised flow, not a rendering contract: the daily listing cap was triggered *through the UI* during the rehearsal and rendered from the payload. UT-01 can now include the host task. OBS-B3 is closed.
- **Positive:** the seam rule turned two latent gaps into shipped controls the same evening (navigation for hosts; sign out) and gives the a11y harness two more auditable routes.
- **Negative:** in development the ADR-002 mock classifier auto-approves benign text within a second, so a freshly hosted meal never reaches the human queue; a demo of the queue must use a seeded low-confidence item or the live classifier.
- **Negative:** the demo seed had to gain phone numbers — the FR-09 policy reads the encrypted phone live, and hosts seeded with the flag but no phone were refused (finding 33). Seeds must satisfy the policy, not assert its result.
- **Neutral / follow-ups:** photos on create use the ADR-004 supply path; edit does not yet manage photos. The search page cache (60 s, 5 s in the demo env) is not invalidated by host writes — finding 32, open.

## AI assistance & provenance
The team decided to ship the screens on 2026-09-11; the agent built them that evening under the existing guards, inverting two guards rather than deleting them, and verified the loop in a scripted browser (publish → auto-approve → guest finds it → host cancels). This record was drafted by Claude Code from that decision. The seam-ownership rule is the agent's generalisation of three concrete defects (navigation, sign out, OBS-B3) and is offered for team ratification.
