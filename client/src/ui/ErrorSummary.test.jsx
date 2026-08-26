// client/src/ui/ErrorSummary.test.jsx — U5-UI-KIT specs (NFR-07): the form-level summary is
// announced (role="alert"), takes programmatic focus, and links each message to its field.
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ErrorSummary from './ErrorSummary.jsx';
import FormField from './FormField.jsx';
import TextInput from './TextInput.jsx';

const twoErrors = [
  { fieldId: 'email', message: 'Enter your email address' },
  { fieldId: 'password', message: 'Enter your password' },
];

describe('ErrorSummary (NFR-07)', () => {
  it('renders nothing at all when there are no errors', () => {
    const { container } = render(<ErrorSummary errors={[]} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders an alert named by its heading, with one link per field error', () => {
    render(<ErrorSummary errors={twoErrors} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAccessibleName('There is a problem');
    expect(screen.getByRole('heading', { level: 2, name: 'There is a problem' })).toBeVisible();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', '#email');
    expect(links[0]).toHaveTextContent('Enter your email address');
    expect(links[1]).toHaveAttribute('href', '#password');
  });

  it('takes programmatic focus when it appears (tabIndex -1 container)', async () => {
    render(<ErrorSummary errors={twoErrors} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('tabindex', '-1');
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('does not steal focus when takeFocus is false', () => {
    render(<ErrorSummary errors={twoErrors} takeFocus={false} />);
    expect(screen.getByRole('alert')).not.toHaveFocus();
  });

  it('activating an error link moves focus to the offending control', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ErrorSummary errors={[{ fieldId: 'email', message: 'Enter your email address' }]} />
        <FormField id="email" label="Email" error="Enter your email address">
          <TextInput type="email" />
        </FormField>
      </>
    );
    await user.click(screen.getByRole('link', { name: 'Enter your email address' }));
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveFocus();
  });

  it('supports a custom heading', () => {
    render(<ErrorSummary heading="Fix the following to reserve" errors={twoErrors} />);
    expect(screen.getByRole('alert')).toHaveAccessibleName('Fix the following to reserve');
  });
});
