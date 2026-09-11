// client/src/features/host/EditMealPage.test.jsx — /host/meals/:id/edit (FR-11 update: only
// changed fields are PATCHed; owner-only; ADR-010 presence-guarded address pre-fill).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import AppLayout from '../../layout/AppLayout.jsx';
import { SessionProvider } from '../../session/index.js';
import { StatusAnnouncer } from '../../ui/index.js';
import hostRoutes from './routes.jsx';
import { changedFields, valuesFromListing } from './EditMealPage.jsx';

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

/** The owner's privileged read (ADR-010): public projection PLUS the exact address. */
const OWNED = Object.freeze({
  id: 'listing-7',
  hostId: 'u-host',
  title: 'Injera Night',
  description: 'A shared Ethiopian dinner.',
  ingredients: ['Teff flour', 'Berbere'],
  allergens: ['Gluten'],
  cuisine: 'Ethiopian',
  scheduledStart: '2099-09-14T01:30:00.000Z', // 18:30 America/Los_Angeles
  durationMinutes: 90,
  seatCapacity: 6,
  seatsRemaining: 6,
  status: 'active',
  moderationStatus: 'approved',
  city: 'San Diego',
  region: 'CA',
  country: 'US',
  addressLine1: '742 Evergreen Terrace',
  postalCode: '92104',
  images: [],
  host: { displayName: 'Rosa' },
  reviews: [],
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

function stubFetch(handlers) {
  const calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init = {}) => {
      const method = init.method || 'GET';
      const path = String(url).split('?')[0];
      const key = `${method} ${path}`;
      const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ key, body });
      const handler = handlers[key];
      if (!handler) throw new Error(`EditMealPage.test: unexpected fetch ${key}`);
      return typeof handler === 'function' ? handler({ body }) : handler;
    })
  );
  return calls;
}

function renderAt(path) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <AppLayout />,
        children: [
          ...hostRoutes,
          { path: 'listings/:id', element: <p>listing-detail-route</p> },
          { path: '*', element: <p>route-miss</p> },
        ],
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

describe('valuesFromListing / changedFields (pure)', () => {
  it('pre-fills from the privileged payload, address included, time in LA wall clock', () => {
    const values = valuesFromListing(OWNED);
    expect(values.when).toBe('2099-09-13T18:30');
    expect(values.ingredients).toBe('Teff flour\nBerbere');
    expect(values.street).toBe('742 Evergreen Terrace');
    expect(values.zip).toBe('92104');
    expect(values.seats).toBe('6');
  });

  it('leaves the address blank when the payload does not carry it (public projection)', () => {
    const { addressLine1: _addressLine1, postalCode: _postalCode, ...publicOnly } = OWNED;
    const values = valuesFromListing(publicOnly);
    expect(values.street).toBe('');
    expect(values.zip).toBe('');
  });

  it('diffs only what changed', () => {
    expect(changedFields({ a: 1, b: [1, 2], c: 'x' }, { a: 1, b: [1, 3], c: 'x' })).toEqual({
      b: [1, 3],
    });
    expect(changedFields({ a: 1 }, { a: 1 })).toEqual({});
  });
});

describe('EditMealPage — /host/meals/:id/edit (FR-11 update)', () => {
  it('a non-owner is refused client-side (the server also refuses) and pointed at the meal', async () => {
    stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: { ...HOST, id: 'someone-else' } }),
      'GET /api/listings/listing-7': jsonResponse(200, { listing: OWNED }),
    });
    renderAt('/host/meals/listing-7/edit');
    const main = within(await screen.findByRole('main'));
    await waitFor(() =>
      expect(main.getByText(/Only the host who created this meal/)).toBeInTheDocument()
    );
    expect(main.queryByLabelText(/^Title/)).toBeNull();
  });

  it('the owner sees the pre-filled form and PATCHes only the changed fields', async () => {
    const calls = stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: HOST }),
      'GET /api/listings/listing-7': jsonResponse(200, { listing: OWNED }),
      'PATCH /api/listings/listing-7': jsonResponse(200, {
        listing: { ...OWNED, seatCapacity: 8 },
      }),
    });
    const router = renderAt('/host/meals/listing-7/edit');
    const user = userEvent.setup();
    const seats = await screen.findByLabelText(/^Seats/);
    expect(seats).toHaveValue(6);
    expect(screen.getByLabelText(/^Street address/)).toHaveValue('742 Evergreen Terrace');
    await user.clear(seats);
    await user.type(seats, '8');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/listings/listing-7'));
    const patches = calls.filter((c) => c.key === 'PATCH /api/listings/listing-7');
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ seatCapacity: 8 }); // nothing else was sent
  });

  it('saving with nothing changed sends no request and says so', async () => {
    const calls = stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: HOST }),
      'GET /api/listings/listing-7': jsonResponse(200, { listing: OWNED }),
    });
    renderAt('/host/meals/listing-7/edit');
    const user = userEvent.setup();
    await screen.findByLabelText(/^Seats/);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(within(screen.getByRole('main')).getByText(/Nothing changed/)).toBeInTheDocument()
    );
    expect(calls.filter((c) => c.key.startsWith('PATCH'))).toHaveLength(0);
  });
});
