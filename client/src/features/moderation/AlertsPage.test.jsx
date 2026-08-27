// client/src/features/moderation/AlertsPage.test.jsx — U6-ACCOUNT-MOD specs for
// /moderation/alerts (FR-07: the moderator alert queue shows every delivery state incl.
// the dead-lettered terminal 'failed'; AB-04 escalation raises a real alert by bookingId
// and the confirmation says RECORDED, never delivered — ADR-001/003; role gate as on the
// queue; NFR-07 labelled filter/field and announced outcomes).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import AppLayout from '../../layout/AppLayout.jsx';
import { SessionProvider } from '../../session/index.js';
import { StatusAnnouncer } from '../../ui/index.js';
import moderationRoutes from './routes.jsx';

const MODERATOR = {
  id: 'mod-1',
  email: 'mod@example.com',
  emailVerified: true,
  fullName: 'Mod Erator',
  phone: '+14155552671',
  emergencyContact: null,
  canReserveSeat: true,
  canPublishListing: false,
  roles: ['user', 'moderator'],
  hostProfile: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const PLAIN_USER = { ...MODERATOR, id: 'u-1', roles: ['user'] };
const BOOKING_ID = '0b891abb-2c3d-4e5f-8a90-123456789abc';

function alertRow(overrides) {
  return {
    id: 'a0',
    bookingId: 'b0',
    bookingStatus: 'confirmed',
    listingId: 'l0',
    hostId: 'h0',
    raisedByUserId: 'u0',
    deliveryStatus: 'pending',
    deliveredAt: null,
    createdAt: '2026-08-25T18:00:00.000Z',
    updatedAt: '2026-08-25T18:00:00.000Z',
    ...overrides,
  };
}

const ALERTS = [
  alertRow({ id: 'a1', deliveryStatus: 'delivered', deliveredAt: '2026-08-25T18:05:00.000Z' }),
  alertRow({ id: 'a2', deliveryStatus: 'failed' }),
  alertRow({ id: 'a3', deliveryStatus: 'no_channel' }),
];

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
    if (!handler) throw new Error(`AlertsPage.test: unexpected fetch ${key}`);
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
        children: [...moderationRoutes, { path: '*', element: <p>route-miss</p> }],
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

const alertsOk = jsonResponse(200, { alerts: ALERTS, page: 1, pageSize: 20, total: 3 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AlertsPage — role gating', () => {
  it('signed-in non-moderator: the clean 403 screen, no alerts call', async () => {
    const calls = stubFetch({ 'GET /api/users/me': jsonResponse(200, { user: PLAIN_USER }) });
    renderAt('/moderation/alerts');
    expect(
      await screen.findByRole('heading', { name: 'Moderator access required (403)' })
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.key === 'GET /api/moderation/alerts')).toHaveLength(0);
  });

  it('server-side 403 (NOT_MODERATOR) renders the same clean 403 screen', async () => {
    stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: MODERATOR }),
      'GET /api/moderation/alerts': errorResponse(
        403,
        'NOT_MODERATOR',
        'Only a moderator may read the safety-alert queue.'
      ),
    });
    renderAt('/moderation/alerts');
    expect(
      await screen.findByRole('heading', { name: 'Moderator access required (403)' })
    ).toBeInTheDocument();
  });
});

