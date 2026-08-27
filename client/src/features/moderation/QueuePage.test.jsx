// client/src/features/moderation/QueuePage.test.jsx — U6-ACCOUNT-MOD specs for /moderation
// (FR-08: the queue lists ALL FOUR content types incl. safety_alert; decisions with
// category + optional note update the list; the client role gate is UX and the server 403
// renders the same clean screen — AB-08 enforcement stays server-side; NFR-07 labelled
// filters/controls and announced outcomes).
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

function queueItem(overrides) {
  return {
    id: 'q0',
    contentType: 'listing',
    contentId: 'c0',
    reason: 'llm_flagged',
    status: 'open',
    assignedTo: null,
    decisionId: null,
    createdAt: '2026-08-20T18:00:00.000Z',
    resolvedAt: null,
    contentStatus: 'pending',
    excerpt: 'excerpt text',
    latestDecision: null,
    ...overrides,
  };
}

// One of each §3.4 content type — safety_alert included since the W4-F1 repair.
const ITEMS = [
  queueItem({ id: 'q1', contentType: 'listing', contentId: 'c1', excerpt: 'Spicy stew night' }),
  queueItem({ id: 'q2', contentType: 'review', contentId: 'c2', excerpt: 'Terrible host!!' }),
  queueItem({ id: 'q3', contentType: 'message', contentId: 'c3', excerpt: 'Buy my thing' }),
  queueItem({
    id: 'q4',
    contentType: 'safety_alert',
    contentId: 'c4',
    reason: 'safety_alert',
    excerpt: null,
    contentStatus: null,
  }),
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
    if (!handler) throw new Error(`QueuePage.test: unexpected fetch ${key}`);
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

const queueOk = jsonResponse(200, { items: ITEMS, page: 1, pageSize: 20, total: 4 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QueuePage — role gating (client UX; server 403 is the enforcement)', () => {
  it('anonymous: sign-in prompt, and the queue endpoint is never called', async () => {
    const calls = stubFetch({
      'GET /api/users/me': errorResponse(401, 'NO_SESSION', 'Authentication required'),
    });
    renderAt('/moderation');
    expect(await screen.findByRole('heading', { name: 'Sign in required' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(calls.filter((c) => c.key === 'GET /api/moderation/queue')).toHaveLength(0);
  });

  it('signed-in non-moderator: the clean 403 screen, no queue call', async () => {
    const calls = stubFetch({ 'GET /api/users/me': jsonResponse(200, { user: PLAIN_USER }) });
    renderAt('/moderation');
    expect(
      await screen.findByRole('heading', { name: 'Moderator access required (403)' })
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.key === 'GET /api/moderation/queue')).toHaveLength(0);
  });

  it('server-side 403 (role stripped server-side) renders the same clean 403 screen', async () => {
    stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: MODERATOR }),
      'GET /api/moderation/queue': errorResponse(
        403,
        'NOT_MODERATOR',
        'Only a moderator may read the moderation queue.'
      ),
    });
    renderAt('/moderation');
    expect(
      await screen.findByRole('heading', { name: 'Moderator access required (403)' })
    ).toBeInTheDocument();
  });
});

describe('QueuePage — FR-08 queue rendering', () => {
  it('renders one h1/title and all four content types with excerpts (safety_alert has none by design)', async () => {
    stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: MODERATOR }),
      'GET /api/moderation/queue': queueOk,
    });
    renderAt('/moderation');
    expect(screen.getByRole('heading', { level: 1, name: 'Moderation queue' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Moderation queue — Homeplate'));
    expect(await screen.findByRole('listitem', { name: 'Listing — Open' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Review — Open' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Message — Open' })).toBeInTheDocument();
    const alertItem = screen.getByRole('listitem', { name: 'Safety alert — Open' });
    expect(screen.getByText('Spicy stew night')).toBeInTheDocument();
    expect(screen.getByText('Terrible host!!')).toBeInTheDocument();
    // No text content on a safety alert — the item says so and links to the alerts view.
    expect(within(alertItem).getByText(/no text content by design/)).toBeInTheDocument();
    expect(within(alertItem).getByRole('link', { name: /safety alerts view/i })).toHaveAttribute(
      'href',
      '/moderation/alerts'
    );
    // The load is announced politely (NFR-07).
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('status')
          .map((n) => n.textContent)
          .join(' ')
      ).toContain('4 items')
    );
  });

  it('forwards the content-type filter to the API and resets to page 1', async () => {
    const ue = userEvent.setup();
    const calls = stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: MODERATOR }),
      'GET /api/moderation/queue': ({ url }) =>
        url.includes('contentType=safety_alert')
          ? jsonResponse(200, { items: [ITEMS[3]], page: 1, pageSize: 20, total: 1 })
          : queueOk,
    });
    renderAt('/moderation');
    await screen.findByRole('listitem', { name: 'Listing — Open' });
    await ue.selectOptions(screen.getByLabelText('Content type'), 'safety_alert');
    await waitFor(() =>
      expect(screen.queryByRole('listitem', { name: 'Listing — Open' })).not.toBeInTheDocument()
    );
    expect(screen.getByRole('listitem', { name: 'Safety alert — Open' })).toBeInTheDocument();
    const filtered = calls.filter(
      (c) => c.key === 'GET /api/moderation/queue' && c.url.includes('contentType=safety_alert')
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].url).toContain('page=1');
  });
});

