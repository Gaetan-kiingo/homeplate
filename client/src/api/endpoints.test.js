// client/src/api/endpoints.test.js — U5-API-CLIENT acceptance: the endpoint SURFACE.
// Three gates (build-plan §6.1 5B):
//   1. Every api.* function issues exactly the METHOD + PATH it documents, with
//      credentials:'include' (NFR-03/AB-05) — asserted per call, table-driven, and the
//      table must cover EVERY exported function (no unlisted endpoint can sneak in).
//   2. Existence gate: every client /api endpoint exists in src/modules/*/routes.js ON THIS
//      TREE — parsed from the backend sources at test time, so a client-invented route
//      fails here, not in wave 6.
//   3. Grep gate: zero document-cookie references anywhere under client/src (the session
//      cookie is opaque HttpOnly and is never read — NFR-03/AB-05).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientSrcDir = path.resolve(here, '..'); // client/src
const repoRoot = path.resolve(here, '..', '..', '..'); // repository root
const modulesDir = path.join(repoRoot, 'src', 'modules');

const UUID = '0b96895d-3d10-4a56-9d1e-2f4c8a7b6c5d';

// ---- backend surface, parsed from src/modules/*/routes.js on this tree -----------------

/** Parse `router.<method>('<path>')` declarations plus the module's mount base path. */
function backendRouteSet() {
  const routes = new Set();
  for (const name of fs.readdirSync(modulesDir)) {
    const routesPath = path.join(modulesDir, name, 'routes.js');
    if (!fs.existsSync(routesPath)) continue;
    const sourceText = fs.readFileSync(routesPath, 'utf8');
    // The mount base path comes from the module's export (src/routes/index.js contract):
    // `module.exports = { basePath: '/api...', router }` or the default /api/<name>.
    const basePathMatch = sourceText.match(/module\.exports\s*=\s*\{\s*basePath:\s*'([^']+)'/);
    const basePath = basePathMatch ? basePathMatch[1] : `/api/${name}`;
    const routeRe = /router\.(get|post|patch|put|delete)\(\s*(?:'([^']*)'|`([^`]*)`)/g;
    let match;
    while ((match = routeRe.exec(sourceText)) !== null) {
      let sub = match[2] !== undefined ? match[2] : match[3];
      // listings routes interpolate a UUID-constrained param: `/${UUID_PARAM}` → /:id
      sub = sub.replace(/\$\{UUID_PARAM\}/g, ':id');
      // strip inline param constraints: :id([0-9a-f]{8}-...) → :id
      sub = sub.replace(/:([A-Za-z0-9_]+)\([^)]*\)/g, ':$1');
      const full = `${basePath}${sub === '/' ? '' : sub}`;
      routes.add(`${match[1].toUpperCase()} ${full}`);
    }
  }
  return routes;
}

// ---- the client surface manifest -------------------------------------------------------
// One row per exported api function that targets /api. `expected` is 'METHOD /path' with
// ids normalized to :id. A completeness check below fails if any exported function is
// missing from this table.

