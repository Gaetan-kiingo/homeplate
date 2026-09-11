# ADR-012: Price per seat — published by the host as information, settled off-platform; no payment feature in v1.0

- **Status:** Accepted (team decision 2026-09-11, recorded the same day; to be listed in the final report as an addition beyond the frozen SRS v3.2 scope)
- **Date:** 2026-09-11
- **Deciders:** Gaetan Rieben (product decision, 2026-09-11)
- **Related requirements:** FR-11 (listing management), FR-01/FR-02 (search results and meal detail), SRS §1.2 (payments out of scope for v1.0), SRS §2.4 (no budget; free tier), NFR-11 (input validation), NFR-13 (data protection), ADR-010 (public projection)

## Context
SRS v3.2 §1.2 puts **payments out of scope for v1.0** (SRS revision 2.0, 2026-07-30: "Implementing Stripe is considered out of scope"; FR-04 lost its payment step, the Stripe NFR was removed). A meal nevertheless costs something, and the demo rehearsal on 2026-09-11 made the gap visible: hosts had no way to say what a seat costs, guests had no way to know before reserving, and the AI-written moderation prompt was already treating "bring cash" as fraud (verification report §7, finding 28 in the code-review log) precisely because the product had no notion of price at all.

The frozen SRS has no field for it. Adding one is therefore a **scope addition**, not an interpretation, and must be recorded as a decision rather than slipped in as an implementation detail.

## Decision
A listing carries a **price per seat**, stored as **whole cents** (`listings.price_per_seat_cents`, integer, `CHECK >= 0`, migration 0007, append-only). It is **information the host publishes**: the guest pays the host directly at the meal. Homeplate v1.0 **takes no payment, holds no money, and makes no charge** — the meal page says so next to the price ("Paid to the host directly at the meal — Homeplate takes no payments").

- **Required in the host form** (0 allowed, rendered as "Free"); the API defaults it to 0 so scripted and legacy callers, fixtures and existing rows stay valid.
- **Public data** in the ADR-010 public projection (`pricePerSeatCents` in `PUBLIC_KEYS`): it appears on the search card sticker and the meal page. It is not personal data.
- **Not a moderation-material field**: a price change publishes immediately; the FR-08 pipeline scans text, not numbers.
- **Not a MEHKO quantity**: ADR-009's single enforcement point is untouched; price never enters a cap.
- Bounded server-side (`0 ≤ cents ≤ 100000`, integer) per NFR-11; USD only in v1.0 (SRS §2.1.7: California).

## Alternatives considered
- **No price until payments arrive in v2.0** — rejected: guests reserve blind, hosts fall back to free text, and the moderation prompt has no way to distinguish a cash note from a payment-diversion scam (the exact false-positive class measured on 2026-09-11).
- **Price as free text in the description** — rejected: not comparable, not sortable, not renderable on the card sticker, and NFR-11 cannot bound it.
- **Store dollars as a decimal** — rejected: floating-point money; whole cents in an integer column is the conventional, exact form.
- **Making the API field required** — rejected for v1.0: it would invalidate every existing listing body in the test protocol and every seeded row for no product gain; the *form* is where "required" matters for the host, and the server enforces the bounds.

## Consequences
- **Positive:** guests see the cost before reserving; hosts state it once, in one place; the moderation prompt's fraud clause can now be reworded to distinguish "the platform has no payments, bring $18" from "pay me off-platform instead" — the prerequisite for closing NFR-10 (finding 28).
- **Negative — scope:** this is a field the SRS does not specify. It must be listed in the final report as a v1.0 addition with this ADR as its record, and the SRS revision history should gain a line at the next re-baseline.
- **Negative — expectation management:** a price on screen can read as "the app charges". The meal page copy and the README state that it does not; the demo should say it out loud.
- **Neutral / follow-ups:** when payments return in v2.0, this column is the natural input to the charge; the disclosure copy is then removed, not the column. Currency stays USD until a jurisdiction decision (SRS §2.1.7) says otherwise.

## AI assistance & provenance
The request came from the team on 2026-09-11 during the demo rehearsal; the agent implemented it (migration, schema, serializer, form, card, detail, tests) and drafted this record. The scope-addition framing — that a field absent from the frozen SRS needs a decision record — is the agent's reading of SPMP §1.1.2 (SRS wins on requirements) and is stated here for the team to confirm or reject at the final review.
