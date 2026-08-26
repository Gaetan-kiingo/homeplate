// client/src/ui/TextInput.jsx — single-line text control (U5-UI-KIT; NFR-07). Inside a
// FormField it inherits the label association, aria-describedby (hint/error), aria-invalid
// and required wiring via useFormControlProps; standalone use must bring its own labelling
// (aria-label / external <label htmlFor>). Always a real <input>.
import { useFormControlProps } from './FormField.jsx';
import styles from './FormField.module.css';

export default function TextInput({ className = '', type = 'text', ...rest }) {
  const controlProps = useFormControlProps(rest);
  return (
    <input {...controlProps} type={type} className={`${styles.control} ${className}`.trim()} />
  );
}
