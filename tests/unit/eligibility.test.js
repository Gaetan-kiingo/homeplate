// tests/unit/eligibility.test.js — U2-ELIGIBILITY acceptance suite (build-plan wave 2).
//
// Requirement traceability (SRS Appendix B — TC-09, IT-02 groundwork):
//   FR-09  — restricted state: policy.evaluate / requireEligibility answer 403 + reason codes
//            for an ineligible user; permitted state: the identical request passes once the
//            missing attributes are set. (The /api/bookings and /api/listings route-level
//            assertions complete in wave 3; the policy itself is fully verified here.)
//   NFR-06 — truth-table over ALL 2^5 attribute combinations, in three accepted user shapes:
//            canReserveSeat true iff email_verified AND full_name AND phone;
//            canPublishListing additionally requires host_profile_complete AND
//            host_agreement_accepted_at; every false case yields machine-readable codes.
//   AB-01  — a host without the completed-profile/agreement gate cannot publish.
//   AB-02  — the gate blocks ineligible users before any capacity logic runs.
//   AB-08  — no PII in snapshots, decisions or error bodies (IDs + codes only).
//   ADR-006 — single-interface rule: a repository walk proves no second implementation of
//            either predicate exists anywhere else under src/.
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const policy = require('../../src/modules/eligibility/policy');
const repo = require('../../src/modules/eligibility/repo');
const { requireEligibility } = require('../../src/modules/eligibility/middleware');
const errorHandler = require('../../src/middleware/errorHandler');
const { AuthenticationError, ForbiddenError } = require('../../src/lib/errors');
const dbh = require('../helpers/db');

const { ACTIONS, REASONS } = policy;

afterAll(async () => {
  await dbh.closeDb();
});

// =============================================================================================
// NFR-06 truth table — all 2^5 combinations of the five policy attributes, in every accepted
// user shape. canReserveSeat depends ONLY on (email, name, phone) — the host attributes must
// never influence it — and canPublishListing requires all five.
// =============================================================================================
describe('truth table over all 2^5 attribute combinations (NFR-06, FR-09)', () => {
  const combos = [];
  for (let bits = 0; bits < 32; bits += 1) {
    combos.push({
      email: Boolean(bits & 1),
      name: Boolean(bits & 2),
      phone: Boolean(bits & 4),
      profile: Boolean(bits & 8),
      agreement: Boolean(bits & 16),
    });
  }

  const shapes = {
    'snake_case row with explicit host_profile_complete': (c) => ({
      email_verified: c.email,
      full_name: c.name ? 'Ada Lovelace' : null,
      phone_enc: c.phone ? 'enc:v1:aabbcc' : null,
      host_profile_complete: c.profile,
      host_agreement_accepted_at: c.agreement ? new Date('2026-08-01T00:00:00Z') : null,
    }),
    'row with nested host_profile object (bio-derived completeness)': (c) => ({
      email_verified: c.email,
      full_name: c.name ? 'Ada Lovelace' : null,
      phone_enc: c.phone ? 'enc:v1:aabbcc' : null,
      host_profile:
        c.profile || c.agreement
          ? {
              bio: c.profile ? 'I cook Oaxacan food on weekends.' : null,
              host_agreement_accepted_at: c.agreement ? new Date('2026-08-01T00:00:00Z') : null,
            }
          : null,
    }),
    'camelCase shape (service-layer objects)': (c) => ({
      emailVerified: c.email,
      fullName: c.name ? 'Ada Lovelace' : undefined,
      phone: c.phone ? '+1 619 555 0100' : undefined,
      hostProfileComplete: c.profile,
      hostAgreementAcceptedAt: c.agreement ? new Date('2026-08-01T00:00:00Z') : null,
    }),
  };

  for (const [shapeName, build] of Object.entries(shapes)) {
    test(`all 32 combinations — ${shapeName}`, () => {
      for (const c of combos) {
        const user = build(c);
        const expectedReserve = c.email && c.name && c.phone;
        const expectedPublish = expectedReserve && c.profile && c.agreement;
        expect({ combo: c, canReserveSeat: policy.canReserveSeat(user) }).toEqual({
          combo: c,
          canReserveSeat: expectedReserve,
        });
        expect({ combo: c, canPublishListing: policy.canPublishListing(user) }).toEqual({
          combo: c,
          canPublishListing: expectedPublish,
        });
      }
    });
  }

  test('reason codes are exact and deterministic for every false case', () => {
    for (const c of combos) {
      const user = shapes['snake_case row with explicit host_profile_complete'](c);
      const expectedReserve = [
        !c.email && REASONS.EMAIL_UNVERIFIED,
        !c.name && REASONS.NAME_MISSING,
        !c.phone && REASONS.PHONE_MISSING,
      ].filter(Boolean);
      const expectedPublish = [
        ...expectedReserve,
        !c.profile && REASONS.HOST_PROFILE_INCOMPLETE,
        !c.agreement && REASONS.HOST_AGREEMENT_MISSING,
      ].filter(Boolean);
      expect(policy.reasonsFor(user, ACTIONS.RESERVE_SEAT)).toEqual(expectedReserve);
      expect(policy.reasonsFor(user, ACTIONS.PUBLISH_LISTING)).toEqual(expectedPublish);
    }
  });

  test('blank-string name/phone/bio count as missing, not present', () => {
    const user = {
      email_verified: true,
      full_name: '   ',
      phone_enc: '',
      host_profile: { bio: '  \t ', host_agreement_accepted_at: new Date() },
    };
    expect(policy.canReserveSeat(user)).toBe(false);
    expect(policy.reasonsFor(user, ACTIONS.PUBLISH_LISTING)).toEqual([
      REASONS.NAME_MISSING,
      REASONS.PHONE_MISSING,
      REASONS.HOST_PROFILE_INCOMPLETE,
    ]);
  });

  test('unknown action fails fast; non-object user fails fast', () => {
    expect(() => policy.reasonsFor({}, 'delete_everything')).toThrow(RangeError);
    expect(() => policy.canReserveSeat(null)).toThrow(TypeError);
    expect(() => policy.assertAction('nope')).toThrow(RangeError);
    expect(policy.assertAction(ACTIONS.RESERVE_SEAT)).toBe(ACTIONS.RESERVE_SEAT);
  });
});

