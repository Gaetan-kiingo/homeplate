// client/src/ui/index.js — the Homeplate UI kit's public surface (U5-UI-KIT; NFR-07).
// Wave-6 screens build EXCLUSIVELY from these primitives, so WCAG 2.1 AA (labels, roles,
// focus management, alt enforcement, aria-live announcement, token-only contrast-checked
// colour) is inherited rather than re-implemented per screen. The kit is the leaf of the
// client: it imports nothing from layout/, api/, or session/ (gated by
// kit-contract.test.js). Design tokens live in ../styles/tokens.css, imported once by the
// shell (5C) — never from here.
export { default as Button } from './Button.jsx';
export { default as FormField } from './FormField.jsx';
export { default as TextInput } from './TextInput.jsx';
export { default as TextArea } from './TextArea.jsx';
export { default as Select } from './Select.jsx';
export { default as ErrorSummary } from './ErrorSummary.jsx';
export { default as StatusAnnouncer, useAnnounce } from './StatusAnnouncer.jsx';
export { default as Dialog } from './Dialog.jsx';
export { default as Spinner } from './Spinner.jsx';
export { default as Img } from './Img.jsx';
export { default as Card } from './Card.jsx';
export { default as VisuallyHidden } from './VisuallyHidden.jsx';
