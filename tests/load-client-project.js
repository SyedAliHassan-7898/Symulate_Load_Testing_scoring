// tests/load-client-project.js
//
// Focused load entry point for the client/project setup phase:
// Super Admin login -> create client -> create activities -> assign
// activities -> impersonate client admin -> account/skills setup ->
// project creation/import.

import { sleep } from 'k6';
import { htmlReport } from '../utils/local-report.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

import { buildThresholds } from '../config/thresholds.js';
import { LOAD_MODE, SCENARIO, ANUM_API_ENABLED } from '../config/environments.js';
import { reportName, log } from '../utils/helpers.js';
import { superAdminLogin, impersonateClientAdmin } from '../scenarios/login.js';
import { createClient } from '../scenarios/clientcreation.js';
import { createAllTaskTypes } from '../scenarios/taskcreation.js';
import { assignTasksToOrg } from '../scenarios/taskassign.js';
import { setupAccountAndSkillsProfile } from '../scenarios/accountsetup.js';
import { completeProjectCreationFlow } from '../scenarios/projectcreation.js';

export const options = {
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: buildThresholds(),
  scenarios:
    LOAD_MODE === 'load'
      ? {
          client_project_load: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
              { duration: __ENV.LOAD_RAMP_UP || '30s', target: Number(__ENV.LOAD_VUS || 5) },
              { duration: __ENV.LOAD_DURATION || '2m', target: Number(__ENV.LOAD_VUS || 5) },
              { duration: __ENV.LOAD_RAMP_DOWN || '30s', target: 0 }
            ],
            gracefulRampDown: '5s',
            gracefulStop: '5s'
          }
        }
      : {
          client_project_smoke: {
            executor: 'per-vu-iterations',
            vus: 1,
            iterations: 1,
            maxDuration: '10m'
          }
        }
};

export default function () {
  log('Client Project Load', `Starting phase load — mode=${LOAD_MODE} scenario=${SCENARIO} anum=${ANUM_API_ENABLED}`);
  const superAdminToken = superAdminLogin();
  if (!superAdminToken) return;

  const { orgId, adminUserId } = createClient(superAdminToken);
  const activities = createAllTaskTypes(superAdminToken);
  assignTasksToOrg(superAdminToken, orgId, activities);

  const clientToken = impersonateClientAdmin(superAdminToken, adminUserId);
  if (!clientToken) return;

  const setup = setupAccountAndSkillsProfile(clientToken, orgId);
  const projectOrgId = setup.accountOrgId || orgId;
  completeProjectCreationFlow(clientToken, projectOrgId, setup.roleProfileId, activities);
  sleep(1);
}

export function handleSummary(data) {
  const name = reportName('client-project-report', { SCENARIO, LOAD_MODE, ANUM_API_ENABLED });
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`reports/${name}.html`]: htmlReport(data),
    [`reports/${name}.json`]: JSON.stringify(data, null, 2)
  };
}
