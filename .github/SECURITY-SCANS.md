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

**What the baseline scan can and cannot see right now.** The baseline is *passive*: it never
fires an attack payload (that is ST-04's job, and only ST-04 knows how to authenticate, reserve a
seat or post a review). It reports on the responses it is given — security headers, cookie flags,
cache directives, information disclosure, error-envelope leakage.

The responses it is given are **not** discovered by crawling. Homeplate v1.0 is a JSON API whose
`/` returns 404 and whose client bundle does not exist until waves 5–6 (SRS §2.1.2), so a spider
has no link to follow: a stock `zap-baseline.py` run against this app crawls one 404 and then
reports "no high-risk alerts" having tested nothing (verification finding STS-R2-03). The scan is
therefore driven by **`.github/zap/baseline-plan.yaml`**, a ZAP automation plan whose `requestor`
job walks the wave-0..3 route registry endpoint by endpoint. The spider job is still in the plan,
after it, so the crawl starts contributing automatically once waves 5–6 give it pages.

> **A baseline whose report covers a single URL is not an AB-06 pass and must never be recorded
> as one.** It says the scanner started, not that the application was examined. The plan exports
> every URL it actually requested to `docs/results/zap-baseline-urls.txt`, and
> `npm run scan:zap:report` **exits 1** when the distinct count is below `ZAP_MIN_URLS`
> (default 8; a wave-3 run reaches ~24), whatever the alert table says.

Even so, a green wave-3 run is a *regression guard*, not the AB-06 close-out: every request it
makes is anonymous, so nothing behind a session — a listing detail, a booking, a moderator queue
page — has been passively scanned yet. The wave-7 close-out run must target the served client, and
should add an authenticated context so the post-login surface is covered too.

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

- `scan:zap:run` — runs `ghcr.io/zaproxy/zaproxy:stable` in `zap.sh -cmd -autorun` mode over
  `.github/zap/baseline-plan.yaml` (mounted read-only at `/zap/plan`), with `docs/results/`
  mounted as the container's `/zap/wrk`. It writes four artifacts there:
  `zap-baseline.html` / `.md` / `.json` (the alert reports), `zap-baseline-urls.txt` (every URL
  requested — the coverage evidence) and `zap-baseline-summary.json` (the per-rule
  PASS/WARN/FAIL summary that reproduces the packaged-scan output line).
- `scan:zap:report` — parses `zap-baseline.json`, prints the alert count per risk level and the
  distinct-URL count, and **exits 1** when either gate trips:
  - **any alert is High** (`riskcode >= 3`) — the alert and the first URLs it fired on are named;
  - **fewer than `ZAP_MIN_URLS` distinct URLs were scanned** — see the callout above.

  A missing report is also an exit 1: a scan that never reached the app must never be read as a
  pass. When no `-urls.txt` sits next to the JSON (an archived pre-2026-08-18 report), the count
  falls back to the distinct URIs in the alert instances, which is why the old one-URL report
  fails this gate rather than silently passing it.

Overrides (all optional environment variables):

| Variable | Default | Use |
| --- | --- | --- |
| `ZAP_TARGET_URL` | `https://host.docker.internal:3000` | scan a different host/port, e.g. a deployed instance |
| `ZAP_REPORT_JSON` | `docs/results/zap-baseline.json` | gate an archived report instead of the latest run |
| `ZAP_URL_LIST` | `<ZAP_REPORT_JSON>` with `.json` → `-urls.txt` | coverage evidence for that report |
| `ZAP_MIN_URLS` | `8` | distinct-URL floor below which no AB-06 pass may be claimed |

The spider budget is **not** an environment variable: the automation framework substitutes env
vars into string values only and rejects the plan when an integer field holds one. Raise
`jobs[spider].maxDuration` in `.github/zap/baseline-plan.yaml` when waves 5–6 give the crawl
something to walk.

### Adding an endpoint to the scan

New route in `src/routes/index.js` or a `src/modules/<name>/routes.js`? Add a matching entry to
the `requestor` job in `.github/zap/baseline-plan.yaml` — url, method, and the `responseCode` an
anonymous caller should get (401 for anything behind `requireSession`). The expected code is an
assertion: a route that moves or stops being mounted makes the run report a plan error instead
of quietly shrinking the scanned surface.

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

1. `zap-baseline.html` (or `.md`) from the run, **and `zap-baseline-urls.txt`** — the alert table
   without the URL list is an unfalsifiable claim, and
2. a note recording **date, commit SHA, target URL, ZAP image digest, the alert table by risk
   level, and the distinct-URL count**, plus a triage line for every Medium/Low alert stating
   fixed / accepted-with-reason.

Then cite that file from the AB-06 and NFR-11 rows of `docs/verification-report.md`. Until such a
run exists, those rows must say the ZAP clause is **not yet measured** — the in-suite ST-04 lane
passing is not the same claim.

Tooling status: executed end to end on 2026-08-18 against the wave-3 tree (macOS/arm64, Docker
28.4, ZAP 2.17.0, image digest `sha256:781a2bd…`) — 24 distinct URLs scanned, 0 High / 0 Medium /
0 Low / 3 Informational, gate exit 0. The run record is `docs/results/zap-baseline-RUN.md`. That
proves the command, the container→host route, the requestor surface and both gates work; it is
**not** the AB-06 close-out, because every request in it is anonymous and the client does not
exist yet. Only a recorded wave-7 run over the served client closes the clause.
