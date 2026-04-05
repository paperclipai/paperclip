#!/usr/bin/env node

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const util = require('util');
const execFilePromise = util.promisify(execFile);

const { Client } = require('/Users/daehan/Documents/persona/paperclip/node_modules/.pnpm/node_modules/pg');

const DB_URL = process.env.PAPERCLIP_DB_URL || 'postgres://paperclip:paperclip@127.0.0.1:54329/paperclip';
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || 'a900f7fe-3219-4afb-8fc2-6f55dedd5fe8';
const PROJECT_ID = process.env.ARTICLE_LOOP_PROJECT_ID || 'c35ff304-0182-48e5-8bb3-375b191a371d'; // Draft Engine
const TARGET_SITE = process.env.ARTICLE_LOOP_TARGET_SITE || 'fluxaivory.com';
const TOPIC_SCOUT_SCRIPT = process.env.ARTICLE_LOOP_TOPIC_SCOUT_SCRIPT || '/Users/daehan/Documents/persona/paperclip/scripts/obsidian_rss_topic_scout.py';
const RSS_REFRESH_SCRIPT = process.env.ARTICLE_LOOP_RSS_REFRESH_SCRIPT === undefined
  ? '/Users/daehan/Documents/persona/paperclip/scripts/refresh_obsidian_rss_dashboard.py'
  : String(process.env.ARTICLE_LOOP_RSS_REFRESH_SCRIPT).trim();
const BLOG_RUNS_DIR = path.join(os.homedir(), '.paperclip', 'instances', 'default', 'data', 'blog-runs');
const REUSED_RUN_TRACEABILITY_REASON = 'article_quality_loop_bridge';
const TOPIC_COOLDOWN_HOURS = Number(process.env.ARTICLE_LOOP_TOPIC_COOLDOWN_HOURS || 12);
const RSS_MAX_AGE_HOURS = Number(process.env.ARTICLE_LOOP_RSS_MAX_AGE_HOURS || 48);
const HOLDOVER_SUPPRESSION_THRESHOLD = Number(process.env.ARTICLE_LOOP_HOLDOVER_SUPPRESSION_THRESHOLD || 4);
const HOLDOVER_WINDOW_HOURS = Number(process.env.ARTICLE_LOOP_HOLDOVER_WINDOW_HOURS || 24);
const WP_API_URL = String(process.env.PUBLISH_WP_API_URL || process.env.WP_API_URL || 'https://fluxaivory.com/wp-json/wp/v2').trim();
const PUBLISHED_TITLES_TIMEOUT_MS = Number(process.env.ARTICLE_LOOP_PUBLISHED_TITLES_TIMEOUT_MS || 1500);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const next = argv[i + 1];
    const key = token.slice(2);
    if (!next || next.startsWith('--')) parsed[key] = true;
    else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function isDisabledValue(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off';
}

