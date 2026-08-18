# ADR-007 open action — moderation provider free-tier data-use review

**Artifact type:** ST-06 acceptance evidence (recorded finding)
**Requirements:** NFR-13 (data protection), FR-08 (moderation), SRS §3.4 (PII register — the LLM API
is listed as an external recipient of message content), SRS §2.4 (free-tier constraint)
**Decisions:** ADR-007 (moderation LLM provider), ADR-002 (two-stage moderation), ADR-008
(synthetic evaluation set)
**Drafted:** 2026-08-14 · **Ratification:** see the sign-off block below — **UNSIGNED**
**ST-06 clause status:** **OPEN** — evidence recorded, team ratification outstanding.
Re-checked 2026-08-17 (verification round 2): §7 is still unsigned.

---

> ### ACTION REQUIRED — this file is not an approval
>
> ST-06 asks the **team** to record a finding on the provider's current free-tier data-use terms.
> §2–§4 of this file record the **evidence** (an automated retrieval of the published terms). §5–§6
> record the **proposed** answer that follows from that evidence. Neither is a team decision, and
> the distinction is the whole point: evidence is something an agent can gather, ratification is
> something a human must do and be accountable for.
>
> Until a named human completes §7, **this document approves nothing.** Live moderation of real
> user content stays prohibited, the conservative default in §5–§6 governs, and any statement
> elsewhere in the repository that ST-06's data-use clause is "closed" is wrong.
>
> **An AI build agent must never fill in the §7 fields.** Doing so would forge the only part of
> this record that carries any authority. Round 1 of verification correctly left it blank; round 2
> re-confirmed that leaving it blank is the honest state, and this banner exists so the blank is
> not mistaken for an oversight.

## 1. Why this document exists

ADR-007 accepted the Google Gemini API free tier as the ADR-002 LLM stage and left one action open:

> "Before any real user content is sent, the team must read Gemini's current free-tier data-use
> terms and record the finding as part of ST-06. If the terms permit retention or training on
> submitted content, the options are (a) restrict the demo to synthetic content, (b) pseudonymize or
> strip identifiers before the call, or (c) move to a paid tier. This ADR does not assume the
> answer."
> — `ADRs/# ADR-007 Moderation LLM provider.md`, *Consequences → Negative — privacy*

`requirements-inventory.json` carries the same clause into the ST-06 acceptance criteria. The
question is not academic: the FR-08 pipeline scans **private host–guest message bodies** and
public listing/review text, and SRS §3.4 already registers the LLM API as an external recipient of
that content. Shipping the live adapter without answering it would be a privacy decision taken by
omission. This file records the **evidence** and the **proposed** answer; §7 is where the team turns
that into a decision. Until then the question is documented and fenced, not settled.

## 2. What was read

| | |
|---|---|
| Document | Gemini API Additional Terms of Service |
| URL | https://ai.google.dev/gemini-api/terms |
| Effective date shown on the page | **23 March 2026** |
| Retrieved | 2026-08-14 |
| How | Automated fetch by the AI-assisted build agent (Claude Code), quotes reproduced verbatim below. The retrieval is *evidence*, not the ratification — a human must confirm the quotes still stand at the effective date in force when live mode is first enabled (§7). |

## 3. Findings — verbatim

**F1 — Free-tier content is used to develop Google products.**
Section *Unpaid Services → How Google Uses Your Data*:

> "Google uses the content you submit to the Services and any generated responses to provide,
> improve, and develop Google products"

**F2 — Free-tier content is subject to human review.**
Same section:

> "human reviewers may read, annotate, and process your API input and output"

**F3 — The terms themselves forbid the use Homeplate was contemplating.**
Same section:

> "Do not submit sensitive, confidential, or personal information to the Unpaid Services."

**F4 — The paid tier is materially different.**
Section *Paid Services → How Google Uses Your Data*:

> "Google doesn't use your prompts […] or responses to improve our products"

and logging is bounded:

> "Google logs prompts and responses for a limited period of time, solely for detecting and
> preventing violations"

with processing under Google's Data Processing Addendum and human access restricted to abuse
investigation rather than product improvement. (The ellipsis in the first paid-tier quote marks
text elided during retrieval; the retained words carry the operative meaning.)

## 4. Verdict

**The free tier permits exactly what ADR-007 feared, and the terms explicitly instruct callers not
to send personal content.** Against Homeplate's obligations:

| Content Homeplate would classify | Personal data? | Free-tier verdict |
|---|---|---|
| Private host–guest message bodies (FR-06) | Yes — §3.4 registers them as personal content between identified users | **Prohibited.** F3 forbids it outright; F1/F2 mean retention, training use and human reading. |
| Review text (FR-05) | Yes — authored by an identified user, may name a host, an address or a household | **Prohibited** on the same grounds. |
| Listing text (FR-11) | Mixed — mostly descriptive, but host-authored and may embed contact or location detail | **Prohibited** as a class: the pipeline cannot reliably decide per item, and NFR-13 does not permit a best-effort guess. |
| ADR-008 synthetic evaluation items | **No** — ADR-008 requires the set to be team-authored, never scraped, containing no personal data | **Permitted.** Nothing personal leaves the boundary. |

