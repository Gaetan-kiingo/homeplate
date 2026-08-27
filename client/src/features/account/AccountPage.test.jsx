// client/src/features/account/AccountPage.test.jsx — U6-ACCOUNT-MOD specs for /account:
// FR-09/NFR-06 (both eligibility flags + per-reason-code fix guidance, recomputed flags
// applied after PATCH), the schema-transcribed profile/hostProfile update (minimal diff),
// NFR-12 (deletion behind an explicit confirm Dialog naming the 30-day erasure), NFR-13
// (export request + retrieval), and the anonymous/hydrating states (NFR-03/AB-05:
// everything response-inferred, fetch stubbed, no cookie).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import AppLayout from '../../layout/AppLayout.jsx';
import { SessionProvider } from '../../session/index.js';
import { StatusAnnouncer } from '../../ui/index.js';
import accountRoutes from './routes.jsx';

const READY_USER = {
  id: 'u1',
  email: 'gaia@example.com',
  emailVerified: true,
  fullName: 'Gaia Tester',
  phone: '+14155552671',
  emergencyContact: null,
  canReserveSeat: true,
  canPublishListing: true,
  roles: ['user'],
  hostProfile: { bio: 'I cook.', hostAgreementAcceptedAt: '2026-08-01T12:00:00.000Z' },
  createdAt: '2026-01-01T00:00:00.000Z',
};

const BLOCKED_USER = {
  ...READY_USER,
  emailVerified: false,
  phone: null,
  canReserveSeat: false,
  canPublishListing: false,
  hostProfile: null,
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
    if (!handler) throw new Error(`AccountPage.test: unexpected fetch ${key}`);
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AccountPage — session states (NFR-03/AB-05)', () => {
  it('anonymous: renders the sign-in prompt with real links, under the single h1', async () => {
    stubFetch({
      'GET /api/users/me': errorResponse(401, 'NO_SESSION', 'Authentication required'),
    });
    renderAt('/account');
    expect(screen.getByRole('heading', { level: 1, name: 'Your account' })).toBeInTheDocument();
    expect(await screen.findByText(/You are not signed in/)).toBeInTheDocument();
    // Scoped to <main>: since 2026-08-27 the layout nav also offers a "Sign in" link, so
    // an unscoped query is ambiguous. The assertion is about THIS PAGE's prompt.
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login'
    );
    expect(screen.getByRole('link', { name: 'create an account' })).toHaveAttribute(
      'href',
      '/signup'
    );
    await waitFor(() => expect(document.title).toBe('Your account — Homeplate'));
  });
});

describe('AccountPage — FR-09/NFR-06 eligibility panel', () => {
  it('renders both flags as ready for an eligible user', async () => {
    stubFetch({ 'GET /api/users/me': jsonResponse(200, { user: READY_USER }) });
    renderAt('/account');
    expect(await screen.findByText(/Ready — you can reserve seats/)).toBeInTheDocument();
    expect(screen.getByText(/Ready — you can publish meal listings/)).toBeInTheDocument();
    // No reason codes when nothing is outstanding.
    expect(screen.queryByText(/\(EMAIL_UNVERIFIED\)/)).not.toBeInTheDocument();
  });

  it('renders each outstanding reason code with fix guidance for a blocked user', async () => {
    stubFetch({ 'GET /api/users/me': jsonResponse(200, { user: BLOCKED_USER }) });
    renderAt('/account');
    const panel = (await screen.findByRole('heading', { name: 'Eligibility' })).closest('section');
    // Both flags blocked, stated in text.
    expect(within(panel).getAllByText(/Not yet available/)).toHaveLength(2);
    // The outstanding codes — the same vocabulary a 403 NOT_ELIGIBLE carries (FR-09).
    expect(within(panel).getAllByText('(EMAIL_UNVERIFIED)').length).toBeGreaterThan(0);
    expect(within(panel).getAllByText('(PHONE_MISSING)').length).toBeGreaterThan(0);
    expect(within(panel).getByText('(HOST_PROFILE_INCOMPLETE)')).toBeInTheDocument();
    expect(within(panel).getByText('(HOST_AGREEMENT_MISSING)')).toBeInTheDocument();
    // fullName is present, so NAME_MISSING must NOT appear (per-code, not blanket copy).
    expect(within(panel).queryByText('(NAME_MISSING)')).not.toBeInTheDocument();
    // Fix paths are real: verify-email link + anchors into the profile form.
    expect(
      within(panel).getAllByRole('link', { name: /request a new verification email/i })[0]
    ).toHaveAttribute('href', '/verify-email');
    expect(within(panel).getAllByRole('link', { name: /profile form below/i })[0]).toHaveAttribute(
      'href',
      '#account-profile'
    );
  });

  it('renders NAME_MISSING positively when fullName is absent (AMV-W6-05)', async () => {
    stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: { ...BLOCKED_USER, fullName: null } }),
    });
    renderAt('/account');
    const panel = (await screen.findByRole('heading', { name: 'Eligibility' })).closest('section');
    expect(within(panel).getAllByText('(NAME_MISSING)').length).toBeGreaterThan(0);
    expect(within(panel).getAllByText('Add your full name').length).toBeGreaterThan(0);
    expect(within(panel).getAllByRole('link', { name: /profile form below/i })[0]).toHaveAttribute(
      'href',
      '#account-profile'
    );
  });
});