async function runTopicScout(vertical) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'paperclip-topic-scout-'));
  const outPath = path.join(tmp, 'topic-scout.json');
  try {
    await execFilePromise('python3', [TOPIC_SCOUT_SCRIPT, '--vertical', vertical, '--out', outPath], {
      maxBuffer: 1024 * 1024 * 4,
    });
    return JSON.parse(await fsp.readFile(outPath, 'utf8'));
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function refreshDashboardIfConfigured() {
  if (!RSS_REFRESH_SCRIPT || isDisabledValue(RSS_REFRESH_SCRIPT)) return null;
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'paperclip-rss-refresh-'));
  const outPath = path.join(tmp, 'rss-refresh.json');
  try {
    const vertical = String(process.env.ARTICLE_LOOP_REFRESH_VERTICAL || '').trim();
    const args = [RSS_REFRESH_SCRIPT, '--out', outPath];
    if (vertical) args.push('--vertical', vertical);
    const { stdout } = await execFilePromise('python3', args, {
      maxBuffer: 1024 * 1024 * 4,
    });
    const filePayload = await fsp.readFile(outPath, 'utf8').then((raw) => JSON.parse(raw)).catch(() => null);
    if (filePayload) return filePayload;
    return JSON.parse(String(stdout || '{}'));
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function buildContext(topicScout, vertical, issueId) {
  const topic = String(topicScout?.selected_topic || '').trim();
  const selectionPolicy = topicScout?.selection_policy && typeof topicScout.selection_policy === 'object' && !Array.isArray(topicScout.selection_policy)
    ? { ...topicScout.selection_policy }
    : null;
  const issueIdentifier = String(topicScout?.traceability_issue_identifier || '').trim() || null;
  const touchedAt = new Date().toISOString();
  return {
    topic,
    verticalKey: vertical,
    topicScout: topicScout || null,
    selectionPolicy,
    title: topic,
    publishReadyGateMode: 'strict',
    publicVerifyContractMode: 'compat',
    highThroughputQualityLoop: true,
    articleLoop: {
      enabled: true,
      articleAttempt: 1,
      maxAttempts: 3,
      specialistGuidanceUsed: {},
      lastFailedGates: [],
      lastGateReasonSummary: {},
      backlog: false,
      selectionPolicy,
    },
    sourceRoutineIssueId: issueId || null,
    traceability: {
      originIssueIdentifier: issueIdentifier,
      lastTouchedIssueIdentifier: issueIdentifier,
      continuity: 'created_new_run',
      lastTouchedAt: touchedAt,
    },
  };
}

function toRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value }
    : {};
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function resolveTopicSelectionFromArgs(args, topicScout, recentTopics, publishedTitles, cooldownHours) {
  const explicitTopic = String(args?.topic || '').trim();
  if (explicitTopic) {
    return {
      selectedTopic: explicitTopic,
      selectedBucket: String(args?.bucket || topicScout?.selected_bucket || '').trim() || null,
      selectionReason: 'manual_topic_override',
      topicScorecard: {},
      selectedRank: 0,
      cooldownApplied: false,
      skippedRecentTopics: [],
      skippedPublishedTopics: [],
      skippedSuppressedTopics: [],
      managerReviewRequired: false,
      selectionPolicy: null,
      explicitTopic: true,
    };
  }
  const selected = selectTopicAvoidingPublished(
    topicScout,
    recentTopics,
    publishedTitles,
    cooldownHours,
    arguments[5] || {},
  );
  return {
    ...selected,
    explicitTopic: false,
  };
}

function normalizeContext(topic, contextJson) {
  return {
    ...(contextJson && typeof contextJson === 'object' && !Array.isArray(contextJson) ? contextJson : {}),
    topic: String(topic || '').trim(),
  };
}

function normalizeTopicKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalUrl(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return normalized.replace(/\/+$/, '').toLowerCase();
}

function buildResearchSignature(researchResult) {
  const record = toRecord(researchResult);
  const factPack = toRecord(record.fact_pack);
  const claimSource = toArray(factPack.claim_list).length > 0 ? toArray(factPack.claim_list) : toArray(factPack.fact_table);
  const claims = claimSource
    .map((entry) => {
      const item = toRecord(entry);
      return {
        claim: String(item.claim || '').trim(),
        evidence: String(item.evidence || '').trim(),
      };
    })
    .filter((entry) => entry.claim || entry.evidence)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const sourceRegistry = toArray(record.source_registry)
    .map((entry) => {
      const item = toRecord(entry);
      return {
        title: String(item.title || '').trim().toLowerCase(),
        url: canonicalUrl(item.url) || '',
        source_type: String(item.source_type || '').trim().toLowerCase(),
      };
    })
    .filter((entry) => entry.url || entry.title)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const uncertaintyLedger = toArray(record.uncertainty_ledger)
    .map((entry) => {
      const item = toRecord(entry);
      return {
        kind: String(item.kind || '').trim().toLowerCase(),
        issue: String(item.issue || item.item || '').trim().toLowerCase(),
        status: String(item.status || item.reason || '').trim().toLowerCase(),
      };
    })
    .filter((entry) => entry.kind || entry.issue || entry.status)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

  if (claims.length === 0 && sourceRegistry.length === 0 && uncertaintyLedger.length === 0) {
    return null;
  }

  return JSON.stringify({
    claims,
    sourceRegistry,
    uncertaintyLedger,
  });
}

