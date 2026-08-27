// client/src/features/booking/BookingDetailPage.test.jsx — U6-BOOKING specs for
// /bookings/:bookingId (FR-04 dual completion, FR-14 cancel-before-start, FR-13 surfacing,
// NFR-07). Real wave-5 stack over a stubbed fetch — see components/testHarness.jsx.
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
const PAST = new Date(Date.now() - DAY_MS).toISOString();

function listingRef(overrides = {}) {
  return {
    id: 'l1',
    hostId: 'u-host',
    title: 'Tuscan farmhouse dinner',
    cuisine: 'Italian',
    scheduledStart: FUTURE,
    durationMinutes: 120,
    city: 'San Diego',
    areaLabel: 'North Park',
    coarseLat: 32.75,
    coarseLng: -117.13,
    status: 'active',
    ...overrides,
  };
}

function booking(overrides = {}, listingOverrides = {}) {
  return {
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
    listing: listingRef(listingOverrides),
    ...overrides,
  };
}

function detailHandlers(bookingPayload, overrides = {}) {
  return {
    ...sessionHandler(GUEST),
    'GET /api/bookings/b1': jsonResponse(200, { booking: bookingPayload }),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BookingDetailPage — lifecycle and FR-13 surfacing', () => {
  it('shows status, both completion flags, the email statement, and community links (URL strings)', async () => {
    installFetch(detailHandlers(booking()));
    renderBooking('/bookings/b1');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Booking details' })
    ).toBeInTheDocument();
    expect(document.title).toBe('Booking details — Homeplate');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('You reserved a seat at this meal.')).toBeVisible();
    expect(screen.getByText('Status: Reserved — upcoming.')).toBeVisible();

    // FR-13: the notification statement is plain text on the page.
    expect(screen.getByText(/Email notifications are sent to both participants/)).toBeVisible();

    // FR-04: BOTH flags visible, the caller's row marked "(you)".
    expect(screen.getByText(/Guest \(you\): not confirmed yet/)).toBeVisible();
    expect(screen.getByText(/Host: not confirmed yet/)).toBeVisible();

    // Cross-feature links are URL strings into community/discovery-owned routes.
    expect(screen.getByRole('link', { name: /Messages with the host/ })).toHaveAttribute(
      'href',
      '/bookings/b1/messages'
    );
    expect(screen.getByRole('link', { name: /Report a safety concern/ })).toHaveAttribute(
      'href',
      '/bookings/b1/safety-alert'
    );
    expect(screen.getByRole('link', { name: /View the full listing/ })).toHaveAttribute(
      'href',
      '/listings/l1'
    );
    // No review link before completion (FR-05 is completed-bookings-only).
    expect(screen.queryByRole('link', { name: /Write a review/ })).not.toBeInTheDocument();
  });

  it('renders the host perspective on the host’s own booking rows', async () => {
    installFetch(detailHandlers(booking({ role: 'host' })));
    renderBooking('/bookings/b1');
    expect(await screen.findByText('A guest reserved a seat at your listing.')).toBeVisible();
    expect(screen.getByText(/Host \(you\): not confirmed yet/)).toBeVisible();
    expect(screen.getByRole('link', { name: /Messages with the guest/ })).toHaveAttribute(
      'href',
      '/bookings/b1/messages'
    );
  });

  it('renders and announces typed errors, with a way back (NFR-07)', async () => {
    installFetch(
      detailHandlers(null, {
        'GET /api/bookings/b1': errorResponse(404, 'BOOKING_NOT_FOUND', 'Booking not found'),
      })
    );
    renderBooking('/bookings/b1');
    expect(
      await screen.findByText('This booking could not be found.', { selector: 'p' })
    ).toBeVisible();
    await expectAnnounced('alert', /could not be found/);
    expect(screen.getByRole('link', { name: 'Back to your bookings' })).toHaveAttribute(
      'href',
      '/bookings'
    );
  });

  it('offers sign-in when the session is gone (401)', async () => {
    installFetch({
      ...sessionHandler(null),
      'GET /api/bookings/b1': errorResponse(401, 'NO_SESSION', 'Session is invalid or expired'),
    });
    renderBooking('/bookings/b1');
    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });
});

