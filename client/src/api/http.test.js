// client/src/api/http.test.js — U5-API-CLIENT acceptance: the typed-error contract of the
// ONE fetch wrapper (build-plan §6.1 5B behaviours 1–2).
// Pins: typed code surfaced from a structured error body (never a stringified body);
// NETWORK_ERROR and UNEXPECTED_RESPONSE mapping; credentials:'include'; 204 → null; the
// 401 session-expired broadcast (NFR-03/AB-05); requestId = the server's correlationId
// (NFR-08); NFR-07 groundwork: `e.code` + user-facing `e.message` are stable.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, get, post, buildQuery, pathParam } from './http.js';
import { ApiError, NETWORK_ERROR, UNEXPECTED_RESPONSE } from './errors.js';
import { onSessionExpired } from './sessionEvents.js';

/** Minimal response stub — the wrapper reads only ok/status/text(). */
function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () =>
      body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function stubFetch(...responses) {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('typed error surfacing (ApiError, never a stringified body)', () => {
  it('surfaces the code, message, details and requestId from a structured error body', async () => {
    stubFetch(
      fakeResponse(403, {
        error: {
          code: 'NOT_ELIGIBLE',
          message: 'You are not eligible to reserve a seat.',
          correlationId: 'corr-123',
          details: { reasons: ['EMAIL_NOT_VERIFIED'] },
        },
      })
    );
    const err = await post('/api/bookings', { body: { listingId: 'x' } }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.code).toBe('NOT_ELIGIBLE');
    expect(err.message).toBe('You are not eligible to reserve a seat.');
    expect(err.details).toEqual({ reasons: ['EMAIL_NOT_VERIFIED'] });
    expect(err.requestId).toBe('corr-123');
  });

  it.each([
    ['MEHKO_DAILY_LISTING_LIMIT', 409],
    ['NO_CAPACITY', 409],
    ['VALIDATION_FAILED', 422],
    ['RATE_LIMITED', 429],
  ])('passes the server code %s through verbatim', async (code, status) => {
    stubFetch(fakeResponse(status, { error: { code, message: 'm', correlationId: 'c' } }));
    const err = await post('/api/listings', { body: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
  });

  it('maps transport failure to NETWORK_ERROR with status 0', async () => {
    const cause = new TypeError('Failed to fetch');
    const fn = vi.fn().mockRejectedValueOnce(cause);
    vi.stubGlobal('fetch', fn);
    const err = await get('/api/users/me').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(NETWORK_ERROR);
    expect(err.status).toBe(0);
    expect(err.cause).toBe(cause);
  });

  it('maps a non-2xx without the typed envelope to UNEXPECTED_RESPONSE (keeps the status)', async () => {
    stubFetch(fakeResponse(502, '<html>Bad Gateway</html>'));
    const err = await get('/api/listings/search').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(UNEXPECTED_RESPONSE);
    expect(err.status).toBe(502);
  });

  it('maps an unparseable 2xx body to UNEXPECTED_RESPONSE', async () => {
    stubFetch(fakeResponse(200, 'not json at all'));
    const err = await get('/api/users/me').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(UNEXPECTED_RESPONSE);
    expect(err.status).toBe(200);
  });

  it('treats a JSON error body missing the envelope shape as UNEXPECTED_RESPONSE', async () => {
    stubFetch(fakeResponse(500, { message: 'no envelope here' }));
    const err = await get('/api/users/me').catch((e) => e);
    expect(err.code).toBe(UNEXPECTED_RESPONSE);
    expect(err.status).toBe(500);
  });
});

describe('success shapes', () => {
  it('resolves with the parsed JSON body', async () => {
    stubFetch(fakeResponse(200, { user: { id: 'u1' } }));
    await expect(get('/api/users/me')).resolves.toEqual({ user: { id: 'u1' } });
  });

  it('resolves 204 (and empty 200 bodies) as null', async () => {
    stubFetch(fakeResponse(204), fakeResponse(200, ''));
    await expect(post('/api/auth/logout')).resolves.toBeNull();
    await expect(get('/api/users/me')).resolves.toBeNull();
  });
});

describe('request mechanics (NFR-03/AB-05)', () => {
  it("sends credentials:'include', the JSON headers and the serialized body", async () => {
    const fn = stubFetch(fakeResponse(200, {}));
    await request('POST', '/api/auth/login', { body: { email: 'a@b.c', password: 'pw' } });
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe('/api/auth/login');
    expect(init.credentials).toBe('include');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Accept).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ email: 'a@b.c', password: 'pw' });
  });

  it('omits body and Content-Type for body-less requests', async () => {
    const fn = stubFetch(fakeResponse(200, {}));
    await get('/api/users/me');
    const [, init] = fn.mock.calls[0];
    expect(init.body).toBeUndefined();
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.credentials).toBe('include');
  });

  it('serializes query params, omitting undefined/null and encoding values', async () => {
    const fn = stubFetch(fakeResponse(200, {}));
    await get('/api/listings/search', {
      query: { location: 'La Jolla', radiusKm: 5, cuisine: undefined, hostId: null, page: 2 },
    });
    const [url] = fn.mock.calls[0];
    expect(url).toBe('/api/listings/search?location=La+Jolla&radiusKm=5&page=2');
  });

  it('buildQuery returns "" for empty/absent input', () => {
    expect(buildQuery()).toBe('');
    expect(buildQuery({})).toBe('');
    expect(buildQuery({ a: undefined })).toBe('');
  });

  it('pathParam refuses a missing id instead of building /undefined URLs', () => {
    expect(() => pathParam(undefined, 'id')).toThrow(TypeError);
    expect(() => pathParam('', 'id')).toThrow(TypeError);
    expect(pathParam('a b', 'id')).toBe('a%20b');
  });
});

describe('the 401 session-expired broadcast (NFR-03/AB-05)', () => {
  it('broadcasts on every 401 before the ApiError reaches the caller', async () => {
    const seen = vi.fn();
    const unsubscribe = onSessionExpired(seen);
    try {
      stubFetch(
        fakeResponse(401, {
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in.', correlationId: 'c9' },
        })
      );
      const err = await get('/api/bookings').catch((e) => e);
      expect(seen).toHaveBeenCalledTimes(1);
      expect(err.code).toBe('AUTHENTICATION_REQUIRED');
      expect(err.status).toBe(401);
    } finally {
      unsubscribe();
    }
  });

  it('broadcasts even when the 401 body is not the typed envelope', async () => {
    const seen = vi.fn();
    const unsubscribe = onSessionExpired(seen);
    try {
      stubFetch(fakeResponse(401, 'nope'));
      const err = await get('/api/bookings').catch((e) => e);
      expect(seen).toHaveBeenCalledTimes(1);
      expect(err.code).toBe(UNEXPECTED_RESPONSE);
    } finally {
      unsubscribe();
    }
  });

  it('does not broadcast for non-401 failures, and unsubscribe works', async () => {
    const seen = vi.fn();
    const unsubscribe = onSessionExpired(seen);
    stubFetch(
      fakeResponse(403, { error: { code: 'FORBIDDEN', message: 'No.', correlationId: 'c' } }),
      fakeResponse(401, {
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'm', correlationId: 'c' },
      })
    );
    await get('/api/moderation/queue').catch(() => {});
    expect(seen).not.toHaveBeenCalled();
    unsubscribe();
    await get('/api/bookings').catch(() => {});
    expect(seen).not.toHaveBeenCalled();
  });
});
