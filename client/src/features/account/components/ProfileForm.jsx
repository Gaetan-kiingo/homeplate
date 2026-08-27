// client/src/features/account/components/ProfileForm.jsx — U6-ACCOUNT-MOD: the /account
// profile editor, transcribed field-for-field from src/schemas/auth.js profileUpdate.
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-06 / FR-09 — PATCH /api/users/me carries only the fields that changed (the schema
//     requires at least one) and the response returns the profile WITH freshly recomputed
//     eligibility flags, which the caller feeds back into the eligibility panel.
//   Schema transcription (src/schemas/auth.js): fullName (safeText 1..120, nullable),
//     phone (E.164, nullable), emergencyContact { name, phone, email } (all three or null —
//     §3.4 minimal collection, NFR-13), hostProfile { bio (safeText 1..2000, no clear path
//     by design), acceptHostAgreement: literal true }. Nothing else is settable — the form
//     invents no field the schema does not accept.
//   NFR-07 — every control labelled via FormField with stable ids (the ErrorSummary and the
//     eligibility panel's fix links target them); pre-submit validation renders a
//     focus-taking ErrorSummary; outcomes are announced via the shell's aria-live channel.
import { useState } from 'react';
import {
  Button,
  ErrorSummary,
  FormField,
  TextArea,
  TextInput,
  useAnnounce,
} from '../../../ui/index.js';
import { api } from '../../../api/index.js';
import { messageForAccountError } from './errorCopy.js';
import styles from '../account.module.css';

const EMAIL_SHAPE = /^\S+@\S+\.\S+$/;
const E164_SHAPE = /^\+[1-9]\d{1,14}$/;

/** Render an ISO instant as a plain date for the "accepted on …" line (locale- and
 *  UTC-pinned so the rendered string is deterministic everywhere, tests included). */
function formatDate(iso) {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return String(iso);
  return parsed.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * @param {{user: import('../../../api/types.js').SessionUser,
 *          onSaved: (user: object) => void}} props
 */
export default function ProfileForm({ user, onSaved }) {
  const { announce, announceError } = useAnnounce();
  const existingContact = user.emergencyContact || null;
  const [fullName, setFullName] = useState(user.fullName || '');
  const [phone, setPhone] = useState(user.phone || '');
  const [ecName, setEcName] = useState(existingContact ? existingContact.name || '' : '');
  const [ecPhone, setEcPhone] = useState(existingContact ? existingContact.phone || '' : '');
  const [ecEmail, setEcEmail] = useState(existingContact ? existingContact.email || '' : '');
  const [bio, setBio] = useState(user.hostProfile ? user.hostProfile.bio || '' : '');
  const [acceptAgreement, setAcceptAgreement] = useState(false);
  const [fieldErrors, setFieldErrors] = useState([]);
  const [serverError, setServerError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  // The agreement is accepted-once by design (z.literal(true); un-acceptance is not a v1.0
  // flow) — once the server holds a timestamp the checkbox is replaced by the record of it.
  const agreementAcceptedAt = user.hostProfile ? user.hostProfile.hostAgreementAcceptedAt : null;

  const errorFor = (fieldId) => {
    const hit = fieldErrors.find((entry) => entry.fieldId === fieldId);
    return hit ? hit.message : undefined;
  };

  /** Pre-submit validation + minimal diff against the served profile. */
  function buildPatch() {
    const errors = [];
    const patch = {};

    const cleanName = fullName.trim();
    if ((user.fullName || '') !== cleanName) {
      patch.fullName = cleanName === '' ? null : cleanName;
    }

    const cleanPhone = phone.trim();
    if (cleanPhone !== '' && !E164_SHAPE.test(cleanPhone)) {
      errors.push({
        fieldId: 'account-phone',
        message: 'Enter the phone number in international format, e.g. +14155552671',
      });
    } else if ((user.phone || '') !== cleanPhone) {
      patch.phone = cleanPhone === '' ? null : cleanPhone;
    }

    // Emergency contact: name+phone+email travel together (schema: all three, or null to
    // clear — §3.4 minimal collection).
    const cName = ecName.trim();
    const cPhone = ecPhone.trim();
    const cEmail = ecEmail.trim();
    const provided = [cName, cPhone, cEmail].filter((value) => value !== '').length;
    if (provided > 0 && provided < 3) {
      if (cName === '')
        errors.push({ fieldId: 'account-ec-name', message: 'Emergency contact needs a name' });
      if (cPhone === '')
        errors.push({
          fieldId: 'account-ec-phone',
          message: 'Emergency contact needs a phone number',
        });
      if (cEmail === '')
        errors.push({
          fieldId: 'account-ec-email',
          message: 'Emergency contact needs an email address',
        });
    } else if (provided === 3) {
      if (!E164_SHAPE.test(cPhone)) {
        errors.push({
          fieldId: 'account-ec-phone',
          message: 'Enter the contact phone in international format, e.g. +14155552671',
        });
      }
      if (!EMAIL_SHAPE.test(cEmail)) {
        errors.push({
          fieldId: 'account-ec-email',
          message: 'Enter a valid email address for the contact',
        });
      }
      const changed =
        !existingContact ||
        existingContact.name !== cName ||
        existingContact.phone !== cPhone ||
        existingContact.email !== cEmail;
      if (changed) {
        patch.emergencyContact = { name: cName, phone: cPhone, email: cEmail };
      }
    } else if (provided === 0 && existingContact) {
      patch.emergencyContact = null;
    }

    // Host profile: bio is set-only (the schema has no clear path — safeText 1..2000);
    // acceptance is the literal-true one-way switch.
    const cleanBio = bio.trim();
    const hostPatch = {};
    if (cleanBio !== '' && cleanBio !== (user.hostProfile ? user.hostProfile.bio || '' : '')) {
      hostPatch.bio = cleanBio;
    }
    if (acceptAgreement && !agreementAcceptedAt) {
      hostPatch.acceptHostAgreement = true;
    }
    if (Object.keys(hostPatch).length > 0) {
      patch.hostProfile = hostPatch;
    }

    return { errors, patch };
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setServerError(null);
    setNotice(null);
    const { errors, patch } = buildPatch();
    setFieldErrors(errors);
    if (errors.length > 0) {
      return;
    }
    if (Object.keys(patch).length === 0) {
      const message = 'Nothing to save — change at least one field first.';
      setNotice(message);
      announce(message);
      return;
    }
    setBusy(true);
    try {
      const { user: updated } = await api.users.updateMe(patch);
      announce('Profile saved. Your eligibility has been recomputed.');
      setNotice('Profile saved.');
      onSaved(updated);
    } catch (err) {
      const message = messageForAccountError(err);
      setServerError(message);
      announceError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ErrorSummary errors={fieldErrors} />
      {serverError !== null && <p className={styles.errorBox}>{serverError}</p>}
      {notice !== null && <p className={styles.noticeBox}>{notice}</p>}
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <FormField
          id="account-fullName"
          label="Full name"
          hint="Required before you can reserve a seat or host (FR-09)."
          error={errorFor('account-fullName')}
        >
          <TextInput
            name="name"
            autoComplete="name"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
          />
        </FormField>
        <FormField
          id="account-phone"
          label="Phone number"
          hint="International format, e.g. +14155552671. Required before reserving or hosting."
          error={errorFor('account-phone')}
        >
          <TextInput
            type="tel"
            name="tel"
            autoComplete="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </FormField>

        <fieldset className={styles.fieldset}>
          <legend>Emergency contact (optional)</legend>
          <p className={styles.lead}>
            Someone we can email if a safety alert is raised around one of your meals (FR-07).
            Provide all three fields, or clear all three to remove the contact.
          </p>
          <FormField id="account-ec-name" label="Contact name" error={errorFor('account-ec-name')}>
            <TextInput value={ecName} onChange={(event) => setEcName(event.target.value)} />
          </FormField>
          <FormField
            id="account-ec-phone"
            label="Contact phone"
            error={errorFor('account-ec-phone')}
          >
            <TextInput
              type="tel"
              value={ecPhone}
              onChange={(event) => setEcPhone(event.target.value)}
            />
          </FormField>
          <FormField
            id="account-ec-email"
            label="Contact email"
            error={errorFor('account-ec-email')}
          >
            <TextInput
              type="email"
              value={ecEmail}
              onChange={(event) => setEcEmail(event.target.value)}
            />
          </FormField>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend>Host profile</legend>
          <p className={styles.lead}>
            Needed only if you want to publish listings: a short host bio and the host agreement
            (FR-09).
          </p>
          <FormField
            id="account-host-bio"
            label="Host bio"
            hint="Tell guests who is cooking. Required before you can publish a listing."
            error={errorFor('account-host-bio')}
          >
            <TextArea rows={4} value={bio} onChange={(event) => setBio(event.target.value)} />
          </FormField>
          {agreementAcceptedAt ? (
            <p className={styles.ready}>
              Host agreement accepted on {formatDate(agreementAcceptedAt)}.
            </p>
          ) : (
            <div className={styles.checkboxRow}>
              <input
                type="checkbox"
                id="account-host-agreement"
                checked={acceptAgreement}
                onChange={(event) => setAcceptAgreement(event.target.checked)}
              />
              <label htmlFor="account-host-agreement">
                I accept the Homeplate host agreement (required before publishing listings; MEHKO
                limits apply).
              </label>
            </div>
          )}
        </fieldset>

        <div className={styles.actions}>
          <Button type="submit" busy={busy}>
            Save profile
          </Button>
        </div>
      </form>
    </>
  );
}
