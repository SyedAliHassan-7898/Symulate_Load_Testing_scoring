// tests/load-project-review.js
//
// Focused load entry point for the client-admin review phase.

import { sleep } from 'k6';
import { htmlReport } from '../utils/local-report.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

import { buildThresholds } from '../config/thresholds.js';
import { LOAD_MODE, SCENARIO, ANUM_API_ENABLED } from '../config/environments.js';
import { reportName, log } from '../utils/helpers.js';
import { projectReviewLogin, completeHardcodedProjectReviewFlow } from '../scenarios/projectreview.js';

const LOAD_VUS = Number(__ENV.LOAD_VUS || 5);
const LOAD_DURATION = __ENV.LOAD_DURATION || '2m';
const LOAD_RAMP_UP = __ENV.LOAD_RAMP_UP || '30s';
const LOAD_RAMP_DOWN = __ENV.LOAD_RAMP_DOWN || '30s';

export const options = {
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: buildThresholds(),
  scenarios:
    LOAD_MODE === 'load'
      ? {
          project_review_load: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
              { duration: LOAD_RAMP_UP, target: LOAD_VUS },
              { duration: LOAD_DURATION, target: LOAD_VUS },
              { duration: LOAD_RAMP_DOWN, target: 0 }
            ],
            gracefulRampDown: '5s',
            gracefulStop: '5s'
          }
        }
      : {
          project_review_smoke: {
            executor: 'per-vu-iterations',
            vus: 1,
            iterations: 1,
            maxDuration: '10m'
          }
        }
};

export default function () {
  log('Project Review Load', `Starting phase load — mode=${LOAD_MODE} scenario=${SCENARIO} anum=${ANUM_API_ENABLED}`);
  const token = projectReviewLogin();
  if (!token) return;
  completeHardcodedProjectReviewFlow(token);
  sleep(1);
}

export function handleSummary(data) {
  const name = reportName('project-review-report', { SCENARIO, LOAD_MODE, ANUM_API_ENABLED });
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`reports/${name}.html`]: htmlReport(data),
    [`reports/${name}.json`]: JSON.stringify(data, null, 2)
  };
}
