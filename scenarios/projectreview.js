// Client Admin project review flow for the hardcoded project.
//
// Mirrors Review Project.har:
//   1. Load candidate scoring list for the hardcoded project
//   2. Load project details, bands, and candidate stages
//   3. Open each activity score detail
//   4. PATCH reviewer score/reason for each reviewable sub-skill
//   5. Load review summary, submit stage review, and fetch report

import { check, sleep } from 'k6';
import { getJson, getJsonWithHeaders, postJsonWithHeaders, patchJsonWithHeaders } from '../utils/http.js';
import { log, logStep } from '../utils/helpers.js';
import { routes } from '../utils/routes.js';
import { PORTALS, HARDCODED_CANDIDATES } from '../config/environments.js';
import { superAdminLogin, clientAdminLogin, impersonateClientAdmin } from './login.js';

const REVIEW_REASON = __ENV.PROJECT_REVIEW_REASON || 'good';
const REVIEW_SCORE_OVERRIDE = __ENV.PROJECT_REVIEW_SCORE ? Number(__ENV.PROJECT_REVIEW_SCORE) : null;
const REVIEW_SCORE_MAX_ATTEMPTS = Number(__ENV.PROJECT_REVIEW_MAX_ATTEMPTS || 8);
const REVIEW_SCORE_RETRY_DELAY_SECONDS = Number(__ENV.PROJECT_REVIEW_RETRY_DELAY_SECONDS || 2);
const DEFAULT_REVIEW_CLIENT_ADMIN_USER_ID = 'd782f765-9d74-43c5-a268-e99e8246ac55';
const CLIENT_ADMIN_HEADERS = {
  'x-base-origin': 'client-admin',
  Origin: PORTALS.clientAdmin,
  Referer: `${PORTALS.clientAdmin}/`
};

function reviewProjectId() {
  return (
    __ENV.PROJECT_REVIEW_PROJECT_ID ||
    __ENV.REVIEW_PROJECT_ID ||
    HARDCODED_CANDIDATES[0]?.projectId ||
    null
  );
}

export function projectReviewLogin() {
  if (__ENV.CLIENT_ADMIN_EMAIL && __ENV.CLIENT_ADMIN_PASSWORD) {
    return clientAdminLogin(__ENV.CLIENT_ADMIN_EMAIL, __ENV.CLIENT_ADMIN_PASSWORD);
  }

  const superAdminToken = superAdminLogin();
  if (!superAdminToken) return null;

  const clientAdminUserId = __ENV.CLIENT_ADMIN_USER_ID || __ENV.HARDCODED_CLIENT_ADMIN_USER_ID || DEFAULT_REVIEW_CLIENT_ADMIN_USER_ID;

  log('Project Review', `Impersonating client admin userId=${clientAdminUserId}`);
  return impersonateClientAdmin(superAdminToken, clientAdminUserId);
}

