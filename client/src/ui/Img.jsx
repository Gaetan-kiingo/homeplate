// client/src/ui/Img.jsx — the kit's ONLY image primitive (U5-UI-KIT; NFR-07: "all images
// carry alt text"). `alt` is REQUIRED and must be non-empty; a purely decorative image must
// say so explicitly via `decorative`, which emits alt="" (ignored by assistive technology).
// Misuse fails LOUDLY in dev/test (throw), and in a production build renders alt="" with a
// console.error rather than crashing a screen — but the dev throw plus the unit spec make
// sure misuse never survives to a build. Passing BOTH a real alt and `decorative` is a
// contradiction and is treated the same way.
//
// BROKEN SOURCES degrade to a neutral placeholder rather than the browser's broken-image
// chrome, which renders the alt string as raw overflowing text and makes a whole card look
// defective. Alt text is still the accessible name while the image is intact; once it fails
// the element becomes decorative, because "Photo of X" describes a photo that is not there.
import { useState } from 'react';
import styles from './Img.module.css';

function failLoudly(message) {
  // Vite statically replaces import.meta.env.DEV (true in dev and vitest, false in builds).
  if (import.meta.env.DEV === true || import.meta.env.DEV === 'true') {
    throw new Error(message);
  }
  console.error(message);
}

export default function Img({ alt, decorative = false, className = '', ...rest }) {
  const hasRealAlt = typeof alt === 'string' && alt.trim().length > 0;

  if (!decorative && !hasRealAlt) {
    failLoudly(
      'Homeplate UI <Img>: `alt` is required and must be non-empty (NFR-07). A purely ' +
        'decorative image must say so explicitly: <Img decorative … /> emits alt="".'
    );
    // Production-build fallback only (the dev/test path threw above): render as decorative
    // instead of unlabelled — never an <img> with no alt attribute at all.
    return <img {...rest} alt="" className={`${styles.img} ${className}`.trim()} />;
  }

  if (decorative && hasRealAlt) {
    failLoudly(
      'Homeplate UI <Img>: `decorative` and a non-empty `alt` contradict each other — ' +
        'drop one of them. Rendering as decorative (alt="").'
    );
  }

  return <Picture {...rest} alt={decorative ? '' : alt} className={className} />;
}

function Picture({ alt, className = '', onError, ...rest }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span
        {...rest}
        role="presentation"
        aria-hidden="true"
        className={`${styles.img} ${styles.broken} ${className}`.trim()}
      />
    );
  }

  return (
    <img
      {...rest}
      alt={alt}
      className={`${styles.img} ${className}`.trim()}
      onError={(event) => {
        setFailed(true);
        if (onError) onError(event);
      }}
    />
  );
}
