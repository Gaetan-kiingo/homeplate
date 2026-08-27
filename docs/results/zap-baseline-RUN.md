# AB-06 — OWASP ZAP baseline scan, run record

Provenance for `zap-baseline.html` / `.json` / `.md`, `zap-baseline-urls.txt` and
`zap-baseline-summary.json` in this directory. Procedure: `.github/SECURITY-SCANS.md`.
Scan definition: `.github/zap/baseline-plan.yaml`.

| Field | Value |
|---|---|
| Date run | 2026-08-27 00:24 UTC |
| Tree | wave-6 verification/repair round, base commit `e8a610d` + uncommitted wave-6 working tree (the four `client/src/features/*` units and wave-6 test/doc changes) |
| Scanner | `ghcr.io/zaproxy/zaproxy:stable`, ZAP **2.17.0**, image digest `sha256:781a2bdaea47324e7bab583e2263f21d257b0aee61ed51521a5be45f5f5081ef` |
| Command | `ZAP_TARGET_URL=https://host.docker.internal:4173 npm run scan:zap` |
| Target | The **served client**: the wave-6 production build (`client/dist/`, current — no `client/src` file newer than it) served by `vite preview` over HTTPS (TLS ≥ 1.2, dev certificate) on `https://host.docker.internal:4173`, with `/api` proxied certificate-verified (`VITE_API_PROXY_TARGET`) to `src/server.js` on `https://localhost:8543`. `NODE_ENV=development`, all adapters in mock mode (ADR-007 / ADR-011), dedicated PostgreSQL database `zap_scan_w6`, Redis index 14 and bucket `homeplate-zapscan` (all migrated/seeded for the run and dropped after it) so no other lane's state was touched |
| Gate | `npm run scan:zap:report` — exit **0** |

## Result

```
FAIL-NEW: 0   FAIL-INPROG: 0   WARN-NEW: 8   WARN-INPROG: 0   INFO: 0   IGNORE: 0   PASS: 53
```

```
AB-06 / NFR-11 / ST-04 — OWASP ZAP baseline alert table (docs/results/zap-baseline.json)
  High: 0
  Medium: 2
  Low: 2
  Informational: 4
  URLs scanned: 30 distinct (source: docs/results/zap-baseline-urls.txt; AB-06 coverage floor ZAP_MIN_URLS=8)
PASS: no high-risk alerts across 30 scanned URLs.
```

| Risk | Alert | Instances |
|---|---|---|
| **High** | — | **0** |
| Medium | Content Security Policy (CSP) Header Not Set `[10038]` | 5 × preview-served documents (`/`, SPA-fallback pages) |
| Medium | Missing Anti-clickjacking Header `[10020]` | 5 × preview-served documents |
| Low | Strict-Transport-Security Header Not Set `[10035]` | 5 × preview-served documents |
| Low | X-Content-Type-Options Header Missing `[10021]` | 5 × preview-served documents + hashed CSS asset |
| Informational | Authentication Request Identified `[10111]` | `POST /api/auth/login` |
| Informational | Information Disclosure - Sensitive Information in URL `[10024]` | `GET /api/auth/verify-email?token=…` |
| Informational | Modern Web Application `[10109]` | 5 × preview-served documents |
| Informational | Re-examine Cache-control Directives `[10015]` | 5 × preview-served documents |

### Triage — every Medium/Low, fixed or accepted with reason (per .github/SECURITY-SCANS.md)

