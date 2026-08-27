// client/src/features/community/MessagesPage.test.jsx — U6-COMMUNITY acceptance specs for
// the FR-06 booking thread (plus the NFR-07 clauses checkable in jsdom).
// Pins: send renders the delivered 201 message immediately and announces it (ADR-002 —
// delivery never waits on moderation); 403 NOT_PARTICIPANT and 409 BOOKING_CANCELLED render
// REAL typed messages (never a stringified body — build-plan G.2) and are announced via the
// assertive aria-live region; an empty send is blocked client-side with no request leaving;
// the thread refreshes periodically (REFRESH_INTERVAL_MS) and politely announces genuinely
// new arrivals; one h1 + document.title; the send control is labelled and required; reads
// stay inside the capped pagination (NFR-02).
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../../session/index.js';
import { StatusAnnouncer } from '../../ui/index.js';
import MessagesPage, { REFRESH_INTERVAL_MS } from './MessagesPage.jsx';
import communityRoutes from './routes.jsx';

const BOOKING_ID = 'b0000000-0000-4000-8000-000000000001';
const GUEST = {
  id: 'u-guest',
  email: 'guest@example.com',
  emailVerified: true,
  fullName: 'Gaia Guest',
  roles: ['user'],
  emergencyContact: null,
};

const ME_KEY = 'GET /api/users/me';
const LIST_KEY = `GET /api/bookings/${BOOKING_ID}/messages`;
const SEND_KEY = `POST /api/bookings/${BOOKING_ID}/messages`;

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

function message(id, senderId, body) {
  return { id, bookingId: BOOKING_ID, senderId, body, createdAt: '2026-08-20T18:00:00.000Z' };
}

function threadResponse(items, extra = {}) {
  return jsonResponse(200, { items, page: 1, pageSize: 50, total: items.length, ...extra });
}

