// client/src/features/discovery/HostProfilePage.test.jsx — U6-DISCOVERY acceptance specs for
// the FR-03 host personal page. Proves: self-introduction, kitchen/dining pictures (alt-
// texted), example dishes (ADR-010 public projection via the shared card) and approved
// reviews with working paging all render from the GET /api/hosts/:id payload; honest empty
// states; 401 redirects to /login (AB-08); typed failures render + announce; one h1 +
// document.title per phase (NFR-07).
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

function exampleDish(overrides = {}) {
  return {
    id: 'listing-7',
    hostId: 'host-1',
    title: 'Doro Wat Sunday',
    description: 'Slow-simmered chicken stew.',
    ingredients: 'Chicken, berbere, eggs',
    allergens: 'Eggs',
    cuisine: 'Ethiopian',
    scheduledStart: '2026-09-07T02:00:00.000Z',
    durationMinutes: 120,
    localDate: '2026-09-06',
    city: 'San Diego',
    region: 'CA',
    country: 'US',
    coarseLat: 32.75,
    coarseLng: -117.15,
    areaLabel: 'North Park',
    seatCapacity: 8,
    seatsRemaining: 8,
    status: 'active',
    moderationStatus: 'approved',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    images: [{ id: 'img-7', url: '/media/img-7.jpg', contentType: 'image/jpeg' }],
    ...overrides,
  };
}

function review(n, overrides = {}) {
  return {
    id: `rev-${n}`,
    rating: 5,
    body: `Review body number ${n}.`,
    createdAt: '2026-08-01T00:00:00.000Z',
    authorId: `guest-${n}`,
    authorDisplayName: `Guest ${n}`,
    ...overrides,
  };
}

function hostPage(overrides = {}) {
  return {
    id: 'host-1',
    displayName: 'Chef Alem',
    memberSince: '2026-03-10T00:00:00.000Z',
    selfIntroduction: 'I cook Ethiopian food for my neighbours every weekend.',
    images: [
      { id: 'hm-1', url: '/media/hm-1.jpg', contentType: 'image/jpeg' },
      { id: 'hm-2', url: '/media/hm-2.jpg', contentType: 'image/jpeg' },
    ],
    exampleDishes: [exampleDish()],
    reviews: [review(1), review(2), review(3), review(4), review(5)],
    averageRating: 4.6,
    reviewCount: 12,
    ...overrides,
  };
}

