// client/src/features/moderation/routes.jsx — U6-ACCOUNT-MOD: the moderation feature's
// route declarations, auto-discovered by client/src/routes.jsx (import.meta.glob — the
// wave-5 extension contract: default-export an ARRAY of react-router route objects).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-08 — /moderation: the human review queue over all four content types (listing,
//            review, message, safety_alert) with approve/reject decisions.
//   FR-07 — /moderation/alerts: the safety-alert queue (delivery status incl. the
//            dead-lettered terminal state) and the AB-04 moderator escalation.
//   NFR-07 — '/moderation' is the moderator-queue interface the a11y harness
//            (scripts/a11y-audit.js) maps via /^\/(moderation|queue)(\/|$)/; both routes
//            render inside the AppLayout landmarks with one h1 per page.
import QueuePage from './QueuePage.jsx';
import AlertsPage from './AlertsPage.jsx';

export default [
  { path: 'moderation', element: <QueuePage /> },
  { path: 'moderation/alerts', element: <AlertsPage /> },
];
