// client/src/features/host/components/MealForm.jsx — the one listing form, used by both the
// create and the edit screen (FR-11 "complete listing data": title, description, ingredients,
// allergy information, schedule, seats, address).
//
// Contract with the API (src/schemas/listings.js `create` / `update`): the form's own state
// uses neutral field names and builds the request body keys itself. The precise-address keys
// are therefore only ever WRITTEN into the outgoing body here — the ADR-010 client guard
// (tests/adr-conformance) confines READING them from a payload to the two screens allowed to
// hold a privileged listing: the booking-gated detail page and the owner's edit page.
//
// NFR-07: every control is labelled through FormField (required marker, hint, error wiring);
// pre-submit refusals render as a focused ErrorSummary (role=alert) whose links move focus
// to the offending field; server-side 422 issues land on the same summary; the submit
// button carries aria-busy while the request is in flight.
import { useState } from 'react';
import { Button, ErrorSummary, FormField, Select, TextArea, TextInput } from '../../../ui/index.js';
import { laWallClockToIso } from './mealTime.js';
import styles from '../host.module.css';

/** Stable control ids (the ErrorSummary links target them), keyed by the FORM's field names. */
export const FIELD_IDS = Object.freeze({
  title: 'meal-title',
  description: 'meal-description',
  cuisine: 'meal-cuisine',
  ingredients: 'meal-ingredients',
  allergens: 'meal-allergens',
  when: 'meal-when',
  duration: 'meal-duration',
  seats: 'meal-seats',
  price: 'meal-price',
  street: 'meal-street',
  street2: 'meal-street2',
  city: 'meal-city',
  region: 'meal-region',
  zip: 'meal-zip',
  country: 'meal-country',
  photos: 'meal-photos',
});

/** API body key → control id, for mapping the server's 422 issue list back onto the form. */
export const BODY_FIELD_IDS = Object.freeze({
  title: FIELD_IDS.title,
  description: FIELD_IDS.description,
  cuisine: FIELD_IDS.cuisine,
  ingredients: FIELD_IDS.ingredients,
  allergens: FIELD_IDS.allergens,
  scheduledStart: FIELD_IDS.when,
  durationMinutes: FIELD_IDS.duration,
  seatCapacity: FIELD_IDS.seats,
  pricePerSeatCents: FIELD_IDS.price,
  addressLine1: FIELD_IDS.street,
  addressLine2: FIELD_IDS.street2,
  city: FIELD_IDS.city,
  region: FIELD_IDS.region,
  postalCode: FIELD_IDS.zip,
  country: FIELD_IDS.country,
});

/** The form's own state shape. `when` is an America/Los_Angeles wall-clock "YYYY-MM-DDTHH:mm". */
export const EMPTY_VALUES = Object.freeze({
  title: '',
  description: '',
  cuisine: '',
  ingredients: '',
  allergens: '',
  when: '',
  duration: '120',
  seats: '4',
  price: '', // dollars as typed, e.g. "18" or "18.50"; sent as whole cents
  street: '',
  street2: '',
  city: '',
  region: 'CA',
  zip: '',
  country: 'US',
});

/** "one per line, or comma-separated" → trimmed, de-duplicated labels. */
export function toLabels(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(/[\n,]/)) {
    const label = raw.trim();
    if (label !== '' && !seen.has(label.toLowerCase())) {
      seen.add(label.toLowerCase());
      out.push(label);
    }
  }
  return out;
}

/** "18", "18.50", "$18" → whole cents; null when not a non-negative amount with ≤ 2 decimals. */
export function dollarsToCents(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^\$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

/** Whole cents → the dollars text the input shows ("18" or "18.50"). */
export function centsToDollars(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n < 0) return '';
  return n % 100 === 0 ? String(n / 100) : (n / 100).toFixed(2);
}

