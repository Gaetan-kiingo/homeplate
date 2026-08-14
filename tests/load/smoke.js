// tests/load/smoke.js — k6 entry point (SRS §4: LT-01/LT-02; NFR-01, NFR-02).
// Runs under the k6 runtime (`npm run test:load`), NOT under Jest/Node — excluded from
// jest.config.js testPathIgnorePatterns and from the node --check walk in check-build.js.
//
// Meaningful load numbers require the wave-3 read paths (browse/search); until then this is
// a smoke shape against the health endpoint. LT runs that cannot reach the NFR-01 target of
// 200 VUs are reported as untestable-at-level, never as a pass (build-plan §8.12).
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: Number(__ENV.VUS || 5),
  duration: __ENV.DURATION || '30s',
  // Local dev cert is self-signed (scripts/gen-dev-certs.sh).
  insecureSkipTLSVerify: true,
  thresholds: {
    // NFR-01: p95 < 500ms for core operations. The health probe must clear it trivially.
    http_req_duration: ['p(95)<500'],
    checks: ['rate>0.99'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'https://localhost:3000';

export default function () {
  const res = http.get(`${BASE_URL}/health`);
  check(res, { 'health responds 200': (r) => r.status === 200 });
  sleep(1);
}