Option **(c) paid tier** is closed: SRS §2.4 makes free-tier operation a constraint and SPMP §5.1.3
records no budget. Option **(b) pseudonymization alone** does not clear F3: stripping names, emails
and phone numbers still leaves the message *body* — which is the very thing the classifier must
read, and which is itself the personal content. Pseudonymization is a useful defence in depth, not a
sufficient answer.

## 5. Proposed decision — and the default that governs until §7 is signed

This section is written in the imperative because it is the operative restriction *today*: an
unsigned review fails closed, so the conservative reading below binds wave 4 whether or not the team
ever ratifies it. What the team's signature adds is the authority to relax it — nothing here becomes
permissive by being left unsigned.

**v1.0 never sends real user content to the moderation LLM.** Concretely:

1. **Live LLM mode is restricted to synthetic content.** `LLM_MODERATION_MODE=live` is legitimate
   only for the IT-03 measurement run over the ADR-008 synthetic evaluation set
   (`tests/fixtures/moderation-eval/vN/`), which by ADR-008 contains no personal data. That run
   stays compliant with F3.
2. **Real user content is moderated by the deterministic stage plus humans.** The ADR-002
   pre-filter (blocklist / regex / rate limit) runs on all content as specified. Where ADR-002 would
   hand off to the LLM, wave 4 routes the item to the **human Moderator queue** instead. This is the
   same code path ADR-002 already requires for a moderation-provider outage, so no new failure mode
   is introduced.
3. **The publication invariant is unchanged and unweakened.** Public content (listings, reviews)
   stays `PENDING` until a moderator approves it — it must never publish unreviewed. Private
   messages still deliver immediately and are scanned asynchronously by the deterministic stage,
   with flagged items raised to the queue.
4. **Pseudonymization is still applied** to anything sent live (option (b) as defence in depth):
   the classifier receives content text only — never user ids, names, emails, phone numbers or
   addresses — consistent with ADR-001's "outbox payloads carry IDs only" and NFR-13.
5. **NFR-10 is measured on the synthetic set**, exactly as ADR-008 and ADR-007 already require, and
   the recorded model id accompanies the result. Nothing about this decision changes what IT-03
   measures.

### Cost of the decision, stated plainly

Automated classification of real user content is not delivered in v1.0; the human Moderator queue
absorbs the volume the LLM stage would have taken. FR-08's confidence-based routing is therefore
exercised and measured against the synthetic set (IT-03/NFR-10) rather than against live traffic.
This is a deliberate scope consequence of the free-tier constraint, and it should be stated as such
in the v1.0 demo and in any NFR-10 claim — not presented as a full FR-08 deployment.

## 6. Binding effect on wave 4 (U4-MODERATION)

Until the sign-off block below is signed, the following are **preconditions**, not suggestions:

- The moderation worker must not pass user-authored content (message, review or listing text) to the
  LLM adapter while `config.moderation.mode === 'live'`. Content originating from the ADR-008
  fixture set is the only permitted live input.
- The fallback path for "would have called the LLM" is the human Moderator queue, with public
  content left `PENDING`. A moderation-provider outage and this policy produce the same observable
  behaviour, which is what makes the restriction safe (ADR-002, NFR-09).
- The existing guards stay: `src/config/schema.js` forces `LLM_MODERATION_MODE=mock` under
  `NODE_ENV=test` and refuses `mock` under `NODE_ENV=production`; provider, model and key remain
  environment-only (ADR-007). Nothing here permits hardcoding a provider or a key.
- If the team ratifies a different option, this file is amended first and the code follows it —
  not the other way round.
- **The gate is the signature, not the file.** U4-MODERATION must refuse to enable live
  classification of user-authored content unless this file parses as *signed* by the §7.2 test.
  The existence of this document must not be readable as approval — an unsigned review is a
  recorded question, not an answer. Concretely, the wave-4 acceptance criterion is: with the
  sign-off block in its current state, any attempt to configure live classification of
  user-authored content fails closed (content routes to the human Moderator queue, public content
  stays `PENDING`), and no code path treats "the review file exists" as sufficient.

## 7. Sign-off

ST-06 asks the *team* to record this finding. The research and the analysis above were produced by
the AI-assisted build agent; the ratification is a human act and is **not** recorded here as done.
Per the project's own precedent for ADR-008 label sign-off, an unsigned block means the conservative
default in §5–§6 governs.

| Field | Value |
|---|---|
| Terms URL and effective date reviewed | https://ai.google.dev/gemini-api/terms — effective 2026-03-23 |
| Reviewer (name) | _unsigned_ |
| Review date | _unsigned_ |
| Option ratified (a / b / c) | _proposed: (a) + (b); unsigned_ |
| Live mode approved for real user content? | **No** |

### 7.1 How to sign — the exact human procedure

This is the only outstanding work on ST-06's data-use clause. It cannot be automated away.