describe('AccountPage — profile update (NFR-06, schema-transcribed)', () => {
  it('PATCHes only the dirty fields and re-renders the panel from the recomputed flags', async () => {
    const ue = userEvent.setup();
    const updated = {
      ...BLOCKED_USER,
      phone: '+14155552671',
      canReserveSeat: false, // email still unverified — flags stay the SERVER's verdict
    };
    const calls = stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: BLOCKED_USER }),
      'PATCH /api/users/me': jsonResponse(200, { user: updated }),
    });
    renderAt('/account');
    await ue.type(await screen.findByLabelText(/^Phone number/), '+14155552671');
    await ue.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findAllByText('Profile saved.');
    const patch = calls.find((c) => c.key === 'PATCH /api/users/me');
    // Minimal diff: ONLY the changed field travels (profileUpdate requires >= 1 key).
    expect(patch.body).toEqual({ phone: '+14155552671' });
    // The panel now reflects the response: PHONE_MISSING resolved, EMAIL_UNVERIFIED remains.
    await waitFor(() => expect(screen.queryByText('(PHONE_MISSING)')).not.toBeInTheDocument());
    expect(screen.getAllByText('(EMAIL_UNVERIFIED)').length).toBeGreaterThan(0);
  });

  it('sends hostProfile { bio, acceptHostAgreement: true } when the host fields are completed', async () => {
    const ue = userEvent.setup();
    const updated = {
      ...BLOCKED_USER,
      hostProfile: { bio: 'I cook well.', hostAgreementAcceptedAt: '2026-08-26T00:00:00.000Z' },
    };
    const calls = stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: BLOCKED_USER }),
      'PATCH /api/users/me': jsonResponse(200, { user: updated }),
    });
    renderAt('/account');
    await ue.type(await screen.findByLabelText(/host bio/i), 'I cook well.');
    await ue.click(screen.getByLabelText(/I accept the Homeplate host agreement/i));
    await ue.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findAllByText('Profile saved.');
    const patch = calls.find((c) => c.key === 'PATCH /api/users/me');
    expect(patch.body).toEqual({
      hostProfile: { bio: 'I cook well.', acceptHostAgreement: true },
    });
    // Accepted-once: the checkbox is replaced by the acceptance record from the response.
    expect(
      await screen.findByText(/Host agreement accepted on August 26, 2026/)
    ).toBeInTheDocument();
  });

  it('validates the emergency contact as all-three-or-none before any PATCH', async () => {
    const ue = userEvent.setup();
    const calls = stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: READY_USER }),
    });
    renderAt('/account');
    await ue.type(await screen.findByLabelText(/contact name/i), 'Pat Neighbor');
    await ue.click(screen.getByRole('button', { name: 'Save profile' }));
    const summary = await screen.findByRole('alert', { name: 'There is a problem' });
    expect(summary).toHaveTextContent('Emergency contact needs a phone number');
    expect(summary).toHaveTextContent('Emergency contact needs an email address');
    expect(calls.filter((c) => c.key === 'PATCH /api/users/me')).toHaveLength(0);
  });
});

