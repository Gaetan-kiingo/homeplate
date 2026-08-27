// client/src/features/booking/ReservePage.test.jsx — U6-BOOKING specs for the reserve flow
// (FR-12 / FR-09 / FR-13 / NFR-07) and the FR-11 / ADR-009 cap-error rendering contract.
// House pattern: global fetch is stubbed and the REAL wave-5 stack runs (API client typed
// codes, SessionProvider, StatusAnnouncer) — see components/testHarness.jsx.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { screen, waitFor, within } from '@testing-library/react';
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
import { bookingErrorMessage, mehkoCapMessage } from './components/bookingErrors.js';

const DAY_MS = 86400000;
const FUTURE = new Date(Date.now() + DAY_MS).toISOString();

/** FR-02 detail payload (ADR-010 PUBLIC projection + detail context — src/api/types.js). */
const LISTING = {
  id: 'l1',
  hostId: 'u-host',
  title: 'Tuscan farmhouse dinner',
  description: 'Slow-cooked ragu and fresh pasta.',
  ingredients: 'pasta, beef, tomatoes',
  allergens: 'gluten',
  cuisine: 'Italian',
  scheduledStart: FUTURE,
  durationMinutes: 120,
  localDate: '2026-09-04',
  city: 'San Diego',
  region: 'CA',
  country: 'US',
  coarseLat: 32.75,
  coarseLng: -117.13,
  areaLabel: 'North Park',
  seatCapacity: 6,
  seatsRemaining: 3,
  status: 'active',
  moderationStatus: 'approved',
  createdAt: '2026-08-15T00:00:00.000Z',
  updatedAt: '2026-08-15T00:00:00.000Z',
  images: [],
  host: { displayName: 'Nonna T', bio: null, averageRating: 4.8, reviewCount: 12 },
  reviews: [],
  reviewsTotal: 12,
  reviewsPageSize: 5,
};

const BOOKING = {
  id: 'b1',
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
  listing: LISTING,
};

function reserveHandlers(overrides = {}) {
  return {
    ...sessionHandler(GUEST),
    'GET /api/listings/l1': jsonResponse(200, { listing: LISTING }),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ReservePage — /bookings/new?listing=<id> (FR-12, NFR-07)', () => {
  it('fetches the listing summary, reserves on confirm, announces, and navigates to the booking', async () => {
    const user = userEvent.setup();
    const calls = installFetch(
      reserveHandlers({
        'POST /api/bookings': jsonResponse(201, { booking: BOOKING }),
        'GET /api/bookings/b1': jsonResponse(200, { booking: BOOKING }),
      })
    );
    const router = renderBooking('/bookings/new?listing=l1');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Reserve a seat' })
    ).toBeInTheDocument();
    expect(document.title).toBe('Reserve a seat — Homeplate');
    // The summary before confirming (FR-12) — coarse location only (ADR-010).
    expect(await screen.findByRole('heading', { level: 2, name: LISTING.title })).toBeVisible();
    expect(screen.getByText('Hosted by Nonna T')).toBeVisible();
    expect(screen.getByText(/North Park, San Diego, CA/)).toBeVisible();
    expect(screen.getByText(/exact address is shared with confirmed guests/)).toBeVisible();
    // FR-13 surfacing: the email-notification statement is on the page.
    expect(screen.getByText(/confirmed\s+by email/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Reserve a seat' }));

    const post = calls.find((c) => c.method === 'POST' && c.pathname === '/api/bookings');
    expect(post.body).toEqual({ listingId: 'l1' });
    await expectAnnounced('status', /Seat reserved/);
    await waitFor(() => expect(router.state.location.pathname).toBe('/bookings/b1'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Booking details' })
    ).toBeInTheDocument();
  });

  it('renders exactly one h1 and keeps every form control labelled (NFR-07 G.3)', async () => {
    installFetch(reserveHandlers());
    renderBooking('/bookings/new?listing=l1');
    await screen.findByRole('heading', { level: 2, name: LISTING.title });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    // The only interactive controls are real links and a real button — nothing unlabelled.
    expect(screen.getByRole('button', { name: 'Reserve a seat' })).toBeVisible();
  });

  it('explains and links to browse when no listing was selected', async () => {
    installFetch(sessionHandler(GUEST));
    renderBooking('/bookings/new');
    expect(await screen.findByText(/No listing was selected/)).toBeVisible();
    expect(screen.getByRole('link', { name: /Browse the available meals/ })).toHaveAttribute(
      'href',
      '/search'
    );
  });

  it('offers sign-in instead of the reserve button when anonymous (NFR-03: response-inferred)', async () => {
    installFetch({
      ...sessionHandler(null),
      'GET /api/listings/l1': jsonResponse(200, { listing: LISTING }),
    });
    renderBooking('/bookings/new?listing=l1');
    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'create an account' })).toHaveAttribute(
      'href',
      '/signup'
    );
    expect(screen.queryByRole('button', { name: 'Reserve a seat' })).not.toBeInTheDocument();
  });

  it('renders and announces a typed message when the listing cannot be loaded', async () => {
    installFetch({
      ...sessionHandler(GUEST),
      'GET /api/listings/l1': errorResponse(404, 'LISTING_NOT_FOUND', 'Listing not found'),
    });
    renderBooking('/bookings/new?listing=l1');
    expect(
      await screen.findByText(/This listing could not be found/, { selector: 'p' })
    ).toBeVisible();
    await expectAnnounced('alert', /This listing could not be found/);
  });
});

