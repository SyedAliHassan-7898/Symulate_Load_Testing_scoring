// tests/smoke.js
//
// The full end-to-end flow, chained exactly as specified:
//   1. Super Admin login
//   2. Create Client (+ enableTalentIntelligence toggle when ANUM_API_ENABLED)
//   3. Create activities ("tasks"), with persona resolution (all 6 types,
//      or just Situation when SCENARIO=situation-only)
//   4. Assign created activities to the new org
//   5. Client Admin (via impersonation) creates Project + imports the 10
//      fixed candidates via CSV
//   6. Each candidate logs in (email/password)
//   7. Each candidate performs all assigned activities, one by one
//
//   LOAD_MODE=smoke (default) -> 1 VU, 1 iteration, fast correctness pass
//   LOAD_MODE=load            -> ramping VUs over time, see LOAD_VUS / LOAD_DURATION
//
// Combine with SCENARIO=full|situation-only and ANUM_API_ENABLED=true|false.
// See package.json for ready-made npm script combinations, and README.md
// for what each one means plus the still-open items from this pass.

import { sleep } from 'k6';
import exec from 'k6/execution';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

import { buildThresholds } from '../config/thresholds.js';
import { LOAD_MODE, SCENARIO, ANUM_API_ENABLED, HARDCODED_CANDIDATES } from '../config/environments.js';
import { reportName, log } from '../utils/helpers.js';

import { superAdminLogin, impersonateClientAdmin } from '../scenarios/login.js';
import { createClient } from '../scenarios/clientcreation.js';
import { createAllTaskTypes } from '../scenarios/taskcreation.js';
import { assignTasksToOrg } from '../scenarios/taskassign.js';
import { setupAccountAndSkillsProfile } from '../scenarios/accountsetup.js';
import { completeProjectCreationFlow } from '../scenarios/projectcreation.js';
import { performAllActivities, getActivitiesFromProject } from '../scenarios/candidateassessment.js';

const LOAD_VUS = Number(__ENV.LOAD_VUS || 10);
const LOAD_DURATION = __ENV.LOAD_DURATION || '2m';
const LOAD_RAMP_UP = __ENV.LOAD_RAMP_UP || '30s';
const LOAD_RAMP_DOWN = __ENV.LOAD_RAMP_DOWN || '30s';

export const options = {
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: buildThresholds(),
  scenarios:
    LOAD_MODE === 'load'
      ? {
          full_flow_load: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
              { duration: LOAD_RAMP_UP, target: LOAD_VUS },
              { duration: LOAD_DURATION, target: LOAD_VUS },
              { duration: LOAD_RAMP_DOWN, target: 0 }
            ],
            gracefulRampDown: '30s'
          }
        }
      : {
          full_flow_smoke: {
            executor: 'per-vu-iterations',
            vus: 1,
            iterations: 1,
            maxDuration: '5m'
          }
        }
};

export default function () {
  log('Flow', `Starting full flow — mode=${LOAD_MODE} scenario=${SCENARIO} anum=${ANUM_API_ENABLED}`);

  try {
    // 1. Super Admin login
    const superAdminToken = superAdminLogin();
    if (!superAdminToken) {
      log('Flow', 'ABORTED — super admin login failed, aborting entire test');
      exec.test.abort('super admin login failed');
      return; // unreachable, but keeps the flow explicit
    }

    // 2. Create Client (+ enableTalentIntelligence toggle when enabled)
    const { orgId, adminUserId } = createClient(superAdminToken);

    // 3. Create activities with persona resolution
    const activities = createAllTaskTypes(superAdminToken);

    // 4. Assign created activities to the new org
    assignTasksToOrg(superAdminToken, orgId, activities);

    // 5. Client Admin (via impersonation) creates Account + Skills Profile,
    // then creates Project + imports candidates.
    const clientToken = impersonateClientAdmin(superAdminToken, adminUserId);
    if (!clientToken) {
      log('Flow', 'Client Admin impersonation failed — aborting entire test');
      exec.test.abort('client admin impersonation failed');
      return; // unreachable, but keeps the flow explicit
    }
    const setup = setupAccountAndSkillsProfile(clientToken, orgId);
    const projectOrgId = setup.accountOrgId || orgId;
    const project = completeProjectCreationFlow(clientToken, projectOrgId, setup.roleProfileId, activities);

    // 6 & 7. Each hardcoded candidate logs in and performs all assigned
    // activities, one by one, sequentially — mirrors a real candidate
    // working through their assessment. Uses known credentials instead
    // of CSV-imported candidates (whose passwords are unknown).
    // Fetch activities dynamically from project details using admin token
    // (candidate token has kid header issue on assignedActivities endpoint).
    const candidateActivities = getActivitiesFromProject(clientToken, HARDCODED_CANDIDATES[0]?.candidateId);
    
    HARDCODED_CANDIDATES.forEach((candidate) => {
      if (!candidate.email) return;
      performAllActivities(candidate.email, candidate.password, candidate.candidateId, candidateActivities, projectOrgId);
    });

    sleep(1);
  } catch (err) {
    log('Flow', `UNEXPECTED ERROR — ${err.message || err}, sleeping before next iteration`);
    sleep(5); // prevent tight loop on unexpected errors
  }
}
// login canDIDATE via api 
// perform activity for this candidate