// =============================================================================================
// policy.evaluate(userId, action[, client]) against the real schema (FR-09, NFR-06, NFR-12).
// Runs inside always-rolled-back transactions so no test data leaks into the shared DB.
// =============================================================================================
describe('evaluate(userId, action) — DB-backed decisions (FR-09, NFR-06)', () => {
  test('restricted then permitted: publish_listing flips once profile + agreement exist (AB-01)', async () => {
    await dbh.withRollback(async (client) => {
      const user = await dbh.makeUser({ phone_enc: 'enc:v1:phone' }, client);

      // Verified email + name + phone: may reserve, may NOT publish.
      await expect(policy.evaluate(user.id, ACTIONS.RESERVE_SEAT, client)).resolves.toEqual({
        allowed: true,
        reasons: [],
      });
      await expect(policy.evaluate(user.id, ACTIONS.PUBLISH_LISTING, client)).resolves.toEqual({
        allowed: false,
        reasons: [REASONS.HOST_PROFILE_INCOMPLETE, REASONS.HOST_AGREEMENT_MISSING],
      });

      // The identical check succeeds once the missing attributes are set (FR-09 both states).
      await dbh.makeHostProfile(
        { user_id: user.id, bio: 'Home cook.', host_agreement_accepted_at: new Date() },
        client
      );
      await expect(policy.evaluate(user.id, ACTIONS.PUBLISH_LISTING, client)).resolves.toEqual({
        allowed: true,
        reasons: [],
      });
    });
  });

  test('each missing publish attribute is reported independently', async () => {
    await dbh.withRollback(async (client) => {
      const noAgreement = await dbh.makeUser({ phone_enc: 'enc:v1:phone' }, client);
      await dbh.makeHostProfile(
        { user_id: noAgreement.id, bio: 'Bio present.', host_agreement_accepted_at: null },
        client
      );
      await expect(
        policy.evaluate(noAgreement.id, ACTIONS.PUBLISH_LISTING, client)
      ).resolves.toEqual({ allowed: false, reasons: [REASONS.HOST_AGREEMENT_MISSING] });

      const noBio = await dbh.makeUser({ phone_enc: 'enc:v1:phone' }, client);
      await dbh.makeHostProfile(
        { user_id: noBio.id, bio: null, host_agreement_accepted_at: new Date() },
        client
      );
      await expect(policy.evaluate(noBio.id, ACTIONS.PUBLISH_LISTING, client)).resolves.toEqual({
        allowed: false,
        reasons: [REASONS.HOST_PROFILE_INCOMPLETE],
      });
    });
  });

  test('reserve_seat reports every missing base attribute with stable ordering', async () => {
    await dbh.withRollback(async (client) => {
      const user = await dbh.makeUser(
        { email_verified: false, full_name: null, phone_enc: null },
        client
      );
      await expect(policy.evaluate(user.id, ACTIONS.RESERVE_SEAT, client)).resolves.toEqual({
        allowed: false,
        reasons: [REASONS.EMAIL_UNVERIFIED, REASONS.NAME_MISSING, REASONS.PHONE_MISSING],
      });
    });
  });

  test('denormalized users.can_* flags are outputs, never rule inputs (ADR-006)', async () => {
    await dbh.withRollback(async (client) => {
      // Flags claim "may publish" but the real attributes say otherwise — the policy must
      // read the attributes (source of truth), not trust the projection.
      const user = await dbh.makeUser(
        { can_publish_listing: true, can_reserve_seat: true, phone_enc: null },
        client
      );
      const publish = await policy.evaluate(user.id, ACTIONS.PUBLISH_LISTING, client);
      expect(publish.allowed).toBe(false);
      expect(publish.reasons).toContain(REASONS.PHONE_MISSING);
      expect(publish.reasons).toContain(REASONS.HOST_PROFILE_INCOMPLETE);
    });
  });

  test('deleted, anonymized, unknown and malformed user ids are USER_NOT_FOUND (NFR-12)', async () => {
    await dbh.withRollback(async (client) => {
      const deleted = await dbh.makeUser(
        { phone_enc: 'enc:v1:phone', deleted_at: new Date() },
        client
      );
      const anonymized = await dbh.makeUser(
        { phone_enc: 'enc:v1:phone', anonymized_at: new Date() },
        client
      );
      const notFound = { allowed: false, reasons: [REASONS.USER_NOT_FOUND] };
      await expect(policy.evaluate(deleted.id, ACTIONS.RESERVE_SEAT, client)).resolves.toEqual(
        notFound
      );
      await expect(policy.evaluate(anonymized.id, ACTIONS.RESERVE_SEAT, client)).resolves.toEqual(
        notFound
      );
      await expect(
        policy.evaluate('00000000-0000-4000-8000-000000000000', ACTIONS.RESERVE_SEAT, client)
      ).resolves.toEqual(notFound);
      // Malformed id: answered as not-found, never a PostgreSQL cast error / 500.
      await expect(policy.evaluate("' OR 1=1 --", ACTIONS.RESERVE_SEAT, client)).resolves.toEqual(
        notFound
      );
    });
  });

  test('evaluate rejects programmer misuse fast', async () => {
    await expect(policy.evaluate(42, ACTIONS.RESERVE_SEAT)).rejects.toThrow(TypeError);
    await expect(
      policy.evaluate('00000000-0000-4000-8000-000000000000', 'fly_to_moon')
    ).rejects.toThrow(RangeError);
  });

  test('repo snapshot carries presence booleans only — no PII keys (AB-08, NFR-13)', async () => {
    await dbh.withRollback(async (client) => {
      const user = await dbh.makeUser({ phone_enc: 'enc:v1:phone' }, client);
      const snapshot = await repo.getEligibilityAttributes(user.id, client);
      expect(Object.keys(snapshot).sort()).toEqual([
        'email_verified',
        'has_full_name',
        'has_phone',
        'host_agreement_accepted_at',
        'host_profile_complete',
        'user_id',
      ]);
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain(user.email);
      expect(serialized).not.toContain('enc:v1:phone');
      expect(serialized).not.toContain(user.full_name);
    });
  });
});

