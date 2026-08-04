# Symulate k6 Load Testing Suite

Backend REST API load testing for the Symulate AI platform, built with
[k6](https://k6.io). It exercises the **real end-to-end flow** across all
three portals (Super Admin, Client Admin, Candidate) directly against the
API — not the UI — so it measures actual backend performance under load.

## Structure

```
config/
  environments.js   # base URLs, credentials, SCENARIO / ANUM_API_ENABLED / LOAD_MODE toggles
  thresholds.js      # pass/fail budgets, global + per-step
data/
  candidates.csv      # 10 fixed candidates, used every run for repeatability
  personas.js           # preferred persona names -> resolved to real personaIds at runtime
  taskTemplates.js        # payload builders for all 6 activity types (2-step: initial + detail)
scenarios/             # one file per flow step, each independently runnable
  login.js               # Super Admin / Client Admin / Candidate login + impersonation
  clientcreation.js       # Create Client (+ Talent Intelligence toggle)
  taskcreation.js          # Create Activities, with persona resolution
  taskassign.js             # Assign activities to the org
  projectcreation.js         # Client Admin (impersonated): Create Project + CSV candidate import
  candidateassessment.js      # Candidate: login + sequential session/response activities
tests/
  discover-login.js    # quick credential/API_URL smoke check
  smoke.js               # THE main entry point — full chained flow, smoke or load mode
utils/
  http.js       # request wrapper: headers, per-step metric tags, byte counters
  routes.js      # every confirmed real endpoint, with CONFIRM/BEST-EFFORT notes inline
  data.js         # CSV loader (SharedArray + papaparse)
  helpers.js       # logging, unique-suffix, report-name helpers
assets/
  task-thumbnail.jpg   # sample task banner image, reused from the Playwright suite
monitoring/             # Grafana + InfluxDB live monitoring stack (see below)
reports/                # every run's HTML + JSON report lands here (gitignored)
```

## Install

```bash
npm install                 # installs cross-env only — k6 itself is a separate binary
# k6 binary: https://k6.io/docs/get-started/installation/
cp .env.example .env         # then fill in real values
```

## Running

| Command                                                                 | What it does                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `npm run discover`                                                      | Login-only smoke check — confirms credentials/API_URL work         |
| `npm run smoke`                                                         | Full flow, 1 VU, 1 iteration, with Anum, all 6 activity types       |
| `npm run smoke:no-anum`                                                 | Same, Anum submission steps skipped                                 |
| `npm run smoke:situation`                                               | Same, only Situation activity type assigned to project              |
| `npm run smoke:situation:no-anum`                                       | Situation-only + no Anum                                            |
| `npm run load`                                                          | Ramping-VU load test, with Anum, full flow                          |
| `npm run load:no-anum`                                                  | Ramping-VU load test, without Anum                                  |
| `npm run load:situation`                                                | Ramping-VU load test, situation-only                                |
| `npm run load:situation:no-anum`                                        | Ramping-VU load test, situation-only + no Anum                      |
| `npm run load:all`                                                      | Runs all four load combinations back to back                        |
| `npm run load:csv`                                                      | Load test + raw per-request metrics CSV (`reports/raw-metrics.csv`) |
| `npm run load:grafana`                                                  | Load test + live-streams metrics to Grafana (see below)             |
| `npm run scenario:login` / `:client` / `:task` / `:assign` / `:project` | Run one step in isolation, for debugging                            |

### Standalone Candidate Assessment (Avoid Rate Limits)

To test candidate evaluation directly without creating a client, project, or candidate (which can trigger HTTP 429 rate limit blockages), run the assessment scenario standalone using a pre-existing candidate:

```bash
k6 run -e CANDIDATE_EMAIL=performer19@yopmail.com -e CANDIDATE_PASSWORD=Test@123 -e CANDIDATE_ORG_ID=dummy scenarios/candidateassessment.js
```

Load shape is configurable via env vars (`.env` or `-e` flags):
`LOAD_VUS` (default 10), `LOAD_DURATION` (default 2m), `LOAD_RAMP_UP` /
`LOAD_RAMP_DOWN` (default 30s each).

Example — 25 VUs for 5 minutes, without Anum:

```bash
cross-env LOAD_MODE=load LOAD_VUS=25 LOAD_DURATION=5m ANUM_API_ENABLED=false k6 run tests/smoke.js
```

## The flow, exactly as chained in `tests/smoke.js`

1. **Super Admin login**
2. **Create Client** (org) — Talent Intelligence toggled on via
   `PATCH /organizations/{id}` when `ANUM_API_ENABLED=true`
3. **Create activities**, with persona resolution where applicable
   - `SCENARIO=full` (default): all 6 types — Role Play, Interview,
     Case Exercise, Situation, Board Meeting, Welcome
   - `SCENARIO=situation-only`: only Situation — the one type with **no**
     persona field, isolating that no-persona path
4. **Assign activities to the org**
5. **Client Admin (via impersonation) creates Project**, imports the
   **20 candidates** from `data/candidates.csv` with a `0.5s` delay between requests to avoid rate limits
6. **Each candidate logs in** with email + `CANDIDATE_DEFAULT_PASSWORD`
7. **Each candidate performs all assigned activities, one by one, sequentially** — never in parallel, mirroring a real candidate session

### WebSocket Transcription (SITUATIONS vs Standard)
- **Standard Activities (Role Play, Interview, Board Meeting, etc.)**: Stream multiple sequential turns over WebSocket via `'text-line'` events containing the candidate/persona responses.
- **SITUATIONS Activities (Supply Chain Bottleneck Analysis)**: Send a single `'audio-line'` event containing the situation ID, candidate ID, session details, and a base64-encoded WebM audio payload in the `line` field (loaded from `utils/webmAudio.js`). The connection stays open for up to 5 seconds to wait for the backend's `'transcript-updated'` confirmation before disconnecting.

## Live Grafana Monitoring

The `monitoring/` folder is a self-contained Docker Compose stack:
**InfluxDB** (k6 writes to it natively — no extension/build of k6 needed)

+ **Grafana**, pre-provisioned with the InfluxDB datasource and a
  dashboard built for this suite's tagged metrics.

**Setup (one-time):**

```bash
cd monitoring
docker compose up -d
```

- Grafana: http://localhost:3001 (anonymous viewer access is enabled for
  convenience — lock this down before using outside a local/dev machine)
