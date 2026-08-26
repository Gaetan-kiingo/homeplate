// client/src/ui/FormField.test.jsx — U5-UI-KIT specs (NFR-07: "form controls have associated
// labels" and errors are programmatically associated). Covers FormField wiring for all three
// controls: programmatic label association, aria-describedby for hint and error,
// aria-invalid, required semantics, and standalone (labelled-by-caller) use.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import FormField from './FormField.jsx';
import TextInput from './TextInput.jsx';
import TextArea from './TextArea.jsx';
import Select from './Select.jsx';

describe('FormField + TextInput (NFR-07)', () => {
  it('associates the label with the control programmatically', () => {
    render(
      <FormField id="email" label="Email">
        <TextInput type="email" />
      </FormField>
    );
    const input = screen.getByRole('textbox', { name: 'Email' });
    expect(input).toHaveAttribute('id', 'email');
    expect(input).toHaveAttribute('type', 'email');
  });

  it('generates an id when none is given — the label still associates', () => {
    render(
      <FormField label="Dish name">
        <TextInput />
      </FormField>
    );
    const input = screen.getByRole('textbox', { name: 'Dish name' });
    expect(input.id).not.toBe('');
  });

  it('wires the hint through aria-describedby', () => {
    render(
      <FormField id="dish" label="Dish name" hint="As it will appear to guests.">
        <TextInput />
      </FormField>
    );
    const input = screen.getByRole('textbox', { name: 'Dish name' });
    expect(input).toHaveAttribute('aria-describedby', 'dish-hint');
    expect(input).toHaveAccessibleDescription('As it will appear to guests.');
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('error: sets aria-invalid, describes the control with the error text, keeps the hint', () => {
    render(
      <FormField
        id="seats"
        label="Seats"
        hint="Between 1 and 8."
        error="Enter a number of seats between 1 and 8"
      >
        <TextInput inputMode="numeric" />
      </FormField>
    );
    const input = screen.getByRole('textbox', { name: 'Seats' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'seats-hint seats-error');
    // Accessible description = hint + error, and the error carries a spoken "Error:" prefix.
    expect(input).toHaveAccessibleDescription(
      'Between 1 and 8. Error: Enter a number of seats between 1 and 8'
    );
  });

  it('required: native required attribute plus a visible "(required)" label marker', () => {
    render(
      <FormField id="title" label="Listing title" required>
        <TextInput />
      </FormField>
    );
    const input = screen.getByRole('textbox', { name: /listing title \(required\)/i });
    expect(input).toBeRequired();
  });

  it('standalone (outside FormField) leaves props untouched — caller owns labelling', () => {
    render(<TextInput aria-label="Search meals" />);
    const input = screen.getByRole('textbox', { name: 'Search meals' });
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');
  });
});

describe('FormField + TextArea (NFR-07)', () => {
  it('associates label, hint and error exactly like TextInput', () => {
    render(
      <FormField id="review" label="Your review" hint="What was the meal like?" error="Required">
        <TextArea />
      </FormField>
    );
    const textarea = screen.getByRole('textbox', { name: 'Your review' });
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea).toHaveAttribute('aria-invalid', 'true');
    expect(textarea).toHaveAttribute('aria-describedby', 'review-hint review-error');
  });
});

describe('FormField + Select (NFR-07)', () => {
  it('associates the label with a real <select> and wires the error', () => {
    render(
      <FormField id="diet" label="Dietary tags" error="Choose a dietary tag">
        <Select defaultValue="">
          <option value="" disabled>
            Choose…
          </option>
          <option value="vegetarian">Vegetarian</option>
        </Select>
      </FormField>
    );
    const select = screen.getByRole('combobox', { name: 'Dietary tags' });
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select).toHaveAttribute('aria-describedby', 'diet-error');
  });
});
