// client/src/features/discovery/SearchPage.test.jsx — U6-DISCOVERY acceptance specs for the
// FR-01 search/browse screen. Proves: the three api.search() NFR-09 states are rendered AND
// announced (degraded shows the stale results plus an explanation; unavailable shows the
// server's SEARCH_DEGRADED human message — never a bare spinner or crash); filters are
// labelled via FormField and transcribed from src/schemas/search.js; results carry ADR-010
// coarse context only; 401 redirects to /login (AB-08); one h1 + document.title (NFR-07);
// the route paths match the a11y harness patterns. The api module is mocked at its published
// interface — screens never fetch directly, so specs assert on api.search calls, not URLs.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { ApiError } from '../../api/errors.js';
import { StatusAnnouncer } from '../../ui/index.js';
import discoveryRoutes from './routes.jsx';
import { DEGRADED_EXPLANATION } from './SearchPage.jsx';

vi.mock('../../api/index.js', () => ({
  api: {
    search: vi.fn(),
    listings: { getListing: vi.fn() },
    hosts: { getHost: vi.fn(), reviews: vi.fn() },
  },
}));
// vi.mock is hoisted above every import by vitest, so this import receives the mock.
import { api } from '../../api/index.js';

function publicListing(overrides = {}) {
  return {
    id: 'listing-1',
    hostId: 'host-1',
    title: 'Sunset Tacos',
    description: 'Baja-style tacos on the patio.',
    ingredients: 'Corn tortillas, fish, cabbage, crema',
    allergens: 'Fish, dairy',
    cuisine: 'Mexican',
    scheduledStart: '2026-09-04T01:30:00.000Z',
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
    images: [{ id: 'img-1', url: '/media/img-1.jpg', contentType: 'image/jpeg' }],
    ...overrides,
  };
}

