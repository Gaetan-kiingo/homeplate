// client/src/api/search.test.js — U5-API-CLIENT acceptance: the three NFR-09 search states
// (build-plan §6.1 5B behaviour 3): 200 → 'ok'; 200 + degraded:true → 'degraded';
// typed 503 SEARCH_DEGRADED → 'unavailable' (returned, never thrown). Anything else throws.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { search } from './search.js';
import { ApiError, NETWORK_ERROR } from './errors.js';

function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

function stubFetch(response) {
  const fn = vi.fn().mockResolvedValueOnce(response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

const listing = { id: 'l1', coarseLat: 32.85, coarseLng: -117.25, areaLabel: 'La Jolla' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api.search — NFR-09 degraded mode as a first-class state', () => {
  it("maps a fresh 200 to state 'ok' with the listings page", async () => {
    stubFetch(fakeResponse(200, { results: [listing], page: 1, pageSize: 20, total: 1 }));
    const result = await search({ location: 'La Jolla' });
    expect(result.state).toBe('ok');
    expect(result.listings).toEqual([listing]);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.total).toBe(1);
    expect(result.error).toBeUndefined();
  });

  it("maps 200 + degraded:true to state 'degraded' (stale-cache answer, still rendered)", async () => {
    stubFetch(
      fakeResponse(200, { results: [listing], page: 1, pageSize: 20, total: 1, degraded: true })
    );
    const result = await search({ location: 'La Jolla' });
    expect(result.state).toBe('degraded');
    expect(result.listings).toEqual([listing]);
  });

  it("maps the typed 503 SEARCH_DEGRADED to state 'unavailable' WITHOUT throwing", async () => {
    stubFetch(
      fakeResponse(503, {
        error: {
          code: 'SEARCH_DEGRADED',
          message:
            'Location search is temporarily unavailable. Please try again shortly, or ' +
            'search without a location.',
          correlationId: 'corr-503',
        },
      })
    );
    const result = await search({ location: 'La Jolla' });
    expect(result.state).toBe('unavailable');
    expect(result.listings).toBeUndefined();
    expect(result.error).toBeInstanceOf(ApiError);
    expect(result.error.code).toBe('SEARCH_DEGRADED');
    // The user-facing message rides along for the aria-live channel (NFR-07 groundwork).
    expect(result.error.message).toMatch(/temporarily unavailable/);
    expect(result.error.requestId).toBe('corr-503');
  });

  it('still throws for failures that are NOT the degraded contract (401 here)', async () => {
    stubFetch(
      fakeResponse(401, {
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in.', correlationId: 'c' },
      })
    );
    await expect(search({})).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  });

  it('still throws NETWORK_ERROR for transport failure (an outage is not "degraded data")', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')));
    await expect(search({})).rejects.toMatchObject({ code: NETWORK_ERROR });
  });

  it('a plain 503 SERVICE_UNAVAILABLE (wrong code) is NOT swallowed into a state', async () => {
    stubFetch(
      fakeResponse(503, {
        error: { code: 'SERVICE_UNAVAILABLE', message: 'down', correlationId: 'c' },
      })
    );
    await expect(search({})).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('sends the FR-01 filters as query params on GET /api/listings/search with credentials', async () => {
    const fn = stubFetch(fakeResponse(200, { results: [], page: 1, pageSize: 20, total: 0 }));
    await search({ location: 'La Jolla', radiusKm: 5, cuisine: 'oaxacan', page: 2 });
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe('/api/listings/search?location=La+Jolla&radiusKm=5&cuisine=oaxacan&page=2');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('include');
  });
});
