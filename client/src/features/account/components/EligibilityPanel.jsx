// client/src/features/account/components/EligibilityPanel.jsx — U6-ACCOUNT-MOD: the
// proactive FR-09/NFR-06 eligibility panel on /account.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-09 / NFR-06 — both flags (canReserveSeat / canPublishListing) come VERBATIM from the
//     server's owner-profile payload; the single server-side policy
//     (src/modules/eligibility/policy.js, ADR-006) computed them and remains the ONLY
//     enforcement point. What this panel adds is guidance: for each false flag it lists the
//     outstanding reason codes with a concrete fix path — the same codes the server returns
//     in a 403 NOT_ELIGIBLE (EMAIL_UNVERIFIED, NAME_MISSING, PHONE_MISSING,
//     HOST_PROFILE_INCOMPLETE, HOST_AGREEMENT_MISSING).
//   DISPLAY-ONLY DERIVATION: GET /api/users/me serves the flags but not the reason codes, so
//     the panel derives WHICH codes are outstanding from the very profile attributes the
//     server policy reads (emailVerified, fullName, phone, hostProfile.bio,
//     hostProfile.hostAgreementAcceptedAt — all in the owner allowlist). This mirrors the
//     policy's inputs for guidance only; it never decides anything — the rendered verdict is
//     always the server's flag, and a flag the derivation cannot explain gets honest
//     fallback copy instead of a guess.
//   NFR-07 — status is stated in text (never colour alone); heading order h2 → h3; fix
//     paths are real links (/verify-email, the #account-profile form anchor).
import { Link } from 'react-router-dom';
import styles from '../account.module.css';

function nonBlank(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** Reason codes for the reserve_seat action, in the server policy's deterministic order. */
export function missingForReserve(user) {
  const codes = [];
  if (!user.emailVerified) codes.push('EMAIL_UNVERIFIED');
  if (!nonBlank(user.fullName)) codes.push('NAME_MISSING');
  if (!nonBlank(user.phone)) codes.push('PHONE_MISSING');
  return codes;
}

/** Reason codes for the publish_listing action (reserve set + host-profile requirements). */
export function missingForPublish(user) {
  const codes = missingForReserve(user);
  const hostProfile = user.hostProfile || null;
  if (!hostProfile || !nonBlank(hostProfile.bio)) codes.push('HOST_PROFILE_INCOMPLETE');
  if (!hostProfile || !hostProfile.hostAgreementAcceptedAt) codes.push('HOST_AGREEMENT_MISSING');
  return codes;
}

/** Per-reason-code guidance: WHAT is missing and HOW to fix it (the FR-09 fix paths). */
const GUIDANCE = {
  EMAIL_UNVERIFIED: {
    label: 'Verify your email address',
    fix: (
      <>
        Open the link in your verification email, or{' '}
        <Link to="/verify-email">request a new verification email</Link>.
      </>
    ),
  },
  NAME_MISSING: {
    label: 'Add your full name',
    fix: (
      <>
        Fill in the full-name field of the <a href="#account-profile">profile form below</a> and
        save.
      </>
    ),
  },
  PHONE_MISSING: {
    label: 'Add a phone number',
    fix: (
      <>
        Fill in the phone field of the <a href="#account-profile">profile form below</a>{' '}
        (international format, e.g. +14155552671) and save.
      </>
    ),
  },
  HOST_PROFILE_INCOMPLETE: {
    label: 'Complete your host profile',
    fix: (
      <>
        Add a host bio in the <a href="#account-profile">profile form below</a> and save.
      </>
    ),
  },
  HOST_AGREEMENT_MISSING: {
    label: 'Accept the host agreement',
    fix: (
      <>
        Tick the host-agreement checkbox in the <a href="#account-profile">profile form below</a>{' '}
        and save.
      </>
    ),
  },
};

function FlagBlock({ heading, allowed, allowedText, allowedAction = null, blockedText, codes }) {
  return (
    <div className={styles.flagCard}>
      <h3>{heading}</h3>
      <p className={allowed ? styles.ready : styles.blocked}>
        {allowed ? allowedText : blockedText}
      </p>
      {allowed && allowedAction ? <p>{allowedAction}</p> : null}
      {!allowed &&
        (codes.length > 0 ? (
          <ul className={styles.reasonList}>
            {codes.map((code) => (
              <li key={code}>
                <strong>{GUIDANCE[code].label}</strong>{' '}
                <span className={styles.reasonCode}>({code})</span> — {GUIDANCE[code].fix}
              </li>
            ))}
          </ul>
        ) : (
          // The server flag is false but the visible profile attributes look complete — the
          // panel never invents a reason; it reports honestly and points at a refresh.
          <p className={styles.lead}>
            The server reports this as not yet available, but every requirement we can see is met.
            Reload the page — if this persists, contact the Homeplate team.
          </p>
        ))}
    </div>
  );
}

/**
 * @param {{user: import('../../../api/types.js').SessionUser}} props
 */
export default function EligibilityPanel({ user }) {
  return (
    <section aria-labelledby="eligibility-heading" className={styles.section}>
      <h2 id="eligibility-heading">Eligibility</h2>
      <p className={styles.lead}>
        Homeplate checks these server-side before every reservation and every listing (FR-09). Here
        is where your account stands, and how to fix anything outstanding.
      </p>
      <div className={styles.flagGrid}>
        <FlagBlock
          heading="Reserving seats"
          allowed={user.canReserveSeat === true}
          allowedText="Ready — you can reserve seats at meals."
          blockedText="Not yet available — the following is outstanding:"
          codes={missingForReserve(user)}
        />
        <FlagBlock
          heading="Publishing listings (hosting)"
          allowed={user.canPublishListing === true}
          allowedText="Ready — you can publish meal listings."
          allowedAction={<Link to="/host/meals/new">Host a meal</Link>}
          blockedText="Not yet available — the following is outstanding:"
          codes={missingForPublish(user)}
        />
      </div>
    </section>
  );
}