/** Client-side checks mirroring the schema's cheap rules, so obvious mistakes never leave. */
export function validate(values, { requireFuture = true } = {}) {
  const problems = [];
  const add = (key, message) => problems.push({ fieldId: FIELD_IDS[key], message });
  if (values.title.trim().length < 3)
    add('title', 'Give the meal a title of at least 3 characters.');
  if (values.description.trim() === '') add('description', 'Describe the meal.');
  if (toLabels(values.ingredients).length === 0) {
    add('ingredients', 'List at least one ingredient (one per line, or comma-separated).');
  }
  const iso = laWallClockToIso(values.when);
  if (!iso) add('when', 'Choose the date and time of the meal.');
  else if (requireFuture && new Date(iso).getTime() <= Date.now()) {
    add('when', 'The meal must be in the future (America/Los_Angeles time).');
  }
  const duration = Number(values.duration);
  if (!Number.isInteger(duration) || duration < 1 || duration > 1440) {
    add('duration', 'Duration must be a whole number of minutes between 1 and 1440.');
  }
  const seats = Number(values.seats);
  if (!Number.isInteger(seats) || seats < 1) {
    add('seats', 'Seat capacity must be a whole number of at least 1.');
  }
  const cents = dollarsToCents(values.price);
  if (cents === null) {
    add('price', 'Enter the price per seat in dollars, e.g. 18 or 18.50 (0 for a free meal).');
  } else if (cents > 100000) {
    add('price', 'Price per seat must be at most $1000.');
  }
  if (values.street.trim() === '') add('street', 'Enter the street address.');
  if (values.city.trim() === '') add('city', 'Enter the city.');
  if (values.region.trim() === '') add('region', 'Enter the state or region.');
  if (!/^[A-Za-z]{2}$/.test(values.country.trim())) {
    add('country', 'Country must be a 2-letter code, e.g. US.');
  }
  return problems;
}

/** Build the API body (src/schemas/listings.js shape) from form values. Optional keys are omitted when blank. */
export function toBody(values) {
  // Optional keys are present only when filled (the schema treats them as optional, not
  // nullable). Written as object-literal keys on purpose: the ADR-010 client guard reserves
  // dot-access to the precise-address keys for the two screens that READ a privileged payload.
  const street2 = values.street2.trim();
  const zip = values.zip.trim();
  const cuisine = values.cuisine.trim();
  return {
    title: values.title.trim(),
    description: values.description.trim(),
    ingredients: toLabels(values.ingredients),
    allergens: toLabels(values.allergens),
    ...(cuisine !== '' ? { cuisine } : {}),
    scheduledStart: laWallClockToIso(values.when),
    durationMinutes: Number(values.duration),
    seatCapacity: Number(values.seats),
    pricePerSeatCents: dollarsToCents(values.price) ?? 0,
    addressLine1: values.street.trim(),
    ...(street2 !== '' ? { addressLine2: street2 } : {}),
    city: values.city.trim(),
    region: values.region.trim(),
    ...(zip !== '' ? { postalCode: zip } : {}),
    country: values.country.trim().toUpperCase(),
  };
}

/**
 * @param {object} props
 * @param {object} [props.initial]        starting values (EMPTY_VALUES shape)
 * @param {boolean} [props.withPhotos]    offer the photo picker (create only)
 * @param {boolean} [props.requireFuture] refuse a past date client-side (create: yes)
 * @param {string} props.submitLabel
 * @param {string} [props.busyLabel]
 * @param {boolean} props.busy
 * @param {Array<{fieldId: string, message: string}>} [props.serverIssues]  422 issues
 * @param {(payload: {values: object, body: object, files: File[]}) => void} props.onSubmit
 */