const surface = [
  {
    name: 'auth.register',
    call: () => api.auth.register({ email: 'a@b.c', password: 'x', fullName: 'A' }),
    expected: 'POST /api/auth/register',
  },
  {
    name: 'auth.login',
    call: () => api.auth.login({ email: 'a@b.c', password: 'x' }),
    expected: 'POST /api/auth/login',
  },
  {
    name: 'auth.logout',
    call: () => api.auth.logout(),
    expected: 'POST /api/auth/logout',
    status: 204,
  },
  {
    name: 'auth.verifyEmail',
    call: () => api.auth.verifyEmail('tok'),
    expected: 'POST /api/auth/verify-email',
  },
  {
    name: 'auth.verifyEmailFromLink',
    call: () => api.auth.verifyEmailFromLink('tok'),
    expected: 'GET /api/auth/verify-email',
    query: '?token=tok',
  },
  {
    name: 'auth.resendVerification',
    call: () => api.auth.resendVerification('a@b.c'),
    expected: 'POST /api/auth/resend-verification',
  },
  { name: 'users.me', call: () => api.users.me(), expected: 'GET /api/users/me' },
  {
    name: 'users.updateMe',
    call: () => api.users.updateMe({ fullName: 'B' }),
    expected: 'PATCH /api/users/me',
  },
  {
    name: 'users.requestDeletion',
    call: () => api.users.requestDeletion(),
    expected: 'DELETE /api/users/me',
  },
  {
    name: 'users.requestExport',
    call: () => api.users.requestExport(),
    expected: 'POST /api/users/me/export',
  },
  {
    name: 'users.getExport',
    call: () => api.users.getExport(UUID),
    expected: 'GET /api/users/me/export/:id',
  },
  {
    name: 'listings.create',
    call: () => api.listings.create({ title: 't' }),
    expected: 'POST /api/listings',
  },
  {
    name: 'listings.getListing',
    call: () => api.listings.getListing(UUID),
    expected: 'GET /api/listings/:id',
  },
  {
    name: 'listings.update',
    call: () => api.listings.update(UUID, { title: 't' }),
    expected: 'PATCH /api/listings/:id',
  },
  {
    name: 'listings.cancel',
    call: () => api.listings.cancel(UUID),
    expected: 'POST /api/listings/:id/cancel',
  },
  {
    name: 'search',
    call: () => api.search({ cuisine: 'thai' }),
    expected: 'GET /api/listings/search',
    query: '?cuisine=thai',
  },
  { name: 'hosts.getHost', call: () => api.hosts.getHost(UUID), expected: 'GET /api/hosts/:id' },
  {
    name: 'hosts.reviews',
    call: () => api.hosts.reviews(UUID, { page: 1 }),
    expected: 'GET /api/hosts/:id/reviews',
    query: '?page=1',
  },
  {
    name: 'bookings.create',
    call: () => api.bookings.create(UUID),
    expected: 'POST /api/bookings',
  },
  {
    name: 'bookings.list',
    call: () => api.bookings.list({ role: 'guest' }),
    expected: 'GET /api/bookings',
    query: '?role=guest',
  },
  {
    name: 'bookings.getBooking',
    call: () => api.bookings.getBooking(UUID),
    expected: 'GET /api/bookings/:id',
  },
  {
    name: 'bookings.cancel',
    call: () => api.bookings.cancel(UUID),
    expected: 'POST /api/bookings/:id/cancel',
  },
  {
    name: 'bookings.confirmCompletion',
    call: () => api.bookings.confirmCompletion(UUID),
    expected: 'POST /api/bookings/:id/confirm-completion',
  },
  {
    name: 'messages.send',
    call: () => api.messages.send(UUID, 'hello'),
    expected: 'POST /api/bookings/:id/messages',
  },
  {
    name: 'messages.list',
    call: () => api.messages.list(UUID),
    expected: 'GET /api/bookings/:id/messages',
  },
  {
    name: 'reviews.create',
    call: () => api.reviews.create(UUID, { rating: 5, comment: 'good' }),
    expected: 'POST /api/bookings/:id/reviews',
  },
  {
    name: 'safety.raiseAlert',
    call: () => api.safety.raiseAlert(UUID),
    expected: 'POST /api/bookings/:id/safety-alerts',
  },
  {
    name: 'safety.listModerationAlerts',
    call: () => api.safety.listModerationAlerts(),
    expected: 'GET /api/moderation/alerts',
  },
  {
    name: 'safety.escalateAlert',
    call: () => api.safety.escalateAlert({ bookingId: UUID }),
    expected: 'POST /api/moderation/alerts',
  },
  {
    name: 'moderation.queue',
    call: () => api.moderation.queue({ status: 'open' }),
    expected: 'GET /api/moderation/queue',
    query: '?status=open',
  },
  {
    name: 'moderation.decide',
    call: () => api.moderation.decide(UUID, { decision: 'approve', category: 'benign' }),
    expected: 'POST /api/moderation/queue/:id/decision',
  },
  {
    name: 'media.createUploadTarget',
    call: () =>
      api.media.createUploadTarget({ kind: 'listing', contentType: 'image/jpeg', sizeBytes: 1 }),
    expected: 'POST /api/media/uploads',
  },
  {
    name: 'media.attach',
    call: () => api.media.attach({ storageKey: 'k', kind: 'listing' }),
    expected: 'POST /api/media',
  },
  {
    name: 'media.remove',
    call: () => api.media.remove(UUID),
    expected: 'DELETE /api/media/:id',
    status: 204,
  },
];

