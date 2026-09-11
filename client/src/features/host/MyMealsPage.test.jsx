// client/src/features/host/MyMealsPage.test.jsx — /host/meals (FR-11 host dashboard): every
// upcoming meal in every state, with status in words, seats booked and price per seat.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import AppLayout from '../../layout/AppLayout.jsx';
import { SessionProvider } from '../../session/index.js';
import { StatusAnnouncer } from '../../ui/index.js';
import hostRoutes from './routes.jsx';
import { priceText, statusText } from './MyMealsPage.jsx';

const HOST = Object.freeze({
  id: 'u-host',
  email: 'rosa@example.com',
  emailVerified: true,
  fullName: 'Rosa Host',
  phone: '+16195550100',
  emergencyContact: null,
  canReserveSeat: true,
  canPublishListing: true,
  roles: ['user'],
  hostProfile: { displayName: 'Rosa', bio: 'Cooking for years.' },
  createdAt: '2026-08-01T00:00:00.000Z',
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}
function errorResponse(status, code, message) {
  return jsonResponse(status, { error: { code, message, correlationId: 'corr-test' } });
}

function stubFetch(handlers) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init = {}) => {
      const method = init.method || 'GET';
      const key = `${method} ${String(url).split('?')[0]}`;
      const handler = handlers[key];
      if (!handler) throw new Error(`MyMealsPage.test: unexpected fetch ${key}`);
      return handler;
    })
  );
}

function renderAt(path) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <AppLayout />,
        children: [...hostRoutes, { path: '*', element: <p>route-miss</p> }],
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
}

const listing = (o) => ({
  id: 'l-1',
  hostId: 'u-host',
  title: 'Injera Night',
  scheduledStart: '2099-09-14T01:30:00.000Z',
  seatCapacity: 6,
  seatsRemaining: 4,
  pricePerSeatCents: 1850,
  status: 'active',
  moderationStatus: 'approved',
  images: [],
  ...o,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pure helpers', () => {
  it('formats prices from whole cents, with Free for 0', () => {
    expect(priceText(1800)).toBe('$18 per seat');
    expect(priceText(1850)).toBe('$18.50 per seat');
    expect(priceText(0)).toBe('Free');
    expect(priceText(undefined)).toBe('Price not set');
  });
  it('says the state in words, cancelled winning over moderation', () => {
    expect(statusText(listing({ moderationStatus: 'pending' }))).toMatch(/Pending moderation/);
    expect(statusText(listing({ status: 'cancelled', moderationStatus: 'approved' }))).toBe(
      'Cancelled'
    );
    expect(statusText(listing({ moderationStatus: 'rejected' }))).toMatch(/Rejected/);
    expect(statusText(listing())).toMatch(/Published/);
  });
});

describe('MyMealsPage — /host/meals (FR-11)', () => {
  it('anonymous: sign-in links, no request for meals', async () => {
    stubFetch({ 'GET /api/users/me': errorResponse(401, 'NO_SESSION', 'Authentication required') });
    renderAt('/host/meals');
    const main = within(await screen.findByRole('main'));
    await waitFor(() => expect(main.getByRole('link', { name: 'Sign in' })).toBeInTheDocument());
    expect(main.queryByRole('list', { name: 'Your upcoming meals' })).toBeNull();
  });

  it('lists every upcoming meal with state, seats booked, price and links; offers Host a meal', async () => {
    stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: HOST }),
      'GET /api/listings/mine': jsonResponse(200, {
        listings: [
          listing(),
          listing({
            id: 'l-2',
            title: 'Pozole Sunday',
            moderationStatus: 'pending',
            seatsRemaining: 6,
            pricePerSeatCents: 0,
          }),
          listing({ id: 'l-3', title: 'Cancelled Supper', status: 'cancelled' }),
        ],
      }),
    });
    renderAt('/host/meals');
    const list = await screen.findByRole('list', { name: 'Your upcoming meals' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Injera Night');
    expect(items[0]).toHaveTextContent('Published — visible to guests');
    expect(items[0]).toHaveTextContent('2 of 6 booked');
    expect(items[0]).toHaveTextContent('$18.50 per seat');
    expect(within(items[0]).getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/host/meals/l-1/edit'
    );
    expect(items[1]).toHaveTextContent('Pending moderation review');
    expect(items[1]).toHaveTextContent('Free');
    expect(items[2]).toHaveTextContent('Cancelled');
    expect(within(items[2]).queryByRole('link', { name: 'Edit' })).toBeNull();
    expect(
      within(screen.getByRole('main')).getByRole('link', { name: 'Host a meal' })
    ).toHaveAttribute('href', '/host/meals/new');
  });

  it('says so when there are no upcoming meals', async () => {
    stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: HOST }),
      'GET /api/listings/mine': jsonResponse(200, { listings: [] }),
    });
    renderAt('/host/meals');
    await waitFor(() =>
      expect(
        within(screen.getByRole('main')).getByText(/no upcoming meals yet/i)
      ).toBeInTheDocument()
    );
  });
});