function extractSourceUrls(researchResult) {
  return new Set(
    toArray(toRecord(researchResult).source_registry)
      .map((entry) => canonicalUrl(toRecord(entry).url))
      .filter(Boolean),
  );
}

function summarizeTopicSelectionPolicy(historyEntries, candidateLink, referenceAt, options = {}) {
  const suppressionThreshold = Math.max(2, Number(options.suppressionThreshold || HOLDOVER_SUPPRESSION_THRESHOLD) || HOLDOVER_SUPPRESSION_THRESHOLD);
  const repeatWindowHours = Math.max(0, Number(options.repeatWindowHours || HOLDOVER_WINDOW_HOURS) || HOLDOVER_WINDOW_HOURS);
  const referenceMs = Date.parse(String(referenceAt || ''));
  const sorted = [...toArray(historyEntries)]
    .map((entry) => toRecord(entry))
    .sort((left, right) => Date.parse(String(right.created_at || '')) - Date.parse(String(left.created_at || '')));
  const latestWithResearch = sorted.find((entry) => buildResearchSignature(entry.research_result_json));
  const latestSignature = latestWithResearch ? buildResearchSignature(latestWithResearch.research_result_json) : null;
  let identicalEvidenceStreak = 0;
  if (latestSignature) {
    for (const entry of sorted) {
      const signature = buildResearchSignature(entry.research_result_json);
      if (!signature || signature !== latestSignature) break;
      identicalEvidenceStreak += 1;
    }
  }

  const latestSourceUrls = latestWithResearch ? extractSourceUrls(latestWithResearch.research_result_json) : new Set();
  const candidateUrl = canonicalUrl(candidateLink);
  const hasNewSourceSignal = Boolean(candidateUrl) && !latestSourceUrls.has(candidateUrl);

  const historyWindowCount = Number.isFinite(referenceMs) && repeatWindowHours > 0
    ? sorted.filter((entry) => {
      const createdAtMs = Date.parse(String(entry.created_at || ''));
      return Number.isFinite(createdAtMs) && (referenceMs - createdAtMs) <= repeatWindowHours * 60 * 60 * 1000;
    }).length
    : sorted.length;
  const repeatCount = historyWindowCount + 1;

  let grokExceptionStreak = 0;
  for (const entry of sorted) {
    const artifacts = toArray(entry.artifacts);
    const hasSuccess = artifacts.some((artifact) => {
      const item = toRecord(artifact);
      const metadata = toRecord(item.metadata);
      return item.artifactKind === 'grok_trend_scan_json' && metadata.ok !== false;
    });
    const hasError = artifacts.some((artifact) => toRecord(artifact).artifactKind === 'grok_artifact_step_error');
    if (hasError && !hasSuccess) {
      grokExceptionStreak += 1;
      continue;
    }
    break;
  }

  let holdoverTag = null;
  if (latestSignature && identicalEvidenceStreak >= 1 && !hasNewSourceSignal) {
    holdoverTag = 'delta / repeated holdover confirmation';
  }
  if (
    latestSignature
    && identicalEvidenceStreak >= (suppressionThreshold - 1)
    && repeatCount >= suppressionThreshold
    && !hasNewSourceSignal
  ) {
    holdoverTag = 'suppressed stale holdover';
  }

  return {
    holdoverTag,
    repeatCount,
    identicalEvidenceStreak,
    historyRunCount: sorted.length,
    hasNewSourceSignal,
    grokExceptionStreak,
    latestResearchRunId: String(latestWithResearch?.run_id || latestWithResearch?.id || '').trim() || null,
    nextAction:
      holdoverTag === 'suppressed stale holdover'
        ? 'pivot_to_next_candidate_or_manager_review'
        : holdoverTag
          ? 'allow_holdover_confirmation'
          : 'fresh_topic_ok',
  };
}

