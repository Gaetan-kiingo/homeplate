// client/src/routes.jsx — routing skeleton of the responsive React WEB client (SRS §2.1.2 —
// web, not React Native; SRS wins over SPMP §5.2.1, recorded at WA-9). U5-SHELL.
// Requirement / decision traceability:
//   NFR-03 — every route renders inside the HTTPS-only shell; nothing here talks to the
//     network directly (the API client lands in U5-API-CLIENT, screens in wave 6).
//   NFR-07 — every route mounts under <AppLayout> (landmarks, skip link, focus-to-#main on
//     route change) and errors fall to <RootErrorBoundary>, so no navigation can ever land on
//     a landmark-free page. One h1 + document.title per route is each page's contract
//     (layout/usePageTitle.js).
//
// EXTENSION CONTRACT (mirror of the backend's self-mounting route registry, build-plan §6.1):
// a wave-6 unit adds screens by creating client/src/features/<name>/routes.jsx that
// DEFAULT-EXPORTS AN ARRAY of react-router route objects (e.g. [{ path: 'search', element:
// <SearchPage /> }]). import.meta.glob discovers it below — no wave-6 unit edits this file or
// any other wave-5 file. In wave 5 the discovered set is empty and the shell ships only what
// is real: home, the catch-all 404, and the top-level error boundary. No placeholder screens,
// no dead nav links.
import AppLayout from './layout/AppLayout.jsx';
import RootErrorBoundary from './layout/RootErrorBoundary.jsx';
import HomePage from './pages/HomePage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';

/**
 * Flatten a `import.meta.glob(..., { eager: true })` result into a route array, enforcing the
 * feature contract loudly: each discovered module must default-export an array of route
 * objects. Deterministic mount order (sorted by file path) so two features never race on
 * declaration order. Exported for direct unit testing with synthetic glob results.
 */
export function mountFeatureRoutes(globbed) {
  return Object.keys(globbed)
    .sort()
    .flatMap((file) => {
      const routes = globbed[file] && globbed[file].default;
      if (!Array.isArray(routes)) {
        throw new Error(
          `Homeplate route discovery: ${file} must default-export an ARRAY of react-router ` +
            'route objects (e.g. export default [{ path: "search", element: <SearchPage /> }]). ' +
            'See client/src/routes.jsx for the wave-6 extension contract.'
        );
      }
      for (const route of routes) {
        if (route === null || typeof route !== 'object') {
          throw new Error(
            `Homeplate route discovery: ${file} default-exports a non-object route entry ` +
              `(${String(route)}) — every entry must be a react-router route object.`
          );
        }
      }
      return routes;
    });
}

// Discovered at build time; empty in wave 5 (client/src/features/ holds only .gitkeep).
const featureModules = import.meta.glob('./features/*/routes.jsx', { eager: true });

/**
 * The full route tree. `features` is injectable for tests; callers outside tests use the
 * default (the glob-discovered set). The catch-all 404 stays LAST so no feature route is ever
 * shadowed by it.
 */
export function buildRoutes(features = mountFeatureRoutes(featureModules)) {
  return [
    {
      path: '/',
      element: <AppLayout />,
      errorElement: <RootErrorBoundary />,
      children: [
        { index: true, element: <HomePage /> },
        ...features,
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ];
}

export default buildRoutes();
