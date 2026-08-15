# Security scans — AB-06 / NFR-11 / ST-04

AB-06 (SRS §3.5, injection attacks) is accepted when the ST-04 payload suite passes **and**
"an OWASP ZAP baseline scan against the running app reports no high-risk alerts". Two guards,
two cadences:

| Guard | What it is | When it runs | Owner |
| --- | --- | --- | --- |
| ST-04 payload suite | `tests/st-security/*` — SQLi/XSS vectors at every input boundary, plus the static "no concatenated SQL" scan | every push (`.github/workflows/ci.yml` → `npm test`) | automated |
| OWASP ZAP baseline | external scanner against a running instance | on demand: `npm run scan:zap`, or the **ZAP baseline (AB-06)** workflow | opt-in, closed out in wave 7 |

ZAP is deliberately **not** in `ci.yml`: it needs a booted stack, pulls a 3.6 GB image and takes
minutes, and it adds no signal that the ST-04 lane does not already give on a per-commit basis.
It is a measurement, like IT-03 and LT-01/LT-02 — run it, record it, cite it.

**What the baseline scan can and cannot see right now.** The baseline is a *passive* scan of what
the spider can reach: it never fires an attack payload (that is ST-04's job, and only ST-04 knows
how to authenticate, reserve a seat or post a review). Until the React client lands in waves 5–6
the only surface is the JSON API, whose `/` returns 404, so the spider crawls almost nothing and
the result is essentially a header/TLS/cookie review. Treat a green wave-3 run as a regression
guard, not as evidence for AB-06; the close-out run in wave 7 must target the served client so
the spider has pages to walk.

## Running it locally

Prerequisites: Docker (the scanner is a container — nothing is installed on the host), and the
app running over HTTPS.

```sh
docker compose up -d --wait     # PostgreSQL, Redis, MinIO
npm run migrate && npm run seed
npm run dev                     # API + outbox worker on https://localhost:3000  (leave running)

# in a second shell, from the repository root:
npm run scan:zap
```

`npm run scan:zap` is `scan:zap:run` (the scan) followed by `scan:zap:report` (the AB-06 gate),
and the gate decides the exit status:

- `scan:zap:run` — runs `zap-baseline.py` from `ghcr.io/zaproxy/zaproxy:stable`, mounting
  `docs/results/` as the container's `/zap/wrk`, and writes `zap-baseline.html`,
  `zap-baseline.md` and `zap-baseline.json` there (plus `zap.yaml`, the automation plan ZAP
  generates for itself — not an artifact to commit). `-I` stops WARN-level passive rules from
  failing the run; the HTML report still lists them.
- `scan:zap:report` — parses `zap-baseline.json`, prints the alert count per risk level, and
  **exits 1 if any alert is High** (`riskcode >= 3`), naming the alert and the first URLs it
  fired on. A missing report is also an exit 1: a scan that never reached the app must never be
  read as a pass.

Overrides (all optional environment variables):

| Variable | Default | Use |
| --- | --- | --- |
| `ZAP_TARGET_URL` | `https://host.docker.internal:3000` | scan a different host/port, e.g. a deployed instance |
| `ZAP_SPIDER_MINUTES` | `3` | spider budget; raise once the React client (waves 5–6) adds crawlable pages |
| `ZAP_REPORT_JSON` | `docs/results/zap-baseline.json` | gate an archived report instead of the latest run |

### Why `host.docker.internal` and not `--network host`

The scanner runs in a container while the app runs on your machine. `--network host` is a Linux
Docker feature and does not reach the host's `localhost` on Docker Desktop for macOS, so the
scan command instead passes `--add-host=host.docker.internal:host-gateway` and targets
`https://host.docker.internal:3000` — one command that works on macOS, Linux and the GitHub
runner. If you point `ZAP_TARGET_URL` at `localhost`, it resolves to the *container*, not the app.

### The dev certificate is self-signed

`scripts/gen-dev-certs.sh` issues a self-signed certificate (NFR-03 forbids a plain-HTTP
listener, so there is no http:// target to scan instead). The scan therefore passes
`-z "-config certificate.allowUnsafeSslRenegotiation=true"`. ZAP is a proxy and does not reject a
self-signed server certificate today; if a future release does, append the relevant
`-config network.…` keys from its network add-on to the same `-z` string, or point the scan at a
host holding a real certificate — do **not** switch the target to http://, and do not set
`ENFORCE_HTTPS=false` to make the scan easier: that would scan a configuration the product never
ships (NFR-03, AB-05).

### Report files are written by the container

`scan:zap:run` runs `chmod -R a+w docs/results` before the scan. The ZAP image runs as uid 1000,
which is usually not your uid, and the container cannot write its report into a directory owned
by someone else — this is the workaround the ZAP Docker documentation prescribes. It touches
only `docs/results/`, which holds measurement artifacts and nothing else.

## Running it in CI

Actions → **ZAP baseline (AB-06)** → *Run workflow* (`.github/workflows/zap-baseline.yml`,
`workflow_dispatch` only). The job boots infrastructure, migrates, seeds, starts the app from
`.env.example` defaults with mock adapters (ADR-007 / ADR-011 — no secret, no third-party call),
runs the same two npm scripts, and uploads `docs/results/zap-baseline.*` plus the server log as
an artifact. The job fails only on High-risk alerts.

## Closing AB-06 (wave 7, U7-PERF-SEC)

A ZAP result is not evidence until it is written down. Commit under `docs/results/`:

1. `zap-baseline.html` (or `.md`) from the run, and
2. a note recording **date, commit SHA, target URL, ZAP image digest, and the alert table by
   risk level**, plus a triage line for every Medium/Low alert stating fixed / accepted-with-reason.

Then cite that file from the AB-06 and NFR-11 rows of `docs/verification-report.md`. Until such a
run exists, those rows must say the ZAP clause is **not yet measured** — the in-suite ST-04 lane
passing is not the same claim.

Tooling status: this procedure was executed once end to end on 2026-08-14 (macOS/arm64, Docker
28.4, image digest `sha256:781a2bd…`, wave-3 tree) purely to prove the command, the container→host
route and the gate work — the container reached the HTTPS listener, wrote its three reports and
the gate reported 0 High. No artifact from that run is committed and **no AB-06 claim follows from
it**: it scanned the API-only wave-3 surface, and only a recorded wave-7 run closes the clause.
