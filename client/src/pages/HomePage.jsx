// client/src/pages/HomePage.jsx — the home page (U5-SHELL; SRS §2.1.2, WA-9).
//
// Wave 5 shipped this page with no links, on the note that "the marketplace screens — the only
// real things to link to — are wave 6". Wave 6 built all seven of them, but every wave-6 unit
// was scoped to client/src/features/**, so nobody owned this file: the copy still told visitors
// the screens were yet to come, and the front door offered no way in. Corrected 2026-08-27
// together with the layout nav.
//
// Demo-polish pass (2026-09-09): the page was a heading and two paragraphs. It is now a front
// door — hero (headline, lede, calls to action, a photo of a real table), "how it works" in
// three steps, and a trust strip that turns the privacy/safety constraints (NFR-13, AB-08,
// FR-07/FR-08) into the product promise they actually are. Still token-only, still no
// third-party request: the photos are static assets under client/public/.
//
// NFR-07: exactly one h1; document.title via usePageTitle (home is the bare product name);
// the calls to action are real links to routes that exist, never buttons that go nowhere;
// photos are decorative (alt="") because the adjacent text carries every fact they show.
import { Link } from 'react-router-dom';
import { useSession } from '../session/index.js';
import usePageTitle from '../layout/usePageTitle.js';
import { Icon } from '../ui/index.js';
import styles from './home.module.css';

export default function HomePage() {
  usePageTitle();
  const { status } = useSession();
  const signedIn = status === 'authenticated';

  return (
    <>
      <section className={styles.hero} aria-labelledby="home-title">
        <div>
          <p className={styles.eyebrow}>
            <Icon name="location" /> San Diego · home-cooked, shared locally
          </p>
          <h1 id="home-title" className={styles.title}>
            A seat at a <em>real table</em>, cooked by a neighbour.
          </h1>
          <p className={styles.lede}>
            Approved home hosts publish a meal with a date and a handful of seats. You browse what
            is coming up nearby, reserve a seat, and the address arrives once you are booked.
          </p>

          {/* Rendered only once the session resolves, so a signed-in visitor is never invited to
              create an account they already have. */}
          {status === 'anonymous' && (
            <>
              <div className={styles.ctaRow}>
                <Link className={styles.ctaPrimary} to="/signup">
                  Create an account
                </Link>
                <Link className={styles.ctaSecondary} to="/login">
                  Sign in
                </Link>
              </div>
              <p className={styles.ctaNote}>
                Browsing needs an account: host locations are never shown to anonymous visitors.
              </p>
            </>
          )}

          {signedIn && (
            <div className={styles.ctaRow}>
              <Link className={styles.ctaPrimary} to="/search">
                Find a meal
              </Link>
              <Link className={styles.ctaSecondary} to="/bookings">
                Your bookings
              </Link>
            </div>
          )}
        </div>

        <figure className={styles.heroMedia}>
          <img className={styles.heroImage} src="/hero-table.jpg" alt="" />
          <figcaption className={styles.heroChip} aria-hidden="true">
            <span className={styles.heroChipTitle}>Friday supper in North Park</span>
            <span className={styles.heroChipMeta}>
              <span>
                <Icon name="calendar" /> Fri 7:00 PM
              </span>
              <span>
                <Icon name="seats" /> 4 seats
              </span>
              <span className={styles.heroChipSeats}>2 left</span>
            </span>
          </figcaption>
        </figure>
      </section>

      <section aria-labelledby="home-how">
        <h2 id="home-how" className={styles.sectionTitle}>
          How it works
        </h2>
        <p className={styles.sectionLede}>Three steps from browsing to sitting down.</p>
        <ol className={styles.steps}>
          <li className={styles.step}>
            <span className={styles.stepNumber} aria-hidden="true">
              1
            </span>
            <span className={styles.stepIcon} aria-hidden="true">
              <Icon name="cuisine" />
            </span>
            <h3>Browse what is coming up</h3>
            <p>
              Filter by neighbourhood, date and cuisine. Every listing is an event: one host, one
              evening, a fixed number of seats.
            </p>
          </li>
          <li className={styles.step}>
            <span className={styles.stepNumber} aria-hidden="true">
              2
            </span>
            <span className={styles.stepIcon} aria-hidden="true">
              <Icon name="calendar" />
            </span>
            <h3>Reserve a seat</h3>
            <p>
              One tap holds your place. The exact address is shared with you only after the
              reservation is confirmed.
            </p>
          </li>
          <li className={styles.step}>
            <span className={styles.stepNumber} aria-hidden="true">
              3
            </span>
            <span className={styles.stepIcon} aria-hidden="true">
              <Icon name="star" />
            </span>
            <h3>Eat, then say thanks</h3>
            <p>
              After the meal, leave a review. Ratings follow the host, so the best tables are easy
              to find next time.
            </p>
          </li>
        </ol>
      </section>

      <section className={styles.trust} aria-labelledby="home-trust">
        <div>
          <h2 id="home-trust">Built to be trusted</h2>
          <ul className={styles.trustList}>
            <li>
              <Icon name="shield" />
              <span>
                Hosts are approved before they can publish, and every listing passes moderation.
              </span>
            </li>
            <li>
              <Icon name="location" />
              <span>
                Only a neighbourhood is public. Exact addresses are shared with confirmed guests.
              </span>
            </li>
            <li>
              <Icon name="check" />
              <span>
                Reviews are tied to completed bookings, so every rating comes from someone who sat
                at the table.
              </span>
            </li>
          </ul>
        </div>
        <figure className={styles.trustMedia}>
          <img src="/hosts-cooking.jpg" alt="" />
        </figure>
      </section>
    </>
  );
}