// =============================================================================================
// requireEligibility(action) middleware through a real Express app (FR-09, AB-02, AB-08).
// Uses committed fixture rows because the middleware evaluates on the shared pool; the
// factories generate collision-proof rows and globalSetup reseeds the DB every run.
// =============================================================================================
describe('requireEligibility(action) middleware (FR-09, AB-02, AB-08)', () => {
  function makeApp(action, { userId } = {}) {
    const app = express();
    app.use((req, _res, next) => {
      if (userId) req.auth = { userId, sessionId: 'test-session', roles: ['user'] };
      next();
    });
    app.post('/protected', requireEligibility(action), (req, res) =>
      res.status(200).json({ ok: true, eligibility: req.eligibility })
    );
    app.use(errorHandler);
    return app;
  }

  test('403 with machine-readable reason codes when not eligible; 200 once attributes exist', async () => {
    const user = await dbh.makeUser({ phone_enc: null }); // verified + named, but no phone

    const blocked = await request(makeApp(ACTIONS.RESERVE_SEAT, { userId: user.id }))
      .post('/protected')
      .expect(403);
    expect(blocked.body.error.code).toBe('NOT_ELIGIBLE');
    expect(blocked.body.error.details).toEqual({
      action: ACTIONS.RESERVE_SEAT,
      reasons: [REASONS.PHONE_MISSING],
    });
    // AB-08: the error body never carries personal data.
    expect(JSON.stringify(blocked.body)).not.toContain(user.email);

    // Permitted state: set the missing attribute, the identical request succeeds (FR-09).
    await dbh.query('UPDATE users SET phone_enc = $1 WHERE id = $2', ['enc:v1:phone', user.id]);
    const ok = await request(makeApp(ACTIONS.RESERVE_SEAT, { userId: user.id }))
      .post('/protected')
      .expect(200);
    expect(ok.body).toEqual({
      ok: true,
      eligibility: { action: ACTIONS.RESERVE_SEAT, allowed: true, reasons: [] },
    });
  });

  test('publish_listing gate blocks a host without profile + agreement (AB-01)', async () => {
    const user = await dbh.makeUser({ phone_enc: 'enc:v1:phone' });
    const res = await request(makeApp(ACTIONS.PUBLISH_LISTING, { userId: user.id }))
      .post('/protected')
      .expect(403);
    expect(res.body.error.code).toBe('NOT_ELIGIBLE');
    expect(res.body.error.details.reasons).toEqual([
      REASONS.HOST_PROFILE_INCOMPLETE,
      REASONS.HOST_AGREEMENT_MISSING,
    ]);
  });

  test('401 when there is no authenticated user — never a data-bearing response (AB-08)', async () => {
    const res = await request(makeApp(ACTIONS.RESERVE_SEAT)).post('/protected').expect(401);
    expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  test('403 USER_NOT_FOUND when the session points at an erased account (NFR-12)', async () => {
    const user = await dbh.makeUser({ phone_enc: 'enc:v1:phone', deleted_at: new Date() });
    const res = await request(makeApp(ACTIONS.RESERVE_SEAT, { userId: user.id }))
      .post('/protected')
      .expect(403);
    expect(res.body.error.details.reasons).toEqual([REASONS.USER_NOT_FOUND]);
  });

  test('a typo’d action name fails at route-definition time, not at request time', () => {
    expect(() => requireEligibility('resserve_seat')).toThrow(RangeError);
  });

  test('middleware errors use the shared taxonomy (401/403 from src/lib/errors)', () => {
    // Guards the errorHandler contract: status/code come from AppError subclasses.
    expect(new AuthenticationError().status).toBe(401);
    expect(new ForbiddenError('x', { code: 'NOT_ELIGIBLE' }).status).toBe(403);
  });
});

// =============================================================================================
// ADR-006 single-interface rule — repository walk: no file under src/ outside
// src/modules/eligibility/ may implement canReserveSeat or canPublishListing.
// =============================================================================================
describe('ADR-006 — single eligibility interface (grep test)', () => {
  const SRC_ROOT = path.resolve(__dirname, '..', '..', 'src');
  const ELIGIBILITY_DIR = path.join(SRC_ROOT, 'modules', 'eligibility');

  function listJsFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listJsFiles(full));
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  // Definition patterns: function declarations, function/arrow expressions assigned to the
  // predicate name (as a variable or object property) and shorthand methods. Importing or
  // CALLING the policy's predicates does not match — only re-implementing them does.
  function definitionPatterns(name) {
    return [
      new RegExp(`function\\s+${name}\\b`),
      new RegExp(`${name}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\()`),
      new RegExp(`(?:^|\\s)(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`, 'm'),
    ];
  }

  test('canReserveSeat / canPublishListing are implemented exactly once, in the policy module', () => {
    const offenders = [];
    for (const file of listJsFiles(SRC_ROOT)) {
      if (file.startsWith(ELIGIBILITY_DIR + path.sep)) continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const name of ['canReserveSeat', 'canPublishListing']) {
        if (definitionPatterns(name).some((re) => re.test(source))) {
          offenders.push(`${path.relative(SRC_ROOT, file)} defines ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);

    // …and the canonical implementation really lives in the policy module.
    const policySource = fs.readFileSync(path.join(ELIGIBILITY_DIR, 'policy.js'), 'utf8');
    expect(policySource).toMatch(/function\s+canReserveSeat\b/);
    expect(policySource).toMatch(/function\s+canPublishListing\b/);
    expect(typeof policy.canReserveSeat).toBe('function');
    expect(typeof policy.canPublishListing).toBe('function');
  });
});
