'use strict';
// scripts/seed-demo.js — load the DEMO seed set (tests/fixtures/seed/demo.json) plus its
// photos into the local stack: `npm run seed:demo`.
//
// Why a separate loader (and not `npm run seed -- --set demo`): the base loader inserts a
// fixture verbatim, and a verbatim date goes stale — the base set's listings are already in
// the past, so FR-01 search (scheduled_start > now()) hides them and the only upcoming rows
// are the NFR-02 "Volume Dinner N" placeholders. The demo set therefore carries RELATIVE dates
// ({"$demoOffsetDays": N, "hour": H} → N days from today at H:00 in the meal time zone), which
// this script resolves at load time, and each media_objects row names the JPEG to upload
// ("$demoFile") so the listing photos actually exist in object storage (ADR-004) and the
// presigned URLs the API mints for them resolve.
//
// Idempotent: every INSERT is ON CONFLICT DO NOTHING (same contract as scripts/seed.js) and
// the S3 PUTs overwrite the same keys. Re-run after `docker compose down -v` + migrate.
// NFR-11: parameterized SQL only. Demo accounts (password "DemoPass123!") are listed in
// README.md — local development only; the fixture never ships to a real environment.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { S3Client, PutObjectCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');
// NFR-13: a demo user's `phone` is encrypted at load time with THIS environment's key, exactly
// as the app does — the fixture never carries ciphertext bound to one machine's key.
const fieldCrypto = require('../src/db/fieldCrypto');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'seed', 'demo.json');
const MEDIA_DIR = path.join(ROOT, 'tests', 'fixtures', 'seed', 'demo-media');
const TABLE_ORDER = [
  'users',
  'host_profiles',
  'listings',
  'media_objects',
  'bookings',
  'reviews',
  'messages',
];
const MEAL_TIME_ZONE = 'America/Los_Angeles';
// The meal time zone's UTC offset on the resolved day (PDT/PST), so "18:00 Pacific" is exact.
function pacificOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MEAL_TIME_ZONE,
    timeZoneName: 'shortOffset',
  }).formatToParts(date);
  const name = (parts.find((p) => p.type === 'timeZoneName') || {}).value || 'GMT-7';
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return -420;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] || 0));
}

/** Resolve {"$demoOffsetDays": N, "hour": H} to an ISO instant / a local date string. */
function resolveDate(spec, wantDateOnly) {
  const today = new Date();
  const base = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  base.setUTCDate(base.getUTCDate() + spec.$demoOffsetDays);
  const y = base.getUTCFullYear();
  const mo = String(base.getUTCMonth() + 1).padStart(2, '0');
  const d = String(base.getUTCDate()).padStart(2, '0');
  if (wantDateOnly) return `${y}-${mo}-${d}`;
  const hour = Number.isInteger(spec.hour) ? spec.hour : 18;
  const naive = new Date(Date.UTC(y, base.getUTCMonth(), base.getUTCDate(), hour, 0, 0));
  const offset = pacificOffsetMinutes(naive);
  return new Date(naive.getTime() - offset * 60 * 1000).toISOString();
}

function materialise(row, table) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('$')) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && '$demoOffsetDays' in value) {
      out[key] = resolveDate(value, key === 'local_date');
    } else {
      out[key] = value;
    }
  }
  if (table === 'media_objects' && row.$demoFile) {
    out.size_bytes = fs.statSync(path.join(MEDIA_DIR, row.$demoFile)).size;
  }
  return out;
}

function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`bad identifier ${name}`);
  return `"${name}"`;
}

async function insertRows(client, table, rows) {
  let inserted = 0;
  for (const row of rows) {
    const cols = Object.keys(row);
    const sql =
      `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')}) VALUES (` +
      cols.map((_, i) => `$${i + 1}`).join(', ') +
      ') ON CONFLICT DO NOTHING';
    const res = await client.query(
      sql,
      cols.map((c) => row[c])
    );
    inserted += res.rowCount;
  }
  return inserted;
}

async function uploadMedia(mediaRows, log) {
  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;
  const bucket = process.env.OBJECT_STORAGE_BUCKET;
  if (!endpoint || !bucket) {
    log.warn('seed:demo — OBJECT_STORAGE_* not configured; photos not uploaded');
    return 0;
  }
  const s3 = new S3Client({
    endpoint,
    region: process.env.OBJECT_STORAGE_REGION || 'us-east-1',
    forcePathStyle: String(process.env.OBJECT_STORAGE_FORCE_PATH_STYLE) !== 'false',
    credentials: {
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY,
      secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY,
    },
  });
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (err) {
    const code = err && (err.name || err.Code);
    if (code !== 'BucketAlreadyOwnedByYou' && code !== 'BucketAlreadyExists') throw err;
  }
  let n = 0;
  for (const row of mediaRows) {
    if (!row.$demoFile) continue;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: row.storage_key,
        Body: fs.readFileSync(path.join(MEDIA_DIR, row.$demoFile)),
        ContentType: row.content_type || 'image/jpeg',
      })
    );
    n += 1;
  }
  return n;
}

async function seedDemo({ databaseUrl = process.env.DATABASE_URL, log = console } = {}) {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set — cannot seed (see .env.example)');
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const counts = {};
  try {
    await client.query('BEGIN');
    for (const table of TABLE_ORDER) {
      const rows = (fixture[table] || []).map((r) => materialise(r, table));
      if (table === 'users') {
        // FR-09/NFR-06: publishing and reserving require a phone; the eligibility policy reads
        // phone_enc live, so a host seeded with can_publish_listing=true but no phone is refused
        // by POST /api/listings (found by the 2026-09-11 host-UI end-to-end run).
        for (const row of rows) {
          if (row.phone !== undefined) {
            row.phone_enc = fieldCrypto.encrypt(row.phone);
            delete row.phone;
          }
        }
      }
      counts[table] = await insertRows(client, table, rows);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
  const photos = await uploadMedia(fixture.media_objects || [], log);
  log.log(
    `seed:demo — ${Object.entries(counts)
      .map(([t, n]) => `${t} +${n}`)
      .join(', ')}; ${photos} photo(s) uploaded`
  );
  return { counts, photos };
}

if (require.main === module) {
  seedDemo().catch((err) => {
    console.error(`seed:demo failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { seedDemo, resolveDate };
