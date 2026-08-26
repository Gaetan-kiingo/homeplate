// client/src/ui/TextArea.jsx — multi-line text control (U5-UI-KIT; NFR-07). Same FormField
// wiring as TextInput (label association, aria-describedby, aria-invalid, required) through
// useFormControlProps. Always a real <textarea>.
import { useFormControlProps } from './FormField.jsx';
import styles from './FormField.module.css';

export default function TextArea({ className = '', rows = 4, ...rest }) {
  const controlProps = useFormControlProps(rest);
  return (
    <textarea {...controlProps} rows={rows} className={`${styles.control} ${className}`.trim()} />
  );
}