function buildTopicSelection(topicScout, recentTopics, cooldownHours, options = {}) {
  const generatedAt = Date.parse(String(topicScout?.generated_at || ''));
  const candidates = Array.isArray(topicScout?.top10_candidates) && topicScout.top10_candidates.length > 0
    ? topicScout.top10_candidates
    : [
        {
          rank: 1,
          title: topicScout?.selected_topic,
          bucket: topicScout?.selected_bucket,
          why_now: topicScout?.selection_reason,
          topic_scorecard: topicScout?.topic_scorecard || {},
          link: topicScout?.link || null,
        },
      ].filter((entry) => String(entry.title || '').trim());
  const normalizedRecent = recentTopics
    .map((entry) => ({
      topicKey: normalizeTopicKey(entry.topic),
      createdAtMs: Date.parse(String(entry.created_at || '')),
    }))
    .filter((entry) => entry.topicKey && Number.isFinite(entry.createdAtMs));
  const cooldownMs = Math.max(0, Number(cooldownHours || 0)) * 60 * 60 * 1000;
  const published = new Set(toArray(options.publishedTitles).map((title) => normalizeTopicKey(title)).filter(Boolean));
  const skippedRecentTopics = [];
  const skippedPublishedTopics = [];
  const skippedSuppressedTopics = [];
  const topicHistories = toRecord(options.topicHistories);
  const referenceAt = String(options.referenceAt || topicScout?.generated_at || new Date().toISOString());
  let lastSuppressedPolicy = null;

  for (const candidate of candidates) {
    const topicKey = normalizeTopicKey(candidate?.title);
    if (!topicKey) continue;
    const conflict = Number.isFinite(generatedAt) && cooldownMs > 0
      ? normalizedRecent.find((entry) => entry.topicKey === topicKey && (generatedAt - entry.createdAtMs) < cooldownMs)
      : null;
    if (conflict) {
      skippedRecentTopics.push({
        title: String(candidate?.title || '').trim(),
        rank: Number(candidate?.rank || 0),
        previousCreatedAt: new Date(conflict.createdAtMs).toISOString(),
      });
      continue;
    }
    if (published.has(topicKey)) {
      skippedPublishedTopics.push({
        title: String(candidate?.title || '').trim(),
        rank: Number(candidate?.rank || 0) || 1,
      });
      continue;
    }

    const policy = options.applySuppressionPolicy === false
      ? null
      : summarizeTopicSelectionPolicy(
          topicHistories[topicKey] || [],
          candidate?.link,
          referenceAt,
          options,
        );
    if (policy?.holdoverTag === 'suppressed stale holdover') {
      skippedSuppressedTopics.push({
        title: String(candidate?.title || '').trim(),
        rank: Number(candidate?.rank || 0) || 1,
        holdoverTag: policy.holdoverTag,
        repeatCount: policy.repeatCount,
        grokExceptionStreak: policy.grokExceptionStreak,
      });
      lastSuppressedPolicy = policy;
      continue;
    }

    return {
      selectedTopic: String(candidate?.title || '').trim() || null,
      selectedBucket: String(candidate?.bucket || '').trim() || null,
      selectionReason: String(candidate?.why_now || topicScout?.selection_reason || 'candidate selected'),
      topicScorecard: candidate?.topic_scorecard || topicScout?.topic_scorecard || {},
      selectedRank: Number(candidate?.rank || 0) || 1,
      cooldownApplied: skippedRecentTopics.length > 0,
      skippedRecentTopics,
      skippedPublishedTopics,
      skippedSuppressedTopics,
      managerReviewRequired: false,
      selectionPolicy: policy,
    };
  }

  const selected = candidates[0] || null;
  return {
    selectedTopic: skippedSuppressedTopics.length > 0 ? null : String(selected?.title || topicScout?.selected_topic || '').trim() || null,
    selectedBucket: skippedSuppressedTopics.length > 0 ? null : String(selected?.bucket || topicScout?.selected_bucket || '').trim() || null,
    selectionReason: skippedSuppressedTopics.length > 0
      ? 'manager_review_required_no_fresh_winner'
      : String(selected?.why_now || topicScout?.selection_reason || 'no candidates'),
    topicScorecard: selected?.topic_scorecard || topicScout?.topic_scorecard || {},
    selectedRank: skippedSuppressedTopics.length > 0 ? 0 : selected?.rank || 1,
    cooldownApplied: skippedRecentTopics.length > 0,
    skippedRecentTopics,
    skippedPublishedTopics,
    skippedSuppressedTopics,
    managerReviewRequired: skippedSuppressedTopics.length > 0,
    selectionPolicy: lastSuppressedPolicy,
  };
}

