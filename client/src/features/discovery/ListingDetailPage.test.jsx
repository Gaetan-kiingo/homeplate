// client/src/features/discovery/ListingDetailPage.test.jsx — U6-DISCOVERY acceptance specs
// for the FR-02 listing-detail screen. Proves: every FR-02 payload field renders (dish,
// description, ingredients, allergy warning, date/duration, seats, alt-texted images, host
// summary, approved-review preview with onward paging); the ADR-010 rule that a precise
// address renders ONLY when the payload itself carries it — and never otherwise; the FR-12
// Reserve CTA targets /bookings/new?listing=<id>; 401 redirects to /login (AB-08); typed
// failures render and announce (NFR-07 aria-live) instead of crashing.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { ApiError } from '../../api/errors.js';
import { StatusAnnouncer } from '../../ui/index.js';
import discoveryRoutes from './routes.jsx';

vi.mock('../../api/index.js', () => ({
  api: {
    search: vi.fn(),
    listings: { getListing: vi.fn() },
    hosts: { getHost: vi.fn(), reviews: vi.fn() },
  },
}));
// vi.mock is hoisted above every import by vitest, so this import receives the mock.
import { api } from '../../api/index.js';

function detailListing(overrides = {}) {
  return {
    id: 'listing-1',
    hostId: 'host-1',
    title: 'Injera Night',
    description: 'A shared Ethiopian dinner around one table.',
    ingredients: 'Teff flour, berbere, chicken, onions',
    allergens: 'Contains gluten and nightshades',
    cuisine: 'Ethiopian',
    scheduledStart: '2026-09-04T01:30:00.000Z', // = Sep 3, 2026, 6:30 PM America/Los_Angeles
    durationMinutes: 90,
    localDate: '2026-09-03',
    city: 'San Diego',
    region: 'CA',
    country: 'US',
    coarseLat: 32.75,
    coarseLng: -117.15,
    areaLabel: 'North Park',
    seatCapacity: 6,
    seatsRemaining: 4,
    status: 'active',
    moderationStatus: 'approved',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    images: [
      { id: 'img-1', url: '/media/img-1.jpg', contentType: 'image/jpeg' },
      { id: 'img-2', url: '/media/img-2.jpg', contentType: 'image/jpeg' },
    ],
    host: {
      displayName: 'Chef Alem',
      bio: 'Cooking Ethiopian food for twenty years.',
      averageRating: 4.8,
      reviewCount: 7,
    },
    reviews: [
      {
        id: 'rev-1',
        rating: 5,
        body: 'Wonderful evening.',
        createdAt: '2026-08-01T00:00:00.000Z',
        authorId: 'guest-9',
        authorDisplayName: 'Dana',
      },
    ],
    reviewsTotal: 7,
    reviewsPageSize: 5,
    ...overrides,
  };
}

