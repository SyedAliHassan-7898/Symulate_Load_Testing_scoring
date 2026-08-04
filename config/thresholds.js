// config/thresholds.js
//
// Shared pass/fail budgets. Kept in one place so every scenario/test file
// fails the run consistently instead of each one inventing its own budget.
// Tune these once real-world baselines are known (see docs in README).

export const DEFAULT_THRESHOLDS = {
  http_req_failed: ['rate<0.01'],   // < 1% failed requests overall
  http_req_duration: ['p(95)<2000', 'p(99)<3500'],
  checks: ['rate>0.99']             // > 99% of check() assertions pass
};

// Per-step budgets — request duration is tagged with { name } in utils/http.js,
// so these apply per logical step rather than to the whole run at once.
export const STEP_THRESHOLDS = {
  'Login - Super Admin': ['p(95)<1500'],
  'Login - Client Admin': ['p(95)<1500'],
  'Login - Candidate (access token)': ['p(95)<1500'],
  'Create Client': ['p(95)<2000'],
  'Enable Intelligence (Anum)': ['p(95)<2500'],
  'Create Task': ['p(95)<2500'],
  'Assign Task': ['p(95)<2000'],
  'Create Project': ['p(95)<2000'],
  'Import Candidates (CSV)': ['p(95)<3000'],
  'Get Assigned Activities': ['p(95)<1500'],
  'Submit Activity': ['p(95)<3000'],
  'Submit Activity (Anum evaluation)': ['p(95)<5000']
};

export function buildThresholds(extra = {}) {
  const stepEntries = {};
  Object.keys(STEP_THRESHOLDS).forEach((name) => {
    stepEntries[`http_req_duration{name:${name}}`] = STEP_THRESHOLDS[name];
  });
  return { ...DEFAULT_THRESHOLDS, ...stepEntries, ...extra };
}

export default DEFAULT_THRESHOLDS;
