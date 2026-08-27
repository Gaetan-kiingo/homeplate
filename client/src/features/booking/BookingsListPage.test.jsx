// client/src/features/booking/BookingsListPage.test.jsx — U6-BOOKING specs for /bookings
// (FR-12 list surface, FR-13 status surfacing, NFR-07). Real wave-5 stack over a stubbed
// fetch — see components/testHarness.jsx.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GUEST,
  errorResponse,
  expectAnnounced,
  installFetch,
  jsonResponse,
  renderBooking,
  sessionHandler,
} from './components/testHarness.jsx';

const DAY_MS = 86400000;
const FUTURE = new Date(Date.now() + DAY_MS).toISOString();

function listingRef(id, title) {
  return {
    id,
    hostId: 'u-host',
    title,
    cuisine: 'Italian',
    scheduledStart: FUTURE,
    durationMinutes: 120,
    city: 'San Diego',
    areaLabel: 'North Park',
    coarseLat: 32.75,
    coarseLng: -117.13,
    status: 'active',
  };
}

function booking(id, overrides = {}) {
  return {
    id,
    listingId: 'l1',
    guestId: 'u-guest',
    status: 'pending',
    guestConfirmedCompletion: false,
    hostConfirmedCompletion: false,
    cancelledAt: null,
    completedAt: null,
    createdAt: '2026-08-20T18:00:00.000Z',
    updatedAt: '2026-08-20T18:00:00.000Z',
    role: 'guest',
    listing: listingRef('l1', 'Tuscan farmhouse dinner'),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BookingsListPage — /bookings (FR-12 / FR-13 / NFR-07)', () => {
  it('lists the caller’s bookings with status and role as text, linked to their detail pages', async () => {
    const calls = installFetch({
      ...sessionHandler(GUEST),
      'GET /api/bookings': jsonResponse(200, {
        bookings: [
          booking('b1'),
          booking('b2', {
            role: 'host',
            status: 'completed',
            completedAt: '2026-08-21T22:00:00.000Z',
            listing: listingRef('l2', 'Ramen night'),
          }),
        ],
        page: 1,
        pageSize: 20,
      }),
    });
    renderBooking('/bookings');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your bookings' })
    ).toBeInTheDocument();
    expect(document.title).toBe('Your bookings — Homeplate');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);

    // Generous wait on the FIRST content assertion: under full-suite worker contention the
    // session+list round-trips can exceed the 1 s default (observation U6VC-O1's one flake).
    expect(
      await screen.findByRole('link', { name: 'Tuscan farmhouse dinner' }, { timeout: 5000 })
    ).toHaveAttribute('href', '/bookings/b1');
    expect(screen.getByRole('link', { name: 'Ramen night' })).toHaveAttribute(
      'href',
      '/bookings/b2'
    );
    // FR-13: lifecycle status surfaced as text, never colour alone; role named per row.
    expect(screen.getByText(/Reserved — upcoming · you are the guest/)).toBeVisible();
    expect(screen.getByText(/Completed · you are the host/)).toBeVisible();
    await expectAnnounced('status', /2 bookings shown/);

    // The default query hits the documented list surface (role=any, first page).
    const list = calls.find((c) => c.pathname === '/api/bookings');
    expect(list.search).toBe('role=any&page=1');
  });

  it('has labelled filters; changing the role filter refetches with that role', async () => {
    const user = userEvent.setup();
    const calls = installFetch({
      ...sessionHandler(GUEST),
      'GET /api/bookings': (call) =>
        jsonResponse(200, {
          bookings: call.search.includes('role=host') ? [] : [booking('b1')],
          page: 1,
          pageSize: 20,
        }),
    });
    renderBooking('/bookings');

    const roleFilter = await screen.findByLabelText('Show');
    const statusFilter = screen.getByLabelText('Status');
    expect(roleFilter).toBeVisible();
    expect(statusFilter).toBeVisible();

    await user.selectOptions(roleFilter, 'host');
    await waitFor(() => {
      expect(calls.some((c) => c.search === 'role=host&page=1')).toBe(true);
    });
    expect(await screen.findByText('No bookings match these filters.')).toBeVisible();
  });

  it('the status filter is forwarded as a query parameter', async () => {
    const user = userEvent.setup();
    const calls = installFetch({
      ...sessionHandler(GUEST),
      'GET /api/bookings': jsonResponse(200, { bookings: [], page: 1, pageSize: 20 }),
    });
    renderBooking('/bookings');
    await user.selectOptions(await screen.findByLabelText('Status'), 'cancelled');
    await waitFor(() => {
      expect(calls.some((c) => c.search === 'role=any&status=cancelled&page=1')).toBe(true);
    });
  });

  it('shows a first-steps message (with a browse link) when there are no bookings at all', async () => {
    installFetch({
      ...sessionHandler(GUEST),
      'GET /api/bookings': jsonResponse(200, { bookings: [], page: 1, pageSize: 20 }),
    });
    renderBooking('/bookings');
    expect(await screen.findByText(/You have no bookings yet/)).toBeVisible();
    expect(screen.getByRole('link', { name: /Browse the available meals/ })).toHaveAttribute(
      'href',
      '/search'
    );
    await expectAnnounced('status', /No bookings to show/);
  });

  it('offers pagination when a page is full, and requests the next page', async () => {
    const user = userEvent.setup();
    const calls = installFetch({
      ...sessionHandler(GUEST),
      'GET /api/bookings': (call) =>
        call.search.includes('page=2')
          ? jsonResponse(200, { bookings: [booking('b3')], page: 2, pageSize: 2 })
          : jsonResponse(200, {
              bookings: [
                booking('b1'),
                booking('b2', { listing: listingRef('l2', 'Ramen night') }),
              ],
              page: 1,
              pageSize: 2,
            }),
    });
    renderBooking('/bookings');

    await user.click(await screen.findByRole('button', { name: 'Next page' }));
    await waitFor(() => {
      expect(calls.some((c) => c.search === 'role=any&page=2')).toBe(true);
    });
    expect(await screen.findByText('Page 2')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeEnabled();
  });

  it('renders the sign-in prompt when anonymous instead of an empty screen', async () => {
    installFetch({
      ...sessionHandler(null),
      'GET /api/bookings': errorResponse(401, 'NO_SESSION', 'Session is invalid or expired'),
    });
    renderBooking('/bookings');
    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(screen.queryByLabelText('Show')).not.toBeInTheDocument();
  });

  it('renders and announces a typed message when the list cannot be loaded (NFR-09)', async () => {
    installFetch({
      ...sessionHandler(GUEST),
      'GET /api/bookings': jsonResponse(500, 'not-an-envelope'),
    });
    renderBooking('/bookings');
    expect(
      await screen.findByText(/The service answered unexpectedly \(HTTP 500\)\./, {
        selector: 'p',
      })
    ).toBeVisible();
    await expectAnnounced('alert', /answered unexpectedly/);
  });
});
