// client/vitest.setup.js — shared vitest setup for the client package (U5-SHELL toolchain).
// Loads the jest-dom matchers (accessible-name/role assertions the NFR-07-oriented specs use)
// and unmounts between tests. Referenced from vite.config.js `test.setupFiles`.
//
// AbortController interop shim (test environment only — measured on this tree, vitest 2 +
// jsdom 24 + Node undici): vitest's jsdom environment shadows Node's native AbortController /
// AbortSignal with jsdom's webidl2js implementations on globalThis, while `Request` stays
// Node's undici class. react-router's data router constructs `new Request(..., { signal })`
// on EVERY navigation, and undici brand-checks the signal against the NATIVE AbortSignal —
// so every `router.navigate()` in a spec would throw
//   "RequestInit: Expected signal (…) to be an instance of AbortSignal".
// `node:util.transferableAbortController()` returns a genuine native instance even when the
// globals are shadowed, so we restore the native classes from its constructor. This changes
// NOTHING about shipped behaviour (a real browser has one consistent realm); it only makes
// the test realm as consistent as the browser one. It disables NO TLS or security check.
import { transferableAbortController } from 'node:util';
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

const nativeController = transferableAbortController();
globalThis.AbortController = nativeController.constructor;
globalThis.AbortSignal = nativeController.signal.constructor;

afterEach(() => {
  cleanup();
});