/** Normalize a recorded URL: strip the query string, replace UUID segments with :id. */
function normalize(url) {
  const [pathname] = url.split('?');
  return pathname.replace(
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
    ':id'
  );
}

function fakeResponse(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (status === 204 ? '' : '{}'),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('every api.* call issues its documented METHOD + /api path with credentials included', () => {
  it.each(surface.map((row) => [row.name, row]))('%s', async (_name, row) => {
    const fn = vi.fn().mockResolvedValue(fakeResponse(row.status ?? 200));
    vi.stubGlobal('fetch', fn);
    await row.call();
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0];
    const [expectedMethod, expectedPath] = row.expected.split(' ');
    expect(init.method).toBe(expectedMethod);
    expect(normalize(url)).toBe(expectedPath);
    if (row.query) expect(url.endsWith(row.query)).toBe(true);
    // NFR-03/AB-05: the opaque HttpOnly cookie rides EVERY API call.
    expect(init.credentials).toBe('include');
  });

  it('the manifest covers EVERY exported api function (nothing unlisted can exist)', () => {
    const listed = new Set(surface.map((row) => row.name));
    const missing = [];
    for (const [resource, mod] of Object.entries(api)) {
      if (typeof mod === 'function') {
        // api.search is itself the callable search endpoint.
        if (!listed.has(resource)) missing.push(resource);
        continue;
      }
      for (const [fnName, value] of Object.entries(mod)) {
        if (typeof value !== 'function') continue;
        const qualified = `${resource}.${fnName}`;
        // uploadToTarget targets the server-minted STORAGE url, not /api — pinned below.
        if (qualified === 'media.uploadToTarget') continue;
        if (!listed.has(qualified)) missing.push(qualified);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('existence gate: no client endpoint without a backend route (build-plan §6.1 5B)', () => {
  it('every manifest endpoint is declared in src/modules/*/routes.js on this tree', () => {
    const backend = backendRouteSet();
    // Guard the parser itself: the backend surface is known to be non-trivial.
    expect(backend.size).toBeGreaterThanOrEqual(25);
    const unmatched = surface
      .map((row) => row.expected)
      .filter((expected) => !backend.has(expected));
    expect(unmatched).toEqual([]);
  });
});

describe('media.uploadToTarget — the ONE non-/api call (direct-to-storage PUT, ADR-004)', () => {
  const target = {
    uploadUrl: 'https://storage.example/homeplate-media/listing/u1/key.jpg?sig=abc',
    headers: { 'Content-Type': 'image/jpeg' },
    storageKey: 'listing/u1/key.jpg',
  };

  it("PUTs to the server-minted URL with credentials:'omit' (never the session cookie)", async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fn);
    await expect(api.media.uploadToTarget(target, new Blob(['x']))).resolves.toEqual({
      storageKey: 'listing/u1/key.jpg',
    });
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe(target.uploadUrl);
    expect(init.method).toBe('PUT');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toEqual({ 'Content-Type': 'image/jpeg' });
  });

  it('maps a non-2xx storage answer to MEDIA_UPLOAD_FAILED and transport failure to NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 403 }));
    await expect(api.media.uploadToTarget(target, new Blob(['x']))).rejects.toMatchObject({
      code: 'MEDIA_UPLOAD_FAILED',
      status: 403,
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')));
    await expect(api.media.uploadToTarget(target, new Blob(['x']))).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      status: 0,
    });
  });

  it('refuses a malformed target instead of PUTting to nowhere', async () => {
    await expect(api.media.uploadToTarget({}, new Blob(['x']))).rejects.toBeInstanceOf(TypeError);
  });
});

describe('grep gate: the opaque HttpOnly session cookie is never read (NFR-03/AB-05)', () => {
  it('zero document-cookie references under client/src', () => {
    const offenders = [];
    const cookieRead = new RegExp('document\\s*\\.\\s*cookie');
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(js|jsx|css|html)$/.test(entry.name)) {
          if (cookieRead.test(fs.readFileSync(full, 'utf8'))) offenders.push(full);
        }
      }
    };
    walk(clientSrcDir);
    expect(offenders).toEqual([]);
  });
});