function selectTopicWithCooldown(topicScout, recentTopics, cooldownHours) {
  return buildTopicSelection(topicScout, recentTopics, cooldownHours, {
    applySuppressionPolicy: false,
  });
}

function selectTopicAvoidingPublished(topicScout, recentTopics, publishedTitles, cooldownHours) {
  return buildTopicSelection(topicScout, recentTopics, cooldownHours, {
    ...(arguments[4] || {}),
    publishedTitles,
    applySuppressionPolicy: true,
  });
}

function getTopicScoutStaleReason(topicScout, maxAgeHours) {
  const age = Number(topicScout?.dashboard_age_hours);
  if (!Number.isFinite(age)) return null;
  const limit = Math.max(0, Number(maxAgeHours || 0));
  if (limit <= 0) return null;
  if (age <= limit) return null;
  return `article_quality_loop_dashboard_stale:${age}h>${limit}h`;
}

function normalizeTraceability(traceability) {
  return traceability && typeof traceability === 'object' && !Array.isArray(traceability)
    ? { ...traceability }
    : {};
}

async function resolveIssueIdentifier(client, issueId) {
  if (!issueId) return null;
  const result = await client.query(
    `select identifier
       from issues
      where id = $1
        and company_id = $2
      limit 1`,
    [issueId, COMPANY_ID],
  );
  const identifier = result.rows[0]?.identifier;
  return typeof identifier === 'string' && identifier.trim() ? identifier.trim() : null;
}

async function listRecentTopics(client, projectId, limit = 25) {
  const result = await client.query(
    `select id, topic, created_at
       from blog_runs
      where company_id = $1
        and project_id = $2
      order by created_at desc
      limit $3`,
    [COMPANY_ID, projectId, limit],
  );
  return result.rows;
}

async function loadTopicHistories(client, recentRuns, topicKeys) {
  const keys = new Set([...topicKeys].filter(Boolean));
  const filteredRuns = toArray(recentRuns).filter((entry) => keys.has(normalizeTopicKey(entry.topic)));
  if (filteredRuns.length === 0) return {};

  const runIds = filteredRuns.map((entry) => entry.id);
  const attemptsResult = await client.query(
    `select blog_run_id, result_json, updated_at, attempt_number
       from blog_run_step_attempts
      where blog_run_id = any($1::uuid[])
        and step_key = 'research'
        and status = 'completed'
      order by blog_run_id asc, updated_at desc, attempt_number desc`,
    [runIds],
  );
  const attemptsByRunId = new Map();
  for (const row of attemptsResult.rows) {
    if (!attemptsByRunId.has(row.blog_run_id)) {
      attemptsByRunId.set(row.blog_run_id, row.result_json || null);
    }
  }

  const artifactsResult = await client.query(
    `select blog_run_id, artifact_kind, metadata, body_preview
       from blog_artifacts
      where blog_run_id = any($1::uuid[])
        and step_key = 'research'
        and artifact_kind in ('grok_artifact_step_error', 'grok_trend_scan_json')
      order by created_at desc`,
    [runIds],
  );
  const artifactsByRunId = new Map();
  for (const row of artifactsResult.rows) {
    const list = artifactsByRunId.get(row.blog_run_id) || [];
    list.push({
      artifactKind: row.artifact_kind,
      metadata: row.metadata || null,
      bodyPreview: row.body_preview || null,
    });
    artifactsByRunId.set(row.blog_run_id, list);
  }

  const histories = {};
  for (const row of filteredRuns) {
    const topicKey = normalizeTopicKey(row.topic);
    const list = histories[topicKey] || [];
    list.push({
      id: row.id,
      run_id: row.id,
      topic: row.topic,
      created_at: row.created_at,
      research_result_json: attemptsByRunId.get(row.id) || null,
      artifacts: artifactsByRunId.get(row.id) || [],
    });
    histories[topicKey] = list;
  }
  return histories;
}

