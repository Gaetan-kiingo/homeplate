// client/src/features/account/LoginPage.test.jsx — U6-ACCOUNT-MOD specs for /login
// (FR-10 session start, NFR-05 honest lockout, NFR-07 labelled/announced error UX,
// NFR-03/AB-05 response-inferred session state — fetch is stubbed, no cookie is ever read).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import AppLayout from '../../layout/AppLayout.jsx';
import { SessionProvider } from '../../session/index.js';
import { StatusAnnouncer } from '../../ui/index.js';
import accountRoutes from './routes.jsx';

const USER = {
  id: 'u1',
  email: 'gaia@example.com',
  emailVerified: true,
  fullName: 'Gaia Tester',
  phone: '+14155552671',
  emergencyContact: null,
  canReserveSeat: true,
  canPublishListing: false,
  roles: ['user'],
  hostProfile: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

function errorResponse(status, code, message, details) {
  return jsonResponse(status, {
    error: { code, message, correlationId: 'corr-test', ...(details !== undefined && { details }) },
  });
}

/** Route-table fetch stub keyed by 'METHOD /path' (query string stripped). */
function stubFetch(handlers) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url).split('?')[0];
    const key = `${method} ${path}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, url: String(url), body });
    const handler = handlers[key];
    if (!handler) throw new Error(`LoginPage.test: unexpected fetch ${key}`);
    return typeof handler === 'function' ? handler({ url: String(url), body }) : handler;
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

function renderAt(path) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <AppLayout />,
        children: [...accountRoutes, { path: '*', element: <p>route-miss</p> }],
      },
    ],
    { initialEntries: [path] }
  );
  render(
    <SessionProvider>
      <StatusAnnouncer />
      <RouterProvider router={router} />
    </SessionProvider>
  );
  return router;
}

// The real anonymous answer: requireSession's 401 carries code NO_SESSION.
const anonMe = errorResponse(401, 'NO_SESSION', 'Authentication required');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LoginPage — /login (FR-10, NFR-07 structure)', () => {
  it('renders one h1, its document.title, and both fields labelled and required', async () => {
    stubFetch({ 'GET /api/users/me': anonMe });
    renderAt('/login');
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Sign in — Homeplate'));
    const email = screen.getByLabelText(/email address/i);
    const password = screen.getByLabelText(/^password/i);
    expect(email).toBeRequired();
    expect(password).toBeRequired();
    expect(password).toHaveAttribute('type', 'password');
    // Fix paths out of this screen exist as real links (signup + verify-email).
    expect(screen.getByRole('link', { name: /create an account/i })).toHaveAttribute(
      'href',
      '/signup'
    );
    expect(screen.getByRole('link', { name: /verify it here/i })).toHaveAttribute(
      'href',
      '/verify-email'
    );
  });

  it('blocks an empty submit client-side with a focus-taking ErrorSummary — no API call', async () => {
    const ue = userEvent.setup();
    const calls = stubFetch({ 'GET /api/users/me': anonMe });
    renderAt('/login');
    await ue.click(screen.getByRole('button', { name: 'Sign in' }));
    // Named query: the shell's aria-live regions are role="alert" too — the summary is the
    // one labelled by its own heading.
    const summary = await screen.findByRole('alert', { name: 'There is a problem' });
    expect(screen.getByRole('link', { name: 'Enter your email address' })).toHaveAttribute(
      'href',
      '#login-email'
    );
    expect(screen.getByRole('link', { name: 'Enter your password' })).toBeInTheDocument();
    await waitFor(() => expect(summary).toHaveFocus());
    expect(calls.filter((c) => c.key === 'POST /api/auth/login')).toHaveLength(0);
  });
});

describe('LoginPage — outcomes per typed code', () => {
  it('signs in, announces it, and lands on /account (the location.state.from contract default)', async () => {
    const ue = userEvent.setup();
    const calls = stubFetch({
      'GET /api/users/me': anonMe,
      'POST /api/auth/login': jsonResponse(200, { user: USER }),
    });
    const router = renderAt('/login');
    await ue.type(screen.getByLabelText(/email address/i), 'gaia@example.com');
    await ue.type(screen.getByLabelText(/^password/i), 'correct horse');
    await ue.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/account'));
    // The session-aware nav proves state came from the RESPONSE (NFR-03/AB-05).
    expect(screen.getByRole('link', { name: /Gaia Tester/ })).toHaveAttribute('href', '/account');
    const login = calls.find((c) => c.key === 'POST /api/auth/login');
    expect(login.body).toEqual({ email: 'gaia@example.com', password: 'correct horse' });
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('status')
          .map((n) => n.textContent)
          .join(' ')
      ).toContain('Gaia Tester')
    );
  });

  it('renders INVALID_CREDENTIALS as its own message, visibly and announced', async () => {
    const ue = userEvent.setup();
    stubFetch({
      'GET /api/users/me': anonMe,
      'POST /api/auth/login': errorResponse(
        401,
        'INVALID_CREDENTIALS',
        'Invalid email or password'
      ),
    });
    renderAt('/login');
    await ue.type(screen.getByLabelText(/email address/i), 'gaia@example.com');
    await ue.type(screen.getByLabelText(/^password/i), 'wrong');
    await ue.click(screen.getByRole('button', { name: 'Sign in' }));
    // Twice in the tree by design: the visible error box AND the aria-live announcement.
    const hits = await screen.findAllByText('Invalid email or password.');
    expect(hits.some((node) => node.tagName === 'P')).toBe(true);
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('alert')
          .map((n) => n.textContent)
          .join(' ')
      ).toContain('Invalid email or password.')
    );
  });

  it('NFR-05: renders the 429 lockout HONESTLY — names the temporary lock and the retry horizon from details.retryAfterSeconds', async () => {
    const ue = userEvent.setup();
    stubFetch({
      'GET /api/users/me': anonMe,
      // The REAL lockout shape (finding AMV-W6-01): src/modules/auth/service.js:318 emits
      // code LOGIN_RATE_LIMITED — pinned by tests/unit/identity.test.js — never RATE_LIMITED.
      'POST /api/auth/login': errorResponse(
        429,
        'LOGIN_RATE_LIMITED',
        'Too many failed login attempts — try again later',
        { retryAfterSeconds: 300 }
      ),
    });
    renderAt('/login');
    await ue.type(screen.getByLabelText(/email address/i), 'gaia@example.com');
    await ue.type(screen.getByLabelText(/^password/i), 'whatever!');
    await ue.click(screen.getByRole('button', { name: 'Sign in' }));
    // Visible box + aria-live announcement both carry it; assert on the visible paragraph.
    const hits = await screen.findAllByText(/temporarily locked/i);
    const visible = hits.find((node) => node.tagName === 'P');
    expect(visible).toBeTruthy();
    expect(visible.textContent).toContain('Too many failed sign-in attempts');
    expect(visible.textContent).toContain('about 5 minutes');
    expect(visible.textContent).toContain('the lock lifts by itself');
  });

  it('shows the already-signed-in state instead of a second sign-in form', async () => {
    stubFetch({ 'GET /api/users/me': jsonResponse(200, { user: USER }) });
    renderAt('/login');
    expect(await screen.findByText(/already signed in as Gaia Tester/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^password/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /account page/i })).toHaveAttribute('href', '/account');
  });
});