function okResult(overrides = {}) {
  return { state: 'ok', listings: [], page: 1, pageSize: 20, total: 0, ...overrides };
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

describe('discovery routes (NFR-07 interface coverage)', () => {
  it('declares exactly the three discovery paths the a11y harness maps to interfaces 1-3', () => {
    expect(discoveryRoutes.map((route) => route.path)).toEqual([
      'search',
      'listings/:id',
      'hosts/:id',
    ]);
  });
});

describe('SearchPage (FR-01, NFR-09, NFR-07)', () => {
  it('renders one h1, sets document.title, and labels every schema filter via FormField', async () => {
    api.search.mockResolvedValue(okResult());
    renderAt('/search');
    await waitFor(() => expect(api.search).toHaveBeenCalledTimes(1));
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Find a meal' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Find a meal — Homeplate'));
    // The five typed filters of src/schemas/search.js (hostId arrives by link, not typing).
    expect(screen.getByLabelText(/location/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/search radius/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/available from/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/available until/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/cuisine/i)).toBeInTheDocument();
    // An empty query is a plain browse: the first search sends no params at all.
    expect(api.search).toHaveBeenCalledWith({});
  });

  it("renders the 'ok' state: result cards with coarse area, alt-texted image, detail link — and announces the count", async () => {
    api.search.mockResolvedValue(
      okResult({ listings: [publicListing()], total: 2, page: 1, pageSize: 20 })
    );
    renderAt('/search');
    const link = await screen.findByRole('link', { name: 'Sunset Tacos' });
    expect(link).toHaveAttribute('href', '/listings/listing-1');
    expect(screen.getByAltText('Photo of Sunset Tacos')).toBeInTheDocument();
    expect(screen.getByText(/Approximate area: North Park, San Diego, CA/)).toBeInTheDocument();
    expect(screen.getByText('4 of 6 seats remaining')).toBeInTheDocument();
    expect(screen.getByText('Cuisine: Mexican')).toBeInTheDocument();
    // Announced politely (aria-live status region).
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('2 meals found.'));
  });

  it("renders the 'degraded' state: STALE results still shown, explanation visible and announced", async () => {
    api.search.mockResolvedValue({
      state: 'degraded',
      listings: [publicListing()],
      page: 1,
      pageSize: 20,
      total: 1,
    });
    renderAt('/search');
    expect(await screen.findByRole('link', { name: 'Sunset Tacos' })).toBeInTheDocument();
    // Visible explanation next to the stale results…
    expect(screen.getAllByText(DEGRADED_EXPLANATION).length).toBeGreaterThanOrEqual(1);
    // …and announced through the polite live region.
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('may be out of date')
    );
  });

  it("renders the 'unavailable' state: the server's SEARCH_DEGRADED message, announced assertively — no spinner, no crash", async () => {
    api.search.mockResolvedValue({
      state: 'unavailable',
      error: new ApiError('Search is temporarily unavailable. Please try again shortly.', {
        status: 503,
        code: 'SEARCH_DEGRADED',
      }),
    });
    renderAt('/search');
    expect(
      await screen.findByRole('heading', { name: 'Search is unavailable' })
    ).toBeInTheDocument();
    // The message appears in the visible box (and again in the live region once announced).
    expect(
      screen.getAllByText('Search is temporarily unavailable. Please try again shortly.').length
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('Searching for meals')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Search is temporarily unavailable')
    );
  });

  it('renders a typed transport failure (NETWORK_ERROR) as a real message, announced', async () => {
    api.search.mockRejectedValue(
      new ApiError('Could not reach the Homeplate service. Check your connection and retry.', {
        status: 0,
        code: 'NETWORK_ERROR',
      })
    );
    renderAt('/search');
    expect(await screen.findByRole('heading', { name: 'Search failed' })).toBeInTheDocument();
    expect(
      screen.getAllByText(/Could not reach the Homeplate service/).length
    ).toBeGreaterThanOrEqual(1);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Could not reach the Homeplate')
    );
  });

  it('shows the empty-result state with advice, not a blank page', async () => {
    api.search.mockResolvedValue(okResult());
    renderAt('/search');
    const matches = await screen.findAllByText(/No meals matched your search/);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('No meals matched your search.')
    );
  });

  it('submits the typed filters as schema params — datetimes converted to timezone-carrying ISO', async () => {
    api.search.mockResolvedValue(okResult());
    renderAt('/search');
    await waitFor(() => expect(api.search).toHaveBeenCalledTimes(1));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/location/i), 'La Jolla');
    await user.type(screen.getByLabelText(/search radius/i), '10');
    await user.type(screen.getByLabelText(/cuisine/i), 'Ethiopian');
    fireEvent.change(screen.getByLabelText(/available from/i), {
      target: { value: '2026-09-01T18:00' },
    });
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(api.search).toHaveBeenCalledTimes(2));
    expect(api.search).toHaveBeenLastCalledWith({
      location: 'La Jolla',
      radiusKm: '10',
      cuisine: 'Ethiopian',
      // src/schemas/search.js requires ISO 8601 WITH timezone (ADR-009: never guess a zone).
      from: new Date('2026-09-01T18:00').toISOString(),
    });
  });

  it('blocks an invalid radius client-side with an ErrorSummary and an in-place field error', async () => {
    api.search.mockResolvedValue(okResult());
    renderAt('/search');
    await waitFor(() => expect(api.search).toHaveBeenCalledTimes(1));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/search radius/i), '-3');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    // ErrorSummary: role=alert with a link to the field; FormField: aria-invalid + message.
    const summary = screen
      .getAllByRole('alert')
      .find((el) => el.textContent.includes('There is a problem'));
    expect(summary).toBeDefined();
    expect(
      screen.getByRole('link', {
        name: 'Search radius must be a positive number of kilometres.',
      })
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/search radius/i)).toHaveAttribute('aria-invalid', 'true');
    // No second search was issued with invalid input.
    expect(api.search).toHaveBeenCalledTimes(1);
  });

  it('applies the hostId filter from the URL and clears it on demand (FR-01 host filter)', async () => {
    api.search.mockResolvedValue(okResult());
    renderAt('/search?hostId=host-1');
    await waitFor(() =>
      expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ hostId: 'host-1' }))
    );
    expect(screen.getByText('Showing meals from a single host only.')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show meals from all hosts' }));
    await waitFor(() => expect(api.search).toHaveBeenCalledTimes(2));
    expect(api.search.mock.calls[1][0]).not.toHaveProperty('hostId');
  });

  it('pages results (bounded pages, NFR-02) and requests the next page through the URL', async () => {
    api.search.mockResolvedValue(
      okResult({ listings: [publicListing()], total: 45, page: 1, pageSize: 20 })
    );
    renderAt('/search');
    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
    const user = userEvent.setup();
    api.search.mockResolvedValue(
      okResult({
        listings: [publicListing({ id: 'listing-2', title: 'Second Page Stew' })],
        total: 45,
        page: 2,
        pageSize: 20,
      })
    );
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() =>
      expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ page: '2' }))
    );
    expect(await screen.findByText('Page 2 of 3')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Second Page Stew' })).toBeInTheDocument();
  });

  it('redirects to /login carrying a next param on 401 (AB-08 session-gated search)', async () => {
    api.search.mockRejectedValue(
      new ApiError('Authentication required', { status: 401, code: 'NO_SESSION' })
    );
    const router = renderAt('/search?cuisine=Ethiopian');
    expect(await screen.findByRole('heading', { name: 'Sign in stub' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toContain(
      `next=${encodeURIComponent('/search?cuisine=Ethiopian')}`
    );
  });
});
