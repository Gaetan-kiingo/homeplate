# `tests/fixtures/moderation-eval/`

The ADR-008 moderation evaluation set — the labelled corpus IT-03 (SRS §4.2) scores through the
FR-08 pipeline to measure NFR-10 (false-positive and false-negative rates each below 5%).

```
moderation-eval/
├── index.js               loader · validator · scorer · NFR-10 claim gate
├── set-integrity.test.js  proves the set and the gate hold (runs in `npm test`)
└── v1/
    ├── MANIFEST.md        provenance, taxonomy, label policy, sign-off block  ← read this first
    ├── manifest.json      the same facts, machine-readable
    └── items/{offensive,spam,fraudulent,benign}.json   56 items each, 224 total
```

**Versioning.** A set directory is immutable once an IT-03 result has been recorded against it. A
revision is a new directory (`v2/`), so every result names the exact corpus it measured.

**Using it.**

```js
const evalSet = require('../fixtures/moderation-eval');

const set = evalSet.assertValidSet(evalSet.loadSet('v1'));
const predictions = set.items.map((item) => ({ id: item.id, category: classify(item.text) }));
const result = evalSet.score(set, predictions);
// result.falsePositiveRate, result.falseNegativeRate, result.confusion, result.withinBound

const verdict = evalSet.claimability({ set, modelId, promptVersion });
// verdict.claimable === false  ->  the numbers are PROVISIONAL and NFR-10 stays open
```

**Two gates stand between a number and an NFR-10 pass**, and `claimability()` enforces both:

1. **ADR-008 — human label sign-off.** The labels here were drafted with AI assistance. Until a
   team member reviews them and records reviewer, date and set version in `manifest.json →
   labelReview` and in the results file, any run reports provisional numbers only.
2. **ADR-007 — a live model id.** CI and the whole automated suite run the deterministic mock
   classifier, which is a fixed fixture-pattern matcher, not a classifier: it returns
   `benign / 0.99` for any text its patterns do not cover. Rates measured through it are
   meaningless, so a mock model id is rejected outright.

**Current state:** unreviewed, no `v1/RESULTS.md`, and the FR-08 pipeline itself is wave-4 work. No
false-positive or false-negative number may be quoted for NFR-10 today.
