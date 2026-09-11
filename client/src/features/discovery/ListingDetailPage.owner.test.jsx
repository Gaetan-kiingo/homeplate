// client/src/features/discovery/ListingDetailPage.owner.test.jsx — the FR-11 manage block on
// the listing page (2026-09-11, closes OBS-B3): edit link and inline cancel confirmation for
// the listing's host only; never for another viewer; never without a session store.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { ApiError } from '../../api/errors.js';
import { StatusAnnouncer } from '../../ui/index.js';
import { SessionContext } from '../../session/context.js';
import discoveryRoutes from './routes.jsx';

vi.mock('../../api/index.js', () => ({
  api: {
    search: vi.fn(),
    listings: { getListing: vi.fn(), cancel: vi.fn() },
    hosts: { getHost: vi.fn(), reviews: vi.fn() },
  },
}));
import { api } from '../../api/index.js';

function listing(overrides = {}) {
  return {
    id: 'listing-1',
    hostId: 'host-1',
    title: 'Injera Night',
    description: 'A shared Ethiopian dinner.',
    ingredients: ['Teff flour'],
    allergens: [],
    cuisine: 'Ethiopian',
    scheduledStart: '2099-09-04T01:30:00.000Z',
    durationMinutes: 90,
    localDate: '2099-09-03',
    city: 'San Diego',
    region: 'CA',
    country: 'US',
    areaLabel: 'North Park',
    seatCapacity: 6,
    seatsRemaining: 4,
    status: 'active',
    moderationStatus: 'approved',
    images: [],
    host: { displayName: 'Chef Alem', bio: '', averageRating: null, reviewCount: 0 },
    reviews: [],
    reviewsTotal: 0,
    reviewsPageSize: 5,
    ...overrides,
  };
}

function renderAs(sessionValue) {
  const router = createMemoryRouter(
    [{ path: '/', children: [...discoveryRoutes, { path: '*', element: <p>miss</p> }] }],
    { initialEntries: ['/listings/listing-1'] }
  );
  const tree = (
    <>
      <StatusAnnouncer />
      <RouterProvider router={router} />
    </>
  );
  render(
    sessionValue === undefined ? (
      tree
    ) : (
      <SessionContext.Provider value={sessionValue}>{tree}</SessionContext.Provider>
    )
  );
}

const asOwner = { status: 'authenticated', user: { id: 'host-1', roles: ['user'] } };
const asGuest = { status: 'authenticated', user: { id: 'guest-2', roles: ['user'] } };

afterEach(() => {
  vi.clearAllMocks();
});

describe('ListingDetailPage — owner manage block (FR-11)', () => {
  it('shows edit + cancel to the host, with the pending note while moderation is outstanding', async () => {
    api.listings.getListing.mockResolvedValue({
      listing: listing({ moderationStatus: 'pending' }),
    });
    renderAs(asOwner);
    const section = await screen.findByRole('region', { name: 'You host this meal' });
    expect(within(section).getByRole('link', { name: 'Edit this meal' })).toHaveAttribute(
      'href',
      '/host/meals/listing-1/edit'
    );
    expect(section).toHaveTextContent(/waiting for moderation review/);
    expect(within(section).getByRole('button', { name: 'Cancel this meal' })).toBeInTheDocument();
  });

  it('shows nothing of the sort to another signed-in viewer, nor without a session store', async () => {
    api.listings.getListing.mockResolvedValue({ listing: listing() });
    renderAs(asGuest);
    await screen.findByRole('heading', { level: 1, name: 'Injera Night' });
    expect(screen.queryByRole('region', { name: 'You host this meal' })).toBeNull();

    vi.clearAllMocks();
    api.listings.getListing.mockResolvedValue({ listing: listing() });
    renderAs(undefined);
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 1, name: 'Injera Night' }).length).toBe(2)
    );
    expect(screen.queryByRole('region', { name: 'You host this meal' })).toBeNull();
  });

  it('cancels only after the inline confirmation, then renders the cancelled state', async () => {
    api.listings.getListing.mockResolvedValue({ listing: listing() });
    api.listings.cancel.mockResolvedValue({ listing: { id: 'listing-1', status: 'cancelled' } });
    renderAs(asOwner);
    const user = userEvent.setup();
    const section = await screen.findByRole('region', { name: 'You host this meal' });
    await user.click(within(section).getByRole('button', { name: 'Cancel this meal' }));
    expect(api.listings.cancel).not.toHaveBeenCalled(); // asking is not doing
    await user.click(within(section).getByRole('button', { name: 'Yes, cancel the meal' }));
    await waitFor(() => expect(api.listings.cancel).toHaveBeenCalledWith('listing-1'));
    await waitFor(() =>
      expect(screen.getByText('This meal has been cancelled by the host.')).toBeInTheDocument()
    );
    expect(screen.getByRole('status')).toHaveTextContent(/Meal cancelled/);
  });

  it('"Keep the meal" backs out without a request; a refused cancel is rendered as text', async () => {
    api.listings.getListing.mockResolvedValue({ listing: listing() });
    api.listings.cancel.mockRejectedValue(
      new ApiError('Already cancelled.', { status: 409, code: 'LISTING_CANCELLED' })
    );
    renderAs(asOwner);
    const user = userEvent.setup();
    const section = await screen.findByRole('region', { name: 'You host this meal' });
    await user.click(within(section).getByRole('button', { name: 'Cancel this meal' }));
    await user.click(within(section).getByRole('button', { name: 'Keep the meal' }));
    expect(api.listings.cancel).not.toHaveBeenCalled();
    expect(within(section).getByRole('button', { name: 'Cancel this meal' })).toBeInTheDocument();

    await user.click(within(section).getByRole('button', { name: 'Cancel this meal' }));
    await user.click(within(section).getByRole('button', { name: 'Yes, cancel the meal' }));
    await waitFor(() =>
      expect(within(section).getByText('This meal was already cancelled.')).toBeInTheDocument()
    );
  });
});