export function completeHardcodedProjectReviewFlow(
  token,
  projectId = reviewProjectId(),
  candidates = HARDCODED_CANDIDATES
) {
  if (!projectId) {
    log('Project Review', 'ABORTED - project id is missing');
    return [];
  }

  reviewGet(routes.organizationsList(1, 1000), token, 'Project Review - Get Accounts');
  const projectRes = reviewGet(routes.projectById(projectId), token, 'Project Review - Get Project Details');
  logStep('Project Review - Get Project Details', projectRes);
  reviewGet(routes.bandsList(1, 15), token, 'Project Review - Get Bands');

  const reviewTargets = resolveReviewTargetsFromProject(projectRes, candidates);
  check(reviewTargets, { 'project review: target candidates found': (items) => items.length > 0 });

  const results = [];
  reviewTargets.forEach((target) => {
    const stages = target.stages;
    stages.forEach((stage) => {
      const stageId = stage.stageId;
      const activities = stage.activities || [];

      check(stage, {
        'project review stage: id returned': () => !!stageId,
        'project review stage: activities returned': () => activities.length > 0
      });

      let reviewedItems = 0;
      let skippedActivities = 0;
      activities.forEach((activity, activityIndex) => {
        const result = reviewActivity(token, projectId, target.candidateId, activity, activityIndex);
        reviewedItems += result.reviewedItems;
        if (result.skipped) skippedActivities += 1;
        sleep(0.5);
      });

      const summaryRes = reviewGet(
        routes.projectCandidateReviewSummary(projectId, target.candidateId, stageId),
        token,
        'Project Review - Get Summary'
      );
      logStep(`Project Review - Get Summary (${target.candidateId})`, summaryRes);
      check(summaryRes, { 'project review summary: status 2xx': (r) => r.status >= 200 && r.status < 300 });

      if (reviewedItems === 0) {
        log('Project Review', `SKIP submit - candidateId=${target.candidateId} stageId=${stageId}: no skills/sub-skills were reviewed; skippedActivities=${skippedActivities}`);
        results.push({ candidateId: target.candidateId, stageId, submitted: false, reviewedItems, skippedActivities });
        return;
      }

      const submitRes = reviewPost(
        routes.submitProjectCandidateStageReview(projectId, target.candidateId, stageId),
        {},
        token,
        'Project Review - Submit Review'
      );
      logStep(`Project Review - Submit Review (${target.candidateId})`, submitRes);
      check(submitRes, { 'project review submit: status 2xx': (r) => r.status >= 200 && r.status < 300 });

      const reportRes = reviewGet(
        routes.projectCandidateStageReport(projectId, stageId, target.candidateId),
        token,
        'Project Review - Get Report'
      );
      logStep(`Project Review - Get Report (${target.candidateId})`, reportRes);
      check(reportRes, { 'project review report: status 2xx': (r) => r.status >= 200 && r.status < 300 });

      const completed = submitRes.status >= 200 && submitRes.status < 300 && isReviewMarkedComplete(submitRes, reportRes);
      if (completed) {
        log('Project Review', `Review completed - candidateId=${target.candidateId} stageId=${stageId} reviewedItems=${reviewedItems} skippedActivities=${skippedActivities}`);
      } else {
        log('Project Review', `WARN submit succeeded but completion marker was not confirmed - candidateId=${target.candidateId} stageId=${stageId}`);
      }

      results.push({ candidateId: target.candidateId, stageId, submitted: submitRes.status >= 200 && submitRes.status < 300, reviewedItems, skippedActivities });
    });
  });

  return results;
}

function resolveProjectAdminUserId(superAdminToken, projectId) {
  if (!projectId) return DEFAULT_REVIEW_CLIENT_ADMIN_USER_ID;

  const projectRes = getJson(routes.projectById(projectId), superAdminToken, 'Project Review - Resolve Project Org');
  logStep('Project Review - Resolve Project Org', projectRes);

  const org = extractProjectOrganization(projectRes);
  if (!org.id && !org.name) return null;

  if (org.id) {
    const orgByIdRes = getJson(routes.organizationById(org.id), superAdminToken, 'Project Review - Resolve Client Admin By Org Id');
    logStep('Project Review - Resolve Client Admin By Org Id', orgByIdRes);
    const adminFromOrgById = extractAdminUserId(orgByIdRes, org);
    if (adminFromOrgById) {
      log('Project Review', `Resolved project org admin userId=${adminFromOrgById} from org id=${org.id}`);
      return adminFromOrgById;
    }
  }

  const search = encodeURIComponent(org.name || org.id);
  const orgRes = getJson(`${routes.organizationsList(1, 10)}&search=${search}`, superAdminToken, 'Project Review - Resolve Client Admin');
  logStep('Project Review - Resolve Client Admin', orgRes);

  const adminUserId = extractAdminUserId(orgRes, org);
  if (adminUserId) {
    log('Project Review', `Resolved project org admin userId=${adminUserId} for org=${org.name || org.id}`);
  } else {
    log('Project Review', `Could not resolve project org admin for org=${org.name || org.id}`);
  }
  return adminUserId;
}

function extractProjectOrganization(res) {
  try {
    const body = res.json();
    const project = body && body.data;
    const org = (project && project.organization) || {};
    return { id: org.id || project.organizationId || null, name: org.name || project.organizationName || null };
  } catch (e) {
    return { id: null, name: null };
  }
}

function extractAdminUserId(res, projectOrg) {
  const orgs = responseData(res);
  const list = Array.isArray(orgs) && orgs.length ? orgs : [safeDataObject(res)].filter(Boolean);
  const match = list.find((org) => {
    if (projectOrg.id && org.id === projectOrg.id) return true;
    return projectOrg.name && org.name === projectOrg.name;
  }) || list[0];

  return match && ((match.admin && match.admin.id) || match.ownerId || null);
}