async function listPublishedTitles(limit = 50) {
  if (isDisabledValue(process.env.ARTICLE_LOOP_FETCH_PUBLISHED_TITLES)) {
    return [];
  }
  const base = WP_API_URL.endsWith('/') ? WP_API_URL : `${WP_API_URL}/`;
  const url = new URL(`posts?per_page=${limit}&_embed=1&orderby=date&order=desc&status=publish`, base);
  const request = {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'paperclip-article-loop/0.1',
    },
  };
  if (
    Number.isFinite(PUBLISHED_TITLES_TIMEOUT_MS) &&
    PUBLISHED_TITLES_TIMEOUT_MS > 0 &&
    typeof AbortSignal !== 'undefined' &&
    typeof AbortSignal.timeout === 'function'
  ) {
    request.signal = AbortSignal.timeout(PUBLISHED_TITLES_TIMEOUT_MS);
  }
  const res = await fetch(url.toString(), request);
  if (!res.ok) {
    throw new Error(`published_titles_fetch_failed:${res.status}`);
  }
  const posts = await res.json();
  return Array.isArray(posts)
    ? posts
      .map((post) => String(post?.title?.rendered || '').replace(/<[^>]+>/g, '').trim())
      .filter(Boolean)
    : [];
}

async function writeJson(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function writeTopicScoutSnapshot(runDir, topicScout) {
  const payload = toRecord(topicScout);
  if (Object.keys(payload).length === 0) return null;
  const filePath = path.join(runDir, 'topic-scout.json');
  await writeJson(filePath, payload);
  return filePath;
}

async function createRun({ topic, issueId, contextJson }) {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const normalizedContextJson = normalizeContext(topic, contextJson);
    const lastTouchedIssueIdentifier = await resolveIssueIdentifier(client, issueId);
    const existing = await client.query(
      `select id, topic, lane, target_site, publish_mode, wordpress_post_id, status, current_step, context_json, created_at, issue_id
         from blog_runs
        where company_id = $1
          and project_id = $2
          and topic = $3
          and status not in ('failed', 'public_verified', 'human_review_backlog')
        order by created_at desc
        limit 1`,
      [COMPANY_ID, PROJECT_ID, topic],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      const existingContextJson = normalizeContext(topic, row.context_json);
      const nextContextJson = {
        ...existingContextJson,
        ...normalizedContextJson,
        articleLoop: {
          ...toRecord(existingContextJson.articleLoop),
          ...toRecord(normalizedContextJson.articleLoop),
        },
      };
      const existingTraceability = normalizeTraceability(existingContextJson.traceability);
      const incomingTraceability = normalizeTraceability(normalizedContextJson.traceability);
      const traceability = {
        ...existingTraceability,
        ...incomingTraceability,
      };
      const originIssueIdentifier =
        typeof existingTraceability.originIssueIdentifier === 'string' && existingTraceability.originIssueIdentifier.trim()
          ? existingTraceability.originIssueIdentifier.trim()
          : typeof incomingTraceability.originIssueIdentifier === 'string' && incomingTraceability.originIssueIdentifier.trim()
            ? incomingTraceability.originIssueIdentifier.trim()
          : await resolveIssueIdentifier(client, row.issue_id);
      const touchedAt = new Date().toISOString();
      nextContextJson.traceability = {
        ...traceability,
        originIssueIdentifier: originIssueIdentifier || lastTouchedIssueIdentifier || null,
        lastTouchedIssueIdentifier: lastTouchedIssueIdentifier || traceability.lastTouchedIssueIdentifier || originIssueIdentifier || null,
        continuity: 'reused_existing_run',
        lastTouchedAt: touchedAt,
        reuseReason: REUSED_RUN_TRACEABILITY_REASON,
      };
      if (issueId) {
        nextContextJson.sourceRoutineIssueId = issueId;
      }
      const updated = await client.query(
        `update blog_runs
            set context_json = $2
          where id = $1
        returning id, topic, lane, target_site, publish_mode, wordpress_post_id, status, current_step, context_json, created_at`,
        [row.id, nextContextJson],
      );
      const reusedRow = updated.rows[0];
      const runDir = path.join(BLOG_RUNS_DIR, reusedRow.id);
      await writeJson(path.join(runDir, 'context.json'), {
        run_id: reusedRow.id,
        created_at: reusedRow.created_at instanceof Date ? reusedRow.created_at.toISOString() : new Date().toISOString(),
        topic: reusedRow.topic,
        lane: reusedRow.lane,
        target_site: reusedRow.target_site || TARGET_SITE,
        wordpress: {
          publish: reusedRow.publish_mode === 'publish',
          status: reusedRow.publish_mode === 'publish' ? 'publish' : 'draft',
          post_id: reusedRow.wordpress_post_id ?? null,
        },
        ...nextContextJson,
      });
      await writeTopicScoutSnapshot(runDir, nextContextJson.topicScout);
      return { reused: true, run: reusedRow };
    }

    const touchedAt = new Date().toISOString();
    const initialTraceability = normalizeTraceability(normalizedContextJson.traceability);
    normalizedContextJson.traceability = {
      ...initialTraceability,
      originIssueIdentifier: initialTraceability.originIssueIdentifier || lastTouchedIssueIdentifier || null,
      lastTouchedIssueIdentifier: lastTouchedIssueIdentifier || initialTraceability.lastTouchedIssueIdentifier || null,
      continuity: initialTraceability.continuity || 'created_new_run',
      lastTouchedAt: touchedAt,
    };

    const runId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const inserted = await client.query(
      `insert into blog_runs (
         id, company_id, project_id, issue_id, topic, lane, target_site, status, current_step,
         approval_mode, publish_mode, context_json
       ) values ($1,$2,$3,$4,$5,'publish',$6,'queued','research','manual','dry_run',$7)
       returning id, topic, status, current_step, context_json, created_at`,
      [runId, COMPANY_ID, PROJECT_ID, issueId || null, topic, TARGET_SITE, normalizedContextJson],
    );

    const runDir = path.join(BLOG_RUNS_DIR, runId);
    await writeJson(path.join(runDir, 'context.json'), {
      run_id: runId,
      created_at: createdAt,
      topic,
      lane: 'publish',
      target_site: TARGET_SITE,
      wordpress: { publish: false, status: 'draft', post_id: null },
      ...normalizedContextJson,
    });
    await writeTopicScoutSnapshot(runDir, normalizedContextJson.topicScout);
    await writeJson(path.join(runDir, 'status.json'), {
      phase: 'research',
      state: 'running',
      last_completed_step: null,
      next_step: 'research',
      error: null,
      updated_at: createdAt,
    });

    return { reused: false, run: inserted.rows[0] };
  } finally {
    await client.end();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const vertical = String(args.vertical || 'ai-tech').trim();
  const issueId = String(args['issue-id'] || process.env.PAPERCLIP_TASK_ID || '').trim() || null;
  const explicitTopic = String(args.topic || '').trim();
  process.env.ARTICLE_LOOP_REFRESH_VERTICAL = vertical;
  const dashboardRefresh = explicitTopic
    ? { ok: true, skipped: true, reason: 'manual_topic_override' }
    : await refreshDashboardIfConfigured().catch((error) => ({
      ok: false,
      error: String(error.message || error),
    }));
  const topicScout = explicitTopic
    ? {
        generated_at: new Date().toISOString(),
        selected_topic: explicitTopic,
        selected_bucket: String(args.bucket || '').trim() || null,
        selection_reason: 'manual_topic_override',
        topic_scorecard: {},
        top10_candidates: [],
        manual_topic_override: true,
      }
    : await runTopicScout(vertical);
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  let topic = null;
  let selectedBucket = null;
  let selectionReason = null;
  let topicScorecard = {};
  let selectedRank = 1;
  let cooldownApplied = false;
  let skippedRecentTopics = [];
  let skippedPublishedTopics = [];
  let issueIdentifier = null;
  try {
    const recentTopics = await listRecentTopics(client, PROJECT_ID);
    const publishedTitles = explicitTopic ? [] : await listPublishedTitles().catch(() => []);
    issueIdentifier = await resolveIssueIdentifier(client, issueId);
    const candidateTopicKeys = new Set(
      [
        normalizeTopicKey(topicScout?.selected_topic),
        ...toArray(topicScout?.top10_candidates).map((entry) => normalizeTopicKey(entry?.title)),
      ].filter(Boolean),
    );
    const topicHistories = explicitTopic ? {} : await loadTopicHistories(client, recentTopics, candidateTopicKeys);
    const selected = resolveTopicSelectionFromArgs(
      args,
      topicScout,
      recentTopics,
      publishedTitles,
      TOPIC_COOLDOWN_HOURS,
      {
        topicHistories,
        referenceAt: topicScout?.generated_at,
        suppressionThreshold: HOLDOVER_SUPPRESSION_THRESHOLD,
        repeatWindowHours: HOLDOVER_WINDOW_HOURS,
      },
    );
    topic = selected.selectedTopic;
    selectedBucket = selected.selectedBucket;
    selectionReason = selected.selectionReason;
    topicScorecard = selected.topicScorecard;
    selectedRank = selected.selectedRank;
    cooldownApplied = selected.cooldownApplied;
    skippedRecentTopics = selected.skippedRecentTopics;
    skippedPublishedTopics = selected.skippedPublishedTopics;
    if (selected.selectionPolicy) {
      topicScout.selection_policy = selected.selectionPolicy;
    }
    topicScout.skipped_suppressed_topics = selected.skippedSuppressedTopics || [];
    topicScout.manager_review_required = selected.managerReviewRequired === true;
  } finally {
    await client.end();
  }
  const staleReason = explicitTopic ? null : getTopicScoutStaleReason(topicScout, RSS_MAX_AGE_HOURS);
  if (staleReason) {
    throw new Error(staleReason);
  }
  if (!explicitTopic && topicScout.manager_review_required === true && !topic) {
    throw new Error('article_quality_loop_manager_review_required:no_fresh_winner');
  }
  if (!topic) {
    throw new Error('article_quality_loop_topic_missing');
  }
  topicScout.selected_topic = topic;
  topicScout.selected_bucket = selectedBucket;
  topicScout.selection_reason = selectionReason;
  topicScout.topic_scorecard = topicScorecard;
  topicScout.cooldown_applied = cooldownApplied;
  topicScout.skipped_recent_topics = skippedRecentTopics;
  topicScout.skipped_published_topics = skippedPublishedTopics;
  topicScout.selected_rank = selectedRank;
  topicScout.traceability_issue_identifier = issueIdentifier || null;
  const result = await createRun({
    topic,
    issueId,
    contextJson: buildContext(topicScout, vertical, issueId),
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    vertical,
    topic,
    dashboardRefresh,
    reused: result.reused,
    run: result.run,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error.message || error) }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  summarizeTopicSelectionPolicy,
  normalizeTopicKey,
  selectTopicWithCooldown,
  selectTopicAvoidingPublished,
  resolveTopicSelectionFromArgs,
  getTopicScoutStaleReason,
};
