// client/src/features/account/VerifyEmailPage.test.jsx — U6-ACCOUNT-MOD specs for
// /verify-email (FR-10 token redemption from the mailed link: success, failure with the
// always-202 recovery form, and the no-token guidance state; single-use token redeemed
// exactly once; NFR-07 announced states).
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import AppLayout from '../../layout/AppLayout.jsx';
import { SessionProvider } from '../../session/index.js';
import { StatusAnnouncer } from '../../ui/index.js';
import accountRoutes from './routes.jsx';

// 43-char base64url token, the shape src/modules/users/tokens.js mints (FR-10).
const TOKEN = 'a'.repeat(43);

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

function stubFetch(handlers) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url).split('?')[0];
    const key = `${method} ${path}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, url: String(url), body });
    const handler = handlers[key];
    if (!handler) throw new Error(`VerifyEmailPage.test: unexpected fetch ${key}`);
    return typeof handler === 'function' ? handler({ url: String(url), body }) : handler;
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

function renderAt(path, { strict = false } = {}) {
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
  const tree = (
    <SessionProvider>
      <StatusAnnouncer />
      <RouterProvider router={router} />
    </SessionProvider>
  );
  // `strict` mirrors client/src/main.jsx, which mounts the app under React.StrictMode: effects
  // run → clean up → run again in development, which is exactly the path that hid the
  // orphaned-response defect below.
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return router;
}

// The real anonymous answer: requireSession's 401 carries code NO_SESSION.
const anonMe = errorResponse(401, 'NO_SESSION', 'Authentication required');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VerifyEmailPage — /verify-email (FR-10)', () => {
  it('consumes the link token exactly once and flips to the success state with a sign-in path', async () => {
    const calls = stubFetch({
      'GET /api/users/me': anonMe,
      'POST /api/auth/verify-email': jsonResponse(200, { emailVerified: true }),
    });
    renderAt(`/verify-email?token=${TOKEN}`);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Verify your email' })
    ).toBeInTheDocument();
    const notices = await screen.findAllByText(/email address is verified/i);
    expect(notices.some((node) => node.tagName === 'P')).toBe(true);
    // Scoped to <main>: since 2026-08-27 the layout nav also offers a "Sign in" link, so
    // an unscoped query is ambiguous. The assertion is about THIS PAGE's prompt.
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login'
    );
    await waitFor(() => expect(document.title).toBe('Verify your email — Homeplate'));
    // Single-use token: redeemed exactly once, with the token relayed verbatim.
    const redemptions = calls.filter((c) => c.key === 'POST /api/auth/verify-email');
    expect(redemptions).toHaveLength(1);
    expect(redemptions[0].body).toEqual({ token: TOKEN });
  });

  it('under StrictMode, a response that arrives AFTER the double effect still reaches the page (regression, 2026-09-11)', async () => {
    // Reproduction of the real defect: the app runs under React.StrictMode (main.jsx), the
    // verify POST resolves only after the effect has run, cleaned up and run again, and the
    // page stayed on the spinner forever although the server had verified the account.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const calls = stubFetch({
      'GET /api/users/me': anonMe,
      'POST /api/auth/verify-email': async () => {
        await gate;
        return jsonResponse(200, { emailVerified: true });
      },
    });
    renderAt(`/verify-email?token=${TOKEN}`, { strict: true });
    expect(screen.getByText('Verifying your email address')).toBeInTheDocument();
    // Both StrictMode effect runs have happened by now; only then does the server answer.
    release();
    const notices = await screen.findAllByText(/email address is verified/i);
    expect(notices.some((node) => node.tagName === 'P')).toBe(true);
    // Still exactly one redemption: StrictMode must not burn the single-use token either.
    expect(calls.filter((c) => c.key === 'POST /api/auth/verify-email')).toHaveLength(1);
  });

  it('renders the 400 INVALID_VERIFICATION_TOKEN honestly and offers the resend recovery form', async () => {
    const ue = userEvent.setup();
    const calls = stubFetch({
      'GET /api/users/me': anonMe,
      'POST /api/auth/verify-email': errorResponse(
        400,
        'INVALID_VERIFICATION_TOKEN',
        'Invalid or expired verification token'
      ),
      'POST /api/auth/resend-verification': jsonResponse(202, { accepted: true }),
    });
    renderAt(`/verify-email?token=${TOKEN}`);
    const failures = await screen.findAllByText(/invalid, already used, or expired/i);
    expect(failures.some((node) => node.tagName === 'P')).toBe(true);

    // FR-10 recovery path, right on the failure state.
    expect(
      screen.getByRole('heading', { name: 'Request a new verification email' })
    ).toBeInTheDocument();
    await ue.type(screen.getByLabelText(/email address/i), 'gaia@example.com');
    await ue.click(screen.getByRole('button', { name: 'Request a new verification email' }));
    const notices = await screen.findAllByText(/If an account exists for gaia@example\.com/);
    expect(notices.some((node) => node.tagName === 'P')).toBe(true);
    const resend = calls.find((c) => c.key === 'POST /api/auth/resend-verification');
    expect(resend.body).toEqual({ email: 'gaia@example.com' });
  });

  it('with no token: explains the mailed-link flow, offers resend, and never posts a redemption', async () => {
    const calls = stubFetch({ 'GET /api/users/me': anonMe });
    renderAt('/verify-email');
    expect(
      await screen.findByText(/Open the verification link from your email/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Request a new verification email' })
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.key === 'POST /api/auth/verify-email')).toHaveLength(0);
  });
});
