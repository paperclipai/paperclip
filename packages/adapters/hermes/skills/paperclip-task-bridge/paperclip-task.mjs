#!/usr/bin/env node

import fs from "node:fs/promises";

const STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"]);
const PRIORITIES = new Set(["critical", "high", "medium", "low"]);
const WORK_MODES = new Set(["standard", "ask", "planning"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const HELP = `Paperclip task bridge for Hermes

Usage:
  paperclip-task.mjs list-assigned [--status todo,in_progress,in_review,blocked] [--limit 20]
  paperclip-task.mjs create-task --title <title> [--description <text>|--description-file <path|->] [options]
  paperclip-task.mjs comment --issue <id|identifier> (--body <text>|--body-file <path|->) [--resume|--reopen]
  paperclip-task.mjs update-status --issue <id|identifier> --status <status> [--comment <text>|--comment-file <path|->]

Environment:
  PAPERCLIP_API_URL    Paperclip base URL, with or without /api.
  PAPERCLIP_BRIDGE_API_KEY
                       Task-bridge Paperclip API key with kind=task_bridge scope.
  PAPERCLIP_API_KEY    Fallback bridge key env var. Do not use a full agent key.
  PAPERCLIP_COMPANY_ID Optional company id override.
  PAPERCLIP_AGENT_ID   Optional agent id override.
  PAPERCLIP_RUN_ID     Optional run id for X-Paperclip-Run-Id on mutations.

create-task options:
  --assignee-agent-id <uuid|self>  Assign to an agent. Defaults to self.
  --unassigned                    Create backlog/unassigned work.
  --parent-id <uuid>              Parent issue id.
  --goal-id <uuid>                Goal id.
  --project-id <uuid>             Project id.
  --priority <critical|high|medium|low>
  --status <backlog|todo|in_progress|in_review|done|blocked|cancelled>
  --work-mode <standard|ask|planning>

Output is JSON and never includes credentials.`;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

class ApiError extends Error {
  constructor(status, body) {
    const message = typeof body?.error === "string" ? body.error : `Paperclip API request failed with status ${status}`;
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function readStringFlag(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value;
}

function requireStringFlag(args, name) {
  const value = readStringFlag(args, name);
  if (!value) throw new UsageError(`Missing required --${name}`);
  return value;
}

function boolFlag(args, name) {
  return args[name] === true;
}

function normalizeApiBaseUrl(raw) {
  if (!raw || typeof raw !== "string" || raw.trim().length === 0) {
    throw new UsageError("PAPERCLIP_API_URL is required");
  }
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

function getConfig() {
  const apiKey = process.env.PAPERCLIP_BRIDGE_API_KEY?.trim() || process.env.PAPERCLIP_API_KEY?.trim();
  if (!apiKey) throw new UsageError("PAPERCLIP_BRIDGE_API_KEY is required");
  return {
    apiBaseUrl: normalizeApiBaseUrl(process.env.PAPERCLIP_API_URL),
    apiKey,
    runId: process.env.PAPERCLIP_RUN_ID?.trim() || null,
    companyId: process.env.PAPERCLIP_COMPANY_ID?.trim() || null,
    agentId: process.env.PAPERCLIP_AGENT_ID?.trim() || null,
  };
}

async function readBody(args, textFlag, fileFlag) {
  const direct = readStringFlag(args, textFlag);
  const file = readStringFlag(args, fileFlag);
  if (direct && file) throw new UsageError(`Use either --${textFlag} or --${fileFlag}, not both`);
  if (direct) return direct;
  if (!file) return null;
  if (file === "-") {
    return await new Promise((resolve, reject) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        data += chunk;
      });
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", reject);
    });
  }
  return fs.readFile(file, "utf8");
}

async function apiFetch(config, path, options = {}) {
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: "application/json",
    ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(options.mutating && config.runId ? { "X-Paperclip-Run-Id": config.runId } : {}),
  };
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text.slice(0, 1000) };
    }
  }
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

async function resolveIdentity(config) {
  if (config.companyId && config.agentId) {
    return { companyId: config.companyId, agentId: config.agentId, agent: null };
  }
  const agent = await apiFetch(config, "/agents/me");
  const companyId = config.companyId || agent.companyId;
  const agentId = config.agentId || agent.id;
  if (!companyId || !agentId) throw new ApiError(500, { error: "Paperclip identity response did not include companyId and agent id" });
  return { companyId, agentId, agent };
}

function issueSummary(issue) {
  if (!issue || typeof issue !== "object") return issue;
  return {
    id: issue.id ?? null,
    identifier: issue.identifier ?? null,
    title: issue.title ?? null,
    status: issue.status ?? null,
    priority: issue.priority ?? null,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    assigneeUserId: issue.assigneeUserId ?? null,
    projectId: issue.projectId ?? null,
    goalId: issue.goalId ?? null,
    parentId: issue.parentId ?? null,
    updatedAt: issue.updatedAt ?? null,
  };
}