describe('QueuePage — FR-08 decisions', () => {
  it('requires a category client-side before any decision is posted', async () => {
    const ue = userEvent.setup();
    const calls = stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: MODERATOR }),
      'GET /api/moderation/queue': queueOk,
    });
    renderAt('/moderation');
    const item = await screen.findByRole('listitem', { name: 'Listing — Open' });
    await ue.click(within(item).getByRole('button', { name: 'Approve' }));
    expect(
      await within(item).findByText('Choose a category before recording a decision')
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.key.startsWith('POST '))).toHaveLength(0);
  });

  it('posts approve + category + note, announces it, and updates the item in place', async () => {
    const ue = userEvent.setup();
    const resolvedItem = queueItem({
      id: 'q1',
      contentType: 'listing',
      contentId: 'c1',
      status: 'resolved',
      resolvedAt: '2026-08-26T12:00:00.000Z',
      excerpt: null, // the decision response reloads no content row (AB-08)
      contentStatus: null,
      latestDecision: {
        id: 'd1',
        category: 'benign',
        confidence: null,
        outcome: 'approved',
        decidedBy: 'human',
        modelId: null,
        createdAt: '2026-08-26T12:00:00.000Z',
      },
    });
    const calls = stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: MODERATOR }),
      'GET /api/moderation/queue': queueOk,
      'POST /api/moderation/queue/q1/decision': jsonResponse(200, {
        item: resolvedItem,
        decision: { id: 'd1', contentType: 'listing', contentId: 'c1' },
      }),
    });
    renderAt('/moderation');
    const item = await screen.findByRole('listitem', { name: 'Listing — Open' });
    await ue.selectOptions(within(item).getByLabelText(/^Category/), 'benign');
    await ue.type(within(item).getByLabelText(/note/i), 'Looks fine.');
    await ue.click(within(item).getByRole('button', { name: 'Approve' }));

    // The list updates in place: same item, now resolved, excerpt preserved from the page.
    const resolved = await screen.findByRole('listitem', { name: 'Listing — Resolved' });
    expect(within(resolved).getByText('Spicy stew night')).toBeInTheDocument();
    expect(within(resolved).getByText(/no further action possible here/)).toBeInTheDocument();

    const post = calls.find((c) => c.key === 'POST /api/moderation/queue/q1/decision');
    expect(post.body).toEqual({ decision: 'approve', category: 'benign', note: 'Looks fine.' });
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('status')
          .map((n) => n.textContent)
          .join(' ')
      ).toContain('Decision recorded: approved as benign.')
    );
  });

  it('renders QUEUE_ITEM_RESOLVED (a moderator race) as its own visible + announced message', async () => {
    const ue = userEvent.setup();
    stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: MODERATOR }),
      'GET /api/moderation/queue': queueOk,
      'POST /api/moderation/queue/q2/decision': errorResponse(
        409,
        'QUEUE_ITEM_RESOLVED',
        'This queue item is already resolved.'
      ),
    });
    renderAt('/moderation');
    const item = await screen.findByRole('listitem', { name: 'Review — Open' });
    await ue.selectOptions(within(item).getByLabelText(/^Category/), 'spam');
    await ue.click(within(item).getByRole('button', { name: 'Reject' }));
    expect(
      await within(item).findByText(/already resolved \(possibly by another moderator\)/)
    ).toBeInTheDocument();
  });
});