All four Medium/Low alerts are the **same finding four ways**: the `vite preview` static file
server — the scan scaffold standing in for a production edge that does not exist in this
free-tier repository yet — sends none of the four standard security headers on the documents
and assets it serves. Not one instance is on an `/api/*` response: the Express API behind the
proxy sends all four on every response (verified by inspection during this run —
`Content-Security-Policy: default-src 'none';frame-ancestors 'none'`,
`Strict-Transport-Security: max-age=15552000; includeSubDomains`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` — which is why the wave-3
API-direct run below reported 0 Medium / 0 Low and why these rules PASS against the 30
requestor URLs).

- **`[10038]` CSP Header Not Set** (Medium) — **accepted with reason**: property of the
  `vite preview` tooling server, not of repo-owned code; no repo source serves the client
  (`src/app.js` has no static handler by design). **Deployment follow-up, wave-7 close-out:**
  whatever host serves `client/dist/` in the real deployment must send a CSP for the
  document, and that edge must be re-scanned before AB-06's deployment story is final.
- **`[10020]` Missing Anti-clickjacking Header** (Medium) — **accepted with reason**: same
  scope, same owner, same follow-up. The API itself refuses framing twice over
  (`X-Frame-Options: DENY` + `frame-ancestors 'none'`).
- **`[10035]` Strict-Transport-Security Header Not Set** (Low) — **accepted with reason**:
  same scope. HTTPS-only is enforced on both listeners (NFR-03: neither serves plain HTTP);
  HSTS on the client edge is part of the same deployment follow-up.
- **`[10021]` X-Content-Type-Options Header Missing** (Low) — **accepted with reason**: same
  scope, plus the hashed same-origin CSS asset, which `vite preview` serves with the correct
  `Content-Type`; sniffing exposure is minimal and the header belongs on the real edge.
- **`[10111]` Authentication Request Identified** (Informational) — not a defect. ZAP tags the
  request it recognises as a login so later scans can authenticate. No action.
- **`[10024]` Sensitive Information in URL** (Informational) — real, and **accepted with
  reason**, unchanged from the wave-3 record: FR-10 delivers a clickable verification link, so
  `GET /api/auth/verify-email?token=…` necessarily carries the token in the query string;
  `POST /api/auth/verify-email` exists for callers that can avoid it. The token is single-use,
  expires after `EMAIL_TOKEN_TTL_HOURS` (24), and the structured request log records `path`
  without the query string. Re-triage at deployment against the reverse-proxy access-log
  configuration.
- **`[10109]` Modern Web Application** (Informational) — ZAP recognising the responses as an
  SPA. No action; it is corroboration that the crawl saw the client, not the 404 shim.
- **`[10015]` Re-examine Cache-control Directives** (Informational) — accepted. The preview
  server sends `Cache-Control: no-cache` on the HTML shell, which is the correct choice for an
  SPA entry document; long-lived caching for the hashed immutable assets is an edge concern.

## Coverage — what this run did and did not examine

`zap-baseline-urls.txt` carries **30 distinct URLs** — the full requestor floor, grown from the
wave-3 run's 24 by the wave-4 surfaces the plan added (review create, message send/list,
moderation queue + decision, account delete, export request/fetch). Every `/api/*` entry went
through the served client's own `/api` proxy — the exact origin a browser using the app talks
to — and **every API status-code assertion held** (401/422/202/200 exactly as the plan
declares).

On top of that floor, the crawl contributed for the first time: the spider fetched the root
document and reported **46 in-context URLs found**, and the passive rules demonstrably ran
against the rendered client surface — the alert instances in `zap-baseline.json` name `GET /`
(the app shell), the SPA-fallback documents (`/health`, `/robots.txt`, `/sitemap.xml`,
`/this-path-does-not-exist` as served HTML), and the hashed asset
`/assets/index-BPuO7LYm.css`. Those crawl requests appear in the alert instances rather than in
`zap-baseline-urls.txt` (the export job snapshots the requestor history); the gate's 30-URL
count is therefore the floor, not the ceiling, of what was examined.

Three requestor assertions logged mismatches, all explained by the SPA history fallback at the
preview origin and none a defect: `POST /health` → 404 (static server, no such handler here —
the 405 lives on the API origin), `GET /this-path-does-not-exist` → 200 and `GET /robots.txt`
→ 200 (both the app shell, which is how an SPA answers unknown paths). The plan records them
as warnings by design (`failOnError: false` — information, not a gate).

**Limits, stated so nobody reads more into this than it holds:**

1. **Every request is anonymous.** Nothing behind a session — a listing detail with an exact
   address, a booking, the moderator queue — was passively scanned beyond its 401 envelope.
   `.github/SECURITY-SCANS.md` marks an authenticated context as a *should* for the wave-7
   close-out; it remains open.
2. **A passive baseline does not execute JavaScript.** Every client route resolves to the same
   `index.html` document at the HTTP layer, so the seven NFR-07 interfaces are covered here as
   documents/assets/API responses, not as seven distinct rendered DOMs — per-screen DOM-level
   verification is the a11y lane's job (`npm run test:a11y`), not ZAP's.
3. **A baseline fires no payloads.** SQLi/XSS coverage is the in-suite ST-04 lane
   (`tests/st-security/`), which authenticates, reserves seats and posts content. ZAP baseline
   is corroboration on headers, cookies, caching and information disclosure — not an attack.

**What this run does establish:** the AB-06 ZAP clause — "an OWASP ZAP baseline scan against
the running app reports no high-risk alerts" — is now **measured over the served client plus
the full wave-0..4 API surface**, with the coverage gate at 30 distinct URLs (floor 8), and it
is clean at High. This resolves verification finding STSEC-01 (and the STS-V-01 restatement of
it): a recorded served-client run now exists. The wave-7 close-out still owes the two
follow-ups named above — an authenticated-context scan, and re-scan/re-triage at the real
deployed edge where the four client-document headers must be set.

## Superseded runs (history preserved; their artifact files are replaced by this run's)

### 2026-08-18 — wave-3 API-direct run (requestor floor only)

Target `src/server.js` directly on `https://host.docker.internal:8543` (no client existed;
database `zap_scan_r2`). Same scanner and digest. Result: `WARN-NEW: 3, PASS: 58`; **24
distinct URLs, 0 High / 0 Medium / 0 Low / 3 Informational** (`[10111]`, `[10024]`, `[10015]`
on `/health` — triages carried forward above); gate exit 0. It proved the command, the
container→host route, the requestor surface and both gates work, and its record explicitly
said it was *not* the AB-06 close-out because every request was anonymous and the client did
not exist. The spider job it deliberately kept ("0 URLs added" then) is what began
contributing in the run above.

### 2026-08-14 / 2026-08-18-early — the one-URL run (verification finding STS-R2-03)

An earlier record described a `zap-baseline.py` run reporting `WARN-NEW: 1 … PASS: 66` and
`High 0` — but whose every alert instance resolved to the single URL
`https://host.docker.internal:8443`, the 404 root: 66 passive rules had run against one 404
response. The alert numbers were true and the conclusion drawn from them was not. Fixed at the
cause, not by annotating the report:

- `.github/zap/baseline-plan.yaml` replaces spider-only discovery with an explicit endpoint
  list asserting per-route status codes, so a route that moves or stops being mounted surfaces
  as a plan error instead of quietly shrinking the scanned surface.
- The plan exports every requested URL to `zap-baseline-urls.txt`, and `npm run
  scan:zap:report` **exits 1 when fewer than `ZAP_MIN_URLS` (default 8) distinct URLs were
  scanned**, whatever the alert table says.
- `.github/SECURITY-SCANS.md` states the rule directly: a baseline whose report covers a
  single URL is not an AB-06 pass and must never be recorded as one.
