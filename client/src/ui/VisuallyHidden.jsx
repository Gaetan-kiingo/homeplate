// client/src/ui/VisuallyHidden.jsx — screen-reader-only text (U5-UI-KIT; NFR-07). Renders
// its children invisibly but keeps them in the accessibility tree — the primitive wave-6
// screens use whenever a visual affordance (icon, layout) needs a textual equivalent.
import styles from './VisuallyHidden.module.css';

export default function VisuallyHidden({ as: Component = 'span', children, ...rest }) {
  return (
    <Component {...rest} className={styles.visuallyHidden}>
      {children}
    </Component>
  );
}
