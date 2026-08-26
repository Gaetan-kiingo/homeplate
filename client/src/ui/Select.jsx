// client/src/ui/Select.jsx — native select control (U5-UI-KIT; NFR-07). A real <select>
// (native keyboard/AT behaviour beats any custom dropdown for AA), with the same FormField
// wiring as the text controls. Options are the caller's <option> children.
import { useFormControlProps } from './FormField.jsx';
import styles from './FormField.module.css';

export default function Select({ className = '', children, ...rest }) {
  const controlProps = useFormControlProps(rest);
  return (
    <select {...controlProps} className={`${styles.control} ${className}`.trim()}>
      {children}
    </select>
  );
}
