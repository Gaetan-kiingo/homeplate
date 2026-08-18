# CI readiness for wave 3 — what is proven, and what only a push can prove

**Written:** 2026-08-18 · **Tree:** wave-3 close-out plus the 2026-08-18 team ratifications
**Deliverable of build-plan unit W3-CI-PUSH**, which was not produced by the verification run.

## The situation this replaces

Until this push, **CI had never executed a single line of wave 3.** `origin/main` ended at `af1a91a`
— waves 0–2 only, 28 suites, 611 tests. Everything wave 3 claims was measured on one developer
machine. That is the weakest form of evidence a project can offer at a design review, and it is
exactly the gap that the first wave 0–2 CI run closed by finding three defects a clean checkout
exposed and a local run could not.

## What was measured locally before pushing

CI runs `npm test -- --coverage`, which is **not** the command most local runs used. Coverage mode
was a recorded risk: the pre-repair report noted it reorders suites and had once reddened an ADR
assertion (W3-F1). So it was run explicitly, twice, plus once under the strict handle gate.

| Run | Command | Result |
|---|---|---|
| Coverage 1 | `npm test -- --coverage` | 71 suites / 1302 tests, **exit 0**, 97 s |
| Coverage 2 | `npm test -- --coverage` (back to back) | 71 suites / 1302 tests, **exit 0**, 98 s |
| Strict + coverage | `TEST_STRICT_HANDLES=1 npm test -- --coverage` | 71 suites / 1302 tests, **exit 0**, 96 s |

**Coverage totals:** statements **94.01 %** (3281/3490) · branches **84.00 %** (2064/2457) ·
functions **97.69 %** (550/563) · lines **94.80 %** (3123/3294).

**The W3-F1 coverage risk does not reproduce on this tree.** Coverage mode is green, deterministic
across two consecutive runs, and exits on its own.

**No leaked handle on a full run.** `globalTeardown`'s "still holding the event loop" warning appears
in **none** of the three runs above. It does still appear on some *subset* runs — a suite whose
handle another suite happens to close in a full run — so residual **R-1** stays open and the
backstop stays in place; it is simply not reached by the command CI executes.

## What changed in the workflow because of that

1. **`timeout-minutes: 25` on the job, `12` on the test step.** The failure mode being defended
   against is specific and was observed: Jest prints a green summary, then never exits. Without a
   timeout that occupies a runner until GitHub's 6-hour cap and then reports failure with a *passing*
   test summary sitting in the log — the most misleading possible outcome. The suite takes ~96 s, so
   these limits are generous while still failing fast and visibly.
2. **`TEST_STRICT_HANDLES=1` on the test step.** The verification report recommended turning this on
   so a future leak reddens the build instead of warning. It was safe to enable only because the
   strict run above passes; enabling it while a leak existed would have knowingly reddened CI.
3. **`--forceExit` remains banned.** It would make the symptom disappear by killing the process
   before reporters and coverage finish, hiding exactly what these two changes exist to surface.

## What a push proves that a local run cannot

- That every file the suite needs is **actually committed**. The first CI run on waves 0–2 caught an
  unanchored `coverage/` gitignore rule that had silently kept a whole 24-test lane out of every
  commit — invisible locally, because the file was on disk.
- That the run works **without developer-machine state**: no pre-existing database, no `.env`, no
  certificates (CI generates them), no globally installed tool.
- That `docker compose up -d --wait` brings PostgreSQL, Redis and MinIO up on a cold runner.
- That the toolchain resolves from `package-lock.json` on Node as pinned by `.nvmrc`.

## What CI still does not prove, and must not be read as proving

- **NFR-01 latency.** The k6 acceptance run (200 VUs, 749,234 requests, p95 250.8 ms) was executed
  locally and is recorded in `lt01-k6-summary.json`. CI does not run k6; a shared runner is not a
  latency measurement environment.
- **AB-06.** The ZAP baseline was run locally against a local instance. CI does not run it.
- **Anything requiring a deployment**: external TLS certificate validity (ST-01's chain/expiry half),
  NFR-09's 99 % availability over a demo window, backup expiry.
- **NFR-07 / UT-01.** No client exists to audit or study — see `docs/ut01-usability-study-plan.md`.

## Verdict

The workflow replays what was proven locally, with the same isolation and no masking flags, and it
now fails fast instead of hanging. Pushing is the right next step, and the run it triggers is the
first independent execution of wave 3 anywhere.
