// client/src/session/SessionProvider.test.jsx — U5-API-CLIENT acceptance: cookie-free
// session state (build-plan §6.1 5B behaviour 1).
// Pins: hydration from GET /api/users/me (200 → 'authenticated', 401 → 'anonymous',
// transport failure → stays 'unknown'); ANY API 401 broadcasts session-expired and flips
// the store (NFR-03/AB-05 — auth state inferred from responses, never a cookie read);
// login/logout/refresh transitions; typed login failure codes (NFR-07 groundwork);
// useSession outside the provider is a loud usage error.
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/index.js';
import { SessionProvider, useSession } from './index.js';

const USER = { id: 'u1', email: 'gaia@example.com', emailVerified: true, roles: ['user'] };

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

const AUTH_401 = jsonResponse(401, {
  error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in.', correlationId: 'c' },
});

/** Route-by-URL fetch stub: handlers = { 'METHOD /path': response | (init) => response }. */
function stubFetch(handlers) {
  const fn = vi.fn(async (url, init) => {
    const key = `${init.method} ${url.split('?')[0]}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`SessionProvider.test: unexpected fetch ${key}`);
    return typeof handler === 'function' ? handler(init) : handler;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

let captured;
function Capture() {
  captured = useSession();
  return (
    <output data-testid="state">
      {captured.status}:{captured.user ? captured.user.email : 'none'}
    </output>
  );
}

function renderSession() {
  return render(
    <SessionProvider>
      <Capture />
    </SessionProvider>
  );
}

afterEach(() => {
  captured = undefined;
  vi.unstubAllGlobals();
});

describe('hydration from GET /api/users/me (never a cookie read)', () => {
  it("starts 'unknown', then 200 → 'authenticated' with the served user", async () => {
    stubFetch({ 'GET /api/users/me': jsonResponse(200, { user: USER }) });
    renderSession();
    expect(screen.getByTestId('state')).toHaveTextContent('unknown:none');
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authenticated:gaia@example.com')
    );
  });

  it("401 → 'anonymous' (the normal signed-out answer, not an error)", async () => {
    stubFetch({ 'GET /api/users/me': AUTH_401 });
    renderSession();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('anonymous:none'));
  });

  it("transport failure keeps status 'unknown' (NFR-09: no guessing while unreachable)", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fn);
    renderSession();
    await waitFor(() => expect(fn).toHaveBeenCalled());
    // Give the swallowed rejection a tick to (not) flip the store.
    await act(async () => {});
    expect(screen.getByTestId('state')).toHaveTextContent('unknown:none');
  });

  it('hydration sends credentials so the HttpOnly cookie rides (NFR-03/AB-05)', async () => {
    const fn = stubFetch({ 'GET /api/users/me': jsonResponse(200, { user: USER }) });
    renderSession();
    await waitFor(() => expect(fn).toHaveBeenCalled());
    expect(fn.mock.calls[0][1].credentials).toBe('include');
  });
});

describe('login / logout / refresh transitions', () => {
  it('login() → POST /api/auth/login, store flips to authenticated with the returned user', async () => {
    stubFetch({
      'GET /api/users/me': AUTH_401,
      'POST /api/auth/login': jsonResponse(200, { user: USER }),
    });
    renderSession();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('anonymous:none'));
    let returned;
    await act(async () => {
      returned = await captured.login({ email: USER.email, password: 'pw' });
    });
    expect(returned).toEqual(USER);
    expect(screen.getByTestId('state')).toHaveTextContent('authenticated:gaia@example.com');
  });

  it('a failed login rejects with the typed code and leaves the store anonymous', async () => {
    stubFetch({
      'GET /api/users/me': AUTH_401,
      'POST /api/auth/login': jsonResponse(401, {
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Wrong email or password.',
          correlationId: 'c',
        },
      }),
    });
    renderSession();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('anonymous:none'));
    await act(async () => {
      await expect(captured.login({ email: USER.email, password: 'nope' })).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
        status: 401,
      });
    });
    expect(screen.getByTestId('state')).toHaveTextContent('anonymous:none');
  });

  it('logout() → POST /api/auth/logout (204), store flips to anonymous', async () => {
    stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: USER }),
      'POST /api/auth/logout': jsonResponse(204),
    });
    renderSession();
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authenticated:gaia@example.com')
    );
    await act(async () => {
      await captured.logout();
    });
    expect(screen.getByTestId('state')).toHaveTextContent('anonymous:none');
  });

  it('logout() treats a 401 as already-logged-out (still anonymous, no throw)', async () => {
    stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: USER }),
      'POST /api/auth/logout': AUTH_401,
    });
    renderSession();
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authenticated:gaia@example.com')
    );
    await act(async () => {
      await captured.logout();
    });
    expect(screen.getByTestId('state')).toHaveTextContent('anonymous:none');
  });

  it('refresh() re-hydrates an anonymous store after a server-side session appears', async () => {
    let me = AUTH_401;
    stubFetch({ 'GET /api/users/me': () => me });
    renderSession();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('anonymous:none'));
    me = jsonResponse(200, { user: USER });
    await act(async () => {
      await captured.refresh();
    });
    expect(screen.getByTestId('state')).toHaveTextContent('authenticated:gaia@example.com');
  });
});

describe('the API-wide 401 broadcast (NFR-03/AB-05 — the acceptance flip)', () => {
  it('ANY api call answering 401 flips an authenticated store to anonymous', async () => {
    stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: USER }),
      'GET /api/bookings': AUTH_401,
    });
    renderSession();
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authenticated:gaia@example.com')
    );
    // An unrelated feature call — not through the session store — hits an expired session.
    await act(async () => {
      await expect(api.bookings.list()).rejects.toMatchObject({ status: 401 });
    });
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('anonymous:none'));
  });

  it('unmounting unsubscribes: no store flip (and no crash) after teardown', async () => {
    stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: USER }),
      'GET /api/bookings': AUTH_401,
    });
    const view = renderSession();
    await waitFor(() =>
      expect(screen.getByTestId('state')).toHaveTextContent('authenticated:gaia@example.com')
    );
    view.unmount();
    await expect(api.bookings.list()).rejects.toMatchObject({ status: 401 });
  });
});

describe('useSession usage contract', () => {
  it('throws a loud error outside <SessionProvider>', () => {
    function Naked() {
      useSession();
      return null;
    }
    // Silence React's error-boundary console noise for this intentional throw.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => render(<Naked />)).toThrow(/inside <SessionProvider>/);
    } finally {
      consoleError.mockRestore();
    }
  });
});
