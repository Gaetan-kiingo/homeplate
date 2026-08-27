// client/src/features/moderation/components/ModeratorGate.jsx — U6-ACCOUNT-MOD: the
// client-side moderator role gate shared by the FR-08 queue and FR-07 alerts views.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-08 / AB-08 — the gate is UX ONLY: it reads user.roles from the session snapshot to
//     spare non-moderators a doomed fetch and give them a clean 403 screen. The ENFORCEMENT
//     is the server's 403 (NOT_MODERATOR / FORBIDDEN) on every /api/moderation route — the
//     screens still handle that 403 identically even if this gate is bypassed.
//   NFR-03 / AB-05 — the verdict is response-inferred session state (useSession), never a
//     cookie read; while the session is hydrating ('unknown') the gate shows a labelled
//     spinner and claims nothing.
//   NFR-07 — every gate outcome is real text under the page's h1 (h2 sections), with a
//     working way out (sign-in link / home link).
import { Link } from 'react-router-dom';
import { Spinner } from '../../../ui/index.js';
import { useSession } from '../../../session/index.js';
import styles from '../moderation.module.css';

/** Mirrors src/modules/moderation/service.js MODERATOR_ROLE — display gating only. */
export const MODERATOR_ROLE = 'moderator';

/** The clean 403 screen (also rendered when the SERVER answers 403 — the enforcement). */
export function ForbiddenScreen() {
  return (
    <section aria-labelledby="moderation-403-heading">
      <h2 id="moderation-403-heading">Moderator access required (403)</h2>
      <p className={styles.lead}>
        This area is restricted to accounts holding the moderator role. Your account does not, so
        the server refuses these requests.
      </p>
      <p>
        <Link to="/">Back to Homeplate</Link>
      </p>
    </section>
  );
}

export default function ModeratorGate({ children }) {
  const { user, status } = useSession();
  if (status === 'unknown') {
    return <Spinner label="Checking your session" />;
  }
  if (status === 'anonymous') {
    return (
      <section aria-labelledby="moderation-signin-heading">
        <h2 id="moderation-signin-heading">Sign in required</h2>
        <p className={styles.lead}>
          The moderation tools need a signed-in moderator account. <Link to="/login">Sign in</Link>{' '}
          to continue.
        </p>
      </section>
    );
  }
  if (!Array.isArray(user.roles) || !user.roles.includes(MODERATOR_ROLE)) {
    return <ForbiddenScreen />;
  }
  return children;
}
