// tests/adr-conformance/route-layer-db-access.test.js — the ROUTE LAYER OWNS NO DATA ACCESS.
//
// Why this file exists: findings W3-ADR-04 / COV-07 (round 1) and STS-R2-05 / ADRC2-03 (round 2)
// all reported the same defect — src/modules/media/routes.js executed
// `SELECT author_id FROM reviews WHERE id = $1` inside the request handler assertEntityAttachable
// and imported { query } from src/db/pool for that one statement. It was the last database access
// left in any route file. Three verification rounds found it by hand; from here a static check
// fails CI instead.
//
// Requirement / decision traceability (SRS Appendix B):
//   ADR-001/003 — modular-monolith layering: routes validate and translate HTTP, services
//            orchestrate, repos own SQL. A route that queries directly bypasses the layer that
//            the transaction/outbox rules are written against, so the "one transaction, no dual
//            writes" invariant becomes unenforceable by inspection.
//   NFR-11 / AB-06 — all SQL is parameterized and lives in one auditable layer per module. The
//            statement removed here was already parameterized (this was a layering defect, not
//            an injection defect), but confining SQL to repos is what makes NFR-11 checkable at
//            all: a reviewer reads src/modules/*/repo.js and is done.
//   FR-05 / AB-08 — the media attach path still refuses a photo aimed at a review the caller did
//            not write. The behavioural half of this file proves the refactor kept 404/403/201
//            exactly as before, because no other suite exercised the review branch.
//
// RESOLVED (wave-4 verification, 2026-08-21): the authorship SQL now lives in its owning
// module, src/modules/reviews/repo.js (U4-REVIEWS), and src/modules/media/repo.js re-exports
// the SAME function object unchanged. The lane's decision is to KEEP that delegation rather
// than repoint src/modules/media/routes.js at the reviews repo: the SQL exists exactly once
// (NFR-11 stays auditable per module), the media routes keep depending only on their own
// module's repo facade (ADR-001 layering — a module consumes another's published contract
// through its own boundary), and the identity assertion below turns the delegation into a
// verified invariant — a quiet re-implementation inside the media module would fail here.
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const config = require('../../src/config');
const { createApp } = require('../../src/app');
const mediaUrls = require('../../src/lib/mediaUrls');
const mediaRepo = require('../../src/modules/media/repo');
const sessions = require('../../src/modules/auth/sessions');
const dbh = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');

const ROOT = path.join(__dirname, '..', '..');

// ---------------------------------------------------------------------------------------------
// Route-file discovery (dynamic — a wave-4 module's routes.js is covered the day it lands)
// ---------------------------------------------------------------------------------------------

/** Every file that IS the HTTP surface: src/routes/*.js plus src/modules/<m>/routes.js. */
function routeLayerFiles() {
  const files = [];
  const registryDir = path.join(ROOT, 'src', 'routes');
  for (const entry of fs.readdirSync(registryDir)) {
    if (entry.endsWith('.js')) files.push(path.join(registryDir, entry));
  }
  const modulesDir = path.join(ROOT, 'src', 'modules');
  for (const mod of fs.readdirSync(modulesDir)) {
    const candidate = path.join(modulesDir, mod, 'routes.js');
    if (fs.existsSync(candidate)) files.push(candidate);
  }
  return files.sort();
}

