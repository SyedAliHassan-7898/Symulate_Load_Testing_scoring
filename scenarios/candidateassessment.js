// scenarios/candidateassessment.js
// Steps 6 & 7: Candidate logs in and performs each assigned activity,
// one by one, sequentially.
//
// CHANGED vs. original assumption:
// - Candidate login is plain email/password (scenarios/login.js ->
//   candidateLogin()), NOT an access-token endpoint.
// - CONFIRMED real activity list endpoint: GET /activities/assigned-activities
//   (no projectId param in the spec — it's scoped to the authenticated
//   candidate's token).
//
// SUPERSEDED (kept only as history): earlier notes here assumed a plain
// REST submission (POST /sessions -> GET /stimuli/activity/{id} -> POST
// /responses). A real HAR capture (symulate-ai-dev_weuno_co.har) shows
// that's not how it actually works. The real flow per activity is:
//   1. POST session-token (or the board-meeting/contact variants)  -> sessionId
//   2. Client opens a Socket.IO connection, joins a room keyed by
//      activityId, and streams "text-line" events (role: persona/user) as
//      the Anam voice conversation happens. Server persists these into a
//      transcript row and echoes "transcript-updated"/"transcribed-line".
//      SITUATIONS sends a single "audio-line" event instead (no persona
//      dialogue — one video prompt, one recorded response).
//   3. PATCH candidate-activity/update-status -> COMPLETED
// The actual voice/AI turn generation happens inside Anam's WebRTC engine,
// which k6 cannot join (no media stack available to a load-testing tool).
// What THIS suite was missing — and what was almost certainly producing
// the null performance scores — is step 2 entirely: it went straight from
// session-token to COMPLETED with zero transcript content, so Anum had
// nothing to score. utils/socketConversation.js now drives that same
// Socket.IO path with realistic canned dialogue (data/conversationScripts.js)
// so a load run exercises the real transcript-persistence path instead of
// skipping it. See utils/socketConversation.js for the "confirm with
// Backend" caveat on whether Anum reads this same record regardless of
// how it was populated.

import { check, sleep } from 'k6';
import { getJson, postJson, patchJson, extractId } from '../utils/http.js';
import { log, logStep } from '../utils/helpers.js';
import { routes } from '../utils/routes.js';
import { candidateLogin } from './login.js';
import { runTranscriptConversation } from '../utils/socketConversation.js';
import { buildConversationTurns, buildSituationTurn } from '../data/conversationScripts.js';
import { ANUM_API_ENABLED, HARDCODED_PROJECT_ID, API_URL } from '../config/environments.js';

export function getAssignedActivities(candidateToken, candidateId, organizationId) {
  const res = getJson(
    routes.assignedActivities(HARDCODED_PROJECT_ID, organizationId),
    candidateToken,
    'Get Assigned Activities'
  );
  logStep('Get Assigned Activities', res);
  check(res, { 'get assigned activities: status 2xx': (r) => r.status >= 200 && r.status < 300 });

  try {
    const body = res.json();
    const project = body && body.data;
    if (!project) return [];

    // Response structure: { data: { stages: [{ stageActivities: [{ activity: {...}, activityId, ... }] }] } }
    const activities = [];
    const stages = project.stages || [];
    stages.forEach((stage) => {
      const stageActivities = stage.stageActivities || [];
      stageActivities.forEach((sa) => {
        const activity = sa.activity || {};
        activities.push({
          id: activity.id || sa.activityId,
          title: activity.title || activity.type,
          type: activity.type || sa.type,
          stageId: stage.id,
          candidateId
        });
      });
    });
    return activities;
  } catch (e) {
    return [];
  }
}

// Get activities from project details using admin token (fallback when candidate token fails)
export function getActivitiesFromProject(adminToken, candidateId) {
  const res = getJson(
    routes.projectById(HARDCODED_PROJECT_ID),
    adminToken,
    'Get Project Details (Activities)'
  );
  logStep('Get Project Details (Activities)', res);
  check(res, { 'get project details: status 2xx': (r) => r.status >= 200 && r.status < 300 });

  try {
    const body = res.json();
    const project = body && body.data;
    if (!project) return [];

    // Response structure: { data: { stages: [{ stageActivities: [{ activity: {...}, activityId, ... }] }] } }
    const activities = [];
    const stages = project.stages || [];
    stages.forEach((stage) => {
      const stageActivities = stage.stageActivities || [];
      stageActivities.forEach((sa) => {
        const activity = sa.activity || {};
        activities.push({
          id: activity.id || sa.activityId,
          title: activity.title || activity.type,
          type: activity.type || sa.type,
          stageId: stage.id,
          candidateId
        });
      });
    });
    return activities;
  } catch (e) {
    return [];
  }
}

