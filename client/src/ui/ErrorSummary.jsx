// client/src/ui/ErrorSummary.jsx — form-level error summary (U5-UI-KIT; NFR-07: errors are
// reachable, readable and actionable, not just announced). The GDS-proven pattern: on a
// failed submit the summary renders with role="alert" (immediate announcement), takes
// PROGRAMMATIC FOCUS (tabIndex -1 container, focused when the error set changes), and lists
// one LINK per field error; activating a link moves focus to the offending control (whose
// FormField carries the in-place message via aria-describedby). Renders nothing when
// `errors` is empty — never an empty alert box.
//   errors: [{ fieldId, message }] — fieldId must be the FormField/control id.
//   takeFocus: pass false only when the caller manages focus itself (e.g. via the ref).
import { forwardRef, useEffect, useId, useRef } from 'react';
import styles from './ErrorSummary.module.css';

const ErrorSummary = forwardRef(function ErrorSummary(
  { heading = 'There is a problem', errors = [], takeFocus = true },
  forwardedRef
) {
  const ownRef = useRef(null);
  const headingId = useId();
  // Refocus when the SET of errors changes (a new failed submit), not on every parent
  // re-render — an unchanged summary must not keep stealing focus.
  const signature = errors.map((e) => `${e.fieldId} ${e.message}`).join(' | ');

  useEffect(() => {
    if (signature && takeFocus && ownRef.current) {
      ownRef.current.focus();
    }
  }, [signature, takeFocus]);

  if (errors.length === 0) {
    return null;
  }

  function setRefs(node) {
    ownRef.current = node;
    if (typeof forwardedRef === 'function') {
      forwardedRef(node);
    } else if (forwardedRef) {
      forwardedRef.current = node;
    }
  }

  function focusField(event, fieldId) {
    const target = document.getElementById(fieldId);
    if (target) {
      event.preventDefault();
      target.focus();
    }
    // No target (stale id): let the browser follow the #fragment rather than doing nothing.
  }

  return (
    <div
      role="alert"
      tabIndex={-1}
      ref={setRefs}
      aria-labelledby={headingId}
      className={styles.summary}
    >
      <h2 id={headingId} className={styles.heading}>
        {heading}
      </h2>
      <ul className={styles.list}>
        {errors.map(({ fieldId, message }) => (
          <li key={`${fieldId} ${message}`}>
            <a
              className={styles.link}
              href={`#${fieldId}`}
              onClick={(event) => focusField(event, fieldId)}
            >
              {message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
});

export default ErrorSummary;