/** Route-by-URL fetch stub: handlers = { 'METHOD /path': response | (url, init) => resp }. */
function stubFetch(handlers) {
  const fn = vi.fn(async (url, init) => {
    const key = `${init.method} ${String(url).split('?')[0]}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`MessagesPage.test: unexpected fetch ${key}`);
    return typeof handler === 'function' ? handler(url, init) : handler;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderPage(handlers) {
  const fn = stubFetch({ [ME_KEY]: jsonResponse(200, { user: GUEST }), ...handlers });
  const router = createMemoryRouter(
    [{ path: '/bookings/:bookingId/messages', element: <MessagesPage /> }],
    { initialEntries: [`/bookings/${BOOKING_ID}/messages`] }
  );
  render(
    <SessionProvider>
      <StatusAnnouncer />
      <RouterProvider router={router} />
    </SessionProvider>
  );
  return fn;
}

/** The StatusAnnouncer region for one politeness level (Spinner/ErrorSummary excluded). */
function liveRegion(politeness) {
  const role = politeness === 'assertive' ? 'alert' : 'status';
  return screen.getAllByRole(role).find((el) => el.getAttribute('aria-live') === politeness);
}

function sendCalls(fn) {
  return fn.mock.calls.filter(
    ([url, init]) => init.method === 'POST' && String(url).includes('/messages')
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
  vi.useRealTimers();
});

describe('route contract (the U6-COMMUNITY public interface; NFR-07 harness mapping)', () => {
  it('declares exactly the three community paths, messages matching the a11y-harness messaging pattern', () => {
    const paths = communityRoutes.map((route) => route.path);
    expect(paths).toEqual([
      'bookings/:bookingId/messages',
      'bookings/:bookingId/review',
      'bookings/:bookingId/safety-alert',
    ]);
    for (const route of communityRoutes) {
      expect(route.element).toBeTruthy();
    }
    // scripts/a11y-audit.js maps route-path literals (leading '/' added) onto the seven
    // NFR-07 interfaces; the messaging pattern is /^\/bookings\/[^/]+\/messages/.
    const concrete = `/${paths[0]}`.replace(':bookingId', BOOKING_ID);
    expect(concrete).toMatch(/^\/bookings\/[^/]+\/messages/);
  });
});

describe('thread rendering (FR-06, NFR-07 structure)', () => {
  it('renders the thread with You/Other sender labels, one h1 and its document.title', async () => {
    const fn = renderPage({
      [LIST_KEY]: threadResponse([
        message('m1', GUEST.id, 'Hello! Looking forward to it.'),
        message('m2', 'u-host', 'Welcome — see you at seven.'),
      ]),
    });
    expect(await screen.findByText('Hello! Looking forward to it.')).toBeInTheDocument();
    expect(screen.getByText('Welcome — see you at seven.')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('Other participant')).toBeInTheDocument();
    // NFR-07: exactly one h1, and the route names itself.
    expect(
      screen.getByRole('heading', { level: 1, name: 'Booking conversation' })
    ).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(document.title).toBe('Booking conversation — Homeplate');
    // NFR-02: the read went out inside the server's capped pagination.
    const listCall = fn.mock.calls.find(([url]) => String(url).includes('/messages'));
    expect(String(listCall[0])).toContain('page=1');
    expect(String(listCall[0])).toContain('pageSize=50');
    // The send control is labelled (FormField) and required.
    expect(screen.getByRole('textbox', { name: /message/i })).toBeRequired();
  });

  it('renders the empty-thread invitation when there are no messages', async () => {
    renderPage({ [LIST_KEY]: threadResponse([]) });
    expect(
      await screen.findByText('No messages yet — start the conversation below.')
    ).toBeInTheDocument();
  });
});

describe('send (FR-06 — deliver immediately, ADR-002)', () => {
  it('renders the delivered message immediately, announces it and clears the field', async () => {
    const fn = renderPage({
      [LIST_KEY]: threadResponse([]),
      [SEND_KEY]: (url, init) =>
        jsonResponse(201, { message: message('m9', GUEST.id, JSON.parse(init.body).body) }),
    });
    await screen.findByText('No messages yet — start the conversation below.');
    const user = userEvent.setup();
    await user.type(
      screen.getByRole('textbox', { name: /message/i }),
      'Is parking available nearby?'
    );
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Is parking available nearby?')).toBeInTheDocument();
    expect(liveRegion('polite')).toHaveTextContent('Message sent.');
    expect(screen.getByRole('textbox', { name: /message/i })).toHaveValue('');
    // Exactly one POST left, carrying the typed body — nothing else invented.
    const posts = sendCalls(fn);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1].body)).toEqual({ body: 'Is parking available nearby?' });
  });

  it('blocks an empty send client-side: field error, assertive announcement, no request', async () => {
    const fn = renderPage({ [LIST_KEY]: threadResponse([]) });
    await screen.findByText('No messages yet — start the conversation below.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send message' }));

    expect(screen.getByRole('textbox', { name: /message/i })).toBeInvalid();
    expect(screen.getByRole('textbox', { name: /message/i })).toHaveAccessibleDescription(
      /enter a message before sending/i
    );
    expect(liveRegion('assertive')).toHaveTextContent('Enter a message before sending.');
    expect(sendCalls(fn)).toHaveLength(0);
  });

  it('maps a 409 BOOKING_CANCELLED send to its typed message and announces it', async () => {
    renderPage({
      [LIST_KEY]: threadResponse([message('m1', 'u-host', 'Hi')]),
      [SEND_KEY]: apiError(
        409,
        'BOOKING_CANCELLED',
        'This booking is cancelled; its thread is closed.'
      ),
    });
    await screen.findByText('Hi');
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: /message/i }), 'Anyone there?');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(
      await findRendered('This booking is cancelled, so its conversation is closed.')
    ).toBeInTheDocument();
    expect(liveRegion('assertive')).toHaveTextContent(
      'This booking is cancelled, so its conversation is closed.'
    );
  });
});

describe('typed load refusals (FR-06 participants only)', () => {
  it('renders the typed 403 NOT_PARTICIPANT message for a third party, with no send form', async () => {
    renderPage({
      [LIST_KEY]: apiError(
        403,
        'NOT_PARTICIPANT',
        'Only the guest or the host may use this booking thread.'
      ),
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Conversation unavailable' })
    ).toBeInTheDocument();
    expect(
      await findRendered(/guest or host can read or send messages in this conversation/i)
    ).toBeInTheDocument();
    expect(liveRegion('assertive')).toHaveTextContent(/guest or host/);
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
  });

  it('renders and announces the actionable sign-in copy on a 401 NO_SESSION (finding U6VC-F1)', async () => {
    renderPage({ [LIST_KEY]: apiError(401, 'NO_SESSION', 'Session is invalid or expired') });
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Conversation unavailable' })
    ).toBeInTheDocument();
    expect(
      await findRendered(/go to the login page, sign in, then come back here/i)
    ).toBeInTheDocument();
    expect(liveRegion('assertive')).toHaveTextContent(/sign in first/i);
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
  });

  it('renders the typed 409 BOOKING_CANCELLED message when the thread itself is closed', async () => {
    renderPage({
      [LIST_KEY]: apiError(
        409,
        'BOOKING_CANCELLED',
        'This booking is cancelled; its thread is closed.'
      ),
    });
    expect(
      await findRendered('This booking is cancelled, so its conversation is closed.')
    ).toBeInTheDocument();
  });
});

describe('periodic refresh (FR-06)', () => {
  it('polls the thread on the interval and politely announces genuinely new arrivals', async () => {
    vi.useFakeTimers();
    let listCalls = 0;
    renderPage({
      [LIST_KEY]: () => {
        listCalls += 1;
        return threadResponse(
          listCalls === 1
            ? [message('m1', 'u-host', 'Hi there')]
            : [message('m1', 'u-host', 'Hi there'), message('m2', 'u-host', 'Table is ready')]
        );
      },
    });
    await act(async () => {});
    expect(screen.getByText('Hi there')).toBeInTheDocument();
    expect(screen.queryByText('Table is ready')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    });
    expect(screen.getByText('Table is ready')).toBeInTheDocument();
    expect(liveRegion('polite')).toHaveTextContent('One new message in the conversation.');
  });

  it('keeps the last good thread when a background poll fails (no crash, no flip to error)', async () => {
    vi.useFakeTimers();
    let listCalls = 0;
    renderPage({
      [LIST_KEY]: () => {
        listCalls += 1;
        if (listCalls === 1) return threadResponse([message('m1', 'u-host', 'Hi there')]);
        throw new TypeError('network down');
      },
    });
    await act(async () => {});
    expect(screen.getByText('Hi there')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    });
    expect(screen.getByText('Hi there')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Conversation unavailable' })
    ).not.toBeInTheDocument();
  });
});