function safeDataObject(res) {
  try {
    const body = res.json();
    return body && body.data && !Array.isArray(body.data) ? body.data : null;
  } catch (e) {
    return null;
  }
}

function reviewActivity(token, projectId, candidateId, activity, activityIndex) {
  const activityId = activity.activityId;
  const detailRes = waitForReviewableActivity(token, projectId, candidateId, activityId, activity.type, activityIndex);
  logStep(`Project Review - Get Activity Score (${activityId})`, detailRes);

  if (detailRes.status === 404) {
    log('Project Review', `SKIP activityId=${activityId}: activity not found in project for candidateId=${candidateId}`);
    return { skipped: true, reviewedItems: 0, reason: 'activity_not_found' };
  }

  if (detailRes.status < 200 || detailRes.status >= 300) {
    log('Project Review', `SKIP activityId=${activityId}: activity score request failed with status=${detailRes.status}`);
    return { skipped: true, reviewedItems: 0, reason: 'activity_score_failed' };
  }

  const missingReason = getMissingReviewDataReason(detailRes);
  if (missingReason) {
    log('Project Review', `SKIP activityId=${activityId}: ${missingReason}`);
    return { skipped: true, reviewedItems: 0, reason: 'missing_review_data' };
  }

  logTranscriptWarning(detailRes, activityId);
  const reviewItems = extractReviewItems(detailRes, null, activityId, activity.type, activityIndex);
  if (reviewItems.length === 0) {
    log('Project Review', `SKIP activityId=${activityId}: ${explainMissingReviewItems(detailRes)}`);
    return { skipped: true, reviewedItems: 0, reason: 'no_review_items' };
  }

  let reviewedItems = 0;
  reviewItems.forEach((item) => {
    const res = reviewPatch(
      routes.reviewProjectCandidate(projectId, candidateId),
      item,
      token,
      'Project Review - Save Sub Skill Review'
    );
    logStep(`Project Review - Save Sub Skill Review (${activityId})`, res);
    check(res, { 'project review save sub skill: status 2xx': (r) => r.status >= 200 && r.status < 300 });
    if (res.status >= 200 && res.status < 300) reviewedItems += 1;

    reviewGet(
      routes.scoringProjectCandidateActivity(projectId, candidateId, activityId),
      token,
      'Project Review - Refresh Activity Score'
    );
  });

  return { skipped: reviewedItems === 0, reviewedItems, reason: reviewedItems === 0 ? 'save_failed' : null };
}

function waitForReviewableActivity(token, projectId, candidateId, activityId, activityType, activityIndex) {
  let lastRes = null;

  for (let attempt = 1; attempt <= REVIEW_SCORE_MAX_ATTEMPTS; attempt += 1) {
    lastRes = reviewGet(
      routes.scoringProjectCandidateActivity(projectId, candidateId, activityId),
      token,
      'Project Review - Get Activity Score'
    );

    if (lastRes.status === 404) {
      return lastRes;
    }

    if (lastRes.status >= 200 && lastRes.status < 300) {
      const missingReason = getMissingReviewDataReason(lastRes);
      if (!missingReason) {
        return lastRes;
      }

      if (attempt < REVIEW_SCORE_MAX_ATTEMPTS) {
        log(
          'Project Review',
          `Waiting for review data activityId=${activityId} attempt=${attempt}/${REVIEW_SCORE_MAX_ATTEMPTS} reason=${missingReason}`
        );
        sleep(REVIEW_SCORE_RETRY_DELAY_SECONDS);
        continue;
      }
    }

    break;
  }

  if (lastRes && lastRes.status >= 200 && lastRes.status < 300) {
    log(
      'Project Review',
      `Review data still incomplete for activityId=${activityId} type=${activityType} index=${activityIndex} after ${REVIEW_SCORE_MAX_ATTEMPTS} attempts`
    );
  }

  return lastRes;
}

