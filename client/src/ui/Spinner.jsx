// client/src/ui/Spinner.jsx — loading indicator (U5-UI-KIT; NFR-07). role="status" makes the
// spinner a polite live region, so assistive technology announces the text alternative when
// it appears; the animated circle itself is aria-hidden (pure decoration). The label prop
// lets screens say WHAT is loading ("Searching nearby meals…"), not just that something is.
import styles from './Spinner.module.css';
import vhStyles from './VisuallyHidden.module.css';

export default function Spinner({ label = 'Loading' }) {
  return (
    <span role="status" className={styles.spinner}>
      <span aria-hidden="true" className={styles.circle} />
      <span className={vhStyles.visuallyHidden}>{label}</span>
    </span>
  );
}
