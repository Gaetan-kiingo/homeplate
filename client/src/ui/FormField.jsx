// client/src/ui/FormField.jsx — the labelled-form-control wrapper (U5-UI-KIT; NFR-07: "form
// controls have associated labels", errors programmatically associated and flagged). One
// FormField wraps exactly one control (TextInput/TextArea/Select) and wires, via context:
//   - programmatic label association (<label htmlFor> → control id, useId() fallback);
//   - aria-describedby pointing at the hint and/or error paragraphs;
//   - aria-invalid + a visually-hidden "Error:" prefix when `error` is set;
//   - required semantics (native `required` + a visible "(required)" label marker).
// Give the field a stable `id` whenever an ErrorSummary links to it (#id → control focus).
// Announcing errors is the StatusAnnouncer/ErrorSummary's job; this component makes them
// READABLE in place (WCAG 1.3.1, 3.3.1, 3.3.2).
import { createContext, useContext, useId } from 'react';
import styles from './FormField.module.css';
import vhStyles from './VisuallyHidden.module.css';

const FormFieldContext = createContext(null);

/**
 * Merge a control's own props with the enclosing FormField's wiring (id, aria-describedby,
 * aria-invalid, required). Used by TextInput/TextArea/Select; standalone use (no FormField)
 * returns the props untouched — the caller then owns labelling (e.g. aria-label).
 */
export function useFormControlProps(props) {
  const field = useContext(FormFieldContext);
  if (!field) {
    return props;
  }
  const { id, 'aria-describedby': ownDescribedBy, ...rest } = props;
  return {
    ...rest,
    id: id || field.controlId,
    'aria-describedby': [ownDescribedBy, field.describedBy].filter(Boolean).join(' ') || undefined,
    'aria-invalid': field.invalid || rest['aria-invalid'] ? true : undefined,
    required: Boolean(field.required || rest.required) || undefined,
  };
}

export default function FormField({ id, label, hint, error, required = false, children }) {
  const reactId = useId();
  const controlId = id || `${reactId}-control`;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  const field = {
    controlId,
    describedBy,
    invalid: Boolean(error),
    required: Boolean(required),
  };

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={controlId}>
        {label}
        {required ? <span className={styles.requiredMarker}> (required)</span> : null}
      </label>
      {hint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className={styles.error}>
          <span className={vhStyles.visuallyHidden}>Error: </span>
          {error}
        </p>
      ) : null}
      <FormFieldContext.Provider value={field}>{children}</FormFieldContext.Provider>
    </div>
  );
}