function renderAt(initialPath) {
  const router = createMemoryRouter(
    [...discoveryRoutes, { path: 'login', element: <h1>Sign in stub</h1> }],
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

describe('HostProfilePage (FR-03, ADR-010, NFR-07)', () => {
  it('renders identity, introduction, alt-texted pictures, example dishes and reviews from the payload', async () => {
    api.hosts.getHost.mockResolvedValue({ host: hostPage() });
    renderAt('/hosts/host-1');
    expect(await screen.findByRole('heading', { level: 1, name: 'Chef Alem' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await waitFor(() => expect(document.title).toBe('Chef Alem — Homeplate'));
    expect(screen.getByText(/Member since/)).toBeInTheDocument();
    expect(screen.getByText('March 2026')).toBeInTheDocument();
    expect(screen.getByText('Rated 4.6 out of 5 from 12 reviews')).toBeInTheDocument();
    expect(
      screen.getByText('I cook Ethiopian food for my neighbours every weekend.')
    ).toBeInTheDocument();
    // Kitchen/dining pictures with derived alt text (NFR-07).
    expect(screen.getByAltText('Chef Alem — kitchen and dining photo 1 of 2')).toBeInTheDocument();
    expect(screen.getByAltText('Chef Alem — kitchen and dining photo 2 of 2')).toBeInTheDocument();
    // Example dishes ride the ADR-010 public projection: coarse area, never an address.
    const dishLink = screen.getByRole('link', { name: 'Doro Wat Sunday' });
    expect(dishLink).toHaveAttribute('href', '/listings/listing-7');
    expect(screen.getByText(/Approximate area: North Park, San Diego, CA/)).toBeInTheDocument();
    // First page of reviews is the embedded preview.
    expect(screen.getByText('Review body number 1.')).toBeInTheDocument();
    expect(screen.getByText('Guest 5')).toBeInTheDocument();
    // FR-01 host filter link.
    expect(
      screen.getByRole('link', { name: 'Search all upcoming meals from this host' })
    ).toHaveAttribute('href', '/search?hostId=host-1');
  });

  it('pages the reviews through GET /api/hosts/:id/reviews using the preview length as page size', async () => {
    api.hosts.getHost.mockResolvedValue({ host: hostPage() });
    api.hosts.reviews.mockResolvedValue({
      reviews: [review(6), review(7), review(8), review(9), review(10)],
      page: 2,
      pageSize: 5,
      total: 12,
      averageRating: 4.6,
      reviewCount: 12,
    });
    renderAt('/hosts/host-1');
    await screen.findByText('Review body number 1.');
    // 12 reviews at the embedded preview size of 5 → 3 pages.
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Next reviews' }));
    expect(await screen.findByText('Review body number 6.')).toBeInTheDocument();
    expect(api.hosts.reviews).toHaveBeenCalledWith('host-1', { page: 2, pageSize: 5 });
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Showing reviews page 2 of 3.')
    );
    // Previous returns to page 1.
    api.hosts.reviews.mockResolvedValue({
      reviews: [review(1), review(2), review(3), review(4), review(5)],
      page: 1,
      pageSize: 5,
      total: 12,
      averageRating: 4.6,
      reviewCount: 12,
    });
    await user.click(screen.getByRole('button', { name: 'Previous reviews' }));
    expect(await screen.findByText('Review body number 1.')).toBeInTheDocument();
    expect(api.hosts.reviews).toHaveBeenLastCalledWith('host-1', { page: 1, pageSize: 5 });
  });

  it('announces a review-paging failure and stays on the current page (typed error, no crash)', async () => {
    api.hosts.getHost.mockResolvedValue({ host: hostPage() });
    api.hosts.reviews.mockRejectedValue(
      new ApiError('The request failed.', { status: 500, code: 'UNEXPECTED_RESPONSE' })
    );
    renderAt('/hosts/host-1');
    await screen.findByText('Review body number 1.');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Next reviews' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('The request failed.')
    );
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.getByText('Review body number 1.')).toBeInTheDocument();
  });

  it('renders honest empty states: no introduction, no pictures, no dishes, no reviews', async () => {
    api.hosts.getHost.mockResolvedValue({
      host: hostPage({
        selfIntroduction: null,
        images: [],
        exampleDishes: [],
        reviews: [],
        averageRating: null,
        reviewCount: 0,
      }),
    });
    renderAt('/hosts/host-1');
    await screen.findByRole('heading', { name: 'Chef Alem' });
    expect(screen.getByText('This host has not written an introduction yet.')).toBeInTheDocument();
    expect(screen.getByText('No upcoming meals from this host right now.')).toBeInTheDocument();
    expect(screen.getByText('No reviews yet')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('redirects to /login with a next param on 401 (AB-08 session-gated host page)', async () => {
    api.hosts.getHost.mockRejectedValue(
      new ApiError('Authentication required', { status: 401, code: 'NO_SESSION' })
    );
    const router = renderAt('/hosts/host-1');
    expect(await screen.findByRole('heading', { name: 'Sign in stub' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toContain(`next=${encodeURIComponent('/hosts/host-1')}`);
  });

  it('renders a typed not-found state with its own h1 and announces it', async () => {
    api.hosts.getHost.mockRejectedValue(
      new ApiError('Host not found', { status: 404, code: 'NOT_FOUND' })
    );
    renderAt('/hosts/host-1');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Host not found' })
    ).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Host not found — Homeplate'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Host not found'));
  });
});
