// client/src/features/discovery/routes.jsx — U6-DISCOVERY route declarations, discovered by
// the U5-SHELL glob mount (client/src/routes.jsx import.meta.glob contract: default-export
// an ARRAY of react-router route objects; no wave-5 file is edited).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-01 — '/search' (SearchPage): the NFR-07 "search/browse" interface.
//   FR-02 — '/listings/:id' (ListingDetailPage): the NFR-07 "listing detail" interface.
//   FR-03 — '/hosts/:id' (HostProfilePage): the NFR-07 "host profile" interface.
// The scripts/a11y-audit.js harness discovers these three literals and maps them onto the
// first three of the seven NFR-07 interfaces; the parameterized two are audited in wave 7
// with seeded fixture ids.
import SearchPage from './SearchPage.jsx';
import ListingDetailPage from './ListingDetailPage.jsx';
import HostProfilePage from './HostProfilePage.jsx';

export default [
  { path: 'search', element: <SearchPage /> },
  { path: 'listings/:id', element: <ListingDetailPage /> },
  { path: 'hosts/:id', element: <HostProfilePage /> },
];