- InfluxDB: http://localhost:8087 (database `k6`, no auth in this dev setup)

**Run a load test with live streaming** (from the project root, a separate
terminal, stack already up):

```bash
npm run load:grafana
# or: npm run load:grafana:no-anum / load:grafana:situation
```

Open Grafana → **k6 Load Testing** folder → **"Symulate k6 Load Test - Live
Monitoring"**. It auto-refreshes every 5s while the test runs and shows:

- Virtual Users (VUs) over time
- Requests/sec
- Response time p95/p99 (overall)
- Error rate (%)
- **p95 response time broken down by step** (Login, Create Client, Create
  Task, Submit Activity, etc. — same step names used in the HTML report
  and in `config/thresholds.js -> STEP_THRESHOLDS`)
- Checks pass rate (%)
- Data received/sent by step
- Run totals (requests, failures, iterations)

Stop the stack when done: `docker compose down` (add `-v` to also wipe
stored metrics: `docker compose down -v`, or `npm run monitoring:reset`).

## Reports

Every `tests/smoke.js` run (smoke or load) writes, with no extra setup:

- `reports/report-<mode>-<scenario>-<anum-tag>-<timestamp>.html` — open
  directly in a browser, works fully offline, full per-step breakdown
- `reports/report-<mode>-<scenario>-<anum-tag>-<timestamp>.json` — full
  machine-readable k6 summary
- `reports/raw-metrics.csv` — only with `npm run load:csv`, every raw
  per-request sample (for building your own with/without-Anum comparison
  charts)

Comparing **with vs without Anum**: run `npm run load` then
`npm run load:no-anum` and open both HTML reports side by side — request
names are tagged consistently (`Create Client`, `Submit Activity` vs
`Submit Activity (Anum evaluation)`, etc.) so the per-step breakdown lines
up directly. The same comparison is live in Grafana if both runs use
`npm run load:grafana` / `load:grafana:no-anum` — use the time picker to
overlay or step between the two runs' time windows.

## Thresholds

Global (`config/thresholds.js -> DEFAULT_THRESHOLDS`): < 1% failed
requests, p95 < 2000ms, p99 < 3500ms, > 99% checks passing. Per-step
budgets (`STEP_THRESHOLDS`) are looser for heavier steps (task creation,
Anum-backed submission). Tune both once a couple of real runs establish
your actual baseline.
