// U1-HTTP — route registry. Mounts src/modules/<name>/routes.js for every KNOWN module so
// later waves add routes without editing this (or any other) shared file: a module lands
// its routes.js and the next boot mounts it (build-plan §1 convention 2).
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-08 — a startup warning is logged for every known module whose routes are not on
//            disk yet (after wave 2 the mounted set is auth + users, and that is expected);
//            unknown paths / wrong methods become structured JSON 404/405 errors routed
//            through the shared error handler (U1-OBS), never HTML error pages.
//   NFR-11 — every route reachable through this registry sits behind the app-level
//            security middleware (src/middleware/security.js) and the module's own
//            validation layer (U1-VALID) — the registry mounts under /api/<name> only.
//   ADR-001 — modules are mounted in-process (modular monolith); nothing here may import
//            src/adapters/* (worker-only, adr-conformance lane).
//
// Module contract: src/modules/<name>/routes.js exports EITHER an Express router
// (module.exports = router) OR { basePath: '/api/custom', router }. Default mount point
// is /api/<name>.
'use strict';

const fs = require('fs');
const path = require('path');

// The KNOWN module list across all waves (build-plan §1 directory layout). Order is mount
// order. Modules whose wave has not landed yet are warned about, never invented.
const KNOWN_MODULES = [
  // waves 0-2
  'auth',
  'users',
  'eligibility',
  'media',
  'notifications',
  // waves 3-4
  'listings',
  'search',
  'hosts',
  'bookings',
  'reviews',
  'messaging',
  'moderation',
  'safety',
  'privacy',
];

const DEFAULT_MODULES_DIR = path.join(__dirname, '..', 'modules');

/**
 * Resolve and mount every known module router that exists on disk.
 * @param {import('express').Application} app
 * @param {{ logger: {info:Function, warn:Function}, modulesDir?: string }} options
 *   `modulesDir` overrides the module root (unit tests point it at a fixture tree;
 *   production always uses src/modules).
 * @returns {{ mounted: Array<{name: string, basePath: string}>, missing: string[] }}
 */
function mountModuleRoutes(app, { logger, modulesDir = DEFAULT_MODULES_DIR }) {
  const mounted = [];
  const missing = [];

  for (const name of KNOWN_MODULES) {
    const routesPath = path.join(modulesDir, name, 'routes.js');
    if (!fs.existsSync(routesPath)) {
      missing.push(name);
      logger.warn(
        `route registry: src/modules/${name}/routes.js not present — module not mounted ` +
          '(expected until its wave lands; build-plan §1)'
      );
      continue;
    }

    const mod = require(routesPath);
    const router = typeof mod === 'function' ? mod : mod && mod.router;
    if (typeof router !== 'function') {
      // A present-but-malformed module is a build error, not something to skip silently.
      throw new Error(
        `route registry: ${routesPath} must export an Express router or { basePath, router }`
      );
    }
    const basePath = (typeof mod === 'object' && mod !== null && mod.basePath) || `/api/${name}`;
    app.use(basePath, router);
    mounted.push({ name, basePath });
    logger.info(`route registry: mounted ${name} at ${basePath}`);
  }

  return { mounted, missing };
}

// ---- terminal 404/405 handling ----------------------------------------------------------------
//
// Express has no built-in 405: an unmatched request falls off the router regardless of
// whether the PATH is known under another method. This handler walks the app's real
// routing table, collects the methods actually registered for req.path, and:
//   - path known, method not registered  -> 405 + `Allow` header (RFC 9110 §15.5.6)
//   - path unknown                       -> 404
// Both are forwarded as coded errors to the shared error handler so every error leaves
// this API as JSON (NFR-08).

/** True when `method` is served by the collected method set (Express serves HEAD via GET). */
function methodAllowed(methods, method) {
  const m = method.toLowerCase();
  if (methods.has('_all') || methods.has('all')) return true;
  if (m === 'head' && methods.has('get')) return true;
  return methods.has(m);
}

/**
 * Walk an Express 4 router stack and collect every HTTP method registered for `pathname`.
 * Handles nested routers (the registry mounts one per module) by consuming the mount
 * prefix that the layer's own regexp matched, exactly as Express dispatch does.
 */
function collectAllowedMethods(stack, pathname, found = new Set()) {
  for (const layer of stack) {
    if (layer.route) {
      // Route layers carry an end-anchored regexp for the (remaining) path.
      if (layer.regexp && layer.regexp.test(pathname)) {
        for (const [method, on] of Object.entries(layer.route.methods)) {
          if (on) found.add(method);
        }
      }
    } else if (layer.name === 'router' && layer.handle && Array.isArray(layer.handle.stack)) {
      const match = layer.regexp && layer.regexp.exec(pathname);
      if (!match) continue;
      let rest = pathname.slice(match[0].length);
      if (rest === '') rest = '/';
      else if (!rest.startsWith('/')) rest = `/${rest}`;
      collectAllowedMethods(layer.handle.stack, rest, found);
    }
  }
  return found;
}

/** `Allow` header value for a collected method set (adds HEAD alongside GET, uppercase). */
function formatAllow(methods) {
  const out = new Set();
  for (const m of methods) {
    if (m === '_all' || m === 'all') continue;
    out.add(m.toUpperCase());
    if (m === 'get') out.add('HEAD');
  }
  return [...out].sort().join(', ');
}

/**
 * Build the terminal not-found / method-not-allowed middleware.
 * @param {{ buildError: (status: number, code: string, message: string) => Error }} deps
 *   `buildError` comes from src/app.js, which prefers the U1-OBS error taxonomy
 *   (src/lib/errors.js) when it is on disk.
 */
function notFoundHandler({ buildError }) {
  return function notFoundOrMethodNotAllowed(req, res, next) {
    const stack = (req.app && req.app._router && req.app._router.stack) || [];
    const methods = collectAllowedMethods(stack, req.path);
    if (methods.size > 0 && !methodAllowed(methods, req.method)) {
      res.set('Allow', formatAllow(methods));
      return next(buildError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed'));
    }
    return next(buildError(404, 'NOT_FOUND', 'Not found'));
  };
}

module.exports = { KNOWN_MODULES, mountModuleRoutes, notFoundHandler, collectAllowedMethods };