function renderAt(initialPath) {
  const router = createMemoryRouter(
    [
      ...discoveryRoutes,
      { path: 'login', element: <h1>Sign in stub</h1> },
      { path: 'bookings/new', element: <h1>Booking stub</h1> },
    ],
    { initialEntries: [initialPath] }
  );
  render(
    <>
      <StatusAnnouncer />
      <RouterProvider router={router} />
    </>
  );
  return router;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('ListingDetailPage (FR-02, ADR-010, NFR-07)', () => {
  it('renders every FR-02 field: dish, description, ingredients, allergy warning, schedule, seats, images, host summary, reviews', async () => {
    api.listings.getListing.mockResolvedValue({ listing: detailListing() });
    renderAt('/listings/listing-1');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Injera Night' })
    ).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await waitFor(() => expect(document.title).toBe('Injera Night — Homeplate'));
    expect(screen.getByText('A shared Ethiopian dinner around one table.')).toBeInTheDocument();
    expect(screen.getByText('Teff flour, berbere, chicken, onions')).toBeInTheDocument();
    expect(screen.getByText(/Contains gluten and nightshades/)).toBeInTheDocument();
    expect(screen.getByText(/Allergy warning/)).toBeInTheDocument();
    // Meal-local wall clock (America/Los_Angeles) — deterministic on any machine.
    expect(screen.getByText('Sep 3, 2026, 6:30 PM')).toBeInTheDocument();
    expect(screen.getByText('90 minutes')).toBeInTheDocument();
    expect(screen.getByText('4 of 6 seats remaining')).toBeInTheDocument();
    // Every image carries derived alt text (NFR-07).
    expect(screen.getByAltText('Injera Night — photo 1 of 2')).toBeInTheDocument();
    expect(screen.getByAltText('Injera Night — photo 2 of 2')).toBeInTheDocument();
    // Host summary with a link to the FR-03 page.
    const hostLink = screen.getByRole('link', { name: 'Chef Alem' });
    expect(hostLink).toHaveAttribute('href', '/hosts/host-1');
    expect(screen.getByText('Cooking Ethiopian food for twenty years.')).toBeInTheDocument();
    expect(screen.getByText('Rated 4.8 out of 5 from 7 reviews')).toBeInTheDocument();
    // Approved-review preview.
    expect(screen.getByText('Wonderful evening.')).toBeInTheDocument();
    expect(screen.getByText('Dana')).toBeInTheDocument();
  });

  it('renders coarse area only and the disclosure note when the payload has no precise address (ADR-010)', async () => {
    api.listings.getListing.mockResolvedValue({ listing: detailListing() });
    renderAt('/listings/listing-1');
    await screen.findByRole('heading', { name: 'Injera Night' });
    expect(screen.getByText('North Park, San Diego, CA')).toBeInTheDocument();
    // No Address row exists, and the screen says WHY the exact address is withheld.
    expect(screen.queryByText('Address')).not.toBeInTheDocument();
    expect(
      screen.getByText(/exact address is shared once you have reserved a seat/)
    ).toBeInTheDocument();
  });

  it('renders the exact address ONLY when the payload itself carries it (booking-gated path)', async () => {
    api.listings.getListing.mockResolvedValue({
      listing: detailListing({
        addressLine1: '123 Fig St',
        addressLine2: 'Apt 2',
        postalCode: '92104',
        lat: 32.749123,
        lng: -117.129456,
      }),
    });
    renderAt('/listings/listing-1');
    await screen.findByRole('heading', { name: 'Injera Night' });
    expect(screen.getByText('Address')).toBeInTheDocument();
    expect(screen.getByText('123 Fig St, Apt 2, San Diego, CA, 92104')).toBeInTheDocument();
    expect(screen.queryByText(/exact address is shared only after/)).not.toBeInTheDocument();
    // Precise coordinates are never rendered, even when present (ADR-010).
    expect(screen.queryByText(/32\.749123/)).not.toBeInTheDocument();
    expect(screen.queryByText(/-117\.129456/)).not.toBeInTheDocument();
  });

  it('offers a Reserve CTA linking to /bookings/new?listing=<id> while seats remain (FR-12 entry)', async () => {
    api.listings.getListing.mockResolvedValue({ listing: detailListing() });
    renderAt('/listings/listing-1');
    const cta = await screen.findByRole('link', { name: 'Reserve a seat' });
    expect(cta).toHaveAttribute('href', '/bookings/new?listing=listing-1');
  });

  it('replaces the Reserve CTA with a full message when no seats remain', async () => {
    api.listings.getListing.mockResolvedValue({
      listing: detailListing({ seatsRemaining: 0 }),
    });
    renderAt('/listings/listing-1');
    await screen.findByRole('heading', { name: 'Injera Night' });
    expect(screen.queryByRole('link', { name: 'Reserve a seat' })).not.toBeInTheDocument();
    expect(screen.getByText('No seats remaining for this meal.')).toBeInTheDocument();
  });

  it('surfaces pending moderation status to the owner (FR-08: born pending, never public until approved)', async () => {
    api.listings.getListing.mockResolvedValue({
      listing: detailListing({ moderationStatus: 'pending' }),
    });
    renderAt('/listings/listing-1');
    await screen.findByRole('heading', { name: 'Injera Night' });
    expect(
      screen.getByText(/pending moderation review and is visible only to you/)
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Reserve a seat' })).not.toBeInTheDocument();
  });

  it('surfaces rejected moderation status to the owner (FR-08 — repair of finding D-02)', async () => {
    api.listings.getListing.mockResolvedValue({
      listing: detailListing({ moderationStatus: 'rejected' }),
    });
    renderAt('/listings/listing-1');
    await screen.findByRole('heading', { name: 'Injera Night' });
    expect(
      screen.getByText(/rejected by moderation and is not publicly visible/)
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Reserve a seat' })).not.toBeInTheDocument();
  });

  it('pages onward through the host reviews with the payload-declared page size (FR-02/TCC-04)', async () => {
    api.listings.getListing.mockResolvedValue({ listing: detailListing() });
    api.hosts.reviews.mockResolvedValue({
      reviews: [
        {
          id: 'rev-9',
          rating: 4,
          body: 'Great host, would return.',
          createdAt: '2026-07-01T00:00:00.000Z',
          authorId: 'guest-2',
          authorDisplayName: 'Miguel',
        },
      ],
      page: 2,
      pageSize: 5,
      total: 7,
      averageRating: 4.8,
      reviewCount: 7,
    });
    renderAt('/listings/listing-1');
    await screen.findByText('Wonderful evening.');
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Next reviews' }));
    expect(await screen.findByText('Great host, would return.')).toBeInTheDocument();
    expect(api.hosts.reviews).toHaveBeenCalledWith('host-1', { page: 2, pageSize: 5 });
    // The page change is announced politely (NFR-07 aria-live).
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Showing reviews page 2 of 2.')
    );
  });

  it('redirects to /login with a next param on 401 (AB-08 session-gated detail)', async () => {
    api.listings.getListing.mockRejectedValue(
      new ApiError('Authentication required', { status: 401, code: 'NO_SESSION' })
    );
    const router = renderAt('/listings/listing-1');
    expect(await screen.findByRole('heading', { name: 'Sign in stub' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toContain(
      `next=${encodeURIComponent('/listings/listing-1')}`
    );
  });

  it('renders a typed not-found state with its own h1 and announces the failure (never a crash)', async () => {
    api.listings.getListing.mockRejectedValue(
      new ApiError('Listing not found', { status: 404, code: 'NOT_FOUND' })
    );
    renderAt('/listings/listing-1');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Listing not found' })
    ).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Listing not found — Homeplate'));
    expect(screen.getByRole('link', { name: 'Browse other meals' })).toHaveAttribute(
      'href',
      '/search'
    );
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Listing not found')
    );
  });
});
