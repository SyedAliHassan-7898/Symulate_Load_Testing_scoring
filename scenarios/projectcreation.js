// scenarios/projectcreation.js
// Step 5: Client Admin creates a Project and imports the 10 fixed
// candidates via CSV.
//
// CHANGED vs. original assumption:
// - CONFIRMED endpoint: POST /project/create-project/{orgId}, body
//   { title, description } — NOT POST /projects with { projectName, clientName }.
// - CONFIRMED endpoint: POST /candidate/upload-candidates?projectId={id},
//   multipart field "file".
// - STILL OPEN (see README): the real response
//   (UploadCandidateCsvResponseDto) is only { totalRows, queued, errors } —
//   there is NO per-candidate credential/token in it. So this suite can't
//   pull working candidate logins out of the import response like the
//   previous version assumed. Candidates are logged in afterwards with
//   CANDIDATE_DEFAULT_PASSWORD (config/environments.js) using the same
//   emails from data/candidates.csv — this only works once Backend
//   confirms candidates are actually created with that password (or gives
//   us an equivalent to impersonateClientAdmin() for candidates).
// - Uses impersonateClientAdmin() (scenarios/login.js) instead of a plain
//   password login, since the admin's real password is only known via an
//   activation email this suite can't read.

import http from 'k6/http';
import { check } from 'k6';
import { sleep } from 'k6';
import { getJson, postJson, postMultipart, extractId } from '../utils/http.js';
import { logStep, uniqueSuffix } from '../utils/helpers.js';
import { routes } from '../utils/routes.js';
import { superAdminLogin, impersonateClientAdmin } from './login.js';
import { createClient } from './clientcreation.js';
import { createAllTaskTypes } from './taskcreation.js';
import { assignTasksToOrg } from './taskassign.js';
import { setupAccountAndSkillsProfile } from './accountsetup.js';
import { SEND_PROJECT_INVITATIONS } from '../config/environments.js';

const candidatesCsv = open('../data/candidates.csv');
const candidatesFromCsv = parseCandidatesCsv(candidatesCsv);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createProject(clientToken, orgId) {
  const suffix = uniqueSuffix();
  const payload = {
    title: `Candidate Perform with timer ${suffix}`,
    description: ''
  };

  const res = postJson(routes.createProject(orgId), payload, clientToken, 'Create Project');
  logStep('Create Project', res);
  const projectId = extractId(res, 'id');
  check(res, {
    'create project: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'create project: id returned': () => !!projectId
  });
  return projectId;
}

export function configureProjectAvailability(clientToken, projectId) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(11, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const payload = {
    availabilityStart: start.toISOString(),
    availabilityEnd: end.toISOString(),
    maxAssessmentDurationMinutes: 105,
    durationBufferMinutes: 15,
    minimumLeadTimeMinutes: 2,
    slotIntervalMinutes: 15,
    slotIntervalMinutesQuiet: 5,
    anamHardLimit: 100,
    bookingCapacityPercent: 5,
    rescheduleCutoffMinutes: 30,
    noShowGracePeriodMinutes: 15
  };

  const res = postJson(routes.projectAvailabilityConfig(projectId), payload, clientToken, 'Configure Project Availability');
  logStep('Configure Project Availability', res);
  check(res, {
    'configure project availability: status 2xx': (r) => r.status >= 200 && r.status < 300
  });
  return res;
}

export function assignRoleProfileToProject(clientToken, projectId, roleProfileId) {
  const payload = { projectId, roleProfileId };
  const res = postJson(routes.assignRoleProfileToProject(), payload, clientToken, 'Assign Role Profile to Project');
  logStep('Assign Role Profile to Project', res);
  check(res, {
    'assign role profile to project: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'assign role profile to project: role profile returned': (r) => hasNestedId(r, 'roleProfile', roleProfileId)
  });
  return res;
}

export function createProjectStage(clientToken, projectId) {
  const payload = {
    name: 'Stage 1',
    sequence: 1,
    projectId
  };
  const res = postJson(routes.stages(), payload, clientToken, 'Create Project Stage');
  logStep('Create Project Stage', res);
  const stageId = extractId(res, 'id');
  check(res, {
    'create project stage: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'create project stage: id returned': () => !!stageId
  });
  return stageId;
}

export function assignActivitiesToStage(clientToken, stageId, activities) {
  const assignableActivities = (Array.isArray(activities) ? activities : [])
    .filter((activity) => activity && activity.activityId && UUID_RE.test(String(activity.activityId)));
  const skippedActivities = (Array.isArray(activities) ? activities : []).filter(
    (activity) => !activity || !activity.activityId || !UUID_RE.test(String(activity.activityId))
  );

  if (skippedActivities.length) {
    console.log(
      `[${new Date().toISOString()}] [VU ${__VU}] Project Creation: skipping ${skippedActivities.length} activity record(s) without a valid activityId before stage assignment`
    );
  }

  const payload = {
    assignments: [{
      stageId,
      activityIds: assignableActivities.map((activity) => activity.activityId)
    }]
  };
  const res = postJson(routes.assignStageActivitiesBulk(), payload, clientToken, 'Assign Activities to Stage');
  logStep('Assign Activities to Stage', res);
  check(res, {
    'assign activities to stage: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'assign activities to stage: all activities assigned': (r) => responseListFromRes(r).length === assignableActivities.length
  });
  return res;
}