**Who.** Per SPMP §4.3, moderation integration is owned by **Gaetan Rieben** (Software Engineer /
QA) and data lifecycle plus documentation by **Nam Tran** (Software Engineer / Documentation Lead /
PM). One of them signs as reviewer; the other countersigns, satisfying SPMP §7.4's "at least one
peer review, without exception for AI-assisted work". Record the decision in the weekly stand-up
report (SPMP §5.3.5) so the ratification has a minute outside this file.

**Steps.**

1. Open https://ai.google.dev/gemini-api/terms yourself. Do not rely on §2–§4 of this file: they
   are a snapshot, and the terms can change under a new effective date at any time.
2. Read the effective date shown on the page. If it is **not** 2026-03-23, the quotes in §3 are
   stale — re-quote them before deciding, and update §2 and §3 with what you actually read.
3. Confirm or refute F1–F4 in §3 against the live text.
4. Decide the option, from ADR-007's three: **(a)** restrict live calls to synthetic content,
   **(b)** pseudonymize/strip identifiers before the call, **(c)** move to a paid tier. §4 argues
   (c) is closed by SRS §2.4 / SPMP §5.1.3 and that (b) alone does not clear F3; the proposal on
   the table is **(a) + (b)**. You are not bound by that proposal — you are bound to state which
   option the team takes and why.
5. Fill in the four table rows above: reviewer name, review date (ISO `YYYY-MM-DD`), the ratified
   option, and whether live mode is approved for real user content. Replace every `_unsigned_`
   placeholder; leaving one behind leaves the clause open.
6. Update ADR-007's header line ("Open action — free-tier data-use review") to cite this file as
   **ratified**, with the reviewer and date.
7. Flip the two pinned assertions in
   `tests/st-security/st-security-verify.test.js` → *"STS-W3-05 (round 2): the ADR-007 data-use
   finding is RECORDED but NOT human-signed"*. They currently assert the `_unsigned_` placeholders
   are present, precisely so a signature cannot be lost silently; after signing, they must assert
   the reviewer/date fields are populated instead. Do not delete the test — it is what keeps this
   clause from drifting back to "closed by assumption".

### 7.2 What counts as "signed" (the machine-checkable predicate)

So that wave-4 code and any future verifier agree on one definition: the sign-off is **signed** iff
the §7 table contains **no `_unsigned_` token** and the *Reviewer (name)* and *Review date* rows are
both non-empty, with the review date parsing as an ISO date. Anything else — including this file
existing, or §5's proposal being persuasive — is **unsigned**, and unsigned fails closed.

**Re-review triggers.** Re-read the terms and re-sign before: the first live moderation run after
this record is more than 90 days old; any change to the effective date on the page; any change of
provider, base URL or model id; or any proposal to send content other than the ADR-008 synthetic
set.

### 7.3 Current exposure, stated plainly

Zero, today. `src/modules/moderation/` does not exist (wave 4), no code path sends any content to
the LLM adapter, and `src/config/schema.js` forces `LLM_MODERATION_MODE=mock` under
`NODE_ENV=test`. The clause is nevertheless reported **OPEN**, not "deferred", because the exposure
becomes real the moment the wave-4 moderation worker lands: it scans private host–guest message
bodies, and SRS §3.4 already registers the LLM API as an external recipient of that content. The
decision must exist *before* the code, not after.

## 8. Traceability

| Item | Where |
|---|---|
| ST-06 acceptance clause | `docs/_generated/requirements-inventory.json` (NFR-13 / ST-06) |
| Open action this **documents** (does not yet close) | `ADRs/# ADR-007 Moderation LLM provider.md` → head-of-record open-action line and *Consequences → Negative — privacy* |
| Publication invariant preserved | `ADRs/# ADR-002 Content moderation.md` |
| Synthetic evaluation set | `ADRs/# ADR-008 Moderation evaluation set.md`, `tests/fixtures/moderation-eval/v1/` |
| Provider configuration (env only) | `src/config/schema.js`, `.env.example`, `src/adapters/llmModeration.js` |
| Encryption-at-rest counterpart of ST-06 | `README.md` → *Deployment — data at rest* |
| Test pinning both halves (recorded, not signed) | `tests/st-security/st-security-verify.test.js` → *"STS-W3-05 (round 2)"* |
| Verification finding that this clause is only half closed | `docs/_generated/verification-findings-wave3.json` → STS-R2-02 (round 2) |

**Why this file is not under `docs/results/`.** That directory is reserved by the build plan
(§U7-MODERATION-MEASURE / U7-PERF-SEC / U7-A11Y-UX) for wave-7 *measurement* outputs. This document
is a terms review, not a measurement, so it sits at `docs/`.

*Amended 2026-08-17.* This note previously said the directory did not exist and that
`tests/it-adapters/it01c-adapter-depth.test.js` asserted its absence. Both halves are now stale:
verification round 2 (findings MTUT-RV-02 / COV-11) replaced that directory-absence assertion —
it was an assertion over global repository state, and `mkdir -p docs/results` in
`package.json scan:zap:run` falsified it — with one scoped to a *moderation* results file. The
directory now holds LT-01 and ZAP outputs. The ADR-008 guard is unchanged in substance: no NFR-10
number may be claimed without a moderation result carrying a human label sign-off. The placement
rationale above stands on its own; it never depended on that assertion.
