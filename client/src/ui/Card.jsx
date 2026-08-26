// client/src/ui/Card.jsx — content-grouping container (U5-UI-KIT; NFR-07). Semantics are the
// caller's choice via `as` (e.g. as="article" for a listing result, as="section" for a form
// group) so the kit never forces a generic <div> where a landmark or list item is right.
import styles from './Card.module.css';

export default function Card({ as: Component = 'div', className = '', children, ...rest }) {
  return (
    <Component {...rest} className={`${styles.card} ${className}`.trim()}>
      {children}
    </Component>
  );
}