export default function MealForm({
  initial = EMPTY_VALUES,
  withPhotos = false,
  requireFuture = true,
  submitLabel,
  busyLabel,
  busy,
  serverIssues = [],
  onSubmit,
}) {
  const [values, setValues] = useState({ ...EMPTY_VALUES, ...initial });
  const [files, setFiles] = useState([]);
  const [problems, setProblems] = useState([]);

  const errors = problems.length > 0 ? problems : serverIssues;
  function fieldError(key) {
    const found = errors.find((entry) => entry.fieldId === FIELD_IDS[key]);
    return found ? found.message : undefined;
  }
  const set = (key) => (event) => setValues((prev) => ({ ...prev, [key]: event.target.value }));

  function handleSubmit(event) {
    event.preventDefault();
    const found = validate(values, { requireFuture });
    setProblems(found);
    if (found.length > 0) return; // the ErrorSummary renders, takes focus and announces
    onSubmit({ values, body: toBody(values), files });
  }

  return (
    <>
      <ErrorSummary errors={errors} />
      {/* noValidate: the custom validation above owns the refusal (focused ErrorSummary), so
          native bubbles never pre-empt it; `required` stays on the controls for AT. */}
      <form onSubmit={handleSubmit} noValidate className={styles.form}>
        <FormField id={FIELD_IDS.title} label="Title" required error={fieldError('title')}>
          <TextInput value={values.title} onChange={set('title')} maxLength={200} />
        </FormField>
        <FormField
          id={FIELD_IDS.description}
          label="Description"
          required
          hint="What you are cooking, the setting, anything guests should know."
          error={fieldError('description')}
        >
          <TextArea rows={5} value={values.description} onChange={set('description')} />
        </FormField>
        <FormField id={FIELD_IDS.cuisine} label="Cuisine (optional)" error={fieldError('cuisine')}>
          <TextInput value={values.cuisine} onChange={set('cuisine')} maxLength={80} />
        </FormField>
        <FormField
          id={FIELD_IDS.ingredients}
          label="Ingredients"
          required
          hint="One per line, or comma-separated."
          error={fieldError('ingredients')}
        >
          <TextArea rows={4} value={values.ingredients} onChange={set('ingredients')} />
        </FormField>
        <FormField
          id={FIELD_IDS.allergens}
          label="Allergens (optional)"
          hint="One per line, or comma-separated — guests see these as warning chips."
          error={fieldError('allergens')}
        >
          <TextArea rows={2} value={values.allergens} onChange={set('allergens')} />
        </FormField>

        <fieldset className={styles.fieldset}>
          <legend>When and how many</legend>
          <FormField
            id={FIELD_IDS.when}
            label="Date and time"
            required
            hint="America/Los_Angeles time — Homeplate v1.0 serves California."
            error={fieldError('when')}
          >
            <TextInput type="datetime-local" value={values.when} onChange={set('when')} />
          </FormField>
          <div className={styles.row}>
            <FormField
              id={FIELD_IDS.duration}
              label="Duration (minutes)"
              required
              error={fieldError('duration')}
            >
              <TextInput
                type="number"
                min={1}
                max={1440}
                step={1}
                inputMode="numeric"
                value={values.duration}
                onChange={set('duration')}
              />
            </FormField>
            <FormField
              id={FIELD_IDS.seats}
              label="Seats"
              required
              hint="MEHKO caps per day and per week apply; the server tells you if a cap would be exceeded."
              error={fieldError('seats')}
            >
              <TextInput
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={values.seats}
                onChange={set('seats')}
              />
            </FormField>
          </div>
          <FormField
            id={FIELD_IDS.price}
            label="Price per seat (USD)"
            required
            hint="What a guest pays you for one seat, settled directly with you — Homeplate v1.0 takes no payments. Enter 0 for a free meal."
            error={fieldError('price')}
          >
            <TextInput
              inputMode="decimal"
              placeholder="18 or 18.50"
              value={values.price}
              onChange={set('price')}
              maxLength={8}
            />
          </FormField>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend>Where</legend>
          <p className={styles.lead}>
            Guests see only the neighbourhood until they hold a reservation; the exact address is
            shared with them after they reserve.
          </p>
          <FormField
            id={FIELD_IDS.street}
            label="Street address"
            required
            error={fieldError('street')}
          >
            <TextInput
              value={values.street}
              onChange={set('street')}
              autoComplete="street-address"
              maxLength={200}
            />
          </FormField>
          <FormField
            id={FIELD_IDS.street2}
            label="Apartment, unit (optional)"
            error={fieldError('street2')}
          >
            <TextInput value={values.street2} onChange={set('street2')} maxLength={200} />
          </FormField>
          <div className={styles.row}>
            <FormField id={FIELD_IDS.city} label="City" required error={fieldError('city')}>
              <TextInput
                value={values.city}
                onChange={set('city')}
                autoComplete="address-level2"
                maxLength={120}
              />
            </FormField>
            <FormField id={FIELD_IDS.region} label="State" required error={fieldError('region')}>
              <TextInput
                value={values.region}
                onChange={set('region')}
                autoComplete="address-level1"
                maxLength={120}
              />
            </FormField>
          </div>
          <div className={styles.row}>
            <FormField id={FIELD_IDS.zip} label="ZIP code (optional)" error={fieldError('zip')}>
              <TextInput
                value={values.zip}
                onChange={set('zip')}
                autoComplete="postal-code"
                maxLength={20}
              />
            </FormField>
            <FormField
              id={FIELD_IDS.country}
              label="Country"
              required
              error={fieldError('country')}
            >
              <Select value={values.country} onChange={set('country')}>
                <option value="US">United States (US)</option>
              </Select>
            </FormField>
          </div>
        </fieldset>

        {withPhotos ? (
          <>
            <FormField
              id={FIELD_IDS.photos}
              label="Photos (optional)"
              hint="The first photo becomes the meal's cover image."
            >
              <TextInput
                type="file"
                accept="image/*"
                multiple
                onChange={(event) => setFiles(Array.from(event.target.files || []))}
              />
            </FormField>
            {files.length > 0 ? (
              <p className={styles.fileNote}>
                {files.length === 1 ? '1 photo selected.' : `${files.length} photos selected.`}
              </p>
            ) : null}
          </>
        ) : null}

        <div className={styles.actions}>
          <Button type="submit" busy={busy}>
            {busy ? busyLabel || submitLabel : submitLabel}
          </Button>
        </div>
      </form>
    </>
  );
}