/** Source with line and block comments blanked out, so a CODE rule never fires on prose. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const rel = (file) => path.relative(ROOT, file);

describe('ADR-001 layering — no data access in the route layer (W3-ADR-04 / COV-07 / STS-R2-05)', () => {
  const files = routeLayerFiles();

  test('the check is aimed at a real, non-empty route layer', () => {
    // A discovery bug that finds nothing would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files.map(rel)).toContain(path.join('src', 'modules', 'media', 'routes.js'));
    expect(files.map(rel)).toContain(path.join('src', 'routes', 'index.js'));
  });

  test('no route file imports a database handle (src/db/pool, src/db/tx or pg itself)', () => {
    const offenders = [];
    // require('…/db/pool'), require('…/db/tx'), require('pg') — in any relative depth.
    const dbImport = /require\(\s*['"]([^'"]*\bdb\/(pool|tx)|pg)['"]\s*\)/;
    for (const file of files) {
      stripComments(fs.readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          if (dbImport.test(line)) offenders.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  test('no route file contains an executable SQL statement', () => {
    const offenders = [];
    // Shapes, not bare keywords: "SELECT <col>", "INSERT INTO", "UPDATE <t> SET", "DELETE FROM".
    const sql = /\bSELECT\s+[\w*"(]|\bINSERT\s+INTO\s|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\s/i;
    for (const file of files) {
      stripComments(fs.readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          if (sql.test(line)) offenders.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  test('the media attach path reaches review authorship through a repo, not a pool', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'media', 'routes.js'), 'utf8');
    expect(source).toContain('mediaRepo.findReviewAuthorId(');
    expect(typeof mediaRepo.findReviewAuthorId).toBe('function');
    // The delegation decision (header note): the media repo export IS the reviews module's
    // published function — one SQL home, no silent re-implementation.
    const reviewsRepo = require('../../src/modules/reviews/repo');
    expect(mediaRepo.findReviewAuthorId).toBe(reviewsRepo.findReviewAuthorId);
    // The removed import, spelled as it was, must not come back.
    expect(stripComments(source)).not.toContain("require('../../db/pool')");
  });
});

// ---------------------------------------------------------------------------------------------
// Behavioural half: the refactor changed the layer, not the contract (FR-05 / AB-08)
// ---------------------------------------------------------------------------------------------

describe('FR-05 / AB-08 — attaching media to a review still enforces authorship', () => {
  let app;
  let author;
  let authorCookie;
  let stranger;
  let strangerCookie;
  let ownReview;
  let othersReview;

  async function cookieFor(user) {
    const { token } = await sessions.createSession({ id: user.id, roles: user.roles });
    return `${config.auth.sessionCookieName}=${token}`;
  }

  /** An approved review authored by `guest` on their own booking of a fresh listing. */
  async function makeReviewBy(guest) {
    const listing = await dbh.makeListing({});
    const booking = await dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id });
    return dbh.insertRow('reviews', {
      booking_id: booking.id,
      author_id: guest.id,
      target_user_id: listing.host_id,
      rating: 5,
      body: 'Route-layer conformance fixture.',
      moderation_status: 'approved',
    });
  }

  /** Mint a real server-issued key in the caller's own namespace (AB-08). */
  function mintReviewKey(userId) {
    return mediaUrls.createUploadTarget(userId, 'review', 'image/jpeg', { sizeBytes: 2048 })
      .storageKey;
  }

  beforeAll(async () => {
    app = createApp();
    author = await dbh.makeUser({ full_name: 'Review Author' });
    stranger = await dbh.makeUser({ full_name: 'Unrelated User' });
    authorCookie = await cookieFor(author);
    strangerCookie = await cookieFor(stranger);
    ownReview = await makeReviewBy(author);
    othersReview = await makeReviewBy(stranger);
  });

  afterAll(async () => {
    await dbh.closeDb();
    await closeTestRedis();
  });

  test('an unknown review id is 404 (never a 500)', async () => {
    const res = await request(app)
      .post('/api/media')
      .set('Cookie', authorCookie)
      .send({
        storageKey: mintReviewKey(author.id),
        kind: 'review',
        entityId: '99999999-9999-4999-8999-999999999999',
      });
    expect(res.status).toBe(404);
  });

  test("someone else's review is 403 MEDIA_ENTITY_NOT_OWNED, and nothing is recorded", async () => {
    const storageKey = mintReviewKey(author.id);
    const res = await request(app)
      .post('/api/media')
      .set('Cookie', authorCookie)
      .send({ storageKey, kind: 'review', entityId: othersReview.id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MEDIA_ENTITY_NOT_OWNED');
    // Scoped to the key this test minted — never a whole-table scan (suite determinism).
    expect(await mediaRepo.findByKey(storageKey)).toBeNull();
  });

  test("the caller's own review accepts the attachment (201)", async () => {
    const storageKey = mintReviewKey(author.id);
    const res = await request(app)
      .post('/api/media')
      .set('Cookie', authorCookie)
      .send({ storageKey, kind: 'review', entityId: ownReview.id });
    expect(res.status).toBe(201);
    expect(res.body.media).toMatchObject({ kind: 'review', entityId: ownReview.id, storageKey });

    const stored = await mediaRepo.findByKey(storageKey);
    expect(stored).toMatchObject({ ownerUserId: author.id, entityId: ownReview.id });
  });

  test('a review whose author was anonymized (NFR-12) is attachable by nobody', async () => {
    // author_id NULL is the retained-but-severed shape the erasure path leaves behind.
    const listing = await dbh.makeListing({});
    const booking = await dbh.makeBooking({ listing_id: listing.id, guest_id: stranger.id });
    const anonymized = await dbh.insertRow('reviews', {
      booking_id: booking.id,
      author_id: null,
      target_user_id: listing.host_id,
      rating: 4,
      body: 'Anonymized fixture.',
      moderation_status: 'approved',
    });

    const res = await request(app)
      .post('/api/media')
      .set('Cookie', strangerCookie)
      .send({ storageKey: mintReviewKey(stranger.id), kind: 'review', entityId: anonymized.id });
    // Found (so not 404) but owned by no one (so 403) — the null-author case the repo function
    // must keep distinguishable from "no such review".
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MEDIA_ENTITY_NOT_OWNED');
  });

  test('findReviewAuthorId distinguishes "no such review" from "author severed"', async () => {
    expect(await mediaRepo.findReviewAuthorId('11111111-1111-4111-8111-111111111111')).toBeNull();
    expect(await mediaRepo.findReviewAuthorId(ownReview.id)).toEqual({ authorId: author.id });
  });
});
