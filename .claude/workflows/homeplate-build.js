export const meta = {
  name: 'homeplate-build',
  description: 'Coordinator plans from the SRS + SPMP + ADRs, implementers build in dependency waves, verifiers test every requirement/module/function and drive repair rounds',
  whenToUse: 'Building or extending Homeplate v1.0 from the frozen SRS v3.2 baseline and the ADR set. args: {mode:"full"|"plan"|"implement"|"verify", repo, srs, spmp, adrs, focus, maxRepairRounds, lanes, waveLimit}. mode:"plan" is a cheap dry run that produces the work breakdown without writing code.',
  phases: [
    { title: 'Plan', detail: 'coordinator normalizes SRS/SPMP/ADRs into a requirement inventory + work waves' },
    { title: 'Scaffold', detail: 'one agent lays down the repo skeleton, deps, DB migrations, test harness' },
    { title: 'Implement', detail: 'one implementer per work unit, wave by wave, file ownership disjoint' },
    { title: 'Verify', detail: 'verifier lanes execute SRS §4 test protocol against every FR/NFR/module/function' },
    { title: 'Repair', detail: 'fixers apply verifier findings; affected lanes re-verify' },
    { title: 'Report', detail: 'traceability matrix REQ -> design element -> code -> test -> status' },
  ],
}

// ---------------------------------------------------------------------------
// 0. Configuration
// ---------------------------------------------------------------------------

let cfg = {}
if (typeof args === 'string') {
  const t = args.trim()
  if (t.startsWith('{')) { try { cfg = JSON.parse(t) } catch (e) { cfg = { focus: args } } }
  else if (t) cfg = { focus: t }
} else if (args && typeof args === 'object') {
  cfg = args
}

const BASE = cfg.base || '/Users/gaetan/Desktop/MSCS/Software Engineer/HomePlate'
const REPO = cfg.repo || `${BASE}/homeplate`
const SRS_DOC = cfg.srs || `${BASE}/SRSv3.2Homeplate.docx`
const SPMP_DOC = cfg.spmp || `${BASE}/Homeplate_Group6_SPMP.docx`
const ADR_DIR = cfg.adrs || `${REPO}/ADRs`
const GEN = `${REPO}/docs/_generated`          // plain-text extractions + plan artifacts live here
const MODE = cfg.mode || 'full'                // full | plan | implement | verify
const FOCUS = cfg.focus || ''                  // optional: "only FR-10..FR-14", "just the booking service", ...
const MAX_REPAIR = Number.isFinite(cfg.maxRepairRounds) ? cfg.maxRepairRounds : 2
const WAVE_LIMIT = cfg.waveLimit || 6          // max concurrent implementers inside one wave batch
const SKIP_SCAFFOLD = cfg.skipScaffold === true

