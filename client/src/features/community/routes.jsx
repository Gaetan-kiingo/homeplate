// client/src/features/community/routes.jsx — U6-COMMUNITY: the community screens' route
// declarations, discovered by the U5-SHELL glob mount (client/src/routes.jsx
// import.meta.glob): this file default-exports an ARRAY of react-router route objects and
// edits nothing outside the feature subtree (build-plan G.4 — parallel-wave discipline).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-06 — 'bookings/:bookingId/messages' is the participants-only booking thread. The
//     path literal deliberately matches the NFR-07 a11y harness's MESSAGING pattern
//     (scripts/a11y-audit.js: /^\/bookings\/[^/]+\/messages/), so the messaging interface
//     counts as present for the seven-interface coverage the moment this file lands.
//   FR-05 — 'bookings/:bookingId/review' is the review form on a completed booking.
//   FR-07 — 'bookings/:bookingId/safety-alert' raises a safety alert on a booking.
//   FR-08 — the review screen surfaces the born-pending publication policy (ADR-002).
//   NFR-07 — every route mounts under the shell's landmark layout automatically (AppLayout
//     via the glob mount); each page owns exactly one h1 + document.title (usePageTitle).
import MessagesPage from './MessagesPage.jsx';
import ReviewPage from './ReviewPage.jsx';
import SafetyAlertPage from './SafetyAlertPage.jsx';

export default [
  { path: 'bookings/:bookingId/messages', element: <MessagesPage /> },
  { path: 'bookings/:bookingId/review', element: <ReviewPage /> },
  { path: 'bookings/:bookingId/safety-alert', element: <SafetyAlertPage /> },
];
