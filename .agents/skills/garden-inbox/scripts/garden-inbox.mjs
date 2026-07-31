#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
const OFFERED_BUCKETS = new Set(["A", "B", "C"]);
const DEFAULT_STALE_DAYS = 60;
const INTERACTION_LIMIT = 200;
const INBOX_MINE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done"];
const INBOX_QUERY_CAP = 500;

class ApiError extends Error {
  constructor(status, message, body = null) {
    super(`${status}: ${message}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function usage() {
  return `Usage:
  garden-inbox.mjs [scan] [--user-id UUID] [--stale-days 60] [--output-dir DIR]
  garden-inbox.mjs confirm [--issue-id ID] [--candidates FILE] [--dry-run]
  garden-inbox.mjs apply [--issue-id ID] (--interaction-id ID | --interaction-file FILE) [--candidates FILE] [--dry-run]

Common environment:
  PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_RUN_ID, PAPERCLIP_TASK_ID`;
}

function parseArgs(argv) {
  const args = [...argv];
  let command = "scan";
  if (args[0] && !args[0].startsWith("-")) command = args.shift();
  if (!["scan", "confirm", "apply"].includes(command)) throw new Error(`Unknown command: ${command}`);

  const options = {};
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replaceAll("-", "_");
    if (key === "dry_run") {
      options[key] = true;
      continue;
    }
    const value = args.shift();
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} requires a value`);
    if (options[key] === undefined) options[key] = value;
    else options[key] = Array.isArray(options[key]) ? [...options[key], value] : [options[key], value];
  }
  return { command, options };
}

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function normalizeApiBase(value) {
  let base = required(value, "PAPERCLIP_API_URL").replace(/\/+$/, "");
  if (base.endsWith("/api")) base = base.slice(0, -4);
  return base;
}

function runtime(options, { requireApi = true } = {}) {
  const apiUrl = options.api_url ?? process.env.PAPERCLIP_API_URL;
  const apiKey = options.api_key ?? process.env.PAPERCLIP_API_KEY;
  return {
    apiBase: requireApi ? normalizeApiBase(apiUrl) : (apiUrl ? normalizeApiBase(apiUrl) : null),
    apiKey: requireApi ? required(apiKey, "PAPERCLIP_API_KEY") : apiKey ?? null,
    runId: options.run_id ?? process.env.PAPERCLIP_RUN_ID ?? null,
  };
}

