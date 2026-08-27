// client/src/features/community/SafetyAlertPage.test.jsx — U6-COMMUNITY acceptance specs
// for the FR-07 safety-alert screen (plus the NFR-07 clauses checkable in jsdom).
// Pins: raising REQUIRES explicit confirmation through the kit Dialog (open → nothing sent;
// cancel → nothing sent; only the confirm button posts, with the schema's empty body); on
// success the screen states the three-part FR-07 outcome — persisted / moderators notified /
// emergency-contact delivery attempted with retry — and announces it politely; a user with
// no emergency contact on file is pointed to /account both BEFORE raising and in the
// outcome; typed refusals (403 NOT_PARTICIPANT) render real messages and are announced via
// the assertive aria-live region (build-plan G.2); one h1 + document.title.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../../session/index.js';
import { StatusAnnouncer } from '../../ui/index.js';
import SafetyAlertPage from './SafetyAlertPage.jsx';

const BOOKING_ID = 'b0000000-0000-4000-8000-000000000003';
const CONTACT_USER = {
  id: 'u-guest',
  email: 'guest@example.com',
  emailVerified: true,
  fullName: 'Gaia Guest',
  roles: ['user'],
  emergencyContact: { name: 'Max Contact', phone: '+14155552671', email: 'max@example.com' },
};
const NO_CONTACT_USER = { ...CONTACT_USER, emergencyContact: null };

const ME_KEY = 'GET /api/users/me';
const ALERT_KEY = `POST /api/bookings/${BOOKING_ID}/safety-alerts`;

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

function apiError(status, code, message) {
  return jsonResponse(status, { error: { code, message, correlationId: 'corr-1' } });
}

function alertResponse() {
  return jsonResponse(201, {
    alert: {
      id: 'a1',
      bookingId: BOOKING_ID,
      raisedByUserId: CONTACT_USER.id,
      deliveryStatus: 'pending',
      deliveredAt: null,
      createdAt: '2026-08-26T10:00:00.000Z',
    },
  });
}

