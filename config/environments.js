// config/environments.js
//
// Single source of truth for base URLs / credentials, read from env vars
// (set them in .env, or pass with -e on the k6 command line).
//
// CONFIRMED against the real Symulate-ai V1.0 OpenAPI spec
// (api.symulate.weuno.co/dev/docs-json), extracted 2026-07-29.
// Every path in the spec is prefixed "/dev/api/..." — the previous
// API_URL was missing the "/api" segment, which is why every request in
// this suite was 404-ing before this fix.

export const ENV = __ENV.ENV || 'dev';

// FIXED: was 'https://api.symulate.weuno.co/dev' (missing /api).
// Every route in utils/routes.js is relative to this base, e.g.
// `${API_URL}/auth/login` -> https://api.symulate.weuno.co/dev/api/auth/login
export const API_URL = __ENV.API_URL || 'https://api.symulate.weuno.co/dev/api';

export const PORTALS = {
  superAdmin: __ENV.SUPER_ADMIN_URL || 'https://superadmin.symulate-dev.weuno.co',
  clientAdmin: __ENV.CLIENT_ADMIN_URL || 'https://client-admin.symulate-dev.weuno.co',
  candidate: __ENV.CANDIDATE_URL || 'https://symulate-ai-dev.weuno.co'
};

export const CREDENTIALS = {
  superAdmin: {
    email: __ENV.SUPER_ADMIN_EMAIL || 'superadmin@yopmail.com',
    password: __ENV.SUPER_ADMIN_PASSWORD || 'Test@123'
  }
};

// Toggle: run the flow WITH or WITHOUT the Talent Intelligence ("Anum")
// feature enabled on the org.
// CONFIRMED: this is NOT a separate endpoint — it's the boolean
// `enableTalentIntelligence` field on the Organization, set via 
// PATCH /organizations/{id} (UpdateOrganizationDto). See
// scenarios/clientcreation.js.
export const ANUM_API_ENABLED = String(__ENV.ANUM_API_ENABLED || 'true').toLowerCase() !== 'true';

// Which flow to execute:
// full            -> all 6 activity types, persona selection on every type that needs one
// situation-only  -> only the Situation activity type (no persona field)
export const SCENARIO = __ENV.SCENARIO || 'full';

// smoke -> 1 VU / few iterations, correctness-focused
// load  -> ramping VUs, performance-focused
export const LOAD_MODE = __ENV.LOAD_MODE || 'smoke';

export const NUM_CANDIDATES = Number(__ENV.NUM_CANDIDATES || 1);
export const SEND_PROJECT_INVITATIONS = String(__ENV.SEND_PROJECT_INVITATIONS || 'false').toLowerCase() !== 'false';
export const SEND_CLIENT_EMAIL = String(__ENV.SEND_CLIENT_EMAIL || 'true').toLowerCase() !== 'false';

// CONFIRMED gap (still open): POST /candidate/upload-candidates only
// returns { totalRows, queued, errors } — no per-candidate credentials or
// tokens. There is no candidate-impersonation endpoint in the spec either
// (POST /auth/impersonate-user takes an "Admin user ID" only). So candidate
// login (POST /auth/candidate/login, plain email+password, same as
// Super/Client Admin — NOT an access-token flow as originally assumed)
// still needs a real, known password per candidate.
// Until Backend confirms how QA/load-test candidates get a password
// (fixed seed password on create? invite-link token?), this suite logs
// in candidates with this placeholder. See README "Still open" section.
export const CANDIDATE_DEFAULT_PASSWORD = __ENV.CANDIDATE_DEFAULT_PASSWORD || 'Test@123';
export const CLIENT_ADMIN_DEFAULT_PASSWORD = __ENV.CLIENT_ADMIN_DEFAULT_PASSWORD || 'Test@123';

// Hardcoded candidates with known working credentials for assessment.
// Used instead of CSV-imported candidates (whose passwords are unknown).
// Add more entries here when scaling to load tests (7-8 candidates).
export const HARDCODED_CANDIDATES = [
  {
    email: __ENV.CANDIDATE_EMAIL || 'candidate001@yopmail.com',
    password: __ENV.CANDIDATE_PASSWORD || 'Test@123',
    candidateId: '84ffba92-1a8e-4dc4-b3c1-4ee04592c738'
  }
  // Add more candidates for load testing:
  // { email: 'performer2@yopmail.com', password: 'Test@123', candidateId: '0873bf73-1522-40d9-9bf9-1e354d2db5f9' },
  // { email: 'performer3@yopmail.com', password: 'Test@123', candidateId: 'dabd71cf-74f0-4796-b88e-b80708e5ee37' },
];

// Hardcoded project ID for candidate assessment (pre-existing project with
// activities already assigned to the hardcoded candidates above).
export const HARDCODED_PROJECT_ID =
  __ENV.HARDCODED_PROJECT_ID || 'beda7645-bd14-4142-9b26-65023db61cd8';