async function apiRequest(context, path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json", Authorization: `Bearer ${context.apiKey}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && context.runId) headers["X-Paperclip-Run-Id"] = context.runId;
  const response = await fetch(`${context.apiBase}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!response.ok) {
    const message = parsed && typeof parsed === "object"
      ? parsed.error ?? parsed.message ?? response.statusText
      : parsed ?? response.statusText;
    throw new ApiError(response.status, String(message), parsed);
  }
  return parsed;
}

function decodeJwtPayload(token) {
  const parts = required(token, "PAPERCLIP_API_KEY").split(".");
  if (parts.length < 2) throw new Error("PAPERCLIP_API_KEY is not a JWT; pass --user-id explicitly");
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Could not decode the PAPERCLIP_API_KEY JWT payload; pass --user-id explicitly");
  }
}

function resolveUserId(options, apiKey) {
  if (options.user_id) return required(options.user_id, "--user-id");
  const userId = decodeJwtPayload(apiKey).responsible_user_id;
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new Error("Run JWT has no responsible_user_id; pass --user-id explicitly");
  }
  return userId.trim();
}

function parsePositiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) {
    throw new Error(`${name} must be an integer from 1 to 3650`);
  }
  return parsed;
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function latestDate(...values) {
  return values.flat().map(validDate).filter(Boolean).sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
}

function runGit(args, cwd) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  } catch {
    return "";
  }
}

function gitLastCommitAt(branchName, roots) {
  if (!branchName) return null;
  for (const root of [...new Set(roots.filter(Boolean))]) {
    const parsed = validDate(runGit(["log", "-1", "--format=%cI", branchName], root));
    if (parsed) return parsed;
  }
  return null;
}

function findLocalBranch(identifier, roots) {
  if (!identifier) return null;
  const needle = identifier.toLowerCase();
  for (const root of [...new Set(roots.filter(Boolean))]) {
    const branches = runGit(["for-each-ref", "--format=%(refname:short)", "refs/heads"], root)
      .split("\n").map((branch) => branch.trim()).filter(Boolean)
      .filter((branch) => branch.toLowerCase().includes(needle));
    if (branches.length === 1) return branches[0];
  }
  return null;
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

async function fetchMineInboxRows(context, userId) {
  const statusResults = await Promise.all(INBOX_MINE_STATUSES.map(async (status) => {
    const query = new URLSearchParams({ userId, status });
    const rows = await apiRequest(context, `/agents/me/inbox/mine?${query}`);
    if (!Array.isArray(rows)) throw new Error(`Inbox API returned a non-array response for status ${status}`);
    return { status, rows };
  }));
  const rowsById = new Map();
  const statusCounts = {};
  const cappedStatuses = [];
  let duplicateCount = 0;
  for (const { status, rows } of statusResults) {
    statusCounts[status] = rows.length;
    if (rows.length >= INBOX_QUERY_CAP) cappedStatuses.push(status);
    for (const issue of rows) {
      if (rowsById.has(issue.id)) duplicateCount += 1;
      rowsById.set(issue.id, issue);
    }
  }
  return {
    rows: [...rowsById.values()],
    coverage: {
      strategy: "per_status",
      queryCap: INBOX_QUERY_CAP,
      statusCounts,
      cappedStatuses,
      duplicateCount,
      complete: cappedStatuses.length === 0,
    },
  };
}

async function inspectWorkspace(context, workspaceId, issueIdentifiers, gitRoot) {
  let workspace = null;
  let readiness = null;
  let gone = false;
  let error = null;
  try {
    workspace = await apiRequest(context, `/execution-workspaces/${encodeURIComponent(workspaceId)}`);
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) gone = true;
    else error = caught.message;
  }
  if (workspace) {
    try {
      readiness = await apiRequest(context, `/execution-workspaces/${encodeURIComponent(workspaceId)}/close-readiness`);
    } catch (caught) {
      error = error ?? caught.message;
    }
  }

  const roots = [workspace?.cwd, workspace?.providerRef, readiness?.git?.repoRoot, readiness?.git?.workspacePath, gitRoot];
  let branchName = workspace?.branchName ?? readiness?.git?.branchName ?? null;
  if (!branchName && gone) {
    const matches = issueIdentifiers.map((identifier) => findLocalBranch(identifier, roots)).filter(Boolean);
    if (new Set(matches).size === 1) branchName = matches[0];
  }
  const branchCommitAt = gitLastCommitAt(branchName, roots);
  return {
    id: workspaceId,
    gone,
    error,
    status: workspace?.status ?? null,
    branchName,
    lastUsedAt: workspace?.lastUsedAt ?? null,
    branchCommitAt: branchCommitAt?.toISOString() ?? null,
    readiness,
  };
}

function reason(code, message, facts = {}) {
  return { code, message, facts };
}

function classify(issue, workspaceInfo, staleDays, now) {
  const terminal = TERMINAL_STATUSES.has(issue.status);
  const workspaceArchived = workspaceInfo?.status === "archived";
  const workspaceGone = Boolean(workspaceInfo?.gone);
  const readiness = workspaceInfo?.readiness ?? null;
  const linkedIssues = Array.isArray(readiness?.linkedIssues) ? readiness.linkedIssues : [];
  const allLinkedIssuesTerminal = Boolean(readiness) && linkedIssues.every((linked) => linked.isTerminal === true);
  const mergedIntoBase = readiness?.git?.isMergedIntoBase === true;
  const aheadCount = Number.isInteger(readiness?.git?.aheadCount) ? readiness.git.aheadCount : null;
  const blockerAttention = issue.blockerAttention?.state;
  const hasOpenBlockers = issue.status === "blocked"
    || (Array.isArray(issue.blockedBy) && issue.blockedBy.some((blocker) => !TERMINAL_STATUSES.has(blocker.status)))
    || (typeof blockerAttention === "string" && blockerAttention !== "none");
  const awaitingUser = issue.blockedInboxAttention?.state === "awaiting_decision"
    || (issue.status === "in_review" && Boolean(issue.assigneeUserId));
  const issueActivity = latestDate(issue.lastActivityAt, issue.updatedAt, issue.createdAt);
  const branchActivity = latestDate(workspaceInfo?.branchCommitAt, workspaceInfo?.lastUsedAt);
  const lastActivity = latestDate(issueActivity, branchActivity) ?? new Date(0);
  const cutoff = new Date(now.getTime() - staleDays * 86_400_000);
  const stale = lastActivity.getTime() <= cutoff.getTime();
  const facts = {
    issueStatus: issue.status,
    workspaceStatus: workspaceInfo?.status ?? null,
    workspaceGone,
    workspaceInspectionError: workspaceInfo?.error ?? null,
    mergedIntoBase,
    allLinkedIssuesTerminal,
    aheadCount,
    staleDays,
  };

  if (workspaceInfo?.error) {
    return {
      bucket: "D",
      reason: reason("workspace_inspection_failed", "Keep: workspace archive safety could not be verified.", facts),
      lastActivity,
    };
  }
  if (hasOpenBlockers) return { bucket: "D", reason: reason("open_blockers", "Keep: the issue has unresolved blocker or liveness attention.", facts), lastActivity };
  if (awaitingUser) return { bucket: "D", reason: reason("pending_user_action", "Keep: the issue is awaiting a user decision or review.", facts), lastActivity };
  if (!terminal) {
    const code = issue.status === "in_review" ? "pending_interaction_or_review" : "non_terminal_status";
    return { bucket: "D", reason: reason(code, `Keep: issue status ${issue.status} is not terminal.`, facts), lastActivity };
  }
  if ((mergedIntoBase || workspaceArchived) && allLinkedIssuesTerminal) {
    const code = workspaceArchived ? "workspace_archived_finished" : "merged_finished";
    return { bucket: "A", reason: reason(code, "Archive candidate: work is merged or archived and every linked issue is terminal.", facts), lastActivity };
  }
  if (!stale) return { bucket: "D", reason: reason("recent_activity", `Keep: activity is newer than ${staleDays} days.`, facts), lastActivity };
  if (aheadCount !== null && aheadCount > 0) {
    return { bucket: "C", reason: reason("stale_unmerged_commits", `Review manually: stale branch is ${aheadCount} commit(s) ahead of base.`, facts), lastActivity };
  }
  if (terminal || workspaceGone) {
    return { bucket: "B", reason: reason("stale_terminal_or_workspace_gone", `Archive candidate: no issue or branch activity for at least ${staleDays} days and the issue is terminal or workspace is gone.`, facts), lastActivity };
  }
  return { bucket: "D", reason: reason("insufficient_archive_evidence", "Keep: archive safety conditions were not met.", facts), lastActivity };
}

function candidateFrom(issue, workspace, classification) {
  return {
    issueId: issue.id,
    identifier: issue.identifier ?? null,
    title: issue.title,
    bucket: classification.bucket,
    reason: classification.reason,
    executionWorkspaceId: issue.executionWorkspaceId ?? null,
    workspaceStatus: workspace?.status ?? null,
    workspaceGone: Boolean(workspace?.gone),
    branchName: workspace?.branchName ?? null,
    lastActivityAt: classification.lastActivity.toISOString(),
  };
}

function markdownEscape(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderReport(scanResult) {
  const labels = {
    A: "A — merged and finished (default checked)",
    B: "B — stale (default checked)",
    C: "C — stale but unmerged (default unchecked)",
    D: "D — keep (not offered)",
  };
  const lines = [
    "# Garden inbox scan", "",
    `- Generated: ${scanResult.generatedAt}`,
    `- Target user: \`${scanResult.userId}\``,
    `- Stale threshold: ${scanResult.staleDays} days`,
    `- Inbox rows classified: ${scanResult.items.length}`,
    `- Archive candidates: ${scanResult.candidates.length}`,
    `- Scan coverage: ${scanResult.coverage.complete ? "complete across per-status queries" : "possibly truncated"}`,
  ];
  if (!scanResult.coverage.complete) {
    lines.push(
      "",
      "> [!WARNING]",
      `> Coverage may be incomplete: ${scanResult.coverage.cappedStatuses.map((status) => `\`${status}\``).join(", ")} returned at least ${scanResult.coverage.queryCap} rows, the Mine endpoint cap.`,
    );
  }
  for (const bucket of ["A", "B", "C", "D"]) {
    const items = scanResult.items.filter((item) => item.bucket === bucket);
    lines.push("", `## ${labels[bucket]} (${items.length})`, "");
    if (items.length === 0) {
      lines.push("_None._");
      continue;
    }
    lines.push("| Issue | Title | Reason | Workspace / branch | Last activity |", "|---|---|---|---|---|");
    for (const item of items) {
      const issue = item.identifier ? `\`${markdownEscape(item.identifier)}\`` : `\`${item.issueId}\``;
      const workspace = [item.workspaceStatus, item.branchName].filter(Boolean).join(" / ") || (item.workspaceGone ? "gone" : "none");
      lines.push(`| ${issue} | ${markdownEscape(item.title)} | \`${item.reason.code}\` — ${markdownEscape(item.reason.message)} | ${markdownEscape(workspace)} | ${item.lastActivityAt} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function writeText(path, contents) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function stableScanId(scanResult) {
  const fingerprint = {
    userId: scanResult.userId,
    staleDays: scanResult.staleDays,
    generatedAt: scanResult.generatedAt,
    candidates: scanResult.candidates.map((item) => ({
      issueId: item.issueId,
      bucket: item.bucket,
      reason: item.reason.code,
      lastActivityAt: item.lastActivityAt,
    })),
  };
  return createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex").slice(0, 24);
}

async function scan(options) {
  const context = runtime(options);
  const userId = resolveUserId(options, context.apiKey);
  const staleDays = parsePositiveInteger(options.stale_days, DEFAULT_STALE_DAYS, "--stale-days");
  const now = options.now ? validDate(options.now) : new Date();
  if (!now) throw new Error("--now must be an ISO date");
  const outputDir = options.output_dir ?? ".";
  const candidatesPath = options.candidates ?? resolve(outputDir, "candidates.json");
  const reportPath = options.report ?? resolve(outputDir, "garden-inbox-report.md");

  const { rows, coverage } = await fetchMineInboxRows(context, userId);
  const issuesByWorkspace = new Map();
  for (const issue of rows) {
    if (!issue.executionWorkspaceId) continue;
    const identifiers = issuesByWorkspace.get(issue.executionWorkspaceId) ?? [];
    if (issue.identifier) identifiers.push(issue.identifier);
    issuesByWorkspace.set(issue.executionWorkspaceId, identifiers);
  }
  const workspaceIds = [...issuesByWorkspace.keys()];
  const inspected = await mapLimit(workspaceIds, 8, (workspaceId) => inspectWorkspace(
    context, workspaceId, issuesByWorkspace.get(workspaceId), options.git_root ?? process.cwd(),
  ));
  const workspaceById = new Map(inspected.map((entry) => [entry.id, entry]));
  const items = rows.map((issue) => {
    const workspace = issue.executionWorkspaceId ? workspaceById.get(issue.executionWorkspaceId) ?? null : null;
    return candidateFrom(issue, workspace, classify(issue, workspace, staleDays, now));
  });
  const scanResult = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    userId,
    staleDays,
    sourceCount: rows.length,
    coverage,
    items,
    candidates: items.filter((item) => OFFERED_BUCKETS.has(item.bucket)),
  };
  scanResult.scanId = stableScanId(scanResult);
  const output = {
    schemaVersion: 1,
    scanId: scanResult.scanId,
    generatedAt: scanResult.generatedAt,
    userId,
    staleDays,
    sourceCount: rows.length,
    coverage,
    candidates: scanResult.candidates,
    kept: items.filter((item) => item.bucket === "D"),
  };
  const candidatesFile = writeText(candidatesPath, `${JSON.stringify(output, null, 2)}\n`);
  const report = renderReport(scanResult);
  const reportFile = writeText(reportPath, report);
  process.stdout.write(`${report}\nCandidates JSON: ${candidatesFile}\nReport: ${reportFile}\n`);
  return output;
}

function truncate(value, limit) {
  const text = String(value ?? "").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function candidateFile(options) {
  const data = readJson(options.candidates ?? "candidates.json");
  if (data?.schemaVersion !== 1
    || typeof data.scanId !== "string"
    || typeof data.userId !== "string"
    || data.userId.trim() === ""
    || !Array.isArray(data.candidates)) {
    throw new Error("Candidates file is not a garden-inbox schemaVersion 1 scan");
  }
  for (const item of data.candidates) {
    if (!item?.issueId || !OFFERED_BUCKETS.has(item.bucket)) {
      throw new Error("Candidates file contains an invalid or non-offered item");
    }
  }
  return data;
}

function archiveTargetBody(scanData) {
  return { userId: scanData.userId };
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function confirmationBody(scanData, candidates, index, count) {
  const options = candidates.map((candidate) => ({
    id: candidate.issueId,
    label: truncate(`${candidate.identifier ?? candidate.issueId} — ${candidate.title}`, 120),
    description: truncate(`${candidate.reason.message} Last activity: ${candidate.lastActivityAt}.`, 500),
  }));
  const part = count > 1 ? ` (${index + 1}/${count})` : "";
  return {
    kind: "request_checkbox_confirmation",
    idempotencyKey: `garden-inbox:${scanData.scanId}:${index + 1}:${count}`,
    title: `Confirm inbox archive candidates${part}`,
    summary: `Choose which reversible inbox entries to archive${part}.`,
    continuationPolicy: "wake_assignee",
    payload: {
      version: 1,
      prompt: `Select the inbox entries to archive${part}. Unchecked entries will remain visible.`,
      options,
      defaultSelectedOptionIds: candidates
        .filter((candidate) => candidate.bucket === "A" || candidate.bucket === "B")
        .map((candidate) => candidate.issueId),
      minSelected: 0,
      acceptLabel: "Archive selected",
      rejectLabel: "Keep everything",
      detailsMarkdown: `Scan \`${scanData.scanId}\` used a ${scanData.staleDays}-day stale threshold. Buckets A and B start checked; stale branches with unmerged commits (C) start unchecked. Archiving changes only this user's inbox visibility and is reversible.`,
    },
  };
}