function resolveReviewTargetsFromProject(res, configuredCandidates) {
  const project = safeDataObject(res);
  if (!project) return [];

  const explicitCandidateId = __ENV.PROJECT_REVIEW_CANDIDATE_ID || __ENV.REVIEW_CANDIDATE_ID;
  const wantedIds = explicitCandidateId
    ? [explicitCandidateId]
    : configuredCandidates.map((candidate) => candidate.candidateId).filter(Boolean);

  const projectCandidates = project.candidates || [];
  const candidateIds = wantedIds.length
    ? wantedIds
    : projectCandidates
        .map((row) => (row.candidate && row.candidate.id) || row.candidateId || row.id)
        .filter(Boolean);

  const stageRows = (project.stages || []).map((stage) => ({
    stageId: stage.id || stage.stageId,
    stageName: stage.name || stage.stageName,
    activities: (stage.stageActivities || stage.activities || [])
      .map((row) => ({
        activityId: (row.activity && row.activity.id) || row.activityId || row.id,
        title: (row.activity && row.activity.title) || row.title,
        type: (row.activity && row.activity.type) || row.type
      }))
      .filter((activity) => activity.activityId)
  })).filter((stage) => stage.stageId && stage.activities.length > 0);

  return candidateIds.slice(0, Number(__ENV.PROJECT_REVIEW_CANDIDATE_LIMIT || 1)).map((candidateId) => ({
    candidateId,
    stages: stageRows
  }));
}

function resolveReviewTargets(res, configuredCandidates) {
  const rows = responseData(res);
  const explicitCandidateId = __ENV.PROJECT_REVIEW_CANDIDATE_ID || __ENV.REVIEW_CANDIDATE_ID;
  const wantedIds = explicitCandidateId
    ? [explicitCandidateId]
    : configuredCandidates
        .map((candidate) => candidate.reviewCandidateId || candidate.projectReviewCandidateId || candidate.candidateId)
        .filter(Boolean);
  const projects = Array.isArray(rows) ? rows : [];
  const candidates = [];
  projects.forEach((project) => {
    (project.candidates || []).forEach((candidate) => {
      const isRequested = wantedIds.length && wantedIds.indexOf(candidate.candidateId) !== -1;
      const isReviewable =
        !wantedIds.length &&
        candidate.candidateStatus === 'COMPLETED' &&
        (!candidate.actionLabel || candidate.actionLabel === 'Review') &&
        hasReviewableStage(candidate);

      if (isRequested || isReviewable) {
        candidates.push({
          candidateId: candidate.candidateId,
          candidateName: candidate.candidateName,
          stages: candidate.stages || []
        });
      }
    });
  });
  return candidates.slice(0, Number(__ENV.PROJECT_REVIEW_CANDIDATE_LIMIT || 1));
}

function hasReviewableStage(candidate) {
  return (candidate.stages || []).some((stage) => stage.stageId && stage.stageCandidateId && (stage.activities || []).length > 0);
}

function mergeStageDetails(candidateStages, stageDetails) {
  const byId = {};
  (candidateStages || []).forEach((stage) => {
    byId[stage.stageId] = { ...stage };
  });
  (stageDetails || []).forEach((stage) => {
    const existing = byId[stage.stageId] || {};
    byId[stage.stageId] = {
      ...existing,
      ...stage,
      activities: stage.activities || existing.activities || []
    };
  });
  return Object.values(byId);
}

function extractStages(res) {
  const rows = responseData(res);
  const first = Array.isArray(rows) ? rows[0] : null;
  return (first && first.stages) || [];
}

function extractReviewItems(res, fallbackStageCandidateId, fallbackActivityId, activityType, activityIndex = 0) {
  try {
    const body = res.json();
    const activity = body && body.data && body.data.activity;
    const stageCandidateId = (activity && activity.stageCandidateId) || fallbackStageCandidateId;
    const activityId = (activity && activity.id) || fallbackActivityId;
    const skills = (activity && activity.skills) || [];
    const items = [];

    skills.forEach((skill, skillIndex) => {
      (skill.subSkills || []).forEach((subSkill, subSkillIndex) => {
        const skillId = skill.skillId || skill.id;
        const subSkillId = subSkill.subSkillId || subSkill.id;
        if (!skillId || !subSkillId) return;
        const score = reviewScore(activityType, activityIndex, skillIndex, subSkillIndex, subSkill.score);
        items.push({
          stageCandidateId,
          activityId,
          skillId,
          subSkillId,
          reviewerScore: score,
          reviewerScoreReason: reviewReason(score, skill.skillName, subSkill.subSkillName)
        });
      });
    });

    return items.filter((item) => item.stageCandidateId && item.activityId);
  } catch (e) {
    return [];
  }
}

