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
deferred work (ADR-001/003). The responsive React web client arrives in waves 5–6 (SRS §2.1.2).

## Prerequisites

- Node.js 20+ (`.nvmrc`)
- Docker with Compose v2
- Optional: [k6](https://k6.io) for load runs (`npm run test:load`), a browser for the wave-5
  a11y checks (`npm run test:a11y`)

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

## CI

`.github/workflows/ci.yml`: install → infra (`docker compose up -d --wait`) → migrate → lint →
build check → test with coverage (SPMP §5.1.3). No secrets are used; CI runs mock adapters only.

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
how correct the erasure job is. Restoring a backup that predates an erasure run therefore requires
re-running the lifecycle sweep before the restored system serves traffic. `FIELD_ENCRYPTION_KEY`
is never stored inside a backup image — a backup that contains both the ciphertext and its key is
plaintext.

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
