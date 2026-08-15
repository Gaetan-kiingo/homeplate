# Wave 3 verification — handoff (paused 2026-08-14)

The wave-3 verification run was **stopped deliberately after repair round 1**, before re-verification.
This note is the restart point. Nothing here is independently re-verified — read the status honestly.

## Where things stand

| Gate | Result (measured 2026-08-14, clean machine) |
|---|---|
| `npm test` | **60 suites / 1182 tests pass**, 91 s |
| `npm run lint` | clean (eslint + prettier) |
| `npm run build` | clean |

Wave 3 itself (listings, bookings, search, hosts/media) was committed green at `3136b91`.
This commit adds repair-round-1 fixes on top of it.

## What the verification found

8 lanes ran 264 checks and produced **40 findings** (3 blockers, ~12 majors).
The full machine-readable set — every check, every finding with its reproduction and proposed
fix, plus each fixer's report — is in `docs/_generated/verification-findings-wave3.json`.

Fixers claimed **30 of 40 resolved**, with 5 partial disputes (fixers pushed back on the wording or
root-cause attribution of a finding, not its substance — see `fixerReports[].rejected`).

The single most important one, now fixed: **TCB-W3-01 (blocker)** — FR-10 email verification was
unmeetable in production. The outbox payload carried only the token's SHA-256 digest, so the
delivered email contained a hash, not a link, and no user could ever verify their email — therefore
nobody could ever become eligible to book or publish. Waves 1–2 reported FR-10 as PASS because the
tests exercised the token via the in-process return value, never through the delivered email. The
fix mints the deliverable link worker-side (`resolveRenderContext`) so the outbox payload stays
IDs-only per ADR-003.

Also fixed this round: production config accepting the committed sample `FIELD_ENCRYPTION_KEY` and
`minioadmin` credentials (STS-W3-02); the media route constructing an S3 client on the request path
(W3-ADR-01); `NODE_ENV=test` not pinning adapters to mock (W3-ADR-02); booking promotion not
rescheduling when a listing moves earlier (TCB-W3-02); no notification on `pending -> in_progress`
(TCB-W3-03); outbox template ids missing from the SendGrid registry (TCB-W3-04).

## What is NOT done

1. **No re-verification.** The 30 "resolved" claims are the fixers' own word plus a green suite.
   No independent lane has confirmed the original failure scenarios no longer reproduce.
2. **~10 findings were never repaired** — the run was stopped mid-batch. Diff the `findings` ids
   against the `claimedResolved` set in the JSON to get the exact remainder.
3. **`docs/verification-report.md` is mid-rewrite.** Its header says waves 0–3 and commit `3136b91`,
   but it was produced before repair round 1 landed and the Report phase never ran. Treat its
   contents as a draft, not evidence, until a report agent regenerates it.
4. **ADR-009 was amended by an agent** and needs human ratification: it now records the weekly MEHKO
   window shape as an OPEN sub-decision (Monday-anchored calendar week, which the code implements,
   versus a rolling 7-day window). Under the implemented reading a host can serve 120 meals inside a
   7-day span. No AB 626 weekly-compliance claim may be made until the team ratifies one reading.

## How to restart

Run a fresh verification (the previous run's cache is session-scoped and will not survive):

```
Workflow homeplate-build with args as a JSON OBJECT:
{"mode":"verify","model":"opus","maxRepairRounds":1,
 "focus":"<point at docs/_generated/verification-findings-wave3.json; confirm the 30 claimed
           resolutions by re-running each original failure scenario, then repair the remainder>"}
```

Gotchas that cost time last run:

- **Args must be a JSON object.** A bare `mode=verify model=opus` string is swallowed whole into
  `focus`, silently leaving mode `full` and model `fable` — and a Fable usage limit kills the run.
- **`maxRepairRounds` controls the shape.** Repair batches run *sequentially*, at most 4 fixers per
  batch, and round 1 actions minor findings too. 40 findings became ~29 fixers in ~8 sequential
  batches — about 6 hours. Round 2 only actions blockers/majors.
- **Killing the workflow leaves orphaned jest and worker processes** that saturate the CPU and make
  the suite look hung. After any stop: `pkill -f "node_modules/.bin/jest"; pkill -f
  "homeplate/scripts/worker.js"`.
- **Parallel lanes must set `TEST_DATABASE_URL`, `TEST_REDIS_URL` *and* `OBJECT_STORAGE_BUCKET`.**
  RTLT-01 found a lane's `FLUSHDB` wiping a sibling's live sessions because only the database was
  isolated, not Redis.
- The suite emits one `Jest did not exit` open-handle warning; a test leaks a handle. Harmless so
  far but it is a plausible cause of a future hang.