// Every prompt gets this. It is the single source of truth about *where things are*
// and which document wins when two documents disagree.
const CONTEXT = `
PROJECT: Homeplate v1.0 — a two-sided home-cooked-meal marketplace (MSCS 2101, Group 6).

AUTHORITATIVE DOCUMENTS
- SRS v3.2 (FROZEN BASELINE): ${SRS_DOC}
- SPMP v1.0 (process/work breakdown): ${SPMP_DOC}
- Architecture decision records (markdown, ADR-001 upward): ${ADR_DIR}
- Code repository (git, remote git@github.com:Gaetan-kiingo/homeplate.git): ${REPO}
- Plain-text extractions and plan artifacts: ${GEN}

The two specs are .docx and live OUTSIDE the git repository (they are maintained on the team's Google
Drive per SPMP §7.1), so the paths above are machine-specific. If they are not there, search for
\`SRS*.docx\` and \`*SPMP*.docx\` in the repository's parent directory and one level below it before
giving up. Extract them with:
  mkdir -p "${GEN}"
  textutil -convert txt -output "${GEN}/SRS.txt" "<path to the SRS .docx>"      # macOS
  textutil -convert txt -output "${GEN}/SPMP.txt" "<path to the SPMP .docx>"
On Linux use \`pandoc -t plain\` or \`python3 -m docx2txt\` instead of textutil.
Reuse those .txt files if they already exist. List ${ADR_DIR} and read EVERY ADR markdown file you
find there — the set grows as the team decides things, so never assume a fixed count.
If you truly cannot locate the SRS, stop and say so — do NOT invent requirements from memory.

CONFLICT RULE (from SPMP §1.1.2): SRS v3.2 is the frozen requirements baseline. Where the SPMP
or a proposal contradicts it, the SRS wins. Known instance: the SPMP §5.2.1 mentions "React Native",
the SRS §2.1.2 mandates a single responsive React WEB app and states no native mobile app ships in
v1.0 — build the responsive React web client. Where an ADR contradicts the SRS on a *requirement*,
the SRS wins; where the SRS leaves a mechanism open (§2.4: deferred-work mechanism, media storage,
moderation runtime config), the ADR is binding.

FIXED TECHNOLOGY (SRS §2.4 — not open to reinterpretation)
React responsive web client · Node.js/Express stateless REST API · PostgreSQL as source of truth ·
Redis for sessions and read caching only. Object storage for media (ADR-004). Free-tier only.

BINDING ARCHITECTURE INVARIANTS (ADR-001..011) — treat these as acceptance criteria, not advice:
1. ADR-001/003 — Modular monolith. A booking row and its outbox row commit in the SAME PostgreSQL
   transaction. An in-process background worker polls the outbox and performs deferred work through
   per-service adapters with retry, backoff and dead-letter handling. REQUEST HANDLERS MUST NEVER
   CALL AN EXTERNAL ADAPTER INLINE — only worker code may. No dual writes. Outbox payloads carry
   IDs only, never raw personal data.
2. ADR-002 — Moderation is two-stage: deterministic pre-filter (blocklist/regex/rate limit) first,
   then a hosted LLM returning {category, confidence}; low-confidence or flagged content routes to a
   human Moderator queue. Public content (listings, reviews) stays PENDING until approved; private
   messages deliver immediately and are scanned asynchronously; a moderation-provider outage keeps
   public content pending — it must NEVER publish unreviewed.
3. ADR-004 — Listing/review media live in object storage, referenced from PostgreSQL by key, behind
   an adapter supporting per-object deletion; account deletion deletes media by key (NFR-12).
4. ADR-005 — Google Maps/Places for geocoding + location search, behind one adapter with timeout,
   retry and fallback; results and coordinates cached in Redis; that same cache is the NFR-09
   degraded-mode fallback.
5. ADR-006 — One auth service owning credentials, Redis-backed sessions and login rate limiting.
   HTTPS/TLS 1.2+ only, plain HTTP refused. Validation at the API boundary. Eligibility
   (canReserveSeat / canPublishListing) is ONE policy interface consulted by every flow — never
   reimplemented per module. No MFA, no ID verification, no payments (all deferred to v2.0).
6. ADR-007 — The moderation LLM stage calls the GOOGLE GEMINI FREE TIER through the provider-agnostic
   adapter (LLM_MODERATION_BASE_URL / LLM_MODERATION_API_KEY / MODERATION_MODEL). Never hardcode a
   provider, a model id or a key. CI and the automated suite use a deterministic MOCK adapter; only
   the IT-03 measurement run may call the live API. Record the model id with any IT-03 result.
7. ADR-008 — The NFR-10 evaluation set is SYNTHETIC (team-authored, never scraped), balanced across
   offensive/spam/fraudulent/benign, >=200 items, versioned under tests/fixtures/moderation-eval/vN/.
   NO NFR-10 PASS MAY BE CLAIMED WITHOUT A RECORDED HUMAN LABEL SIGN-OFF (reviewer, date, set version)
   in the results file. An unreviewed run reports provisional numbers only.
8. ADR-009 — MEHKO caps are CONFIGURATION in src/config/, never inline: 1 listing/host/day,
   30 meals/day, 60 meals/week, day and week boundaries evaluated in America/Los_Angeles (never UTC,
   never the caller's timezone). ONE server-side enforcement point for every listing create/update
   path. A client-side cap enforces nothing.
9. ADR-010 — Progressive host-address disclosure. The PUBLIC serializer (coarsened coordinates +
   neighbourhood/city label) is the DEFAULT on every read path; exact street address and precise
   coordinates go only to a guest holding a pending/in-progress booking on that listing, or to a
   moderator handling an FR-07 alert on it. Redis caches PUBLIC precision only — a cache read must
   never be able to leak an exact location. This is a safety property: one forgotten serializer in
   search, listing detail, host profile, messaging or a moderation view leaks it silently.
10. ADR-011 — EMAIL via SendGrid is the v1.0 notification channel (FR-13, FR-14, FR-07). The FCM push
   adapter is implemented but gated behind notifications.push.enabled, DEFAULT FALSE. Dev and the whole
   test suite use a mock transport that records a NOTIFICATION_ATTEMPT row instead of sending; tests
   assert on persisted attempts, never on a third party's behaviour. Both adapters stay worker-only.

SCOPE (SRS §1.2): signup, listing create/manage, browse/reserve, booking notification, meal
completion, reviews, messaging, safety alerts, moderation, data lifecycle/privacy.
OUT OF SCOPE for v1.0: payments, AI-assisted listing generation, identity verification, GPS tracking.
Do not build out-of-scope features even if they seem natural.

GROUND RULES FOR EVERY AGENT
- Work inside ${REPO}. Never modify the .docx sources.
- NEVER run \`git commit\`, \`git push\`, \`git reset --hard\`, or rewrite history. Leave changes in
  the working tree; the human team commits.
- Every requirement you touch is cited by ID (FR-xx / NFR-xx / AB-xx) in code comments on the module
  that implements it, so Appendix B traceability stays verifiable.
- No placeholder implementations. No \`TODO\`, no \`throw new Error("not implemented")\`, no fake
  data returned in place of real logic. If you genuinely cannot finish a unit, say so explicitly in
  your structured result rather than shipping a stub.
- Secrets come from environment variables with a documented \`.env.example\`. Never hardcode keys.
${FOCUS ? `\nUSER FOCUS FOR THIS RUN: ${FOCUS}` : ''}
`.trim()

// ---------------------------------------------------------------------------
// 1. Schemas
// ---------------------------------------------------------------------------

const PLAN_SCHEMA = {
  type: 'object',
  required: ['stack', 'requirements', 'waves', 'commands'],
  properties: {
    blocked: { type: 'string', description: 'Non-empty only if planning cannot proceed; explain why.' },
    docsRead: { type: 'array', items: { type: 'string' } },
    stack: {
      type: 'object',
      required: ['summary', 'packageManager', 'testFramework'],
      properties: {
        summary: { type: 'string' },
        packageManager: { type: 'string' },
        testFramework: { type: 'string' },
        layout: { type: 'string', description: 'Directory layout of the monolith, one line per top-level path.' },
      },
    },
    requirements: {
      type: 'array',
      description: 'Every FR-01..FR-14, NFR-01..NFR-13 and AB-01..AB-08 from the SRS. No omissions.',
      items: {
        type: 'object',
        required: ['id', 'text', 'kind', 'acceptance', 'designElement', 'testIds'],
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          kind: { type: 'string', enum: ['functional', 'nonfunctional', 'abuse'] },
          priority: { type: 'string' },
          acceptance: { type: 'string', description: 'Concrete, executable pass/fail criteria.' },
          designElement: { type: 'string', description: 'SRS Appendix B design element that owns it.' },
          testIds: { type: 'array', items: { type: 'string' }, description: 'TC-/IT-/ST-/LT-/RT-/UT-/MT- ids.' },
        },
      },
    },
    waves: {
      type: 'array',
      description: 'Ordered dependency layers. Units inside a wave must be independently buildable.',
      items: {
        type: 'object',
        required: ['name', 'units'],
        properties: {
          name: { type: 'string' },
          rationale: { type: 'string' },
          units: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'title', 'goal', 'requirements', 'files', 'acceptance'],
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                workActivity: { type: 'string', description: 'SPMP WA-xx this maps to, if any.' },
                goal: { type: 'string', description: 'What must exist and work when this unit is done.' },
                requirements: { type: 'array', items: { type: 'string' } },
                files: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'EXCLUSIVE file ownership, repo-relative. Two units in a wave must not share a path.',
                },
                dependsOn: { type: 'array', items: { type: 'string' } },
                publicInterface: { type: 'string', description: 'Exports/routes other units may rely on. Contract for parallel work.' },
                acceptance: { type: 'string' },
                notes: { type: 'string' },
              },
            },
          },
        },
      },
    },
    commands: {
      type: 'object',
      properties: {
        install: { type: 'string' }, build: { type: 'string' }, test: { type: 'string' },
        lint: { type: 'string' }, migrate: { type: 'string' }, dev: { type: 'string' },
      },
    },
    openQuestions: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