describe('ReservePage — FR-09 NOT_ELIGIBLE is the flagship error surface', () => {
  it('renders WHAT is missing and HOW to fix it per reason code, with fix links', async () => {
    const user = userEvent.setup();
    installFetch(
      reserveHandlers({
        'POST /api/bookings': errorResponse(
          403,
          'NOT_ELIGIBLE',
          'You are not eligible to perform this action.',
          { action: 'reserve_seat', reasons: ['EMAIL_UNVERIFIED', 'NAME_MISSING', 'PHONE_MISSING'] }
        ),
      })
    );
    renderBooking('/bookings/new?listing=l1');
    await user.click(await screen.findByRole('button', { name: 'Reserve a seat' }));

    // The refusal is announced assertively (NFR-07) and explained in place.
    await expectAnnounced('alert', /not eligible to reserve a seat yet/i);
    const notice = (
      await screen.findByRole('heading', { level: 2, name: /reserve a seat yet/i })
    ).closest('section');

    // EMAIL_UNVERIFIED — WHAT + HOW + a real resend action (not just a link).
    expect(within(notice).getByText('Your email address has not been verified.')).toBeVisible();
    expect(
      within(notice).getByRole('button', { name: 'Resend the verification email' })
    ).toBeVisible();

    // NAME_MISSING and PHONE_MISSING — WHAT + HOW + fix links to the account page.
    expect(
      within(notice).getByText('Your profile does not have your full name yet.')
    ).toBeVisible();
    expect(within(notice).getByRole('link', { name: 'Add your full name' })).toHaveAttribute(
      'href',
      '/account'
    );
    expect(
      within(notice).getByText('Your profile does not have a phone number yet.')
    ).toBeVisible();
    expect(within(notice).getByRole('link', { name: 'Add a phone number' })).toHaveAttribute(
      'href',
      '/account'
    );
  });

  it('EMAIL_UNVERIFIED resend really posts and announces the outcome', async () => {
    const user = userEvent.setup();
    const calls = installFetch(
      reserveHandlers({
        'POST /api/bookings': errorResponse(403, 'NOT_ELIGIBLE', 'Not eligible.', {
          action: 'reserve_seat',
          reasons: ['EMAIL_UNVERIFIED'],
        }),
        'POST /api/auth/resend-verification': jsonResponse(202, {}),
      })
    );
    renderBooking('/bookings/new?listing=l1');
    await user.click(await screen.findByRole('button', { name: 'Reserve a seat' }));
    await user.click(await screen.findByRole('button', { name: 'Resend the verification email' }));

    const resend = calls.find((c) => c.pathname === '/api/auth/resend-verification');
    expect(resend.body).toEqual({ email: GUEST.email });
    await expectAnnounced('status', /Verification email sent to guest@example\.com/);
    expect(
      screen.getByText(/Verification email sent to guest@example\.com/, { selector: 'p' })
    ).toBeVisible();
  });
});