export function getDefaultEmailTemplate(clientToken) {
  const res = getJson(routes.emailTemplates(), clientToken, 'Get Email Templates');
  logStep('Get Email Templates', res);
  const templates = responseListFromRes(res);
  const template = templates.find((item) => item.isSystemDefault) || templates[0] || null;
  const emailTemplateId = template && template.id;

  check(res, {
    'get email templates: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'get email templates: template id returned': () => !!emailTemplateId
  });

  return emailTemplateId;
}

export function getProjectFromList(clientToken, projectId) {
  const res = getJson(routes.allProjects(), clientToken, 'Get All Projects');
  logStep('Get All Projects', res);
  const projects = responseListFromRes(res);
  const project = projects.find((item) => item.id === projectId) || null;

  check(res, {
    'get all projects: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'get all projects: created project returned': () => !!project
  });

  return project;
}

export function waitForImportedCandidates(clientToken, projectId, expectedCount = 10) {
  let project = null;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    project = getProjectFromList(clientToken, projectId);
    const count = ((project && project.candidates) || []).length;
    if (count >= expectedCount) break;
    sleep(1);
  }

  const candidateCount = ((project && project.candidates) || []).length;
  check(project || {}, {
    'project candidates: imported candidates assigned': () => candidateCount >= expectedCount
  });

  return project;
}

export function sendInvitationsToProjectCandidates(clientToken, projectId, emailTemplateId, candidateIds = []) {
  const payload = {
    projectId,
    emailTemplateId
  };
  const res = postJson(routes.sendProjectCandidateInvitations(), payload, clientToken, 'Send Project Candidate Invitations');
  logStep('Send Project Candidate Invitations', res);
  check(res, {
    'send project invitations: status 2xx': (r) => r.status >= 200 && r.status < 300
  });
  return res;
}

export function createAndAssignUploadedCandidates(clientToken, projectId, organizationId, candidates) {
  const candidateIds = [];
  candidates.forEach((candidate) => {
    const payload = {
      name: candidate.name,
      email: candidate.email,
      organizationId,
      force: true
    };
    const res = postJson(routes.createCandidateForProject(projectId), payload, clientToken, 'Create Candidate for Project');
    logStep(`Create Candidate for Project (${candidate.email})`, res);
    const candidateId = extractCandidateId(res);
    if (candidateId) candidateIds.push(candidateId);
    check(res, {
      'create candidate for project: status 2xx': (r) => r.status >= 200 && r.status < 300
    });
    sleep(0.5);
  });

  check(candidateIds, {
    'create candidate for project: all candidate ids returned': () => candidateIds.length === candidates.length
  });

  if (candidateIds.length) {
    const assignRes = postJson(routes.bulkAssignCandidatesToProject(projectId), { candidateIds }, clientToken, 'Bulk Assign Candidates to Project');
    logStep('Bulk Assign Candidates to Project', assignRes);
    check(assignRes, {
      'bulk assign candidates to project: status 2xx': (r) => r.status >= 200 && r.status < 300
    });
  }

  return candidateIds;
}

export function createProjectCandidate(clientToken, projectId, organizationId, candidate, stepName = 'Create Project Candidate') {
  const payload = {
    name: candidate.name,
    email: candidate.email,
    organizationId,
    force: true
  };
  const res = postJson(routes.createCandidateForProject(projectId), payload, clientToken, stepName);
  logStep(`${stepName} (${candidate.email})`, res);
  const candidateId = extractCandidateId(res);
  check(res, {
    [`${stepName}: status 2xx`]: (r) => r.status >= 200 && r.status < 300,
    [`${stepName}: id returned`]: () => !!candidateId
  });
  return candidateId;
}

export function getCandidatesByProject(clientToken, projectId) {
  const res = getJson(routes.projectCandidates(projectId), clientToken, 'Get Candidates by Project');
  logStep('Get Candidates by Project', res);
  const candidates = responseListFromRes(res);

  check(res, {
    'get candidates by project: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'get candidates by project: candidates returned': () => candidates.length >= 10
  });

  return candidates;
}

export function verifyProjectActive(clientToken, projectId) {
  let project = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    project = getProjectFromList(clientToken, projectId);
    if (project && project.status === 'ACTIVE' && project.emailTemplateId && project.candidateAccess === true) break;
    sleep(1);
  }

  check(project || {}, {
    'project active: status ACTIVE': () => project && project.status === 'ACTIVE',
    'project active: email template selected': () => project && !!project.emailTemplateId,
    'project active: candidate access enabled': () => project && project.candidateAccess === true,
    'project active: candidates assigned': () => project && Array.isArray(project.candidates) && project.candidates.length >= 10
  });

  return project;
}

