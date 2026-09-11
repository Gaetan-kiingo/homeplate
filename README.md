# Homeplate v1.0

Two-sided home-cooked-meal marketplace (MSCS 2101, Group 6). Modular Node.js/Express monolith
per **SRS v3.2** (frozen baseline), **SPMP v1.0**, and **ADR-001…011** (`ADRs/`). The build plan
and requirement inventory live in `docs/_generated/`.

Traceability (SRS Appendix B): the wave-0 toolchain in this repository (U0-BOOTSTRAP — npm
project, Docker Compose infra, Jest/ESLint, CI, build gate) is the substrate for NFR-02,
NFR-08 and NFR-11; the code implementing each requirement cites its FR/NFR/AB IDs in a header
comment on the owning module.

Stack (SRS §2.4, fixed): Node.js 20+/Express 4 stateless REST API (CommonJS, no transpile step),
PostgreSQL 16 (sole source of truth), Redis 7 (sessions + read cache only), S3-compatible object
storage for media (MinIO locally, ADR-004), transactional outbox + in-process worker for all
deferred work (ADR-001/003). The responsive React **web** client (SRS §2.1.2 — web, not React
Native) lives under `client/` as its own npm package: its foundation landed in wave 5, the
feature screens land in wave 6.

## Prerequisites

