// client/src/features/booking/routes.jsx — U6-BOOKING: the booking-flow routes, discovered
// by client/src/routes.jsx (import.meta.glob — the wave-5 extension contract; SPMP WA-9).
//
// Requirement traceability (SRS Appendix B):
//   FR-12 — 'bookings/new' (?listing=<id>): the reserve flow.
//   FR-04 / FR-13 / FR-14 — 'bookings/:bookingId': lifecycle, dual completion, cancel.
//   FR-12 / FR-13 — 'bookings': the caller's bookings, both roles, with statuses.
//   NFR-07 — these path strings are what scripts/a11y-audit.js maps onto the "booking flow"
//     interface (pattern /^\/bookings(\/|$)/); react-router ranks the static 'bookings/new'
//     above the dynamic ':bookingId', so declaration order carries no risk.
// Published interface (build-plan wave-6): the route PATHS only — /bookings,
// /bookings/new?listing=<id>, /bookings/:bookingId. No sibling feature imports these files.
import BookingsListPage from './BookingsListPage.jsx';
import ReservePage from './ReservePage.jsx';
import BookingDetailPage from './BookingDetailPage.jsx';

export default [
  { path: 'bookings', element: <BookingsListPage /> },
  { path: 'bookings/new', element: <ReservePage /> },
  { path: 'bookings/:bookingId', element: <BookingDetailPage /> },
];
