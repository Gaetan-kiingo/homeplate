// client/src/features/booking/components/SignInPrompt.jsx — U6-BOOKING: the signed-out
// state of the booking screens (SPMP WA-9).
//
// Requirement traceability (SRS Appendix B):
//   FR-12 / AB-08 — every booking surface requires a session; the anonymous state renders a
//     real path to sign in instead of firing requests that can only 401.
//   NFR-03 / AB-05 — the signed-out decision comes from useSession() (response-inferred
//     state) at the call sites, never from a cookie read.
// Cross-feature navigation is by URL string only (wave-6 parallel-work rule): /login and
// /signup are U6-ACCOUNT-MOD routes.
import { Link } from 'react-router-dom';

export default function SignInPrompt({ purpose }) {
  return (
    <p>
      <Link to="/login">Sign in</Link> or <Link to="/signup">create an account</Link> {purpose}.
    </p>
  );
}