describe('ReservePage — distinct typed refusals (FR-12 / AB-02)', () => {
  it('NO_CAPACITY renders and announces its own message', async () => {
    const user = userEvent.setup();
    installFetch(
      reserveHandlers({
        'POST /api/bookings': errorResponse(
          409,
          'NO_CAPACITY',
          'No seats remaining on this listing.'
        ),
      })
    );
    renderBooking('/bookings/new?listing=l1');
    await user.click(await screen.findByRole('button', { name: 'Reserve a seat' }));
    expect(
      await screen.findByText(
        /No seats are left on this listing — another guest took the last seat/,
        { selector: 'p' }
      )
    ).toBeVisible();
    await expectAnnounced('alert', /No seats are left on this listing/);
  });

  it('the per-guest pending cap (BOOKING_LIMIT) renders a distinct message with the limit from the payload', async () => {
    const user = userEvent.setup();
    installFetch(
      reserveHandlers({
        'POST /api/bookings': errorResponse(
          409,
          'BOOKING_LIMIT',
          'You already have 3 pending bookings — complete or cancel one first.',
          { limit: 3 }
        ),
      })
    );
    renderBooking('/bookings/new?listing=l1');
    await user.click(await screen.findByRole('button', { name: 'Reserve a seat' }));
    expect(
      await screen.findByText(/You already have 3 pending bookings — that is the per-guest limit/, {
        selector: 'p',
      })
    ).toBeVisible();
    await expectAnnounced('alert', /per-guest limit/);
    expect(screen.queryByText(/No seats are left/, { selector: 'p' })).not.toBeInTheDocument();
  });
});

describe('FR-11 / ADR-009 — MEHKO cap errors name WHICH cap and WHEN it resets, from details only', () => {
  it('MEHKO_DAILY_LISTING_LIMIT: which cap, the LA calendar day, and the reset', () => {
    const message = mehkoCapMessage({
      code: 'MEHKO_DAILY_LISTING_LIMIT',
      details: { localDate: '2026-09-04', limit: 2 },
    });
    expect(message).toMatch(/Daily listing cap/);
    expect(message).toMatch(/2 listing/);
    expect(message).toMatch(/September 4, 2026/);
    expect(message).toMatch(/America\/Los_Angeles/);
    expect(message).toMatch(/resets at the start of the next calendar day/);
  });

  it('MEHKO_DAILY_MEAL_LIMIT: limit and already-scheduled from the payload', () => {
    const message = mehkoCapMessage({
      code: 'MEHKO_DAILY_MEAL_LIMIT',
      details: { localDate: '2026-09-04', limit: 25, alreadyScheduled: 21 },
    });
    expect(message).toMatch(/Daily meal cap/);
    expect(message).toMatch(/25 meals/);
    expect(message).toMatch(/21 meal/);
    expect(message).toMatch(/September 4, 2026/);
    expect(message).toMatch(/resets at the start of the next calendar day/);
  });

  it('MEHKO_WEEKLY_MEAL_LIMIT: the Monday–Sunday LA week window and its Monday reset', () => {
    const message = mehkoCapMessage({
      code: 'MEHKO_WEEKLY_MEAL_LIMIT',
      details: { weekStart: '2026-08-31', weekEnd: '2026-09-06', limit: 80, alreadyScheduled: 77 },
    });
    expect(message).toMatch(/Weekly meal cap/);
    expect(message).toMatch(/80 meals/);
    expect(message).toMatch(/77 meal/);
    expect(message).toMatch(/August 31, 2026/);
    expect(message).toMatch(/September 6, 2026/);
    expect(message).toMatch(/Monday to Sunday, America\/Los_Angeles/);
    expect(message).toMatch(/resets on the Monday after September 6, 2026/);
  });

  it('bookingErrorMessage routes MEHKO codes to the same cap copy', () => {
    const error = {
      code: 'MEHKO_DAILY_LISTING_LIMIT',
      details: { localDate: '2026-09-04', limit: 2 },
    };
    expect(bookingErrorMessage(error)).toBe(mehkoCapMessage(error));
  });

  it('the cap-rendering module carries NO cap-shaped numeric literal (ADR-009 grep)', () => {
    const specDir = import.meta.url.startsWith('file:')
      ? path.dirname(fileURLToPath(import.meta.url))
      : path.join(process.cwd(), 'src', 'features', 'booking');
    const src = readFileSync(path.join(specDir, 'components', 'bookingErrors.js'), 'utf8');
    expect(src).not.toMatch(/\b(1|30|60|90)\b/);
  });
});
