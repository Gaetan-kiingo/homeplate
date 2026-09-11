# IT-03 results — NFR-10 moderation accuracy, set v1 (live run)

**Run date:** 2026-09-11 · **Model id:** `gemini-3.5-flash-lite` · **Prompt version:** `moderation-prompt-v1` ·
**Set:** v1 (224 items) · **Mode:** live (ADR-007; the mock is never a measurement)

Produced by `scripts/it03-eval.js` `runEval` through the real FR-08 pipeline order (deterministic
pre-filter first, live classifier second) against the ADR-008 set. Raw report: `it03-live-run.json`
in this directory. Every number below is copied from that report by `write-results.py`, not typed.

## Verdict

**At least one rate is at or above the 0.05 bound, or the run is not claimable: NFR-10 is NOT met. The number is recorded; it is not a pass.**

| Metric | Value | Bound |
|---|---|---|
| False-positive rate (benign scored as violating) | **7.14 %** (4 of 56 benign) | < 5 % |
| False-negative rate (violating scored as benign) | **1.19 %** (2 of 168 violating) | < 5 % |
| Misrouted (violating, wrong violating class) | 4 | informational |
| Accuracy (exact class) | 95.54 % | informational |
| Items answered by the pre-filter / by the LLM | 2 / 222 | — |

## Per class

| Expected class | Items | Correct | Precision | Recall |
|---|---|---|---|---|
| offensive | 56 | 56 | 0.966 | 1.000 |
| spam | 56 | 56 | 0.949 | 1.000 |
| fraudulent | 56 | 50 | 0.943 | 0.893 |
| benign | 56 | 52 | 0.963 | 0.929 |

## Confusion (rows = expected, columns = predicted)

| | offensive | spam | fraudulent | benign |
|---|---|---|---|---|
| **offensive** | 56 | 0 | 0 | 0 |
| **spam** | 0 | 56 | 0 | 0 |
| **fraudulent** | 1 | 3 | 50 | 2 |
| **benign** | 1 | 0 | 3 | 52 |

## ADR-008 label sign-off (copied from `manifest.json`)

Reviewer **Gaetan Rieben**, date **2026-08-21**, set version **v1**. The labels as
measured are immutable from this run on; a correction is a new set version `v2/`.

## Claimability

`claimable: true`

## Failing items (from the run cache, by item id)

| Kind | Item | Expected → predicted (confidence) | Why it matters |
|---|---|---|---|
| FP | ben-004 | benign → fraudulent (0.95) | Host asks for cash; the app has no payments, so this is benign by the ADR-008 boundary, "off-platform payment" by the prompt's fraud clause. |
| FP | ben-021 | benign → fraudulent (0.89) | Same boundary. |
| FP | ben-052 | benign → fraudulent (0.95) | A guest warning others about a scam: reporting fraud is not fraud. |
| FP | ben-055 | benign → offensive (0.95) | A review describing insults it received: reporting abuse is not abuse. |
| FN | fraud-015 | fraudulent → benign (0.85) | Request for a third party's emergency-contact number; 0.85 is above the 0.8 routing threshold, so it would publish unreviewed. |
| FN | fraud-041 | fraudulent → benign (0.85) | Admits the kitchen photos are a hotel's; same threshold consequence. |
| misrouted | fraud-009, fraud-010, fraud-021, fraud-035 | fraudulent → offensive / spam | Still routed to the human queue; wrong class only. |

**Team decision required (not made here):** the prompt's "attempts to move payment off the
platform" clause contradicts the label set for a product with no payment feature. Resolve by a new
`PROMPT_VERSION` and a fresh run, or by a label set `v2/`; never by editing v1.

## Second model, measured in parallel (supplementary, not the record)

`gemini-3.1-flash-lite`, same set, prompt and pipeline, started 15:08 UTC and finished 16:46 UTC
(raw report `it03-live-run-second-model.json`): **FP 5.36 % (3/56), FN 0.60 % (1/168)**, misrouted 1,
accuracy 97.77 %, `withinBound: false`. It failed on the same cash-payment items (ben-004, ben-021,
ben-052), which is why the false positives are read as a prompt/label boundary rather than model
noise. The record above is the run that completed first; it was chosen as the record before either
result was known.

## Provenance and limits

- One live run, as ADR-007 sanctions; the automated suite still pins the mock under `NODE_ENV=test`.
- The set is synthetic and team-authored (NFR-13); no user content was sent to the provider.
- The per-attempt HTTP budget for this run was raised to 90 s from the worker's 3 s default
  because the model reasons before answering; pipeline, prompt, temperature (0) and JSON
  response mode are the production adapter's own.
- Model availability on the provider's free tier changes over time; the exact model id above is
  what this number is valid for. A different model or prompt version needs a new run.
- The model was chosen during the run, not beforehand: `gemini-2.5-flash` (planned) is retired for
  new keys, and `gemini-3.5-flash` stopped at item 13 on the free tier's 20-requests-per-day cap.
  The lite models were the ones the key could complete 224 items on today.
- Operational finding: the worker's shipped `ADAPTER_TIMEOUT_MS=3000` is far below the 4–47 s the
  provider took per answer under load; a live worker would time out every scan.

## Machine-readable record

```json
{
  "testId": "IT-03",
  "requirement": "NFR-10",
  "setVersion": "v1",
  "modelId": "gemini-3.5-flash-lite",
  "promptVersion": "moderation-prompt-v1",
  "runDate": "2026-09-11",
  "itemCount": 224,
  "prefilterBlocked": 2,
  "classified": 222,
  "perClassCounts": {
    "offensive": 56,
    "spam": 56,
    "fraudulent": 56,
    "benign": 56
  },
  "falsePositives": 4,
  "falsePositiveRate": 0.07142857142857142,
  "falseNegatives": 2,
  "falseNegativeRate": 0.011904761904761904,
  "misrouted": 4,
  "accuracy": 0.9553571428571429,
  "maxRate": 0.05,
  "withinBound": false,
  "claimable": true,
  "labelReview": {
    "reviewer": "Gaetan Rieben",
    "date": "2026-08-21",
    "setVersion": "v1"
  }
}
```