// Produces a self-contained HTML report + JSON summary on every run.
export function handleSummary(data) {
  const name = reportName('report', { SCENARIO, LOAD_MODE, ANUM_API_ENABLED });
  const csvBaseName = name.replace(/^report-/, 'symulate-report-');
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`reports/${name}.html`]: htmlReport(data),
    [`reports/${name}.json`]: JSON.stringify(data, null, 2),
    [`reports/${csvBaseName}-overview.csv`]: overviewCsv(data, name),
    [`reports/${csvBaseName}-summary.csv`]: summaryCsv(data),
    [`reports/${csvBaseName}-aggregate.csv`]: aggregateCsv(data),
    [`reports/${csvBaseName}-checks.csv`]: checksCsv(data)
  };
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  return `${rows.map((row) => row.map(csvEscape).join(',')).join('\r\n')}\r\n`;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function metricValue(metric, key, fallback = 0) {
  return metric && metric.values && Number.isFinite(metric.values[key]) ? metric.values[key] : fallback;
}

function extractRequestLabel(metricName) {
  const match = metricName.match(/^http_req_duration\{name:(.+)\}$/);
  return match ? match[1] : null;
}

function requestRows(data) {
  const metrics = data.metrics || {};
  const durationSeconds = Math.max(metricValue(metrics.iteration_duration, 'avg') / 1000, 1);
  const totalDataReceived = metricValue(metrics.data_received, 'count');
  const totalDataSent = metricValue(metrics.data_sent, 'count') || metricValue(metrics.sent_bytes, 'count');
  const globalRequests = metricValue(metrics.http_reqs, 'count') || 1;
  const globalFailures = metricValue(metrics.http_req_failed, 'rate');

  return Object.keys(metrics)
    .map((name) => ({ label: extractRequestLabel(name), metric: metrics[name] }))
    .filter((row) => row.label)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(({ label, metric }) => {
      const samples = Math.round(metricValue(metric, 'count', globalRequests));
      const share = samples / globalRequests;
      const throughput = samples / durationSeconds;
      const receivedKbSec = (totalDataReceived * share) / 1024 / durationSeconds;
      const sentKbSec = (totalDataSent * share) / 1024 / durationSeconds;
      const avgBytes = samples ? (totalDataReceived * share) / samples : 0;

      return {
        label,
        samples,
        average: round(metricValue(metric, 'avg')),
        median: round(metricValue(metric, 'med')),
        p90: round(metricValue(metric, 'p(90)')),
        p95: round(metricValue(metric, 'p(95)')),
        p99: round(metricValue(metric, 'p(99)')),
        min: round(metricValue(metric, 'min')),
        max: round(metricValue(metric, 'max')),
        errorRate: round(globalFailures * 100, 4),
        throughput: round(throughput, 5),
        receivedKbSec: round(receivedKbSec, 2),
        sentKbSec: round(sentKbSec, 2),
        avgBytes: round(avgBytes, 1)
      };
    });
}

function overviewCsv(data, sourceName) {
  const metrics = data.metrics || {};
  return toCsv([
    ['Metric', 'Value'],
    ['Report Type', 'Symulate Load Test Report'],
    ['Source JSON', `${sourceName}.json`],
    ['Generated At', new Date().toISOString()],
    ['Mode', LOAD_MODE],
    ['Scenario', SCENARIO],
    ['Anum Enabled', ANUM_API_ENABLED],
    ['Total Requests', metricValue(metrics.http_reqs, 'count')],
    ['Failed Request %', round(metricValue(metrics.http_req_failed, 'rate') * 100, 4)],
    ['Checks Passed %', round(metricValue(metrics.checks, 'rate') * 100, 2)],
    ['Iterations', metricValue(metrics.iterations, 'count')]
  ]);
}

function summaryCsv(data) {
  const rows = requestRows(data);
  return toCsv([
    ['Label', '# Samples', 'Average', 'Min', 'Max', 'Error %', 'Throughput', 'Received KB/sec', 'Sent KB/sec', 'Avg. Bytes'],
    ...rows.map((row) => [
      row.label,
      row.samples,
      row.average,
      row.min,
      row.max,
      row.errorRate,
      row.throughput,
      row.receivedKbSec,
      row.sentKbSec,
      row.avgBytes
    ])
  ]);
}

function aggregateCsv(data) {
  const rows = requestRows(data);
  return toCsv([
    ['Label', '# Samples', 'Average', 'Median', '90% Line', '95% Line', '99% Line', 'Min', 'Max', 'Error %', 'Throughput', 'Received KB/sec', 'Sent KB/sec'],
    ...rows.map((row) => [
      row.label,
      row.samples,
      row.average,
      row.median,
      row.p90,
      row.p95,
      row.p99,
      row.min,
      row.max,
      row.errorRate,
      row.throughput,
      row.receivedKbSec,
      row.sentKbSec
    ])
  ]);
}

function checksCsv(data) {
  const rows = [];

  function collectChecks(group, prefix = '') {
    const groupName = group.name && group.name !== '' ? `${prefix}${group.name}` : prefix;
    for (const check of group.checks || []) {
      const passes = check.passes || 0;
      const fails = check.fails || 0;
      rows.push([
        groupName || 'default',
        check.name,
        passes,
        fails,
        round((passes / Math.max(passes + fails, 1)) * 100, 2)
      ]);
    }
    for (const nested of group.groups || []) {
      collectChecks(nested, groupName ? `${groupName} / ` : '');
    }
  }

  collectChecks(data.root_group || {});
  return toCsv([['Group', 'Check', 'Passes', 'Fails', 'Pass %'], ...rows]);
}
