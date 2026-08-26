// client/src/pages/NotFoundPage.jsx — catch-all 404 route (U5-SHELL; build-plan §6.1 5A.3).
// Mounted LAST in the route tree (path '*') so it never shadows a real route, including the
// wave-6 feature routes discovered by client/src/routes.jsx.
// NFR-07: exactly one h1; document.title names the state; reached via a route change, so
// AppLayout has already moved focus to #main. The only link is a real one (home).
import { Link } from 'react-router-dom';
import usePageTitle from '../layout/usePageTitle.js';

export default function NotFoundPage() {
  usePageTitle('Page not found');

  return (
    <>
      <h1>Page not found</h1>
      <p>
        There is nothing at this address. The page may have moved, or the link you followed may be
        out of date.
      </p>
      <p>
        <Link to="/">Go to the Homeplate home page</Link>
      </p>
    </>
  );
}