/** Route-by-URL fetch stub: handlers = { 'METHOD /path': response | (url, init) => resp }. */
function stubFetch(handlers) {
  const fn = vi.fn(async (url, init) => {
    const key = `${init.method} ${String(url).split('?')[0]}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`SafetyAlertPage.test: unexpected fetch ${key}`);
    return typeof handler === 'function' ? handler(url, init) : handler;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderPage(handlers, user = CONTACT_USER) {
  const fn = stubFetch({ [ME_KEY]: jsonResponse(200, { user }), ...handlers });
  const router = createMemoryRouter(
    [{ path: '/bookings/:bookingId/safety-alert', element: <SafetyAlertPage /> }],
    { initialEntries: [`/bookings/${BOOKING_ID}/safety-alert`] }
  );
  render(
    <SessionProvider>
      <StatusAnnouncer />
      <RouterProvider router={router} />
    </SessionProvider>
  );
  return fn;
}

/** The StatusAnnouncer region for one politeness level. */
function liveRegion(politeness) {
  const role = politeness === 'assertive' ? 'alert' : 'status';
  return screen.getAllByRole(role).find((el) => el.getAttribute('aria-live') === politeness);
}

function alertCalls(fn) {
  return fn.mock.calls.filter(
    ([url, init]) => init.method === 'POST' && String(url).includes('/safety-alerts')
  );
}

/** Find text rendered in the PAGE (excluding the aria-live mirror, which repeats it). */
async function findRendered(matcher) {
  const matches = await screen.findAllByText(matcher);
  const rendered = matches.filter((el) => !el.closest('[aria-live]'));
  expect(rendered.length).toBeGreaterThan(0);
  return rendered[0];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('explicit confirmation (FR-07, NFR-07 dialog pattern)', () => {
  it('explains the three-part outcome and sends nothing on render', async () => {
    const fn = renderPage({});
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Safety alert' })
    ).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(document.title).toBe('Safety alert — Homeplate');
    expect(
      screen.getByRole('heading', { level: 2, name: 'What happens when you raise an alert' })
    ).toBeInTheDocument();
    expect(screen.getByText(/retried automatically/i)).toBeInTheDocument();
    expect(alertCalls(fn)).toHaveLength(0);
  });

  it('opening the dialog does not post; cancelling closes it without posting', async () => {
    const fn = renderPage({});
    await screen.findByRole('heading', { level: 1, name: 'Safety alert' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Raise a safety alert' }));

    const dialog = screen.getByRole('dialog', { name: 'Raise a safety alert?' });
    expect(dialog).toBeInTheDocument();
    expect(alertCalls(fn)).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(alertCalls(fn)).toHaveLength(0);
  });

  it('confirming posts the empty-body alert and reports the three-part outcome', async () => {
    const fn = renderPage({ [ALERT_KEY]: alertResponse() });
    await screen.findByRole('heading', { level: 1, name: 'Safety alert' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Raise a safety alert' }));
    await user.click(screen.getByRole('button', { name: 'Yes, raise the alert' }));

    const outcome = await screen.findByRole('heading', { level: 2, name: 'Alert raised' });
    expect(outcome).toBeInTheDocument();
    // The three FR-07 parts: persisted, moderator notified, emergency delivery with retry.
    expect(
      screen.getByText(/has been recorded — it is saved and cannot be lost/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/moderators have been notified/i)).toBeInTheDocument();
    expect(
      screen.getByText(/delivery to your emergency contact is being attempted by email/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/it is retried automatically/i)).toBeInTheDocument();
    expect(liveRegion('polite')).toHaveTextContent(
      'Safety alert recorded. Moderators are notified and delivery to your emergency contact will be attempted.'
    );
    // Exactly one POST, with the schema's deliberately empty body.
    const posts = alertCalls(fn);
    expect(posts).toHaveLength(1);
    expect(posts[0][1].body).toBe('{}');
    // The dialog closed after the action.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('no emergency contact on file (FR-07 no_channel leg)', () => {
  it('points to /account before raising and reports no delivery attempted after', async () => {
    renderPage({ [ALERT_KEY]: alertResponse() }, NO_CONTACT_USER);
    expect(
      await screen.findByRole('heading', { level: 2, name: 'No emergency contact on file' })
    ).toBeInTheDocument();
    const preLink = screen.getByRole('link', { name: 'your account settings' });
    expect(preLink).toHaveAttribute('href', '/account');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Raise a safety alert' }));
    expect(
      screen.getByText(/no emergency contact is on file, so only moderators will be notified/i)
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes, raise the alert' }));

    await screen.findByRole('heading', { level: 2, name: 'Alert raised' });
    expect(screen.getByText(/no emergency-contact delivery was\s+attempted/i)).toBeInTheDocument();
    // Pointed to /account again in the outcome (two links total now).
    expect(screen.getAllByRole('link', { name: 'your account settings' })).toHaveLength(2);
    expect(liveRegion('polite')).toHaveTextContent(
      'Safety alert recorded. Moderators are notified.'
    );
  });
});

describe('typed refusals (build-plan G.2)', () => {
  it('renders and announces the typed 403 NOT_PARTICIPANT message', async () => {
    renderPage({
      [ALERT_KEY]: apiError(
        403,
        'NOT_PARTICIPANT',
        'Only the guest or the host may raise a safety alert on this booking.'
      ),
    });
    await screen.findByRole('heading', { level: 1, name: 'Safety alert' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Raise a safety alert' }));
    await user.click(screen.getByRole('button', { name: 'Yes, raise the alert' }));

    expect(await findRendered(/guest or host can use this page/i)).toBeInTheDocument();
    expect(liveRegion('assertive')).toHaveTextContent(/guest or host can use this page/i);
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Alert raised' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders and announces the actionable sign-in copy on a 401 NO_SESSION (finding U6VC-F1)', async () => {
    renderPage({ [ALERT_KEY]: apiError(401, 'NO_SESSION', 'Session is invalid or expired') });
    await screen.findByRole('heading', { level: 1, name: 'Safety alert' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Raise a safety alert' }));
    await user.click(screen.getByRole('button', { name: 'Yes, raise the alert' }));

    expect(
      await findRendered(/go to the login page, sign in, then come back here/i)
    ).toBeInTheDocument();
    expect(liveRegion('assertive')).toHaveTextContent(/sign in first/i);
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Alert raised' })
    ).not.toBeInTheDocument();
  });
});
