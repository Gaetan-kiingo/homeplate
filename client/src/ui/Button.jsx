// client/src/ui/Button.jsx — the kit's only button (U5-UI-KIT; NFR-07). Always a REAL
// <button> (native focusability, Enter/Space activation, form semantics), defaulting to
// type="button" so a button inside a form never submits by accident. The BUSY state is for
// in-flight async work (reserving a seat, publishing a listing): aria-busy="true" +
// aria-disabled="true" tell assistive tech what is happening, activation is suppressed, but
// the button STAYS FOCUSABLE — hard-disabling would silently drop keyboard/screen-reader
// focus mid-action. `disabled` is the separate, native, truly-inert state. Ref-forwarding so
// focus managers (Dialog initialFocusRef, wave-6 screens) can target it.
import { forwardRef } from 'react';
import styles from './Button.module.css';

const Button = forwardRef(function Button(
  {
    variant = 'primary',
    type = 'button',
    busy = false,
    disabled = false,
    className = '',
    onClick,
    children,
    ...rest
  },
  ref
) {
  function handleClick(event) {
    if (busy) {
      // In-flight: suppress re-activation (double-submit guard) without losing focus.
      event.preventDefault();
      return;
    }
    if (onClick) {
      onClick(event);
    }
  }

  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled}
      aria-busy={busy ? true : undefined}
      aria-disabled={busy && !disabled ? true : undefined}
      onClick={handleClick}
      className={[styles.button, styles[variant] || styles.primary, className]
        .filter(Boolean)
        .join(' ')
        .trim()}
    >
      {children}
    </button>
  );
});

export default Button;