const IMPL_SCHEMA = {
  type: 'object',
  required: ['unitId', 'status', 'filesWritten', 'summary'],
  properties: {
    unitId: { type: 'string' },
    status: { type: 'string', enum: ['complete', 'partial', 'blocked'] },
    filesWritten: { type: 'array', items: { type: 'string' } },
    publicInterface: { type: 'string', description: 'What this unit actually exports/exposes, for downstream waves.' },
    requirementsCovered: { type: 'array', items: { type: 'string' } },
    testsAdded: { type: 'array', items: { type: 'string' } },
    commandsRun: { type: 'array', items: { type: 'string' } },
    deviations: { type: 'array', items: { type: 'string' }, description: 'Anything done differently from the plan or an ADR, and why.' },
    summary: { type: 'string' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['lane', 'checks', 'findings'],
  properties: {
    lane: { type: 'string' },
    commandsRun: { type: 'array', items: { type: 'string' } },
    checks: {
      type: 'array',
      description: 'One entry per requirement / module / function actually examined.',
      items: {
        type: 'object',
        required: ['subject', 'status', 'evidence'],
        properties: {
          subject: { type: 'string', description: 'FR-xx, NFR-xx, AB-xx, or module/function path.' },
          testId: { type: 'string' },
          status: { type: 'string', enum: ['pass', 'fail', 'partial', 'not_implemented', 'untestable'] },
          testPath: { type: 'string' },
          evidence: { type: 'string', description: 'Command run and its observed output. NOT an assertion that it "should" work.' },
        },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'severity', 'title', 'files', 'failureScenario', 'proposedFix'],
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          title: { type: 'string' },
          requirements: { type: 'array', items: { type: 'string' } },
          files: { type: 'array', items: { type: 'string' }, description: 'Files a fixer must edit. First entry = primary owner.' },
          line: { type: 'integer' },
          failureScenario: { type: 'string', description: 'Concrete inputs/state -> wrong output. Reproduced, not hypothesised.' },
          proposedFix: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

const FIX_SCHEMA = {
  type: 'object',
  required: ['status', 'filesChanged', 'resolved', 'summary'],
  properties: {
    status: { type: 'string', enum: ['all_fixed', 'partial', 'blocked'] },
    filesChanged: { type: 'array', items: { type: 'string' } },
    resolved: { type: 'array', items: { type: 'string' }, description: 'Finding ids actually fixed and re-tested.' },
    unresolved: { type: 'array', items: { type: 'string' } },
    rejected: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' } } },
      description: 'Findings judged incorrect. Justify with evidence — a verifier can be wrong.',
    },
    commandsRun: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

// ---------------------------------------------------------------------------
// 2. Verification lanes — the SRS §4 protocol, one lane per test family.
//    Each lane owns its own test directory so parallel verifiers never collide.
// ---------------------------------------------------------------------------

const ALL_LANES = [
  {
    key: 'tc-core',
    title: 'TC-01..TC-07 — discovery, detail, host profile, completion, reviews, messaging, safety alert',
    brief: `Write and RUN automated API-level tests (Jest + Supertest against a seeded test database, SRS §4.1)
for FR-01 through FR-07. Acceptance criteria mirror the EARS statements: fire the trigger, assert the response.
FR-04 requires BOTH host and guest confirmation flags before status becomes "completed" — assert the
single-confirmation case does NOT complete. FR-07 must persist the alert, notify the moderator, and attempt
emergency-contact email via the SendGrid adapter with retry on failure (pair with IT-04).`,
  },
  {
    key: 'tc-booking',
    title: 'TC-08..TC-14 — moderation, eligibility, registration, listing limits, atomic booking, notifications, cancellation',
    brief: `Write and RUN automated API-level tests for FR-08 through FR-14. Non-negotiable assertions:
FR-09 is state-driven — assert BOTH the restricted and the permitted state. FR-11 must enforce
one-listing-per-host-per-day and the AB 626 meal/seat caps server-side. FR-12 must be atomic: assert that
concurrent seat requests never overbook, and that a rejected request leaves capacity UNCHANGED; also assert
the per-guest concurrent-pending-booking limit. FR-13: assert that an adapter failure does NOT roll back or
delay the booking transaction. FR-14: cancellation before scheduled start restores capacity atomically.`,
  },
  {
    key: 'it-adapters',
    title: 'IT-01..IT-04 — external adapters, moderation accuracy, safety-alert delivery',
    brief: `Test each external adapter (Google Maps/Places, FCM, SendGrid, LLM) against sandbox/mock endpoints for
the happy path AND against injected failures for the degraded path (SRS §4.2). IT-03 is a measurement protocol,
not a smoke test: build or extend a versioned labeled evaluation set of AT LEAST 200 items (offensive, spam,
fraudulent and benign in balanced proportions), score it through the real moderation pipeline, and report the
measured false-positive and false-negative rates. NFR-10 requires each to be under 5% — report the actual
numbers, and fail the check if the bound is missed, if the set is smaller than 200, or if the results file carries
no recorded human label sign-off (ADR-008 — an unreviewed set yields provisional numbers, never a pass). IT-04:
alert persisted, moderator notified, emergency-contact email delivered through the SendGrid MOCK transport
(ADR-011 — no live sends in the suite), retry path exercised by injecting a delivery failure.`,
  },
  {
    key: 'st-security',
    title: 'ST-01..ST-06 — TLS, password handling, lockout, injection, deletion, data protection',
    brief: `Execute SRS §4.3. ST-01: verify the server refuses plain HTTP and permits no protocol below TLS 1.2
(configuration scan/review). ST-02: review password handling — Argon2id/bcrypt with sane parameters, and prove no
plaintext path exists (grep the whole codebase and the logging layer). ST-03: script a brute-force attempt and
assert lockout after 5 failed attempts within 10 minutes (NFR-05). ST-04: injection suite — targeted SQLi and XSS
payloads on EVERY input boundary (search, listing text, chat, reviews, profile); assert parameterised queries and
output escaping (NFR-11, AB-06). ST-05: delete an account and verify NFR-12 erasure across PostgreSQL rows AND
object-storage media by key (ADR-004), plus backup-expiry configuration. ST-06: review encryption at rest,
role-restricted+logged access to personal data, and the data-export path (NFR-13). Also exercise abuse cases
AB-01..AB-08 and report each explicitly.`,
  },
  {
    key: 'rt-lt-resilience',
    title: 'RT-01, RT-02, LT-01, LT-02 — degradation, outbox reliability, latency, volume',
    brief: `Execute SRS §4.4. RT-01: cut off each external service in turn; the system MUST show the required error
message, serve cached/previously stored data where available, and defer notifications/moderation — then recover
when the service returns (NFR-09). Confirm specifically that a moderation outage leaves public content PENDING
(ADR-002). RT-02: outbox processing after a crash, duplicate-delivery idempotency, retry/backoff, and dead-letter
handling. LT-01: load-test browse/search/review at 200 concurrent users against the 500 ms p95 budget (NFR-01) and
include the concurrent-reservation race test asserting FR-12 never overbooks. LT-02: volume test at NFR-02 scale
(10,000 users; 1,000 listings/bookings per day) still meeting NFR-01. If the environment cannot sustain a real
load test, run the largest honest approximation, report the numbers you actually measured, and mark the check
"untestable" with the reason — do NOT report a pass you did not measure.`,
  },
  {
    key: 'mt-ut-quality',
    title: 'MT-01, UT-01 — log completeness and accessibility',
    brief: `MT-01 (SRS §4.6): perform registration, booking, cancellation and a moderation decision in a test
environment, then verify the resulting records exist and carry correlation IDs sufficient to reconstruct the cause
(NFR-08) — and that logs contain user IDs only, never PII (SRS §3.4 register). UT-01 (SRS §4.5): run an automated
axe-core WCAG 2.1 AA audit over the key React interfaces plus keyboard-navigation spot checks (NFR-07). The
5-participant moderated usability study is a human activity — mark it "untestable" here and note it for the team.`,
  },
  {
    key: 'adr-conformance',
    title: 'ADR conformance — architectural and policy invariants',
    brief: `Audit the code against each binding invariant in the CONTEXT block and report one check per ADR.
Concretely: (a) grep every Express route handler and prove no external adapter (Maps, FCM, SendGrid, LLM, object
storage) is called inline on the request path — only worker code may; (b) prove the business row and its outbox row
are written in ONE PostgreSQL transaction, with no dual write; (c) prove outbox payloads carry IDs only, never raw
personal data; (d) prove the moderation pre-filter runs before the LLM stage and that public content cannot publish
without approval; (e) prove media is referenced by key and per-object deletion is wired into account deletion;
(f) prove exactly one eligibility-policy interface exists and that no module reimplements canReserveSeat or
canPublishListing locally; (g) prove Redis holds sessions and cache only — never source-of-truth business state;
(h) ADR-007: prove no provider, model id or API key is hardcoded, and that the test suite uses the mock adapter;
(i) ADR-009: prove the MEHKO caps come from config, that there is exactly ONE server-side enforcement point, and
that day/week boundaries use America/Los_Angeles — write a test that submits a second listing just after local
midnight from a different client timezone and assert it is refused; (j) ADR-010: enumerate EVERY endpoint that
returns listing or host data and assert the public serializer is the default — check search results, listing
detail, host profile, messaging payloads, moderation views and the Redis-cached copies, and prove an exact
address is returned ONLY to a guest with a pending/in-progress booking on that listing; (k) ADR-011: prove push
is disabled by default, that no live send occurs in the suite, and that every attempt writes a
NOTIFICATION_ATTEMPT row.`,
  },
  {
    key: 'coverage',
    title: 'Module and function coverage — every exported unit exercised, no stubs',
    brief: `This lane answers "is every module and function actually implemented and tested?". Build an inventory of
every exported module, class, function and HTTP route in the codebase (walk the source tree — do not guess). For
each: does it have real logic, and is it exercised by at least one test? Run the full test suite with coverage
enabled and report real numbers. Explicitly hunt for and report: TODO/FIXME markers, \`not implemented\` throws,
functions that return hardcoded or fabricated data instead of computing it, unreachable/dead exports, and any
requirement ID from the plan with NO implementing code. Then cross-check SRS Appendix B: every listed design
element (Search Service, Listing Service, Booking Service, Eligibility Policy Service, Moderation Module,
Transactional Outbox + Worker, Safety Alert Service, Data Lifecycle Service, Input Validation Module, …) must exist
as identifiable code. Report one check per module and one finding per gap.`,
  },
]

const LANES = cfg.lanes
  ? ALL_LANES.filter((l) => cfg.lanes.includes(l.key))
  : ALL_LANES

// ---------------------------------------------------------------------------
// 3. Helpers (deterministic — this is why the orchestration is a script)
// ---------------------------------------------------------------------------

/** Greedily pack units into batches so that no two units in a batch declare the same file. */
function batchByFileOwnership(units, maxPerBatch) {
  const batches = []
  for (const u of units) {
    const files = (u.files || []).map((f) => String(f).trim()).filter(Boolean)
    let placed = false
    for (const b of batches) {
      if (b.units.length >= maxPerBatch) continue
      if (files.some((f) => b.files.has(f))) continue
      b.units.push(u)
      files.forEach((f) => b.files.add(f))
      placed = true
      break
    }
    if (!placed) batches.push({ units: [u], files: new Set(files) })
  }
  return batches
}

const SEV_RANK = { blocker: 0, major: 1, minor: 2 }

/** Group findings by the file that owns them, so one fixer owns one file. */
function groupFindings(findings) {
  const byOwner = new Map()
  for (const f of findings) {
    const owner = (f.files && f.files[0]) || 'unassigned'
    if (!byOwner.has(owner)) byOwner.set(owner, { owner, findings: [], files: new Set() })
    const g = byOwner.get(owner)
    g.findings.push(f)
    ;(f.files || []).forEach((x) => g.files.add(x))
  }
  return [...byOwner.values()].map((g) => ({ ...g, files: [...g.files] }))
}

function renderUnit(u) {
  return [
    `UNIT ${u.id} — ${u.title}`,
    u.workActivity ? `SPMP activity: ${u.workActivity}` : null,
    `Goal: ${u.goal}`,
    `Requirements it must satisfy: ${(u.requirements || []).join(', ') || '(none listed)'}`,
    `Acceptance: ${u.acceptance}`,
    `Files you EXCLUSIVELY own (create/edit only these): ${(u.files || []).join(', ')}`,
    u.publicInterface ? `Public interface other units depend on: ${u.publicInterface}` : null,
    u.dependsOn && u.dependsOn.length ? `Depends on (already built): ${u.dependsOn.join(', ')}` : null,
    u.notes ? `Notes: ${u.notes}` : null,
  ].filter(Boolean).join('\n')
}

// ---------------------------------------------------------------------------
// 4. Phase: Plan — the coordinator
// ---------------------------------------------------------------------------

phase('Plan')
log(`mode=${MODE} · repo=${REPO} · ${LANES.length} verification lanes · ${MAX_REPAIR} repair round(s) max`)

const plan = await agent(
  `${CONTEXT}

YOU ARE THE COORDINATOR. You plan; you do not write application code.

Do this, in order:
1. Extract the SRS and SPMP to text (commands above) and read them in full. Read every ADR. Then survey the
   existing repository state — what already exists at ${REPO} decides whether this is a green-field build or an
   increment on work in progress. Never assume the repo is empty; check.
2. Build the requirement inventory: EVERY FR-01..FR-14, NFR-01..NFR-13 and AB-01..AB-08 from SRS §3, with the
   SRS Appendix B design element and test IDs that verify it. Do not paraphrase requirements into something
   easier to build, and do not silently drop any. Turn each one into *executable* acceptance criteria — a
   statement a test can pass or fail, with the numbers from the SRS (500 ms p95, 200 concurrent users, 5 failed
   logins in 10 minutes, 30-day erasure, <5% FP/FN, 200-item labeled set, one listing per host per day).
3. Decompose the build into ORDERED WAVES. A wave is a dependency layer: everything in wave N may assume
   everything in waves 1..N-1 exists, and units inside one wave must be independently buildable and must not
   share a single file. File ownership is exclusive — that is what makes parallel implementation safe, so assign
   concrete repo-relative paths per unit and check for overlaps before you answer.
   A sound decomposition for this system looks roughly like:
     wave 1 — foundation: config module (incl. locale/AB 626 caps per SRS §2.1.7), PostgreSQL schema and
              migrations for the SRS §3.4 entities, DB/Redis clients, error+logging middleware (NFR-08),
              input validation layer (NFR-11), outbox table and worker skeleton (ADR-003).
     wave 2 — domain services that depend only on the foundation: auth+sessions+rate limiting (ADR-006, NFR-04/05),
              eligibility policy service (FR-09, NFR-06), registration and email verification (FR-10),
              external adapters (Maps, SendGrid, FCM, LLM, object storage) each with timeout/retry/fallback,
              media adapter (ADR-004).
     wave 3 — features on top: listing service with MEHKO caps (FR-11), search/discovery with Redis cache
              (FR-01, ADR-005), meal detail + host profile (FR-02, FR-03), booking service with atomic capacity
              and outbox notifications (FR-12, FR-13, FR-14, FR-04), reviews (FR-05), messaging (FR-06),
              safety alerts (FR-07), moderation pipeline (FR-08, ADR-002), data lifecycle deletion/export
              (NFR-12, NFR-13), worker dispatch paths.
     wave 4 — the responsive React web client (SRS §2.1.2, NFR-07 WCAG 2.1 AA) over the finished API.
   Adjust it to what the repo actually contains — this is a template, not a mandate. Keep units meaningful
   (a service + its tests), not micro-tasks; aim for 3-7 units per wave.
4. Decide the concrete commands: install, migrate, build, test, lint, dev. Keep everything free-tier and runnable
   locally (Docker Compose for PostgreSQL/Redis is acceptable; local object storage may be a MinIO/S3-compatible
   container or a filesystem-backed adapter implementing the same per-object-delete interface).
5. Write two artifacts into the repo: \`${GEN}/requirements-inventory.json\` (your requirements array) and
   \`${GEN}/build-plan.md\` (human-readable wave breakdown). These are the durable record for the team.

Flag genuine conflicts or ambiguities in openQuestions rather than resolving them silently — but do not block on
them: choose the reading most faithful to the SRS, state it, and keep planning. Set "blocked" only if the source
documents are unreadable.`,
  { label: 'coordinator', phase: 'Plan', schema: PLAN_SCHEMA, effort: 'high' },
)

if (!plan) return { error: 'Coordinator returned nothing — cannot proceed.' }
if (plan.blocked) return { blocked: plan.blocked, plan }

const waves = plan.waves || []
const unitCount = waves.reduce((n, w) => n + (w.units || []).length, 0)
log(`Plan: ${(plan.requirements || []).length} requirements · ${waves.length} waves · ${unitCount} work units`)
if (plan.openQuestions && plan.openQuestions.length) {
  log(`Open questions for the team: ${plan.openQuestions.join(' | ')}`)
}

if (MODE === 'plan') {
  return {
    mode: 'plan',
    requirements: (plan.requirements || []).length,
    waves: waves.map((w) => ({ name: w.name, units: (w.units || []).map((u) => u.id) })),
    commands: plan.commands,
    openQuestions: plan.openQuestions || [],
    risks: plan.risks || [],
    artifacts: [`${GEN}/build-plan.md`, `${GEN}/requirements-inventory.json`],
  }
}

const PLAN_BRIEF = `
STACK: ${plan.stack?.summary || 'per SRS §2.4'}
LAYOUT: ${plan.stack?.layout || '(see build plan)'}
COMMANDS: install=${plan.commands?.install || 'n/a'} · migrate=${plan.commands?.migrate || 'n/a'} · build=${plan.commands?.build || 'n/a'} · test=${plan.commands?.test || 'n/a'} · lint=${plan.commands?.lint || 'n/a'}
The full plan is at ${GEN}/build-plan.md and the requirement inventory (with acceptance criteria) at
${GEN}/requirements-inventory.json — read them before you start.
`.trim()

// ---------------------------------------------------------------------------
// 5. Phase: Scaffold — one agent, so parallel implementers share one foundation
// ---------------------------------------------------------------------------

let scaffold = null
if (MODE !== 'verify' && !SKIP_SCAFFOLD) {
  phase('Scaffold')
  scaffold = await agent(
    `${CONTEXT}

${PLAN_BRIEF}

YOU ARE THE SCAFFOLD IMPLEMENTER. You run alone, before any parallel work, so that every implementer that follows
inherits one consistent foundation instead of inventing its own.

Create (or reconcile, if some of it already exists) at ${REPO}:
- The repository layout from the plan, package manifests and dependencies, and the language/build configuration.
- Docker Compose for PostgreSQL and Redis, plus an S3-compatible object store for media, so the stack runs locally
  on free tier. A \`.env.example\` enumerating every required variable, and config loading that FAILS FAST on a
  missing one. Never commit real secrets.
- The test harness the SRS §4.1 protocol requires: Jest + Supertest wired against a SEEDED TEST DATABASE, with a
  reproducible seed/teardown, plus coverage reporting. Add the k6 and axe-core entry points the plan calls for.
- A \`tests/\` tree with one subdirectory per verification lane so later verifiers never collide:
  ${LANES.map((l) => `tests/${l.key}/`).join(' ')}
- Lint/format configuration, and a GitHub Actions CI workflow running install → migrate → lint → test (SPMP §5.1.3).
- A short README section describing how to run the stack, the tests, and the seed data.

Then PROVE it works: install dependencies, start the services, run the migration and the (empty) test suite, and
report the exact commands and their output. Do not hand a broken foundation to ten parallel agents. If a command
fails, fix it and re-run rather than reporting success.

Do not implement business logic — that belongs to the wave units.`,
    { label: 'scaffold', phase: 'Scaffold', schema: IMPL_SCHEMA },
  )
  if (scaffold) log(`Scaffold: ${scaffold.status} · ${(scaffold.filesWritten || []).length} files`)
}

// ---------------------------------------------------------------------------
// 6. Phase: Implement — wave by wave.
//    The barrier between waves is real: wave N imports what wave N-1 exported.
//    Inside a wave, units run concurrently but only after being packed into
//    file-disjoint batches, so two agents can never edit the same file.
// ---------------------------------------------------------------------------

const implResults = []
if (MODE !== 'verify') {
  phase('Implement')
  let waveIndex = 0
  for (const wave of waves) {
    waveIndex++
    const units = wave.units || []
    if (!units.length) continue
    const batches = batchByFileOwnership(units, WAVE_LIMIT)
    if (batches.length > 1) {
      log(`Wave ${waveIndex} "${wave.name}": ${units.length} units → ${batches.length} sequential batches (file-ownership overlap or concurrency cap)`)
    } else {
      log(`Wave ${waveIndex} "${wave.name}": ${units.length} units in parallel`)
    }

    const built = [] // public interfaces produced earlier in this wave, fed forward
    for (const batch of batches) {
      const out = await parallel(
        batch.units.map((u) => () =>
          agent(
            `${CONTEXT}

${PLAN_BRIEF}

YOU ARE AN IMPLEMENTER. Build exactly one unit. Other agents are building sibling units concurrently.

${renderUnit(u)}

RULES OF PARALLEL WORK
- Create and edit ONLY the files listed above. If you are certain you need a file outside your ownership, do not
  edit it — report it in "deviations" so the coordinator can re-plan. Shared files edited by two agents are lost work.
- Everything from earlier waves already exists on disk. Read it, import it, and conform to it rather than
  re-implementing it. In particular: use the single eligibility-policy interface, the existing outbox helper, the
  existing validation layer, and the existing adapters — never a private copy.
${built.length ? `- Siblings already finished in this wave expose:\n${built.map((b) => `    · ${b}`).join('\n')}` : ''}

DEFINITION OF DONE — all four, verified by you, not assumed:
1. The unit's behaviour satisfies its requirement IDs, including the exact numbers in the acceptance criteria.
2. Real logic end to end. No stubs, no TODOs, no fabricated return values, no \`not implemented\` throws.
3. You wrote automated tests for this unit and RAN them (\`${plan.commands?.test || 'the project test command'}\`),
   and they pass. Run the linter too. Report the commands and their actual output.
4. Each module carries a header comment citing the requirement IDs it implements, so SRS Appendix B traceability
   stays verifiable.

If you cannot honestly reach "complete", return status "partial" or "blocked" with a precise account of what is
missing. An honest partial is useful; a stub that reports success is not.`,
            { label: `impl:${u.id}`, phase: 'Implement', schema: IMPL_SCHEMA },
          ),
        ),
      )
      for (const r of out.filter(Boolean)) {
        implResults.push(r)
        if (r.publicInterface) built.push(`${r.unitId}: ${r.publicInterface}`)
      }
    }
  }

  const partials = implResults.filter((r) => r.status !== 'complete')
  log(`Implementation: ${implResults.filter((r) => r.status === 'complete').length}/${implResults.length} units complete` +
      (partials.length ? ` · incomplete: ${partials.map((r) => r.unitId).join(', ')}` : ''))
  const deviations = implResults.flatMap((r) => r.deviations || [])
  if (deviations.length) log(`${deviations.length} deviation(s) reported by implementers — carried into verification`)
}

if (MODE === 'implement') {
  return {
    mode: 'implement',
    units: implResults.map((r) => ({ id: r.unitId, status: r.status, files: (r.filesWritten || []).length })),
    deviations: implResults.flatMap((r) => r.deviations || []),
    note: 'Verification skipped (mode:"implement"). Re-run with mode:"verify" to test against the SRS.',
  }
}

// ---------------------------------------------------------------------------
// 7. Phase: Verify — every requirement, module and function, then Repair
// ---------------------------------------------------------------------------

const IMPL_DIGEST = implResults.length
  ? `WHAT WAS JUST BUILT (implementer self-reports — treat as claims to check, not facts):\n` +
    implResults.map((r) => `· ${r.unitId} [${r.status}] ${r.summary}`).join('\n') +
    (implResults.flatMap((r) => r.deviations || []).length
      ? `\nDeviations the implementers admitted to:\n` +
        implResults.flatMap((r) => r.deviations || []).map((d) => `  ! ${d}`).join('\n')
      : '')
  : 'No implementation ran in this invocation — verify the repository as it stands.'

function verifyPrompt(lane, round, priorFindings) {
  return `${CONTEXT}

${PLAN_BRIEF}

${IMPL_DIGEST}

YOU ARE A VERIFIER — lane "${lane.key}": ${lane.title}
${round > 1 ? `\nThis is RE-VERIFICATION round ${round}. Fixers claim to have addressed these findings — confirm each is
genuinely fixed by re-running the failing test, and report any that are not, plus anything the fix broke:\n${priorFindings}\n` : ''}
YOUR MANDATE
${lane.brief}

HOW TO WORK
- Read ${GEN}/requirements-inventory.json for the authoritative acceptance criteria, and the SRS text for wording.
- EXECUTE. A check may only be marked "pass" on the strength of a command you ran and output you observed. Reading
  the code and concluding it looks right is not evidence — if you could not run it, the status is "untestable" and
  you say why. Never report a measurement you did not take.
- Write your tests under \`tests/${lane.key}/\` — that directory is yours alone; other verifiers are running
  concurrently and own theirs. You may create test fixtures and seed data there.
- You may NOT edit application source code. You diagnose and propose fixes; a separate fixer applies them. The one
  exception is your own lane's test files.
- Report one check per requirement / module / function in scope — including the ones that pass. A silent omission
  reads as coverage that does not exist.
- Findings must be reproducible: give the concrete input/state and the wrong output you observed. Severity
  "blocker" = a v1.0 requirement is unmet or an ADR invariant is violated; "major" = works but violates the
  specified behaviour or numbers; "minor" = quality issue.

Return every check and every finding.`
}

phase('Verify')
log(`Verifying across ${LANES.length} lanes: ${LANES.map((l) => l.key).join(', ')}`)

// Latest result per lane. A re-verify round only re-runs the lanes that had failures,
// so lanes that passed cleanly must persist here or they vanish from the final matrix.
const latestByLane = new Map()
const record = (results) => { for (const r of results) if (r) latestByLane.set(r.lane, r) }

// Barrier is justified here: repair needs ALL findings at once to group them by owning
// file, otherwise two fixers race on the same file.
record(await parallel(
  LANES.map((lane) => () =>
    agent(verifyPrompt(lane, 1, ''), {
      label: `verify:${lane.key}`, phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high',
    }).then((r) => (r ? { ...r, lane: lane.key } : null)),
  ),
))

const history = []
let round = 0

while (round < MAX_REPAIR) {
  round++
  const laneResults = [...latestByLane.values()]
  const checks = laneResults.flatMap((r) => r.checks || [])
  const findings = laneResults
    .flatMap((r) => r.findings || [])
    .sort((a, b) => (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3))

  const failed = checks.filter((c) => c.status === 'fail' || c.status === 'not_implemented' || c.status === 'partial')
  log(`Round ${round}: ${checks.length} checks · ${failed.length} failing · ${findings.length} findings ` +
      `(${findings.filter((f) => f.severity === 'blocker').length} blocker, ${findings.filter((f) => f.severity === 'major').length} major)`)

  const actionable = findings.filter((f) => f.severity !== 'minor' || round === 1)
  if (!actionable.length) { log('No actionable findings — verification is clean.'); break }

  phase('Repair')
  const groups = groupFindings(actionable)
  const batches = batchByFileOwnership(groups.map((g) => ({ ...g, files: g.files })), 4)
  log(`Repairing ${actionable.length} finding(s) across ${groups.length} owner group(s) in ${batches.length} batch(es)`)

  const fixes = []
  for (const batch of batches) {
    const out = await parallel(
      batch.units.map((g) => () =>
        agent(
          `${CONTEXT}

${PLAN_BRIEF}

YOU ARE A FIXER. Verifiers found the problems below in code you own for this round: ${g.owner}

${g.findings.map((f) => `--- ${f.id} [${f.severity}] ${f.title}
Requirements: ${(f.requirements || []).join(', ') || 'n/a'}
Files: ${(f.files || []).join(', ')}${f.line ? ` (line ${f.line})` : ''}
Failure scenario: ${f.failureScenario}
Proposed fix: ${f.proposedFix}`).join('\n\n')}

RULES
- Edit only the files listed in these findings. Other fixers are working on other files concurrently.
- Fix the CAUSE, not the symptom, and never by weakening or deleting the test that caught it. If a test itself is
  wrong, say so in "rejected" with evidence instead of quietly changing it.
- A verifier can be mistaken. If a finding is wrong, put it in "rejected" with the evidence that disproves it —
  do not implement a change you believe is incorrect.
- After fixing, RUN the relevant tests (\`${plan.commands?.test || 'the project test command'}\`) and the linter,
  and confirm the specific failure scenario no longer reproduces. Report the commands and their output.
- Preserve every ADR invariant while fixing. A fix that satisfies a test by calling an adapter inline from a request
  handler, or by publishing unmoderated content, is not a fix.`,
          { label: `fix:${g.owner.split('/').pop() || g.owner}`, phase: 'Repair', schema: FIX_SCHEMA },
        ),
      ),
    )
    fixes.push(...out.filter(Boolean))
  }

  const resolvedIds = new Set(fixes.flatMap((f) => f.resolved || []))
  const rejected = fixes.flatMap((f) => f.rejected || [])
  history.push({ round, findings: actionable.length, resolved: resolvedIds.size, rejected: rejected.length })
  log(`Round ${round} repair: ${resolvedIds.size} resolved · ${rejected.length} disputed · ` +
      `${fixes.reduce((n, f) => n + (f.filesChanged || []).length, 0)} files changed`)

  if (round >= MAX_REPAIR) {
    log(`Repair budget exhausted after ${MAX_REPAIR} round(s) — remaining findings are reported, not fixed.`)
    break
  }

  // Re-verify only the lanes that actually had failures, plus the coverage lane
  // (a fix in one place can break a module elsewhere).
  const dirtyKeys = new Set(
    laneResults.filter((r) => (r.findings || []).some((f) => actionable.includes(f))).map((r) => r.lane),
  )
  const reLanes = LANES.filter((l) => dirtyKeys.has(l.key) || l.key === 'coverage')
  if (!reLanes.length) break

  phase('Verify')
  log(`Re-verifying ${reLanes.length} lane(s): ${reLanes.map((l) => l.key).join(', ')}`)
  const priorByLane = new Map(
    laneResults.map((r) => [r.lane, (r.findings || []).map((f) => `- ${f.id} [${f.severity}] ${f.title}`).join('\n')]),
  )
  record(await parallel(
    reLanes.map((lane) => () =>
      agent(verifyPrompt(lane, round + 1, priorByLane.get(lane.key) || ''), {
        label: `reverify:${lane.key}`, phase: 'Verify', schema: VERIFY_SCHEMA, effort: 'high',
      }).then((r) => (r ? { ...r, lane: lane.key } : null)),
    ),
  ))
}

// ---------------------------------------------------------------------------
// 8. Phase: Report — traceability matrix the team can hand to the professor
// ---------------------------------------------------------------------------

phase('Report')

const finalLaneResults = [...latestByLane.values()]
const finalChecks = finalLaneResults.flatMap((r) => r.checks || [])
const openFindings = finalLaneResults.flatMap((r) => r.findings || [])
const tally = (s) => finalChecks.filter((c) => c.status === s).length

const report = await agent(
  `${CONTEXT}

You are writing the verification report for the Homeplate team — the artifact that answers "which SRS requirements
are actually met, proven by which test?". SRS Appendix B is the shape the professor expects.

Latest verification results across ${finalLaneResults.length} lane(s):
${JSON.stringify({ checks: finalChecks, findings: openFindings, repairHistory: history }).slice(0, 120000)}

Do this:
1. Read ${GEN}/requirements-inventory.json and the current repository state. Verify the claims above against what
   is actually on disk — do not simply transcribe them. Where a lane claims a pass, spot-check that the cited test
   file exists and that the suite runs.
2. Run the full test suite and the linter once more yourself, and record the real output.
3. Write \`${REPO}/docs/verification-report.md\` containing:
   - A status line: date, commit (\`git rev-parse --short HEAD\`), commands run and their result.
   - A traceability table, one row per FR-01..FR-14, NFR-01..NFR-13, AB-01..AB-08:
     Requirement | Design element (SRS App. B) | Implementing file(s) | Test ID | Test file | Status | Evidence.
   - A section per open finding: severity, requirement, reproduction, proposed fix, why it is still open.
   - "Not verifiable in this environment" — checks marked untestable (real load at NFR-02 scale, the UT-01
     5-participant study, live TLS scanning), with what the team must do manually.
   - Measured numbers where the SRS demands them: NFR-01 p95 latency, NFR-05 lockout behaviour, NFR-10 FP/FN rates
     with the labeled-set size, NFR-12 erasure window coverage.
4. Be accurate over flattering. If coverage is thin or a requirement is unimplemented, the report says so plainly —
   this document is the team's evidence at CDR, and an overstated one is worse than none.

Return a concise summary: what is done, what is not, and the top things the team should do next.`,
  { label: 'report', phase: 'Report', effort: 'high' },
)

return {
  mode: MODE,
  plan: {
    requirements: (plan.requirements || []).length,
    waves: waves.map((w) => ({ name: w.name, units: (w.units || []).map((u) => u.id) })),
    openQuestions: plan.openQuestions || [],
  },
  implementation: implResults.map((r) => ({ id: r.unitId, status: r.status, files: (r.filesWritten || []).length })),
  verification: {
    lanes: LANES.map((l) => l.key),
    checks: finalChecks.length,
    pass: tally('pass'),
    fail: tally('fail'),
    partial: tally('partial'),
    notImplemented: tally('not_implemented'),
    untestable: tally('untestable'),
  },
  repairRounds: history,
  openFindings: openFindings.map((f) => ({ id: f.id, severity: f.severity, title: f.title, requirements: f.requirements })),
  artifacts: [
    `${GEN}/build-plan.md`,
    `${GEN}/requirements-inventory.json`,
    `${REPO}/docs/verification-report.md`,
  ],
  summary: report,
}
