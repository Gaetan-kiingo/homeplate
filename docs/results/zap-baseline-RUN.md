# AB-06 — OWASP ZAP baseline scan, run record

Provenance for `zap-baseline.html` / `.json` / `.md`, `zap-baseline-urls.txt` and
`zap-baseline-summary.json` in this directory. Procedure: `.github/SECURITY-SCANS.md`.
Scan definition: `.github/zap/baseline-plan.yaml`.

| Field | Value |
|---|---|
| Date run | 2026-08-18 02:18 UTC |
| Tree | wave-3 close-out re-verification, base commit `bc27199` + uncommitted repair-round-1/round-2 working tree |
| Scanner | `ghcr.io/zaproxy/zaproxy:stable`, ZAP **2.17.0**, image digest `sha256:781a2bdaea47324e7bab583e2263f21d257b0aee61ed51521a5be45f5f5081ef` |
| Command | `npm run scan:zap:run` → `zap.sh -cmd -autorun /zap/plan/baseline-plan.yaml -config certificate.allowUnsafeSslRenegotiation=true` |
| Target | `src/server.js` over HTTPS (TLS ≥ 1.2, dev certificate) on `https://host.docker.internal:8543`, `NODE_ENV=development`, all adapters in mock mode (ADR-007 / ADR-011), dedicated PostgreSQL database `zap_scan_r2`, Redis index 14 and bucket `homeplate-zapscan` so no other lane's state was touched |
| Gate | `npm run scan:zap:report` — exit **0** |

## Result

```
FAIL-NEW: 0   FAIL-INPROG: 0   WARN-NEW: 3   WARN-INPROG: 0   INFO: 0   IGNORE: 0   PASS: 58
```

```
AB-06 / NFR-11 / ST-04 — OWASP ZAP baseline alert table (docs/results/zap-baseline.json)
  High: 0
  Medium: 0
  Low: 0
  Informational: 3
  URLs scanned: 24 distinct (source: docs/results/zap-baseline-urls.txt; AB-06 coverage floor ZAP_MIN_URLS=8)
PASS: no high-risk alerts across 24 scanned URLs.
```

| Risk | Alert | Instances |
|---|---|---|
| **High** | — | **0** |
| Medium | — | 0 |
| Low | — | 0 |
| Informational | Authentication Request Identified `[10111]` | `POST /api/auth/login` |
| Informational | Information Disclosure - Sensitive Information in URL `[10024]` | `GET /api/auth/verify-email?token=…` |
| Informational | Re-examine Cache-control Directives `[10015]` | `GET /health` |

### Triage of the three Informational alerts

- **`[10111]` Authentication Request Identified** — not a defect. ZAP tags the request it
  recognises as a login so later scans can authenticate. No action.
- **`[10024]` Sensitive Information in URL** — real, and **accepted with reason**. FR-10 delivers
  a clickable verification link, so `GET /api/auth/verify-email?token=…` necessarily carries the
  token in the query string; `POST /api/auth/verify-email` exists for callers that can avoid it.
  The token is single-use and expires after `EMAIL_TOKEN_TTL_HOURS` (24), and the structured
  request log records `path` without the query string — verified in this run's server log, which
  shows `"path":"/api/auth/verify-email"` and no token. The residual exposure is intermediary and
  browser-history logging of the link itself. Re-triage in wave 7 against the deployed
  reverse-proxy access-log configuration, which is where a token could still be written down.
- **`[10015]` Re-examine Cache-control Directives** — accepted. `/health` returns
  `{"status":"ok"}` with no personal data and no caching directives; nothing to protect.

## Coverage — what this run did and did not examine

24 distinct URLs, listed in `zap-baseline-urls.txt`: every wave-0..3 endpoint in the route
registry (auth, users, listings, search, hosts, bookings, media, safety) plus `/health`, an
unknown path, `/robots.txt` and a deliberate 405. The scan is driven by the `requestor` job in
`.github/zap/baseline-plan.yaml` rather than by the spider, because Homeplate is a JSON API with
no HTML at `/` and no client bundle until waves 5–6 (SRS §2.1.2) — the spider job that follows it
still reports `status code returned : 404 expected 200` on the root, which is expected and is not
a defect. The spider begins contributing when the React client ships.

**Limits, stated so nobody reads more into this than it holds:**

1. **Every request is anonymous.** Nothing behind a session — a listing detail, a booking, a host
   profile, the moderator alert queue — has been passively scanned. What ZAP saw of those routes
   is the 401 envelope. The wave-7 close-out run needs an authenticated context.
2. **A baseline fires no payloads.** SQLi/XSS coverage is the in-suite ST-04 lane
   (`tests/st-security/`), which authenticates, reserves seats and posts content. ZAP baseline is
   corroboration on headers, cookies, caching and information disclosure — not an attack.
3. **This is not the AB-06 close-out.** AB-06 closes in wave 7 (U7-PERF-SEC) with a recorded run
   against the served client. Until then the AB-06 / NFR-11 rows of `docs/verification-report.md`
   cite this file as evidence that the ZAP clause has been *exercised and is clean at wave 3*,
   not as evidence that it is closed.

## Supersedes the 2026-08-14 / 2026-08-18-early run (verification finding STS-R2-03)

An earlier record in this file described a `zap-baseline.py` run that reported
`WARN-NEW: 1 … PASS: 66` and `High 0` — but whose every alert instance resolved to the single URL
`https://host.docker.internal:8443`, the 404 root. 66 passive rules had run against one 404
response. The alert numbers were true and the conclusion drawn from them was not: the scan had
not examined the API at all.

Fixed at the cause, not by annotating the report:

- `.github/zap/baseline-plan.yaml` replaces spider discovery with an explicit endpoint list, so
  the passive rules run against real API responses. Each entry asserts the status code an
  anonymous caller should get, so a route that moves or stops being mounted surfaces as a plan
  error instead of quietly shrinking the scanned surface.
- The plan exports every requested URL to `zap-baseline-urls.txt`, and `npm run scan:zap:report`
  now **exits 1 when fewer than `ZAP_MIN_URLS` (default 8) distinct URLs were scanned**, whatever
  the alert table says. Re-run against the archived one-URL report, that gate exits 1 with
  `FAIL: AB-06 coverage — this scan reached only 1 URL(s)`; against this run it exits 0 with 24.
- `.github/SECURITY-SCANS.md` states the rule directly: a baseline whose report covers a single
  URL is not an AB-06 pass and must never be recorded as one.