async function confirm(options) {
  const data = candidateFile(options);
  const drivingIssueId = options.issue_id ?? process.env.PAPERCLIP_TASK_ID;
  if (!options.dry_run) required(drivingIssueId, "--issue-id or PAPERCLIP_TASK_ID");
  const groups = chunk(data.candidates, INTERACTION_LIMIT);
  if (groups.length === 0) {
    process.stdout.write("No archive candidates; no confirmation interaction created.\n");
    return [];
  }
  const bodies = groups.map((candidates, index) => confirmationBody(data, candidates, index, groups.length));
  if (options.dry_run) {
    process.stdout.write(`${JSON.stringify({ dryRun: true, issueId: drivingIssueId ?? null, interactions: bodies }, null, 2)}\n`);
    return bodies;
  }

  const context = runtime(options);
  const created = [];
  for (const body of bodies) {
    created.push(await apiRequest(context, `/issues/${encodeURIComponent(drivingIssueId)}/interactions`, {
      method: "POST",
      body,
    }));
  }
  process.stdout.write(`${JSON.stringify({
    scanId: data.scanId,
    createdInteractions: created.map((item) => ({
      id: item.id,
      status: item.status,
      idempotencyKey: item.idempotencyKey,
    })),
  }, null, 2)}\n`);
  return created;
}

