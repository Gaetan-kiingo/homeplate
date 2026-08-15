# Moderation evaluation set — v1

**Requirements:** NFR-10 (moderation false-positive / false-negative bound), FR-08 (moderation),
AB-01, AB-03, AB-04, NFR-13 · **Test ID:** IT-03 (SRS §4.2) · **Decisions:** ADR-002, ADR-007, ADR-008

This directory is the labelled evaluation set that IT-03 scores through the FR-08 moderation
pipeline. It is versioned as a directory: a later revision is `v2/`, never an edit to this one, so
a recorded result always names the exact set it was measured against.

| | |
|---|---|
| Items | **224** (56 offensive · 56 spam · 56 fraudulent · 56 benign) |
| Minimum required | 200 (SRS §4.2, ADR-008) |
| Surfaces covered | listing text, review text, private message, host profile bio |
| Provenance | synthetic, written for this repository — **never scraped** |
| Label review | **UNREVIEWED — no NFR-10 pass may be claimed (see Sign-off below)** |
| Results file | `RESULTS.md` — **not present**; written by the wave-7 IT-03 run |

## Provenance (ADR-008, NFR-13)

Every item was written for this repository against the FR-08 taxonomy and the Homeplate v1.0
content surfaces. No item is copied or adapted from a real user, a real platform, or a third-party
dataset, and none contains personal data: names, handles, domains and phone numbers are fictional
and use reserved example ranges (`*.example`, `555-01xx`). This keeps the set inside NFR-13's
data-minimisation posture and outside the free-tier data-use question ADR-007 raises.

The items were drafted with AI assistance (Claude Code) under the team's direction — ADR-008
permits items "written by the team **or generated for the purpose**". The labels are therefore
AI-proposed and **not yet human-verified**; that is exactly the gap the sign-off below closes, and
ADR-008 is explicit that the sign-off "is a control on AI-generated content and cannot itself be
delegated to an agent."

The set was authored **before** the U4-MODERATION pre-filter and classifier prompt existed, which
is the ordering ADR-008 requires: building the pipeline first "invites tuning the target to the
result."

## Taxonomy and label policy

The reviewer checks each item against these rules. They are the same rules a disagreement should be
resolved by.

- **offensive** — abuse, hate, threats, sexual harassment, or demeaning language directed at a
  person or group. Strong language *about food* is not offensive.
- **spam** — untargeted promotion: link farming, keyword stuffing, off-topic advertising, bulk or
  templated outreach, engagement farming, undisclosed affiliate or sponsored placement.
- **fraudulent** — an attempt to obtain money, credentials, identity documents or personal data
  from a specific person by deception: advance fees, gift-card / crypto / wire demands, phishing
  links, impersonation of the platform or of another user, overpayment-refund scams, bait listings,
  paid or fabricated reviews, identity and cap evasion, luring a guest off-site.
- **benign** — everything else, *including* negative reviews, food-safety and allergen complaints,
  and reports of abuse that quote the abusive words.

Four boundary rules decide the hard cases:

1. **Dominant violation.** An item violating more than one category takes the most severe label:
   offensive > fraudulent > spam.
2. **Spam versus fraudulent.** Advertising at everyone is spam. Deceiving *this* person out of
   money, credentials or documents is fraudulent.
3. **Payments are out of v1.0 scope.** No money moves through Homeplate (SRS §1.2), so "bring $18
   cash on the night" is benign. A demand for an upfront transfer, gift card, crypto or card
   details is fraudulent precisely *because* no platform flow exists that would justify it.
4. **Criticism is benign.** Moderating away an honest bad review, an allergen complaint, or a
   victim's report of a scam is the false positive NFR-10 exists to bound. **31 of the 56 benign
   items are deliberate hard negatives** (`traits` contains `hard-negative`): 7 negative reviews,
   5 safety reports, 3 that quote the abuse being reported, 4 legitimate cash arrangements, 2
   non-English messages, and 11 lexical look-alikes ("this dish is killer", "free parking", "wire
   rack", "a gift card for the market", "limited time only") that a blocklist pre-filter is likely
   to trip over.

   Scored through the ADR-007 mock today, exactly two of them are flagged — `ben-006` (reports a
   guest who "called me an idiot") and `ben-046` (offers "a gift card for the Asian market") — a
   concrete demonstration that a blocklist stage silently eats reports of abuse unless the LLM
   stage and the moderator queue catch it.

## How IT-03 uses this set

`tests/fixtures/moderation-eval/index.js` loads and validates a version directory and computes the
NFR-10 metrics. Metric definitions (also in `manifest.json`, so a results file can quote them):

- **false positive** — a benign item classified as any violating category;
  `falsePositiveRate = falsePositives / benignItems` (56 here, so one miss = 1.79 points).
- **false negative** — a violating item classified benign;
  `falseNegativeRate = falseNegatives / violatingItems` (168 here, so one miss = 0.60 points).
- **misrouted** — a violating item put in the wrong violating category. Not an FP or FN under
  NFR-10's binary bound, but reported because FR-08 routing depends on the category.

NFR-10 passes only when **both** rates are below 0.05.

## Sign-off (ADR-008 — binding)

> No NFR-10 result may be reported as a pass until a human team member has reviewed and signed off
> these labels. The sign-off — reviewer, date, and set version — is recorded in the IT-03 results
> file alongside the model id, prompt version, item counts and both measured rates. An IT-03 run
> against an unreviewed set reports its numbers marked **provisional**; it does not close NFR-10.

**Current status: UNREVIEWED.** `manifest.json → labelReview.status` reads `"unreviewed"`, and
`reviewer` and `date` are `null`. `index.js → claimability()` refuses to certify a run while that
is true, and refuses a run whose model id names a mock adapter.

To sign off: read every item, correct any label you disagree with using the boundary rules above
(a correction is an edit to this set *before* it has been measured — after a recorded IT-03 run it
must become `v2/`), then set `labelReview` to `{"status": "signed-off", "reviewer": "<name>",
"date": "<YYYY-MM-DD>", "setVersion": "v1"}` and record the same three fields in `RESULTS.md`.

## Not yet present

- `RESULTS.md` — written by the wave-7 IT-03 measurement run (U7-MODERATION-MEASURE). It is absent
  because no measurement has been made: the FR-08 pipeline (`src/modules/moderation/`, the
  `moderation.scan` handler) is wave-4 work, and ADR-007 sanctions exactly one live-provider run
  for it. **No false-positive or false-negative number may be quoted for NFR-10 until it exists.**
- Scoring this set through the ADR-007 *mock* adapter would produce a meaningless number: the mock
  is a fixed fixture-pattern matcher with no discriminating power over unseen text, by design.
  `claimability()` rejects any mock model id for exactly that reason.