// Uploads the fixed 10-candidate CSV (data/candidates.csv) via multipart
// form upload. CONFIRMED response is only a queue summary — see header note
// above for why this can't return usable per-candidate credentials.
export function importCandidatesCsv(clientToken, projectId) {
  const candidates = candidatesFromCsv;
  const fields = {
    file: http.file(candidatesCsv, 'candidates.csv', 'text/csv')
  };
  const res = postMultipart(routes.uploadCandidatesCsv(projectId), fields, clientToken, 'Import Candidates (CSV)');
  logStep('Import Candidates (CSV)', res);

  check(res, { 'import candidates: status 2xx': (r) => r.status >= 200 && r.status < 300 });

  let queued = 0;
  let totalRows = 0;
  try {
    const body = res.json();
    const data = body.data || body;
    totalRows = data.totalRows || 0;
    queued = data.queued || 0;
  } catch (e) {
    // leave at 0
  }

  check(res, { 'import candidates: all CSV rows queued': () => queued === candidates.length });

  return { totalRows, queued, candidates };
}

export function completeProjectCreationFlow(clientToken, projectOrgId, roleProfileId, activities) {
  getJson(routes.organizationsList(), clientToken, 'Get Accounts');
  getJson(routes.roleProfilesList(), clientToken, 'Get Role Profiles');
  if (roleProfileId) getJson(routes.roleProfileById(roleProfileId), clientToken, 'Get Selected Role Profile');

  const projectId = createProject(clientToken, projectOrgId);
  if (roleProfileId) assignRoleProfileToProject(clientToken, projectId, roleProfileId);
  configureProjectAvailability(clientToken, projectId);

  getJson(routes.bandsList(), clientToken, 'Get Bands');
  getJson(routes.activitiesList(), clientToken, 'Get Activities for Project Setup');

  const stageId = createProjectStage(clientToken, projectId);
  assignActivitiesToStage(clientToken, stageId, activities);

  const importResult = importCandidatesCsv(clientToken, projectId);
  createAndAssignUploadedCandidates(clientToken, projectId, projectOrgId, importResult.candidates);
  getCandidatesByProject(clientToken, projectId);
  const emailTemplateId = getDefaultEmailTemplate(clientToken);
  if (SEND_PROJECT_INVITATIONS) {
    sendInvitationsToProjectCandidates(clientToken, projectId, emailTemplateId);
    verifyProjectActive(clientToken, projectId);
  } else {
    getProjectFromList(clientToken, projectId);
  }

  return { projectId, candidates: importResult.candidates };
}

function extractCandidateId(res) {
  try {
    const body = res.json();
    const data = body.data || body;
    return data.id || data.candidateId || data.userId || (data.user && data.user.id) || null;
  } catch (e) {
    return null;
  }
}

function parseCandidatesCsv(csv) {
  const lines = String(csv).trim().split(/\r?\n/);
  const headers = lines.shift().split(',').map((header) => header.trim());
  const nameIndex = headers.indexOf('name');
  const emailIndex = headers.indexOf('email');
  return lines
    .map((line) => line.split(',').map((value) => value.trim()))
    .filter((columns) => columns[nameIndex] && columns[emailIndex])
    .map((columns) => ({
      name: columns[nameIndex],
      email: columns[emailIndex]
    }));
}

function responseListFromRes(res) {
  try {
    const body = res.json();
    return (
      (body && body.data && body.data.data) ||
      (body && body.data && body.data.items) ||
      (body && body.data && body.data.candidates) ||
      (body && body.data && body.data.projectCandidates) ||
      (body && body.data && body.data.results) ||
      (Array.isArray(body && body.data) ? body.data : null) ||
      body.items ||
      body.candidates ||
      body.projectCandidates ||
      []
    );
  } catch (e) {
    return [];
  }
}

function hasNestedId(res, key, expectedId) {
  try {
    const body = res.json();
    return body && body.data && body.data[key] && body.data[key].id === expectedId;
  } catch (e) {
    return false;
  }
}

// Standalone-runnable: `k6 run scenarios/projectcreation.js`
export default function () {
  const superAdminToken = superAdminLogin();
  const { orgId, adminUserId } = createClient(superAdminToken);
  const activities = createAllTaskTypes(superAdminToken);
  assignTasksToOrg(superAdminToken, orgId, activities);

  const clientToken = impersonateClientAdmin(superAdminToken, adminUserId);
  const setup = setupAccountAndSkillsProfile(clientToken, orgId);
  const projectOrgId = setup.accountOrgId || orgId;
  completeProjectCreationFlow(clientToken, projectOrgId, setup.roleProfileId, activities);
}