- Node.js 20+ (`.nvmrc`)
- Docker with Compose v2
- Optional: [k6](https://k6.io) for load runs (`npm run test:load`); for the NFR-07 audit
  (`npm run test:a11y`) the pinned chromium build: `npx playwright install chromium` (one-time
  host step — the `playwright` package is a pinned devDependency, nothing floats)

## Running the stack

```sh
cp .env.example .env            # adjust if needed; NEVER commit .env
./scripts/gen-dev-certs.sh      # self-signed TLS cert into certs/ (git-ignored, NFR-03)
docker compose up -d --wait     # PostgreSQL :5432, Redis :6379, MinIO :9000 (console :9001)
npm install
npm run migrate                 # applies db/migrations/*.sql, records them in schema_migrations
npm run seed                    # loads tests/fixtures/seed/base.json (arrives with wave 1)
npm run dev                     # API + outbox worker (each starts once its wave lands)
```

`npm run build` runs `scripts/check-build.js`: validates that `.env.example` still satisfies the
config schema, checks migration naming/ordering, syntax-checks every server `.js` file, and boots
the Express app factory once it exists. Configuration is **fail-fast**: a missing required
variable aborts start-up with the full list of problems (see `.env.example` for every variable).

MinIO console: http://localhost:9001 (local credentials in `docker-compose.yml`).

## Demo data (class demo / screenshots)

The `base` fixture is a test set: four listings, all now in the past (FR-01 search hides them),
and `seed:volume` adds 1,000 synthetic "Volume Dinner N" rows for the NFR-02 load tests. Neither
looks like a marketplace. The **demo set** does — 12 upcoming meals with photos, 6 hosts with
bios, reviews, bookings and a message thread — and its dates are *relative*, so it is always
"this week" no matter when you seed it:

```sh
npm run seed:demo                # tests/fixtures/seed/demo.json + demo-media/*.jpg → Postgres + MinIO
```

For a clean demo database (no Volume Dinners between the demo meals), reset the stack first:

```sh
docker compose down -v && docker compose up -d --wait && npm run migrate && npm run seed && npm run seed:demo
```

Every demo account uses the password **`DemoPass123!`** (local development only):

| Account | Email | What to show |
| --- | --- | --- |
| Guest | `maya@homeplate.demo` | Search, listing detail, reserve, bookings (2 upcoming, 2 completed) |
| Guest | `jordan@homeplate.demo` | A second guest with reviews |
| Host | `rosa@homeplate.demo` | Host profile with 2 reviews; bookings as host; **Your meals** dashboard and **Host a meal** (FR-11 create/edit/cancel, price per seat) |
| Moderator | `sam.mod@homeplate.demo` | Moderation queue and alerts — approves a newly hosted meal |

Every demo account has a verified email and a phone number (encrypted at load time by
`seed-demo.js`), so the hosts pass the FR-09 publish gate and the guests the reserve gate.

**The full loop, in the UI (added 2026-09-11):** sign in as `rosa` → **Host a meal** in the nav →
publish → the listing page shows *pending moderation* with the host's edit/cancel block → sign in
as `sam.mod` → Moderation → approve → sign in as `maya` → Find a meal (results are cached for
`SEARCH_CACHE_TTL_SECONDS`; the demo `.env` uses 5 s) → reserve. Cancelling the meal as the host
releases every seat and emails each guest.

Photos are Unsplash (free licence), resized and committed under `tests/fixtures/seed/demo-media/`
and `client/public/`, so the demo needs no network access.

## Tests (SRS §4.1 protocol)

```sh
npm test                        # full Jest suite against the SEEDED TEST DATABASE
npm run test:unit               # unit subset (tests/unit/)
npm run test:coverage           # with coverage report into coverage/
npm run test:load               # k6 smoke (LT-01/LT-02 shape; meaningful from wave 3)
```

How the seeded test database works (`tests/helpers/`):

- Jest `globalSetup` creates `homeplate_test` if missing, **resets its schema, re-applies all
  migrations, and re-loads the `base` fixture set on every run** — reproducible by
  construction. It also flushes the isolated test Redis DB (`…/6379/1`) and ensures the MinIO
  test bucket.
- Tests can never touch dev data: the harness forces `DATABASE_URL` to `TEST_DATABASE_URL` (or
  the compose default) and refuses any database whose name does not end in `_test`.
- All external adapters run as deterministic mocks in the suite (ADR-007, ADR-011); tests
  assert on persisted rows (e.g. `NOTIFICATION_ATTEMPT`), never on a third party.
- Escape hatches for local iteration only: `TEST_KEEP_DB=1` (skip the reset),
  `TEST_SKIP_INFRA=1` (pure-unit work with no Docker; never in CI).

Seed data: `scripts/seed.js` loads `tests/fixtures/seed/<set>.json` (or `<set>/*.json`) —
JSON objects of `{ "table": [rows…] }`, inserted in declared order with parameterized SQL and
`ON CONFLICT DO NOTHING` (idempotent). `npm run seed:volume` loads the NFR-02-scale `volume`
set once the wave-3 load lane authors it.

Verification lanes (one directory per lane so verifiers never collide):
`tests/tc-core` · `tests/tc-booking` · `tests/it-adapters` · `tests/st-security` ·
`tests/rt-lt-resilience` · `tests/mt-ut-quality` · `tests/adr-conformance` · `tests/coverage`.
Checks whose implementing code belongs to waves 3–6 are reported `not_implemented`, never
skipped (build-plan §6).

## Client (responsive React web app — SRS §2.1.2)

`client/` is its own npm package (Vite 5 + React 18 + react-router 6 + vitest 2), so the root
`npm test` contract — the backend Jest suite — is untouched. Convenience scripts exist at the
root (`npm run client:dev|client:build|client:test`), or use `--prefix`:

```sh
npm --prefix client ci          # install (client/package-lock.json is the pin)
npm run client:dev              # HTTPS dev server on https://localhost:5173, /api proxied
npm run client:build            # production build into client/dist/ (git-ignored)
npm run client:test             # vitest (jsdom + testing-library), client suite only
```

TLS discipline (NFR-03): the dev/preview server serves **HTTPS only** using
`certs/dev-{cert,key}.pem` — run `./scripts/gen-dev-certs.sh` first, and start the API
(`npm run dev`) for the `/api` proxy. The proxy **verifies** the self-signed API certificate by
passing it as the CA via an explicit `https.Agent`; `secure: false`,
`rejectUnauthorized: false` and `NODE_TLS_REJECT_UNAUTHORIZED` are banned anywhere in the
client toolchain. A non-default API port: `VITE_API_PROXY_TARGET=https://localhost:<port>`.

Layout (build-plan §6.1): `client/src/{main,App,routes}.jsx` + `src/layout/` + `src/pages/`
(U5-SHELL), `src/api/` + `src/session/` (U5-API-CLIENT), `src/ui/` + `src/styles/`
(U5-UI-KIT), `src/features/<name>/` (wave 6 — each feature lands its own `routes.jsx`
default-exporting an array of react-router route objects, discovered by `import.meta.glob`,
never by editing shared files). Client sources are linted by the root gate (`npm run lint`)
through the `client/**` ESLint override — never add `client/` to `.eslintignore`.

Accessibility (NFR-07) is a build-time concern: `npm run test:a11y` runs
`scripts/a11y-audit.js` — it builds the client, serves `client/dist/`, and drives the pinned
`playwright` + `@axe-core/playwright` at wcag2a/wcag2aa plus keyboard checks (skip link,
focus-to-main). **It exits non-zero until all seven NFR-07 interfaces exist and audit clean**
(they arrive in wave 6; the audit closes in wave 7), so its presence can never be mistaken for
coverage. Closing NFR-07 additionally requires the recorded 5-participant usability study
(SRS §4.5, UT-01) — a human activity.

## CI

`.github/workflows/ci.yml`: install (root + client) → infra (`docker compose up -d --wait`) →
migrate → lint → build check → client build → client tests → backend test with coverage
(SPMP §5.1.3). No secrets are used; CI runs mock adapters only.

## Deployment — data at rest (NFR-12, NFR-13; ST-05/ST-06)

Field-level encryption and volume encryption cover different things, and Homeplate needs both.
This section is the deployment note ST-06 requires; it is a **deployment-time control verified by
inspection**, not something the Jest suite can assert.

**What field-level crypto covers.** `src/db/fieldCrypto.js` encrypts the SRS §3.4 sensitive columns
— `users.phone_enc` and `users.emergency_contact_{name,phone,email}_enc` (`db/migrations/0001`) —
with AES-256-GCM under `FIELD_ENCRYPTION_KEY`. That is the whole of it. The key comes from the
environment, never the repository: the placeholder in `.env.example` is published and therefore
protects nothing, and config validation refuses it under `NODE_ENV=production` rather than
pretending to encrypt §3.4 PII with a public key.

**What it does not cover — and what must therefore be encrypted at the volume.** Names, email
addresses (needed as a login lookup key), listing/review/message text, media objects, the
PostgreSQL WAL and any query logs, and Redis session/cache persistence all sit on disk in the
clear. **PostgreSQL, the object store and Redis must therefore run on an encrypted volume:**

- **Local development:** FileVault (macOS) or LUKS (Linux) covering the filesystem that backs the
  Docker named volumes `pgdata` and `miniodata` (`docker-compose.yml`) — encrypting a project
  directory is not enough, because Docker keeps volume data under its own root.
- **Any hosted deployment:** provider-managed volume/disk encryption enabled **at volume creation**
  (it generally cannot be switched on in place afterwards), plus managed-database encryption at rest
  where a managed PostgreSQL is used.

**Backups inherit both requirements.** Every dump, snapshot and object-store replica carries the
same §3.4 PII as the live volume, so backups must sit on encrypted storage **and** expire on the
NFR-12 clock: **retention is capped at 30 days** (ST-05). A backup that outlives the 30-day erasure
deadline silently reintroduces data the user asked to have erased, which defeats NFR-12 no matter
how correct the erasure job is.

> **Status of this clause — documented-only, not enforced (ST-05; finding STS-R2-04).** Nothing in
> this repository creates, expires or even observes a backup. There is no backup job, no dump
> artifact, no `scripts/retention.js`, and no retention variable in the configuration schema;
> `config.privacy.erasureDays` (`PRIVACY_ERASURE_DAYS=30`) is the erasure *job's* due date and does
> not govern backup lifetime. The paragraph above is therefore a **deployment procedure the
> operator must carry out**, verified by inspecting the deployment — no test, config guard or CI
> step can detect a deployment that keeps backups forever. **A reviewer must record ST-05's
> backup-expiry clause as documented-only, never as met.** A retention sweeper landed ahead of a
> backup producer would scan an empty directory and exit zero every time: that is worse than the
> honest gap, because it reads as enforcement while enforcing nothing.

**What the operator must configure today.** This list is the entire control until the wave-4 work
below lands. Each item is checked by inspecting the running deployment:

1. **PostgreSQL dumps/snapshots.** Set the retention window to 30 days or fewer wherever they are
   produced — the provider's automated-backup retention setting on a managed PostgreSQL, or a
   lifecycle rule on the bucket (or an age-based sweep on the host) for a cron'd `pg_dump`.
2. **Object-store copies.** Apply an S3/MinIO lifecycle **expiration** rule of 30 days to any bucket
   holding replicas, snapshots or versioned copies of `OBJECT_STORAGE_BUCKET`, **including
   noncurrent-version expiration** — with versioning on, a deleted object is retained as a
   noncurrent version, which quietly defeats the ADR-004 per-object deletion that NFR-12 depends on.
3. **Redis persistence.** RDB/AOF files hold session and cached data; either disable persistence or
   bring those files inside the same 30-day window.
4. **Keys never travel with the data.** `FIELD_ENCRYPTION_KEY` is never stored inside a backup image
   — a backup containing both the ciphertext and its key is plaintext.
5. **Restores re-materialize erased rows.** Restoring a backup that predates an erasure run requires
   re-running the lifecycle sweep before the restored system serves traffic.

**Wave-4 deliverable (U4-PRIVACY) that turns this into something executable.** A validated retention
setting in `src/config/` — refused under `NODE_ENV=production` when it exceeds 30 days, the same
fail-closed style the config layer already applies to `ENFORCE_HTTPS` and the sample secrets — plus
a `scripts/retention.js` that lists and expires artifacts older than that window and exits non-zero
if any survive. It lands **with** the erasure job (`DELETE /api/users/me` + the outbox erasure
handler), so ST-05 has one reviewable subject rather than a config key with nothing behind it. The
assertion that today pins the *absence* of that surface — "backup-expiry is a documented 30-day
config policy; no retention/backup script exists yet" in `tests/st-security/st-security.test.js` —
inverts into its acceptance criteria in the same change.

Encryption in transit is a separate control (TLS 1.2+, NFR-03, `src/middleware/security.js`);
neither substitutes for the other.

**Moderation provider data-use.** The counterpart ST-06 clause — whether user content may be sent
to the moderation LLM's free tier at all — is recorded in
[`docs/adr007-data-use-review.md`](docs/adr007-data-use-review.md). Its finding is
binding on deployment: live moderation mode is for the ADR-008 **synthetic** evaluation set only,
and real user content is never sent to the free-tier provider.

## Conventions

- Parameterized SQL only (NFR-11); Redis holds sessions/cache only, never business state.
- Request handlers never import `src/adapters/*` — only outbox handlers and worker code may
  (ADR-001/003).
- Every secret comes from the environment and is documented in `.env.example`.
- Passwords hash with Argon2id via `@node-rs/argon2`; documented fallback is `bcryptjs` cost 12
  if a build host lacks prebuilt binaries — record that as a deviation in the ST-02 notes.
- MEHKO caps and jurisdiction numbers live in `src/config/locale.js` (ADR-009) — never inline.
