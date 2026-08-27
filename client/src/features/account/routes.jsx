// client/src/features/account/routes.jsx — U6-ACCOUNT-MOD: the account feature's route
// declarations, auto-discovered by client/src/routes.jsx (import.meta.glob — the wave-5
// extension contract: default-export an ARRAY of react-router route objects).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-10  — /signup (registration + check-your-email + resend), /verify-email (token
//            redemption from the mailed link), /login (session start).
//   FR-09 / NFR-06 — /account carries the proactive eligibility panel (both flags +
//            outstanding reason codes with fix paths).
//   NFR-05 — /login renders the honest lockout state for the 429 LOGIN_RATE_LIMITED answer.
//   NFR-12 / NFR-13 — /account hosts deletion (confirm dialog naming the 30-day erasure)
//            and the data-export request/retrieval flow.
//   NFR-07 — '/login' and '/signup' are the signup-login interface the a11y harness
//            (scripts/a11y-audit.js) maps via /^\/(login|signup|register)(\/|$)/; every
//            route below renders inside the AppLayout landmarks with one h1 per page.
// Other features link to these paths by URL string only ('/login' for 401 redirects,
// '/account' for NOT_ELIGIBLE fix guidance) — never by importing these files.
import LoginPage from './LoginPage.jsx';
import SignupPage from './SignupPage.jsx';
import VerifyEmailPage from './VerifyEmailPage.jsx';
import AccountPage from './AccountPage.jsx';

export default [
  { path: 'login', element: <LoginPage /> },
  { path: 'signup', element: <SignupPage /> },
  { path: 'verify-email', element: <VerifyEmailPage /> },
  { path: 'account', element: <AccountPage /> },
];