function flattenInteractionFile(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.interactions)) return value.interactions;
  if (value?.interaction && typeof value.interaction === "object") return [value.interaction];
  return value && typeof value === "object" ? [value] : [];
}

function optionValues(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

async function resolveInteractions(options, context, drivingIssueId) {
  const files = optionValues(options.interaction_file);
  const ids = optionValues(options.interaction_id);
  const fromFiles = files.flatMap((file) => flattenInteractionFile(readJson(file)));
  if (ids.length === 0) return fromFiles;
  required(drivingIssueId, "--issue-id or PAPERCLIP_TASK_ID");
  const live = await apiRequest(context, `/issues/${encodeURIComponent(drivingIssueId)}/interactions`);
  if (!Array.isArray(live)) throw new Error("Interactions API returned a non-array response");
  const byId = new Map(live.map((interaction) => [interaction.id, interaction]));
  for (const id of ids) {
    if (!byId.has(id)) throw new Error(`Interaction ${id} was not found on the driving issue`);
    fromFiles.push(byId.get(id));
  }
  return fromFiles;
}

function acceptedCandidates(interaction, scanData, candidateById) {
  if (interaction?.kind !== "request_checkbox_confirmation") {
    throw new Error(`Interaction ${interaction?.id ?? "(unknown)"} is not request_checkbox_confirmation`);
  }
  if (typeof interaction.idempotencyKey !== "string"
    || !interaction.idempotencyKey.startsWith(`garden-inbox:${scanData.scanId}:`)) {
    throw new Error(`Interaction ${interaction.id ?? "(unknown)"} does not belong to scan ${scanData.scanId}`);
  }
  if (interaction.status !== "accepted" || interaction.result?.outcome !== "accepted") return [];
  const selected = interaction.result?.selectedOptionIds ?? [];
  if (!Array.isArray(selected)) throw new Error("Accepted interaction has invalid selectedOptionIds");
  const optionIds = new Set((interaction.payload?.options ?? []).map((option) => option.id));
  const seen = new Set();
  return selected.map((issueId) => {
    if (seen.has(issueId)) throw new Error(`Interaction selected duplicate option id ${issueId}`);
    seen.add(issueId);
    if (!optionIds.has(issueId)) throw new Error(`Selected id ${issueId} was not an option in the interaction`);
    const candidate = candidateById.get(issueId);
    if (!candidate || !OFFERED_BUCKETS.has(candidate.bucket)) {
      throw new Error(`Selected id ${issueId} is not an offered candidate in the originating scan`);
    }
    return candidate;
  });
}

function renderApplySummary(results, interactions, dryRun, userId) {
  const lines = [
    `# Garden inbox ${dryRun ? "dry-run " : ""}apply summary`, "",
    `- Interactions inspected: ${interactions.length}`,
    `- Entries ${dryRun ? "that would be archived" : "archived"}: ${results.filter((result) => result.ok).length}`,
    `- Failures: ${results.filter((result) => !result.ok).length}`,
  ];
  if (results.length === 0) {
    lines.push("", "Nothing was archived: the interaction was rejected, unresolved, expired, or accepted with no selections.");
  }
  for (const result of results) {
    lines.push("", `- ${result.ok ? "OK" : "FAILED"}: ${result.identifier ?? result.issueId} — ${result.message}`);
    if (result.ok) {
      lines.push(`  Undo: \`DELETE /api/issues/${result.issueId}/inbox-archive\` with body \`${JSON.stringify({ userId })}\`, or use **Unarchive** in the issue properties pane.`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function applyAccepted(options) {
  const data = candidateFile(options);
  const drivingIssueId = options.issue_id ?? process.env.PAPERCLIP_TASK_ID ?? null;
  const needsLiveApi = optionValues(options.interaction_id).length > 0 || !options.dry_run;
  const context = runtime(options, { requireApi: needsLiveApi });
  const interactions = await resolveInteractions(options, context, drivingIssueId);
  if (interactions.length === 0) throw new Error("Provide --interaction-id or --interaction-file");
  const candidateById = new Map(data.candidates.map((candidate) => [candidate.issueId, candidate]));
  const accepted = [];
  const seen = new Set();
  for (const interaction of interactions) {
    for (const candidate of acceptedCandidates(interaction, data, candidateById)) {
      if (!seen.has(candidate.issueId)) accepted.push(candidate);
      seen.add(candidate.issueId);
    }
  }

  const results = [];
  for (const candidate of accepted) {
    if (options.dry_run) {
      results.push({ ...candidate, ok: true, message: "would archive this accepted inbox entry" });
      continue;
    }
    try {
      await apiRequest(context, `/issues/${encodeURIComponent(candidate.issueId)}/inbox-archive`, {
        method: "POST",
        body: archiveTargetBody(data),
      });
      results.push({ ...candidate, ok: true, message: "archived accepted inbox entry" });
    } catch (error) {
      results.push({ ...candidate, ok: false, message: error.message });
    }
  }

  const summary = renderApplySummary(results, interactions, Boolean(options.dry_run), data.userId);
  process.stdout.write(summary);
  if (options.summary) writeText(options.summary, summary);
  if (results.some((result) => !result.ok)) process.exitCode = 1;
  return results;
}

export {
  acceptedCandidates,
  archiveTargetBody,
  classify,
  confirm,
  decodeJwtPayload,
  fetchMineInboxRows,
  normalizeApiBase,
  scan,
};

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === "scan") await scan(options);
  else if (command === "confirm") await confirm(options);
  else await applyAccepted(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`garden-inbox: ${error.message}\n`);
    process.exitCode = 1;
  });
}
