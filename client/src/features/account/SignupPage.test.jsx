// client/src/features/account/SignupPage.test.jsx — U6-ACCOUNT-MOD specs for /signup
// (FR-10 registration → check-your-email → resend recovery; AB-05 anti-enumeration copy;
// NFR-07 labelled fields, ErrorSummary, aria-live announcements).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import AppLayout from '../../layout/AppLayout.jsx';
import { SessionProvider } from '../../session/index.js';
import { StatusAnnouncer } from '../../ui/index.js';
import accountRoutes from './routes.jsx';

const NEW_USER = {
  id: 'u2',
  email: 'new@example.com',
  emailVerified: false,
  fullName: 'New Person',
  phone: null,
  emergencyContact: null,
  canReserveSeat: false,
  canPublishListing: false,
  roles: ['user'],
  hostProfile: null,
  createdAt: '2026-08-26T00:00:00.000Z',
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

function stubFetch(handlers) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url).split('?')[0];
    const key = `${method} ${path}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, url: String(url), body });
    const handler = handlers[key];
    if (!handler) throw new Error(`SignupPage.test: unexpected fetch ${key}`);
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

describe('SignupPage — /signup (FR-10, NFR-07 structure)', () => {
  it('renders one h1, its document.title, required email/password and optional profile fields', async () => {
    stubFetch({ 'GET /api/users/me': anonMe });
    renderAt('/signup');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Create an account' })
    ).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Create an account — Homeplate'));
    expect(screen.getByLabelText(/email address/i)).toBeRequired();
    expect(screen.getByLabelText(/^password/i)).toBeRequired();
    // fullName/phone are optional at registration by schema; the hints say WHY they matter.
    expect(screen.getByLabelText(/full name/i)).not.toBeRequired();
    expect(screen.getByLabelText(/phone number/i)).not.toBeRequired();
    expect(screen.getAllByText(/FR-09/).length).toBeGreaterThan(0);
  });

  it('validates email shape, password length and phone format client-side — no API call', async () => {
    const ue = userEvent.setup();
    const calls = stubFetch({ 'GET /api/users/me': anonMe });
    renderAt('/signup');
    await ue.type(screen.getByLabelText(/email address/i), 'not-an-email');
    await ue.type(screen.getByLabelText(/^password/i), 'short');
    await ue.type(screen.getByLabelText(/phone number/i), '555-1234');
    await ue.click(screen.getByRole('button', { name: 'Create account' }));
    const summary = await screen.findByRole('alert', { name: 'There is a problem' });
    expect(summary).toHaveTextContent('Enter a valid email address');
    expect(summary).toHaveTextContent('Enter a password of at least 8 characters');
    expect(summary).toHaveTextContent('international format');
    expect(calls.filter((c) => c.key === 'POST /api/auth/register')).toHaveLength(0);
  });
});

describe('SignupPage — registration outcomes', () => {
  it('registers, flips to the check-your-email state, and resends on the recovery path with anti-enumeration copy', async () => {
    const ue = userEvent.setup();
    const calls = stubFetch({
      'GET /api/users/me': anonMe,
      'POST /api/auth/register': jsonResponse(201, { user: NEW_USER }),
      'POST /api/auth/resend-verification': jsonResponse(202, { accepted: true }),
    });
    renderAt('/signup');
    await ue.type(screen.getByLabelText(/email address/i), 'new@example.com');
    await ue.type(screen.getByLabelText(/^password/i), 'long enough password');
    await ue.type(screen.getByLabelText(/full name/i), 'New Person');
    await ue.click(screen.getByRole('button', { name: 'Create account' }));

    // FR-10: the check-your-email state — the token is never in the response, so the UI can
    // only (and does only) point at the inbox.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Check your email' })
    ).toBeInTheDocument();
    expect(screen.getByText('new@example.com')).toBeInTheDocument();
    const register = calls.find((c) => c.key === 'POST /api/auth/register');
    expect(register.body).toEqual({
      email: 'new@example.com',
      password: 'long enough password',
      fullName: 'New Person',
    });

    // Resend: 202 always — the copy promises neither existence nor delivery (AB-05).
    await ue.click(screen.getByRole('button', { name: 'Resend verification email' }));
    // Visible notice + polite aria-live announcement both carry the AB-05 copy.
    const notices = await screen.findAllByText(/If an account exists for new@example\.com/);
    const notice = notices.find((node) => node.tagName === 'P');
    expect(notice).toBeTruthy();
    expect(notice.textContent).toContain('queued');
    expect(notice.textContent).not.toMatch(/was sent|delivered/i);
    const resend = calls.find((c) => c.key === 'POST /api/auth/resend-verification');
    expect(resend.body).toEqual({ email: 'new@example.com' });
  });

  it('renders the 409 EMAIL_IN_USE as its own message pointing at sign-in', async () => {
    const ue = userEvent.setup();
    stubFetch({
      'GET /api/users/me': anonMe,
      'POST /api/auth/register': errorResponse(
        409,
        'EMAIL_IN_USE',
        'An account with this email already exists'
      ),
    });
    renderAt('/signup');
    await ue.type(screen.getByLabelText(/email address/i), 'taken@example.com');
    await ue.type(screen.getByLabelText(/^password/i), 'long enough password');
    await ue.click(screen.getByRole('button', { name: 'Create account' }));
    const hits = await screen.findAllByText(/already exists — try signing in instead/);
    expect(hits.some((node) => node.tagName === 'P')).toBe(true);
  });

  it('renders the resend throttle (429) honestly with its retry horizon', async () => {
    const ue = userEvent.setup();
    stubFetch({
      'GET /api/users/me': anonMe,
      'POST /api/auth/register': jsonResponse(201, { user: NEW_USER }),
      // The REAL throttle shape (finding AMV-W6-02): src/modules/auth/service.js:174 emits
      // code VERIFICATION_RESEND_RATE_LIMITED — never RATE_LIMITED.
      'POST /api/auth/resend-verification': errorResponse(
        429,
        'VERIFICATION_RESEND_RATE_LIMITED',
        'Too many verification requests — try again later',
        { retryAfterSeconds: 120 }
      ),
    });
    renderAt('/signup');
    await ue.type(screen.getByLabelText(/email address/i), 'new@example.com');
    await ue.type(screen.getByLabelText(/^password/i), 'long enough password');
    await ue.click(screen.getByRole('button', { name: 'Create account' }));
    await ue.click(await screen.findByRole('button', { name: 'Resend verification email' }));
    const hits = await screen.findAllByText(/verification emails too often/);
    const visible = hits.find((node) => node.tagName === 'P');
    expect(visible).toBeTruthy();
    expect(visible.textContent).toContain('about 2 minutes');
  });
});