describe('BookingDetailPage — FR-14 cancel before start, behind a confirm Dialog', () => {
  it('cancels through the dialog, announces seat-restored + notified, and updates the page', async () => {
    const user = userEvent.setup();
    const cancelled = booking({ status: 'cancelled', cancelledAt: '2026-08-22T10:00:00.000Z' });
    const calls = installFetch(
      detailHandlers(booking(), {
        'POST /api/bookings/b1/cancel': jsonResponse(200, { booking: cancelled }),
      })
    );
    renderBooking('/bookings/b1');

    const trigger = await screen.findByRole('button', { name: 'Cancel this booking' });
    await user.click(trigger);

    // The kit Dialog: labelled, modal, initial focus on the SAFE action.
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this booking?' });
    expect(dialog).toBeInTheDocument();
    const keep = screen.getByRole('button', { name: 'Keep the booking' });
    await waitFor(() => expect(keep).toHaveFocus());

    await user.click(screen.getByRole('button', { name: 'Cancel the booking' }));
    await waitFor(() =>
      expect(calls.some((c) => c.pathname === '/api/bookings/b1/cancel')).toBe(true)
    );
    await expectAnnounced(
      'status',
      /seat was returned to the listing, and both participants are notified by email/
    );
    expect(await screen.findByText('Status: Cancelled.')).toBeVisible();
    expect(screen.getByText(/This booking is cancelled\./)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Cancel this booking' })).not.toBeInTheDocument();
  });

  it('Escape closes the dialog without cancelling and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    const calls = installFetch(detailHandlers(booking()));
    renderBooking('/bookings/b1');

    const trigger = await screen.findByRole('button', { name: 'Cancel this booking' });
    await user.click(trigger);
    await screen.findByRole('dialog', { name: 'Cancel this booking?' });
    await user.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Cancel this booking?' })).not.toBeInTheDocument()
    );
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(calls.some((c) => c.pathname === '/api/bookings/b1/cancel')).toBe(false);
  });

  it('does NOT offer cancel at/after the scheduled start, and says why (FR-14)', async () => {
    installFetch(detailHandlers(booking({}, { scheduledStart: PAST })));
    renderBooking('/bookings/b1');
    await screen.findByRole('heading', { level: 2, name: 'Cancellation' });
    expect(screen.queryByRole('button', { name: 'Cancel this booking' })).not.toBeInTheDocument();
    expect(
      screen.getByText('The meal has started — this booking can no longer be cancelled.')
    ).toBeVisible();
  });

  it('stays neutral on an unparseable scheduledStart — never claims the meal started (finding F-B2)', async () => {
    installFetch(detailHandlers(booking({}, { scheduledStart: 'not-a-date' })));
    renderBooking('/bookings/b1');
    await screen.findByRole('heading', { level: 2, name: 'Cancellation' });
    // No cancel offer (the start time cannot be verified client-side), but no lie either.
    expect(screen.queryByRole('button', { name: 'Cancel this booking' })).not.toBeInTheDocument();
    expect(screen.queryByText(/The meal has started/)).not.toBeInTheDocument();
    expect(
      screen.getByText('Cancellation is currently unavailable for this booking.')
    ).toBeVisible();
  });

  it('renders and announces the CANCEL_TOO_LATE refusal if the server declines anyway', async () => {
    const user = userEvent.setup();
    installFetch(
      detailHandlers(booking(), {
        'POST /api/bookings/b1/cancel': errorResponse(
          409,
          'CANCEL_TOO_LATE',
          'The meal has already started — this booking can no longer be cancelled.'
        ),
      })
    );
    renderBooking('/bookings/b1');
    await user.click(await screen.findByRole('button', { name: 'Cancel this booking' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel the booking' }));
    await expectAnnounced('alert', /can no longer be cancelled/);
  });
});

describe('BookingDetailPage — FR-04 dual-confirmation completion', () => {
  it('one confirmation announces awaiting-the-other and shows the caller as confirmed', async () => {
    const user = userEvent.setup();
    const confirmed = booking({ status: 'in_progress', guestConfirmedCompletion: true });
    installFetch(
      detailHandlers(booking({ status: 'in_progress' }), {
        'POST /api/bookings/b1/confirm-completion': jsonResponse(200, {
          booking: confirmed,
          awaitingOtherParty: true,
        }),
      })
    );
    renderBooking('/bookings/b1');

    await user.click(await screen.findByRole('button', { name: 'Confirm the meal is complete' }));
    await expectAnnounced('status', /completes when the other participant confirms/);
    expect(
      await screen.findByText('You have confirmed — waiting for the other participant.')
    ).toBeVisible();
    expect(screen.getByText(/Guest \(you\): confirmed/)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Confirm the meal is complete' })
    ).not.toBeInTheDocument();
  });

  it('the second confirmation completes the booking and unlocks the review link', async () => {
    const user = userEvent.setup();
    const completed = booking({
      status: 'completed',
      guestConfirmedCompletion: true,
      hostConfirmedCompletion: true,
      completedAt: '2026-08-22T21:30:00.000Z',
    });
    installFetch(
      detailHandlers(booking({ status: 'in_progress', hostConfirmedCompletion: true }), {
        'POST /api/bookings/b1/confirm-completion': jsonResponse(200, {
          booking: completed,
          awaitingOtherParty: false,
        }),
      })
    );
    renderBooking('/bookings/b1');

    expect(await screen.findByText(/Host: confirmed$/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Confirm the meal is complete' }));

    await expectAnnounced('status', /Meal completed — both participants have confirmed/);
    expect(await screen.findByText('Status: Completed.')).toBeVisible();
    expect(
      screen.getByText('Both participants confirmed — this booking is complete.')
    ).toBeVisible();
    expect(screen.getByRole('link', { name: /Write a review/ })).toHaveAttribute(
      'href',
      '/bookings/b1/review'
    );
  });

  it('offers no completion action while the booking is still pending', async () => {
    installFetch(detailHandlers(booking()));
    renderBooking('/bookings/b1');
    await screen.findByRole('heading', { level: 2, name: 'Meal completion' });
    expect(
      screen.queryByRole('button', { name: 'Confirm the meal is complete' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('Completion can be confirmed once the meal is in progress.')
    ).toBeVisible();
  });

  it('the host sees the confirm action against their own unset flag', async () => {
    installFetch(
      detailHandlers(
        booking({ role: 'host', status: 'in_progress', guestConfirmedCompletion: true })
      )
    );
    renderBooking('/bookings/b1');
    expect(
      await screen.findByRole('button', { name: 'Confirm the meal is complete' })
    ).toBeVisible();
    expect(screen.getByText(/Guest: confirmed/)).toBeVisible();
    expect(screen.getByText(/Host \(you\): not confirmed yet/)).toBeVisible();
  });
});