describe('AlertsPage — FR-07 delivery lifecycle rendering', () => {
  it('renders one h1/title and every delivery state honestly, incl. the dead-lettered terminal failure', async () => {
    stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: MODERATOR }),
      'GET /api/moderation/alerts': alertsOk,
    });
    renderAt('/moderation/alerts');
    expect(screen.getByRole('heading', { level: 1, name: 'Safety alerts' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Safety alerts — Homeplate'));

    expect(
      await screen.findByRole('listitem', { name: 'Safety alert — Delivered' })
    ).toBeInTheDocument();
    const failed = screen.getByRole('listitem', { name: 'Safety alert — Failed (dead-lettered)' });
    expect(
      within(failed).getByText(/dead-lettered — the alert stays listed here; follow up manually/)
    ).toBeInTheDocument();
    const noChannel = screen.getByRole('listitem', { name: 'Safety alert — No channel' });
    expect(within(noChannel).getByText(/no emergency contact on file/)).toBeInTheDocument();
    // AB-08: rows are IDs + lifecycle only — assert the served IDs render, nothing wider.
    expect(within(failed).getByText(/b0 \(confirmed\)/)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('status')
          .map((n) => n.textContent)
          .join(' ')
      ).toContain('3 alerts')
    );
  });

  it('forwards the delivery-status filter to the API', async () => {
    const ue = userEvent.setup();
    const calls = stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: MODERATOR }),
      'GET /api/moderation/alerts': ({ url }) =>
        url.includes('status=failed')
          ? jsonResponse(200, { alerts: [ALERTS[1]], page: 1, pageSize: 20, total: 1 })
          : alertsOk,
    });
    renderAt('/moderation/alerts');
    await screen.findByRole('listitem', { name: 'Safety alert — Delivered' });
    await ue.selectOptions(screen.getByLabelText('Delivery status'), 'failed');
    await waitFor(() =>
      expect(
        screen.queryByRole('listitem', { name: 'Safety alert — Delivered' })
      ).not.toBeInTheDocument()
    );
    expect(
      calls.filter((c) => c.key === 'GET /api/moderation/alerts' && c.url.includes('status=failed'))
    ).toHaveLength(1);
  });
});

describe('AlertsPage — AB-04 escalation', () => {
  it('validates the booking id client-side before any POST', async () => {
    const ue = userEvent.setup();
    const calls = stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: MODERATOR }),
      'GET /api/moderation/alerts': alertsOk,
    });
    renderAt('/moderation/alerts');
    await screen.findByRole('listitem', { name: 'Safety alert — Delivered' });
    await ue.type(screen.getByLabelText(/^Booking ID/), 'not-a-uuid');
    await ue.click(screen.getByRole('button', { name: 'Raise safety alert' }));
    expect(await screen.findByRole('alert', { name: 'There is a problem' })).toHaveTextContent(
      'Enter the booking ID as a UUID'
    );
    expect(calls.filter((c) => c.key === 'POST /api/moderation/alerts')).toHaveLength(0);
  });

  it('escalates by bookingId, announces RECORDED (never delivered), and reloads the list', async () => {
    const ue = userEvent.setup();
    const calls = stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: MODERATOR }),
      'GET /api/moderation/alerts': alertsOk,
      'POST /api/moderation/alerts': jsonResponse(201, {
        alert: alertRow({ id: 'a9', bookingId: BOOKING_ID, deliveryStatus: 'pending' }),
      }),
    });
    renderAt('/moderation/alerts');
    await screen.findByRole('listitem', { name: 'Safety alert — Delivered' });
    await ue.type(screen.getByLabelText(/^Booking ID/), BOOKING_ID);
    await ue.click(screen.getByRole('button', { name: 'Raise safety alert' }));

    // The visible confirmation (also announced): RECORDED — the 201 precedes any delivery
    // (ADR-001/003), so the UI must never claim delivery. (findAll: the aria-live region
    // may briefly carry the same text before the reload announcement replaces it.)
    const notices = await screen.findAllByText(
      new RegExp(`Safety alert recorded for booking ${BOOKING_ID}`)
    );
    const notice = notices.find((node) => node.tagName === 'P');
    expect(notice).toBeTruthy();
    expect(notice.textContent).not.toMatch(/was delivered|has been delivered/i);
    const post = calls.find((c) => c.key === 'POST /api/moderation/alerts');
    expect(post.body).toEqual({ bookingId: BOOKING_ID });
    // The queue reloads so the new alert (and its delivery state) becomes visible.
    expect(calls.filter((c) => c.key === 'GET /api/moderation/alerts').length).toBeGreaterThan(1);
  });
});
