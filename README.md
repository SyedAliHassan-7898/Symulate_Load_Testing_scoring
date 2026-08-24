# Symulate k6 Load Testing Suite

Backend API load testing for the Symulate AI platform, built with [k6](https://k6.io).
It exercises the end-to-end backend flow across the Super Admin, Client Admin, and Candidate paths.

## What This Suite Runs

The main entry point is `tests/smoke.js`. It chains the flow exactly as the code does today:

1. Super Admin login
2. Create Client
3. Create activities
4. Assign activities to the organization
5. Client Admin impersonation
6. Create account / skills setup
7. Create project and import candidates
8. Candidate login
9. Candidate activity completion
10. Optional project review flow for the hardcoded project

The suite currently uses a hardcoded assessment candidate/project pair for the candidate and review paths. That means the README and scripts should be read as "run against the pre-provisioned assessment data plus the client/project setup created during the test," not as a fresh CSV-import-only flow.

## Repository Layout

```text
config/
  environments.js   # base URLs, credentials, scenario toggles, hardcoded assessment IDs
  thresholds.js     # global + per-step pass/fail budgets
scenarios/
  login.js          # Super Admin / Client Admin login + impersonation helpers
  clientcreation.js # Create Client and toggle Talent Intelligence
  taskcreation.js   # Create activities / tasks
  taskassign.js     # Assign activities to the org
  projectcreation.js# Create project and import candidates
  candidateassessment.js # Candidate login and sequential activity completion
  projectreview.js  # Client Admin review flow for the hardcoded project
tests/
  discover-login.js # fast login/API smoke check
  smoke.js          # main chained smoke/load entry point
utils/
  http.js           # request wrapper and token helpers
  routes.js         # endpoint paths
  helpers.js        # logging and report naming
reports/            # generated HTML, JSON, and CSV output
monitoring/         # optional Grafana + InfluxDB stack
```

## Install

```bash
npm install
```

You also need the `k6` binary installed separately.

Create a `.env` file from your own environment values before running the suite.

## Recommended Run Order

1. Run the login smoke check first:

```bash
npm run discover
```

2. Run the default smoke test:

```bash
npm run smoke
```

3. Move to load mode once the smoke run is stable:

```bash
npm run load
```

## Available Commands


| Command                                 | Purpose                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run discover`                      | Login-only smoke check for credentials and API URL                            |
| `npm run smoke`                         | Full flow, 1 VU, 1 iteration                                                  |
| `npm run smoke:no-anum`                 | Full flow without Talent Intelligence                                         |
| `npm run smoke:situation`               | Smoke flow using`SCENARIO=situation-only`                                     |
| `npm run smoke:situation:no-anum`       | Situation-only smoke flow without Talent Intelligence                         |
| `npm run load`                          | Ramping VU load run with Talent Intelligence enabled                          |
| `npm run load:no-anum`                  | Ramping VU load run without Talent Intelligence                               |
| `npm run load:situation`                | Ramping VU load run with`SCENARIO=situation-only`                             |
| `npm run load:situation:no-anum`        | Ramping VU load run with situation-only and no Talent Intelligence            |
| `npm run load:all`                      | Runs all four load combinations back to back                                  |
| `npm run load:csv`                      | Load run that also writes`reports/raw-metrics.csv`                            |
| `npm run load:client-project`           | Focused load on client creation, task creation, assignment, and project setup |
| `npm run load:client-project:situation` | Same client/project load, but with`SCENARIO=situation-only`                   |
| `npm run load:candidate`                | Focused load on candidate assessment execution                                |
| `npm run load:candidate:situation`      | Same candidate load, but with`SCENARIO=situation-only`                        |
| `npm run load:review`                   | Focused load on project review                                                |
| `npm run load:grafana`                  | Load run streamed to InfluxDB for Grafana                                     |
| `npm run smoke:grafana`                 | Smoke run streamed to InfluxDB for Grafana                                    |
| `npm run scenario:login`                | Run only the login scenario                                                   |
| `npm run scenario:client`               | Run only the client creation scenario                                         |
| `npm run scenario:task`                 | Run only the task creation scenario                                           |
| `npm run scenario:assign`               | Run only the task assignment scenario                                         |
| `npm run scenario:project`              | Run only the project creation scenario                                        |
| `npm run scenario:project:email`        | Run project creation with invitation emails enabled                           |

## Flow Details

### Smoke and Load Flow

`tests/smoke.js` uses these key environment toggles:

- `LOAD_MODE=smoke|load`
- `SCENARIO=full|situation-only`
- `ANUM_API_ENABLED=true|false`
- `LOAD_VUS`
- `LOAD_DURATION`
- `LOAD_RAMP_UP`
- `LOAD_RAMP_DOWN`

The flow is:

1. Super Admin logs in.
2. Client is created.
3. Activities are created.
4. Activities are assigned to the new org.
5. Client Admin is impersonated.
6. Account and skills setup runs.
7. Project creation runs.
8. The hardcoded candidate logs in and performs activities sequentially.
9. If candidate activity completion succeeds, the hardcoded project review flow can run.

### Project Review Flow

`scenarios/projectreview.js` is a standalone Client Admin review flow for the hardcoded project.

You can run it indirectly through the main flow or directly by wiring it into a script if needed for debugging. The review flow uses:

- `PROJECT_REVIEW_PROJECT_ID`
- `PROJECT_REVIEW_CANDIDATE_ID`
- `PROJECT_REVIEW_CANDIDATE_LIMIT`
- `PROJECT_REVIEW_REASON`
- `PROJECT_REVIEW_SCORE`

### Phase Load Runs

Use these when you want to isolate a single bottleneck:

- `npm run load:client-project` for client creation, task creation, assignment, and project setup
- `npm run load:client-project:situation` for the same phase mix, but only the Situation activity path
- `npm run load:candidate` for candidate execution against the hardcoded assessment project
- `npm run load:candidate:situation` for candidate execution with only the Situation activity path
- `npm run load:review` for client-admin review behavior

These are better when you want to answer "which phase is slow or failing?" instead of mixing all phases together in one run.

## Custom Load Next Time

If you want to choose your own load next time, use the phase runner that matches the bottleneck and override the shape with environment variables.

Examples:

```bash
# Client/project setup, 20 VUs, 5 minutes, full scenario
node scripts/run.js tests/load-client-project.js LOAD_MODE=load SCENARIO=full LOAD_VUS=20 LOAD_DURATION=5m
```

```bash
# Candidate execution, 50 VUs, situation-only
node scripts/run.js tests/load-candidate-assessment.js LOAD_MODE=load SCENARIO=situation-only LOAD_VUS=50 LOAD_DURATION=10m
```

```bash
# Project review, 10 VUs, full scenario, shorter ramp
node scripts/run.js tests/load-project-review.js LOAD_MODE=load SCENARIO=full LOAD_VUS=10 LOAD_RAMP_UP=15s LOAD_DURATION=3m LOAD_RAMP_DOWN=15s
```

Common knobs:

- `LOAD_MODE=smoke|load`
- `SCENARIO=full|situation-only`
- `ANUM_API_ENABLED=true|false`
- `LOAD_VUS=...`
- `LOAD_DURATION=...`
- `LOAD_RAMP_UP=...`
- `LOAD_RAMP_DOWN=...`

## Load Matrix

Use this as a practical starting point when you want to verify behavior under pressure.


| Phase                                      | Command                                 | Good starting load | What to watch                                                       |
| ------------------------------------------ | --------------------------------------- | ------------------ | ------------------------------------------------------------------- |
| Client / project setup                     | `npm run load:client-project`           | 5-10 VUs, 2-5m     | org creation, task creation, assignment, project setup, rate limits |
| Client / project setup with Situation only | `npm run load:client-project:situation` | 5-10 VUs, 2-5m     | same as above, but only the Situation path                          |
| Candidate assessment                       | `npm run load:candidate`                | 10-25 VUs, 5-10m   | login success, booking flow, transcript updates, submit latency     |
| Candidate assessment with Situation only   | `npm run load:candidate:situation`      | 10-25 VUs, 5-10m   | same as above, but only the Situation path                          |
| Project review                             | `npm run load:review`                   | 5-15 VUs, 2-5m     | review fetch, score PATCH calls, summary/report generation          |

How to use the matrix:

- Start with the lower end of the VU range.
- Increase VUs only after the previous run is stable.
- If one phase fails, isolate that phase instead of rerunning the full end-to-end flow.
- Keep `SCENARIO=full` for general verification and `SCENARIO=situation-only` when you want to stress the no-persona path specifically.

## Quick Presets

These are easy starting points if you just want to run something sensible fast.

### Low

```bash
node scripts/run.js tests/load-client-project.js LOAD_MODE=load SCENARIO=full LOAD_VUS=5 LOAD_DURATION=2m
```

```bash
node scripts/run.js tests/load-candidate-assessment.js LOAD_MODE=load SCENARIO=full LOAD_VUS=10 LOAD_DURATION=5m
```

```bash
node scripts/run.js tests/load-project-review.js LOAD_MODE=load SCENARIO=full LOAD_VUS=5 LOAD_DURATION=2m
```

### Medium

```bash
node scripts/run.js tests/load-client-project.js LOAD_MODE=load SCENARIO=full LOAD_VUS=10 LOAD_DURATION=5m
```

```bash
node scripts/run.js tests/load-candidate-assessment.js LOAD_MODE=load SCENARIO=full LOAD_VUS=25 LOAD_DURATION=10m
```

```bash
node scripts/run.js tests/load-project-review.js LOAD_MODE=load SCENARIO=full LOAD_VUS=10 LOAD_DURATION=5m
```

### High

```bash
node scripts/run.js tests/load-client-project.js LOAD_MODE=load SCENARIO=full LOAD_VUS=20 LOAD_DURATION=10m
```

```bash
node scripts/run.js tests/load-candidate-assessment.js LOAD_MODE=load SCENARIO=full LOAD_VUS=50 LOAD_DURATION=15m
```

```bash
node scripts/run.js tests/load-project-review.js LOAD_MODE=load SCENARIO=full LOAD_VUS=15 LOAD_DURATION=10m
```

## Before You Run

- Make sure `k6` is installed and available in your PATH.
- Make sure `.env` exists and has the correct API URL and credentials.
- Run `npm run discover` first if you changed credentials.
- Confirm whether you want `SCENARIO=full` or `SCENARIO=situation-only`.
- If you are testing Anum behavior, decide whether `ANUM_API_ENABLED=true` or `false`.
- Start with lower VUs first, then increase gradually.
- Check the generated report in `reports/` after each run.

## Environment Variables

Common values read from `.env` or `-e` overrides:

- `API_URL`
- `SUPER_ADMIN_EMAIL`
- `SUPER_ADMIN_PASSWORD`
- `CLIENT_ADMIN_EMAIL`
- `CLIENT_ADMIN_PASSWORD`
- `CANDIDATE_EMAIL`
- `CANDIDATE_PASSWORD`
- `ANUM_API_ENABLED`
- `SCENARIO`
- `LOAD_MODE`
- `LOAD_VUS`
- `LOAD_DURATION`
- `LOAD_RAMP_UP`
- `LOAD_RAMP_DOWN`
- `SEND_PROJECT_INVITATIONS`
- `SEND_CLIENT_EMAIL`

The current default API base is:

```text
https://api.symulate.weuno.co/dev/api
```

## Examples

Smoke without Talent Intelligence:

```bash
npm run smoke:no-anum
```

Situation-only load run:

```bash
npm run load:situation
```

Custom load shape:

```bash
cross-env LOAD_MODE=load LOAD_VUS=25 LOAD_DURATION=5m k6 run tests/smoke.js
```

Direct login discovery:

```bash
k6 run tests/discover-login.js
```

## Reports

Every `tests/smoke.js` run writes files into `reports/`:

- HTML report
- JSON summary
- CSV summaries for request-level stats and checks

The filenames are tagged with mode, scenario, and Anum state so runs do not overwrite each other.

## Live Monitoring

The `monitoring/` folder contains a Docker Compose stack for Grafana and InfluxDB.

Start it with:

```bash
npm run monitoring:up
```

Stop it with:

```bash
npm run monitoring:down
```

Reset stored metrics with:

```bash
npm run monitoring:reset
```

Then run one of the `load:grafana` or `smoke:grafana` commands to stream metrics into InfluxDB.

## Thresholds

Global and per-step thresholds live in `config/thresholds.js`.

If you change the flow shape, update the thresholds alongside it so the report stays meaningful.

## Notes

- The runner in `scripts/run.js` loads `.env` and forwards values to k6 as `-e` flags.
- The suite is tuned around the hardcoded assessment candidate/project data in `config/environments.js`.
- If you are adjusting credentials, candidate IDs, or review IDs, update the README and `config/environments.js` together so the docs stay accurate.