describe('AccountPage — NFR-12 deletion behind explicit confirmation', () => {
  it('cancel sends nothing; confirm DELETEs, shows the accepted state, and the dialog names the 30-day erasure', async () => {
    const ue = userEvent.setup();
    let deleted = false;
    const calls = stubFetch({
      'GET /api/users/me': () =>
        deleted
          ? errorResponse(401, 'NO_SESSION', 'Authentication required')
          : jsonResponse(200, { user: READY_USER }),
      'DELETE /api/users/me': () => {
        deleted = true;
        return jsonResponse(202, {
          request: {
            id: 'req-1',
            kind: 'erasure',
            status: 'pending',
            dueAt: '2026-09-25T00:00:00.000Z',
            completedAt: null,
            createdAt: '2026-08-26T00:00:00.000Z',
          },
        });
      },
    });
    renderAt('/account');

    // Open the dialog; it must NAME the 30-day erasure and require an explicit confirm.
    await ue.click(await screen.findByRole('button', { name: 'Delete my account…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete your account?' });
    expect(dialog).toHaveTextContent(/permanently erased 30 days after this request/);

    // Cancel path: nothing was sent.
    await ue.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls.filter((c) => c.key === 'DELETE /api/users/me')).toHaveLength(0);

    // Confirm path: 202 → the accepted state (and the session store re-hydrates to 401).
    await ue.click(screen.getByRole('button', { name: 'Delete my account…' }));
    await ue.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Yes, delete my account' })
    );
    expect(await screen.findByRole('heading', { name: 'Deletion accepted' })).toBeInTheDocument();
    // Visible notice + polite announcement both carry the 30-day copy.
    const notices = screen.getAllByText(/permanently erased 30 days after this request/);
    expect(notices.some((node) => node.tagName === 'P')).toBe(true);
    // AMV-W6-04: the accepted state renders the SERVER's own due date, not just the number.
    expect(screen.getByText(/scheduled for September 25, 2026/)).toBeInTheDocument();
    expect(calls.filter((c) => c.key === 'DELETE /api/users/me')).toHaveLength(1);
  });
});

describe('AccountPage — NFR-13 export request + retrieval', () => {
  it('requests the export (202, 30-day SLA), polls status, and renders the completed copy', async () => {
    const ue = userEvent.setup();
    const calls = stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: READY_USER }),
      'POST /api/users/me/export': jsonResponse(202, {
        request: {
          id: 'exp-1',
          kind: 'export',
          status: 'pending',
          dueAt: '2026-09-25T00:00:00.000Z',
          completedAt: null,
          createdAt: '2026-08-26T00:00:00.000Z',
        },
      }),
      'GET /api/users/me/export/exp-1': jsonResponse(200, {
        export: {
          id: 'exp-1',
          kind: 'export',
          status: 'completed',
          dueAt: '2026-09-25T00:00:00.000Z',
          completedAt: '2026-08-26T01:00:00.000Z',
          createdAt: '2026-08-26T00:00:00.000Z',
          data: { user: { email: 'gaia@example.com' } },
        },
      }),
    });
    renderAt('/account');
    await ue.click(await screen.findByRole('button', { name: 'Request my data export' }));
    expect(await screen.findByText(/Pending — the copy is being prepared/)).toBeInTheDocument();
    expect(
      screen.getByText(/September 25, 2026 \(30-day statutory deadline\)/)
    ).toBeInTheDocument();

    await ue.click(screen.getByRole('button', { name: 'Check export status' }));
    const copy = await screen.findByLabelText(/Your exported data \(JSON\)/);
    expect(copy).toHaveDisplayValue(/gaia@example\.com/);
    expect(calls.filter((c) => c.key === 'GET /api/users/me/export/exp-1')).toHaveLength(1);
  });

  it("renders a human label for the worker's 'processing' status, never the raw enum (AMV-W6-03)", async () => {
    const ue = userEvent.setup();
    stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: READY_USER }),
      'POST /api/users/me/export': jsonResponse(202, {
        request: {
          id: 'exp-2',
          kind: 'export',
          status: 'pending',
          dueAt: '2026-09-25T00:00:00.000Z',
          completedAt: null,
          createdAt: '2026-08-26T00:00:00.000Z',
        },
      }),
      // The worker picked the job up: db enum value 'processing' (migration 0001,
      // src/modules/privacy/repo.js markProcessing) — the one state that had no label.
      'GET /api/users/me/export/exp-2': jsonResponse(200, {
        export: {
          id: 'exp-2',
          kind: 'export',
          status: 'processing',
          dueAt: '2026-09-25T00:00:00.000Z',
          completedAt: null,
          createdAt: '2026-08-26T00:00:00.000Z',
        },
      }),
    });
    renderAt('/account');
    await ue.click(await screen.findByRole('button', { name: 'Request my data export' }));
    await screen.findByText(/Pending — the copy is being prepared/);
    await ue.click(screen.getByRole('button', { name: 'Check export status' }));
    // Rendered in the status row AND mirrored into the polite live region.
    const hits = await screen.findAllByText(/Processing — your copy is being assembled/);
    expect(hits.some((node) => node.tagName === 'DD')).toBe(true);
    // The raw enum word alone never renders as the status.
    expect(screen.queryByText(/^processing$/)).not.toBeInTheDocument();
  });
});