function getMissingReviewDataReason(res) {
  try {
    const body = res.json();
    const activity = body && body.data && body.data.activity;
    if (!activity) return 'activity detail payload is missing';
    if (!activity.transcript) return 'transcript not found, so no evidence is available for review';
    const skills = activity.skills || [];
    if (skills.length === 0) return 'skills not found on activity score response';
    const subSkillCount = skills.reduce((count, skill) => count + ((skill.subSkills || []).length), 0);
    if (subSkillCount === 0) return 'sub-skills not found on activity score response';
    return null;
  } catch (e) {
    return 'activity score response could not be parsed';
  }
}

function reviewScore(activityType, activityIndex, skillIndex, subSkillIndex, systemScore) {
  if (Number.isFinite(REVIEW_SCORE_OVERRIDE)) return REVIEW_SCORE_OVERRIDE;

  const pattern = [2, 4, 3, 5, 1, 4, 2, 5];
  const typeOffset = {
    CASE: 0,
    INTERVIEW: 1,
    ROLE_PLAY: 2,
    BOARD_MEETING: 3,
    SITUATIONS: 4,
    WELCOME: 5
  }[activityType] || 0;
  const index = (activityIndex + typeOffset + skillIndex * 2 + subSkillIndex) % pattern.length;
  return pattern[index] || systemScore || 3;
}

function reviewReason(score, skillName, subSkillName) {
  const label = `${skillName || 'Skill'} / ${subSkillName || 'Sub-skill'}`;
  if (score >= 5) return `${label}: clear strength; evidence shows consistent, high-quality behaviour.`;
  if (score >= 4) return `${label}: strong performance with only minor gaps to refine.`;
  if (score >= 3) return `${label}: acceptable performance; next step is to make reasoning more specific and evidence-led.`;
  if (score >= 2) return `${label}: developing area; needs clearer structure, stronger evidence, and more complete explanation.`;
  return `${label}: key improvement area; response needs more relevant evidence and a clearer approach.`;
}

function explainMissingReviewItems(res) {
  try {
    const body = res.json();
    const activity = body && body.data && body.data.activity;
    if (!activity) return 'activity detail payload is missing';
    const skills = activity.skills || [];
    if (skills.length === 0) return 'skills not found on activity score response';
    const subSkillCount = skills.reduce((count, skill) => count + ((skill.subSkills || []).length), 0);
    if (subSkillCount === 0) return 'sub-skills not found on activity score response';
    return 'skills/sub-skills are present but ids required for review payload are missing';
  } catch (e) {
    return 'activity score response could not be parsed';
  }
}

function logTranscriptWarning(res, activityId) {
  try {
    const body = res.json();
    const activity = body && body.data && body.data.activity;
    if (activity && !activity.transcript) {
      log('Project Review', `WARN activityId=${activityId}: transcript not found; reviewing available skills/sub-skills`);
    }
  } catch (e) {
    // no warning when the response cannot be parsed here; extraction will handle it
  }
}

function isReviewMarkedComplete(submitRes, reportRes) {
  try {
    const submitBody = submitRes.json();
    if (submitBody && submitBody.data && submitBody.data.reviewSubmittedAt) return true;
  } catch (e) {
    // keep checking report response
  }

  try {
    const reportBody = reportRes.json();
    return !!(reportBody && reportBody.data && reportBody.data.pdfReportUrl);
  } catch (e) {
    return false;
  }
}

function responseData(res) {
  try {
    const body = res.json();
    return (
      (body && body.data && body.data.data) ||
      (body && body.data && body.data.items) ||
      (body && body.data && body.data.projects) ||
      (body && body.data && body.data.results) ||
      (Array.isArray(body && body.data) ? body.data : null) ||
      body.projects ||
      body.items ||
      body.results ||
      []
    );
  } catch (e) {
    return [];
  }
}

function reviewGet(url, token, name) {
  return getJsonWithHeaders(url, token, name, CLIENT_ADMIN_HEADERS);
}

function reviewPost(url, body, token, name) {
  return postJsonWithHeaders(url, body, token, name, CLIENT_ADMIN_HEADERS);
}

function reviewPatch(url, body, token, name) {
  return patchJsonWithHeaders(url, body, token, name, CLIENT_ADMIN_HEADERS);
}

export default function () {
  const token = projectReviewLogin();
  if (!token) return;
  completeHardcodedProjectReviewFlow(token);
}