function commentSummary(comment) {
  if (!comment || typeof comment !== "object") return comment;
  return {
    id: comment.id ?? null,
    issueId: comment.issueId ?? null,
    authorType: comment.authorType ?? null,
    authorAgentId: comment.authorAgentId ?? null,
    createdAt: comment.createdAt ?? null,
  };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function validateEnum(value, allowed, label) {
  if (!allowed.has(value)) {
    throw new UsageError(`Invalid ${label}: ${value}`);
  }
  return value;
}

function parseLimit(args) {
  const raw = readStringFlag(args, "limit");
  if (!raw) return 20;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || value > 100) {
    throw new UsageError("--limit must be an integer from 1 to 100");
  }
  return value;
}

async function listAssigned(config, args) {
  const identity = await resolveIdentity(config);
  const status = readStringFlag(args, "status") || "todo,in_progress,in_review,blocked";
  const limit = parseLimit(args);
  const issues = await apiFetch(config, "/agents/me/inbox-lite");
  const allowedStatuses = new Set(status.split(",").map((entry) => entry.trim()).filter(Boolean));
  const filteredIssues = Array.isArray(issues)
    ? issues.filter((issue) => !allowedStatuses.size || allowedStatuses.has(issue?.status)).slice(0, limit)
    : [];
  printJson({
    command: "list-assigned",
    companyId: identity.companyId,
    agentId: identity.agentId,
    count: filteredIssues.length,
    issues: filteredIssues.map(issueSummary),
  });
}

async function createTask(config, args) {
  const identity = await resolveIdentity(config);
  const title = requireStringFlag(args, "title");
  const description = await readBody(args, "description", "description-file");
  const unassigned = boolFlag(args, "unassigned");
  const assigneeRaw = readStringFlag(args, "assignee-agent-id");
  const assigneeAgentId = unassigned
    ? undefined
    : !assigneeRaw || assigneeRaw === "self"
      ? identity.agentId
      : assigneeRaw;
  if (assigneeAgentId !== undefined && !UUID_RE.test(assigneeAgentId)) {
    throw new UsageError("--assignee-agent-id must be a UUID, self, or omitted");
  }
  const priority = readStringFlag(args, "priority") ?? "medium";
  const workMode = readStringFlag(args, "work-mode") ?? "standard";
  validateEnum(priority, PRIORITIES, "priority");
  validateEnum(workMode, WORK_MODES, "work mode");
  const body = {
    title,
    description,
    priority,
    workMode,
    ...(assigneeAgentId !== undefined ? { assigneeAgentId } : {}),
  };
  for (const [flag, field] of [
    ["parent-id", "parentId"],
    ["goal-id", "goalId"],
    ["project-id", "projectId"],
  ]) {
    const value = readStringFlag(args, flag);
    if (value) body[field] = value;
  }
  const status = readStringFlag(args, "status");
  if (status) body.status = validateEnum(status, STATUSES, "status");

  const issue = await apiFetch(config, `/companies/${encodeURIComponent(identity.companyId)}/issues`, {
    method: "POST",
    mutating: true,
    body,
  });
  printJson({ command: "create-task", issue: issueSummary(issue) });
}

async function comment(config, args) {
  const issueRef = requireStringFlag(args, "issue");
  const bodyText = await readBody(args, "body", "body-file");
  if (!bodyText || bodyText.trim().length === 0) throw new UsageError("comment requires --body or --body-file");
  const commentBody = {
    body: bodyText,
    ...(boolFlag(args, "resume") ? { resume: true } : {}),
    ...(boolFlag(args, "reopen") ? { reopen: true } : {}),
  };
  const created = await apiFetch(config, `/issues/${encodeURIComponent(issueRef)}/comments`, {
    method: "POST",
    mutating: true,
    body: commentBody,
  });
  printJson({ command: "comment", issue: issueRef, comment: commentSummary(created) });
}

async function updateStatus(config, args) {
  const issueRef = requireStringFlag(args, "issue");
  const status = validateEnum(requireStringFlag(args, "status"), STATUSES, "status");
  const commentText = await readBody(args, "comment", "comment-file");
  const body = {
    status,
    ...(commentText && commentText.trim().length > 0 ? { comment: commentText } : {}),
    ...(boolFlag(args, "resume") ? { resume: true } : {}),
    ...(boolFlag(args, "reopen") ? { reopen: true } : {}),
  };
  const issue = await apiFetch(config, `/issues/${encodeURIComponent(issueRef)}`, {
    method: "PATCH",
    mutating: true,
    body,
  });
  printJson({ command: "update-status", issue: issueSummary(issue) });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === "help" || command === "--help" || boolFlag(args, "help")) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const config = getConfig();
  if (command === "list-assigned") return listAssigned(config, args);
  if (command === "create-task") return createTask(config, args);
  if (command === "comment") return comment(config, args);
  if (command === "update-status") return updateStatus(config, args);
  throw new UsageError(`Unknown command: ${command}`);
}

main().catch((err) => {
  if (err instanceof UsageError) {
    process.stderr.write(`Usage error: ${err.message}\n\n${HELP}\n`);
    process.exitCode = 2;
    return;
  }
  if (err instanceof ApiError) {
    printJson({
      error: err.message,
      status: err.status,
      details: err.body?.details ?? null,
    });
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