export function getHardcodedProjectCandidateId(adminToken, email, projectId = HARDCODED_PROJECT_ID) {
  const res = getJson(routes.projectCandidates(projectId), adminToken, 'Get Hardcoded Project Candidates');
  logStep('Get Hardcoded Project Candidates', res);

  try {
    const body = res.json();
    const data = body && body.data;
    const candidates =
      (data && (data.candidates || data.projectCandidates || data.items || data.rows || data.results || data.data)) ||
      body.candidates || body.projectCandidates || body.items || body.rows || body.results || [];
    const target = (Array.isArray(candidates) ? candidates : []).find((item) => {
      const candidate = item && (item.candidate || item.user || item.profile || item);
      return candidate && String(candidate.email || '').toLowerCase() === String(email || '').toLowerCase();
    });
    const candidate = target && (target.candidate || target.user || target.profile || target);
    const resolvedId = target && (target.candidateId || target.userId || (candidate && (candidate.candidateId || candidate.id))) || null;
    return resolvedId;
  } catch (e) {
    return null;
  }
}

// Accept agreement on behalf of candidate (mirrors clicking "I Agree" in the UI)
export function acceptCandidateAgreement(candidateToken, candidateId, projectId = HARDCODED_PROJECT_ID) {
  const res = patchJson(
    routes.acceptAgreement(candidateId, projectId),
    { isAgreementPolicyAccepted: true },
    candidateToken,
    'Accept Candidate Agreement'
  );
  logStep('Accept Candidate Agreement', res);
  check(res, { 'accept agreement: status 2xx': (r) => r.status >= 200 && r.status < 300 });
  return res.status >= 200 && res.status < 300;
}

export function submitActivity(candidateToken, candidateId, activity, candidateName = 'Candidate') {
  const activityId = activity.id;
  const label = activity.title || activity.type || 'Unknown';
  const stepName = ANUM_API_ENABLED ? 'Submit Activity (Anum evaluation)' : 'Submit Activity';

  // DEBUG: log values being sent to API
  log('SubmitActivity', `projectId=${HARDCODED_PROJECT_ID} activityId=${activityId} candidateId=${candidateId} type=${activity.type}`);

  // ------------------------------------------------------------------
  // Step 1: Start session (endpoint varies by activity type)
  // ------------------------------------------------------------------
  let sessionRes;
  let personaId = null;
  
  function startSessionRequest() {
    if (activity.type === 'BOARD_MEETING') {
      personaId = activity.boardMeetingActivity?.id || '30d457a4-5ef1-41ae-bb58-a144d48c0a00';
      return postJson(
        routes.startBoardMeetingSession(activityId, personaId, HARDCODED_PROJECT_ID),
        {},
        candidateToken,
        stepName
      );
    } else {
      return postJson(
        routes.startSession(),
        { projectId: HARDCODED_PROJECT_ID, activityId },
        candidateToken,
        stepName
      );
    }
  }

  sessionRes = startSessionRequest();
  
  // Handle 409 Conflict - active session from previous run
  if (sessionRes.status === 409) {
    try {
      const errorBody = sessionRes.json();
      const activeSessionId = errorBody?.details?.activeSession?.sessionId;
      if (activeSessionId) {
        log('SubmitActivity', `Ending active session ${activeSessionId} from previous run`);
        const completeRes = postJson(routes.completeSession(activeSessionId), {}, candidateToken, 'Complete Stale Session');
        logStep('Complete Stale Session', completeRes);
        sleep(1);
        sessionRes = startSessionRequest(); // Retry
      }
    } catch (e) {
      log('SubmitActivity', `Failed to handle 409: ${e}`);
    }
  }
  
  logStep(`${stepName} - start session (${label})`, sessionRes);
  const sessionId = extractId(sessionRes, 'sessionId');
  check(sessionRes, { [`start session (${label}): status 2xx`]: (r) => r.status >= 200 && r.status < 300 });

  // ------------------------------------------------------------------
  // Step 2: Drive the real transcript-persistence channel (Socket.IO).
  // This is the piece that was missing before — without it, Anum has no
  // transcript content and the performance score comes back null. See the
  // header comment above and utils/socketConversation.js for what this
  // does and doesn't replicate (canned dialogue over the real persistence
  // path, not real speech/AI generation — that part lives inside Anam's
  // WebRTC engine and is out of reach for a load-testing tool).
  // ------------------------------------------------------------------
  let transcriptResult = { transcriptConfirmed: false, linesAcked: 0 };
  if (sessionId) {
    const seed = (__VU || 0) + (__ITER || 0);
    if (activity.type === 'SITUATIONS') {
      let situationId = null;
      const detailsUrl = `${API_URL}/activities/${activityId}?projectId=${HARDCODED_PROJECT_ID}&stageId=${activity.stageId}`;
      const detailsRes = getJson(detailsUrl, candidateToken, 'Get Activity Details');
      logStep(`${stepName} - get details (${label})`, detailsRes);
      if (detailsRes.status === 200) {
        try {
          const body = detailsRes.json();
          log('Flow', `SITUATIONS activity details response: ${JSON.stringify(body)}`);
          const situations = body && body.data && body.data.situations;
          if (situations && situations.length > 0) {
            situationId = situations[0].id;
          }
        } catch (e) {
          log('Flow', `Error parsing activity details: ${e}`);
        }
      }
      log('Flow', `Parsed situationId: ${situationId}`);
      if (!situationId) {
        log('Flow', `Warning: Could not fetch situationId, falling back to default`);
        situationId = '4c1418d8-391e-4a3f-8cf9-1607c015629e';
      }

      const turn = buildSituationTurn(label, candidateName, seed);
      transcriptResult = runTranscriptConversation({
        candidateToken,
        activityId,
        sessionId,
        conversationId: personaId,
        situationId,
        turns: [turn],
        eventName: 'audio-line',
        stepLabel: `${stepName} - transcript (${label})`
      });
    } else {
      const turns = buildConversationTurns(activity.type, label, candidateName, seed);
      transcriptResult = runTranscriptConversation({
        candidateToken,
        activityId,
        sessionId,
        conversationId: personaId,
        turns,
        eventName: 'text-line',
        stepLabel: `${stepName} - transcript (${label})`
      });
    }
    if (!transcriptResult.transcriptConfirmed) {
      log('Flow', `WARNING: no transcript-updated ack for ${label} (${activityId}) — this activity will likely score null`);
    }
  } else {
    log('Flow', `WARNING: no sessionId for ${label} — skipping transcript, activity will score null`);
  }

  // Small pause mirrors a real candidate moving between tasks after the
  // conversation ends.
  sleep(1);

  // ------------------------------------------------------------------
  // Step 3: Mark activity as COMPLETED (same endpoint for all types)
  // ------------------------------------------------------------------
  const endedAt = new Date().toISOString();
  const completeRes = patchJson(
    routes.updateActivityStatus(activityId),
    { status: 'COMPLETED', projectId: HARDCODED_PROJECT_ID, endedAt },
    candidateToken,
    stepName
  );
  logStep(`${stepName} - complete activity (${label})`, completeRes);
  check(completeRes, { [`complete activity (${label}): status 2xx`]: (r) => r.status >= 200 && r.status < 300 });

  return {
    status: completeRes.status,
    skipped: false,
    transcriptConfirmed: transcriptResult.transcriptConfirmed,
    linesAcked: transcriptResult.linesAcked
  };
}

