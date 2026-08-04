// tests/discover-login.js
//
// login()/extractToken() are now CONFIRMED against the real Swagger
// contract (POST /dev/api/auth/login, LoginDto -> LoginResponseDto with
// accessToken nested under `data`). Keep this script around as a fast
// smoke check that your .env credentials/API_URL still work before a real
// run — it's no longer strictly required for path discovery.
//
// Usage:
//   k6 run tests/discover-login.js
//   k6 run -e API_URL=https://api.symulate.weuno.co/dev/api tests/discover-login.js
//
// 1 VU, 1 iteration — this is a discovery/diagnostic script, not a load test.

import { postJson } from '../utils/http.js';
import { routes } from '../utils/routes.js';
import { CREDENTIALS } from '../config/environments.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {} // no pass/fail gate — this script is for discovery only
};

export default function () {
  const url = routes.login();
  const payload = { email: CREDENTIALS.superAdmin.email, password: CREDENTIALS.superAdmin.password };

  console.log(`--- POST ${url} ---`);
  console.log(`Request body: ${JSON.stringify(payload)}`);

  const res = postJson(url, payload, null, 'Login - Super Admin (discover)');

  console.log(`Status: ${res.status}`);
  console.log(`Response headers: ${JSON.stringify(res.headers)}`);
  console.log(`Response body: ${res.body}`);

  if (res.status >= 400) {
    console.log('');
    console.log('Login FAILED. Things to check against Swagger:');
    console.log('  1. Is /auth/login the real path? (utils/routes.js -> login())');
    console.log('  2. Does the API expect { email, password } or different field names?');
    console.log('  3. Does it need an extra header (e.g. x-api-key, tenant id)?');
  } else {
    console.log('');
    console.log('Login succeeded. Confirm the token field name above matches');
    console.log('utils/http.js -> extractToken() (currently checks token / accessToken / access_token).');
  }
}
