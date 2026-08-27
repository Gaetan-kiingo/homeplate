// client/src/ui/Icon.jsx — the kit's minimal icon set (design review §4: "consistent minimal
// icon set … make date, location, seats and account actions feel finished and easier to
// scan"). Inline SVG, self-hosted by construction: no icon font, no sprite request, no
// third-party dependency — the review's own guidance that avoiding a CDN never meant
// avoiding polish.
//
// NFR-07: icons here are DECORATIVE by default (aria-hidden, focusable={false}) because they
// always sit beside the text they illustrate — an icon that repeats its neighbour's words is
// noise to a screen reader. Passing `title` turns one into an img-role graphic with an
// accessible name, for the rare case where an icon stands alone.
// Colour comes from `currentColor` only, so an icon can never introduce an unmeasured
// colour — the kit's token contract holds without the icon set needing pairs of its own.
import styles from './Icon.module.css';

const PATHS = {
  calendar:
    'M7 3v3M17 3v3M4 9h16M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z',
  location:
    'M12 21s7-5.686 7-11a7 7 0 1 0-14 0c0 5.314 7 11 7 11z M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  seats:
    'M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19 M10 10.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5 M20 19v-1.5a3.5 3.5 0 0 0-2.6-3.38 M15.5 4.2a3.25 3.25 0 0 1 0 6.1',
  cuisine:
    'M6 3v8a3 3 0 0 0 6 0V3 M9 11v10 M17 3c-1.5 2-2 3.5-2 6s.7 3 2 3 2-.5 2-3-.5-4-2-6z M17 12v9',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
};

export default function Icon({ name, title, className = '', ...rest }) {
  const d = PATHS[name];
  if (!d) return null;
  const labelled = typeof title === 'string' && title.trim().length > 0;
  return (
    <svg
      {...rest}
      className={`${styles.icon} ${className}`.trim()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden={labelled ? undefined : 'true'}
      role={labelled ? 'img' : undefined}
    >
      {labelled ? <title>{title}</title> : null}
      {d.split(' M').map((seg, i) => (
        <path key={seg.slice(0, 12) + i} d={i === 0 ? seg : `M${seg}`} />
      ))}
    </svg>
  );
}