// Runs every assigned activity for one candidate, strictly one after
// another (not in parallel).
// Activities are passed in (fetched dynamically from project details).
// organizationId is needed for the assignedActivities endpoint.
// All activity types are processed: CASE, WELCOME, SITUATIONS, ROLE_PLAY, INTERVIEW, BOARD_MEETING
export function performAllActivities(email, password, candidateId, activities, organizationId) {
  log('Flow', `Candidate login: ${email} candidateId=${candidateId} orgId=${organizationId}`);
  const loginResult = candidateLogin(email, password);
  const candidateToken = loginResult && loginResult.token;
  if (!candidateToken) {
    log('Flow', `Candidate login FAILED for ${email} — no token returned`);
    return [];
  }
  log('Flow', `Candidate login SUCCESS for ${email} — orgId from login: ${loginResult.organizationId}`);

  // Use organizationId from login response if available, otherwise use the one passed in
  const orgId = loginResult.organizationId || organizationId;

  // Real HAR capture shows the frontend sends the candidate's short handle
  // (e.g. "performer8") as the `name` field on every user text-line, not
  // their full email — derive the same thing from the email prefix.
  const candidateName = (email || 'candidate').split('@')[0];

  // Accept agreement first (mirrors the candidate clicking "I Agree" in the UI)
  acceptCandidateAgreement(candidateToken, candidateId);

  log('Flow', `Processing all ${activities.length} activities`);

  const results = [];

  activities.forEach((activity) => {
    log('Flow', `Starting activity: ${activity.title} (${activity.type})`);
    const res = submitActivity(candidateToken, candidateId, activity, candidateName);
    results.push({
      activity: activity.title || activity.type,
      status: res.status,
      transcriptConfirmed: res.transcriptConfirmed || false
    });
    sleep(1); // mirrors a real candidate moving between tasks
  });

  return results;
}

// Standalone-runnable smoke check only: `k6 run scenarios/candidateassessment.js`
// (needs CANDIDATE_EMAIL + CANDIDATE_PASSWORD env vars)
export default function () {
  const email = __ENV.CANDIDATE_EMAIL;
  const password = __ENV.CANDIDATE_PASSWORD;
  const organizationId = __ENV.CANDIDATE_ORG_ID;
  if (!email || !password) {
    console.error('Standalone run needs -e CANDIDATE_EMAIL=... -e CANDIDATE_PASSWORD=...');
    return;
  }
  if (!organizationId) {
    console.error('Standalone run needs -e CANDIDATE_ORG_ID=... (candidate organization ID)');
    return;
  }
  // For standalone run, try to get activities via candidate token
  const loginResult = candidateLogin(email, password);
  const candidateToken = loginResult && loginResult.token;
  if (!candidateToken) return;
  const orgId = loginResult.organizationId || organizationId;
  acceptCandidateAgreement(candidateToken, 'standalone-candidate');
  const activities = getAssignedActivities(candidateToken, 'standalone-candidate', orgId);
  performAllActivities(email, password, 'standalone-candidate', activities, orgId);
}