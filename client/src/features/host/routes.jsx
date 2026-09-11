// client/src/features/host/routes.jsx — HOST LISTING MANAGEMENT (FR-11): the host-side
// screens that wave 6 never owned (verification finding OBS-B3, closed 2026-09-11 by the team
// decision to ship a host listing UI in v1.0 rather than document host flows as API-driven).
//
// Requirement traceability (SRS Appendix B):
//   FR-11 — /host/meals/new creates a listing through POST /api/listings; /host/meals/:id/edit
//     updates it through PATCH /api/listings/:id. Cancelling lives on the listing's own page
//     (features/discovery/ListingDetailPage.jsx, owner block) so the host acts where they see
//     the meal. The MEHKO caps stay server-enforced (ADR-009); these screens only render the
//     typed refusals.
//   FR-08 — a new or materially edited listing is born PENDING; the screens say so and send
//     the host to the listing page, which shows the pending state until a moderator approves.
//   FR-09 — POST is behind the server's eligibility gate; a 403 NOT_ELIGIBLE renders the reason
//     codes with the account-page fix path. The screen also pre-checks canPublishListing from
//     the session so an ineligible host is told before typing a whole form.
//   NFR-07 — every route here is a real screen with one h1, labelled controls, announced
//     outcomes; the non-parameterized route is picked up by scripts/a11y-audit.js.
import CreateMealPage from './CreateMealPage.jsx';
import EditMealPage from './EditMealPage.jsx';
import MyMealsPage from './MyMealsPage.jsx';

export default [
  { path: 'host/meals', element: <MyMealsPage /> },
  { path: 'host/meals/new', element: <CreateMealPage /> },
  { path: 'host/meals/:id/edit', element: <EditMealPage /> },
];
