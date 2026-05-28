#!/usr/bin/env node

const OPEN_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
const DEFAULT_LIMIT = 1000;

function parseArgs(argv) {
  const args = {
    create: false,
    requireDeploymentSource: true,
    limit: DEFAULT_LIMIT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };

    if (arg === "--api-url") args.apiUrl = next();
    else if (arg === "--api-key") args.apiKey = next();
    else if (arg === "--company-id") args.companyId = next();
    else if (arg === "--assignee-agent-id") args.assigneeAgentId = next();
    else if (arg === "--goal-id") args.goalId = next();
    else if (arg === "--parent-id") args.parentId = next();
    else if (arg === "--date") args.date = next();
    else if (arg === "--limit") args.limit = Number.parseInt(next(), 10);
    else if (arg === "--create") args.create = true;
    else if (arg === "--allow-missing-deployment-source") args.requireDeploymentSource = false;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function usage() {
  return [
    "Usage: node scripts/ceo-standup-seed.mjs [options]",
    "",
    "Builds a manual CEO standup seed from live Paperclip issue state.",
    "",
    "Options:",
    "  --api-url <url>                       Paperclip API URL (default: PAPERCLIP_API_URL)",
    "  --api-key <token>                     Paperclip API bearer token (default: PAPERCLIP_API_KEY)",
    "  --company-id <id>                     Company id (default: PAPERCLIP_COMPANY_ID)",
    "  --date <iso-date>                     Snapshot time (default: now)",
    "  --limit <n>                           Issue fetch limit (default: 1000)",
    "  --create                              Create the manual CEO standup issue",
    "  --assignee-agent-id <id>              Assignee for --create",
    "  --goal-id <id>                        Goal for --create",
    "  --parent-id <id>                      Parent issue for --create",
    "  --allow-missing-deployment-source     Print seed even if canonical deployment section is unavailable",
  ].join("\n");
}

function toDate(value, fallback = null) {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function issueTimestamp(issue) {
  return toDate(issue.completedAt) ?? toDate(issue.updatedAt) ?? toDate(issue.createdAt) ?? new Date(0);
}

function issueLabel(issue) {
  return issue.identifier ?? issue.id ?? "(unidentified)";
}

function issueAssignee(issue, agentsById) {
  if (issue.assigneeAgentId && agentsById.has(issue.assigneeAgentId)) {
    return agentsById.get(issue.assigneeAgentId);
  }
  if (issue.assigneeAgentId) return issue.assigneeAgentId.slice(0, 8);
  if (issue.assigneeUserId) return "board";
  return "unassigned";
}

function issueRef(issue, agentsById = new Map()) {
  return {
    id: issue.id,
    identifier: issue.identifier ?? null,
    title: issue.title,
    status: issue.status,
    priority: issue.priority ?? "medium",
    assignee: issueAssignee(issue, agentsById),
    updatedAt: toDate(issue.updatedAt)?.toISOString() ?? null,
    completedAt: toDate(issue.completedAt)?.toISOString() ?? null,
  };
}

function sortByPriorityThenActivity(left, right) {
  const priorityRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const priority = (priorityRank[left.priority] ?? 4) - (priorityRank[right.priority] ?? 4);
  if (priority !== 0) return priority;
  return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
}

export function buildStandupSnapshot(input) {
  const now = toDate(input.now) ?? new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const staleBefore = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const agentsById = new Map((input.agents ?? []).map((agent) => [agent.id, agent.name ?? agent.title ?? agent.id]));
  const issues = (input.issues ?? []).filter((issue) => !issue.hiddenAt);
  const categories = {
    shipped: [],
    inStaging: [],
    inProgress: [],
    blockedOrStale: [],
    backlog: [],
    unknownOpen: [],
  };

  for (const issue of issues) {
    if (issue.status === "done" && issueTimestamp(issue) >= since) {
      categories.shipped.push(issueRef(issue, agentsById));
      continue;
    }

    if (issue.status === "in_review") categories.inStaging.push(issueRef(issue, agentsById));
    else if (issue.status === "in_progress") categories.inProgress.push(issueRef(issue, agentsById));
    else if (issue.status === "blocked") categories.blockedOrStale.push(issueRef(issue, agentsById));
    else if (issue.status === "todo" || issue.status === "backlog") categories.backlog.push(issueRef(issue, agentsById));
    else if (!TERMINAL_STATUSES.has(issue.status)) categories.unknownOpen.push(issueRef(issue, agentsById));
  }

  for (const values of Object.values(categories)) {
    values.sort(sortByPriorityThenActivity);
  }

  const openIssues = issues.filter((issue) => OPEN_STATUSES.has(issue.status));
  const staleOpenIssues = openIssues
    .filter((issue) => issueTimestamp(issue) <= staleBefore)
    .map((issue) => issueRef(issue, agentsById))
    .sort(sortByPriorityThenActivity);

  const statusCounts = {};
  for (const issue of issues) {
    statusCounts[issue.status] = (statusCounts[issue.status] ?? 0) + 1;
  }

  return {
    generatedAt: now.toISOString(),
    window: {
      since: since.toISOString(),
      staleBefore: staleBefore.toISOString(),
    },
    counts: {
      totalIssues: issues.length,
      open: openIssues.length,
      staleOpen: staleOpenIssues.length,
      byStatus: statusCounts,
      categories: Object.fromEntries(Object.entries(categories).map(([key, values]) => [key, values.length])),
    },
    categories,
    staleOpenIssues,
  };
}

export function seedCountsFromSnapshot(snapshot) {
  return {
    shipped: snapshot.categories.shipped.length,
    inStaging: snapshot.categories.inStaging.length,
    inProgress: snapshot.categories.inProgress.length,
    blockedOrStale: snapshot.categories.blockedOrStale.length,
    backlog: snapshot.categories.backlog.length,
  };
}

export function validateSeedCountsAgainstLiveSnapshot(seedCounts, snapshot) {
  const expected = seedCountsFromSnapshot(snapshot);
  const mismatches = Object.entries(expected).filter(([key, value]) => seedCounts[key] !== value);
  if (mismatches.length > 0) {
    throw new Error(
      [
        "Standup seed counts do not match the live issue snapshot.",
        `Live open issues: ${snapshot.counts.open}.`,
        `Mismatches: ${mismatches.map(([key, value]) => `${key} expected ${value}, got ${seedCounts[key] ?? "missing"}`).join("; ")}.`,
      ].join(" "),
    );
  }

  const allSeedCategoriesZero = Object.values(seedCounts).every((value) => value === 0);
  if (snapshot.counts.open > 0 && allSeedCategoriesZero) {
    throw new Error(
      `Refusing to emit an all-zero standup seed while ${snapshot.counts.open} live issues are open.`,
    );
  }

  if (snapshot.categories.unknownOpen.length > 0) {
    throw new Error(
      `Refusing to emit standup seed with ${snapshot.categories.unknownOpen.length} open issues in unknown statuses.`,
    );
  }
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}...`;
}

function renderIssueList(items, limit = 12) {
  if (items.length === 0) return "";
  const visible = items.slice(0, limit).map((issue) => {
    const label = issue.identifier ?? issue.id;
    return `  - ${label}: ${truncate(issue.title, 72)} (${issue.assignee}, ${issue.priority})`;
  });
  if (items.length > limit) {
    visible.push(`  - ... ${items.length - limit} more`);
  }
  return `${visible.join("\n")}\n`;
}

export function extractDeploymentSection(commentBody) {
  if (!commentBody) return null;
  const normalized = commentBody.replace(/\r\n/g, "\n");
  const heading = /(?:^|\n)[^\n]*(?:\*\*|\*)\s*DEPLOYMENTS\s*(?:\*\*|\*)[^\n]*/i.exec(normalized);
  if (!heading) return null;
  const start = heading.index + (heading[0].startsWith("\n") ? 1 : 0);
  const rest = normalized.slice(start);
  const next = rest.search(/\n[^\n]*(?:\*\*|\*)\s*(SHIPPED|IN STAGING|IN PROGRESS|BLOCKED|BACKLOG)\b/i);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

export function latestDeploymentSectionFromComments(comments) {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    const section = extractDeploymentSection(comment?.body);
    if (section) {
      return {
        commentId: comment?.id ?? null,
        section,
      };
    }
  }
  return null;
}

export function renderStandupIssueDescription(snapshot, deploymentInput) {
  const counts = seedCountsFromSnapshot(snapshot);
  validateSeedCountsAgainstLiveSnapshot(counts, snapshot);

  const lines = [
    "As CEO of Measure Coffee, write today's engineering standup summary.",
    "",
    "The issue categories below were generated from the live Paperclip issue API at snapshot time. If any category looks impossible, stop and report a seed integrity error instead of writing a narrative summary.",
    "",
    "Format for Slack #paperclip-eng. Use clear sections, mention specific issue IDs, and identify who is assigned. Write in first person as CEO. Keep under 50 lines.",
    "",
    "---",
    "",
    `SNAPSHOT: ${snapshot.generatedAt}`,
    `OPEN ISSUE STATUS COUNTS: in_review=${snapshot.counts.byStatus.in_review ?? 0}, blocked=${snapshot.counts.byStatus.blocked ?? 0}, todo/backlog=${(snapshot.counts.byStatus.todo ?? 0) + (snapshot.counts.byStatus.backlog ?? 0)}, in_progress=${snapshot.counts.byStatus.in_progress ?? 0}, open_total=${snapshot.counts.open}`,
    `STALE OPEN SIGNAL: ${snapshot.counts.staleOpen} open issues have not updated since ${snapshot.window.staleBefore}.`,
    "",
    `SHIPPED (last 24h) - ${snapshot.categories.shipped.length} items:`,
    renderIssueList(snapshot.categories.shipped).trimEnd(),
    "",
    `DEPLOYMENTS - canonical source: ${deploymentInput.sourceIssueIdentifier ?? "missing"}`,
    deploymentInput.section,
    "",
    `IN STAGING - ${snapshot.categories.inStaging.length} items:`,
    renderIssueList(snapshot.categories.inStaging).trimEnd(),
    "",
    `IN PROGRESS - ${snapshot.categories.inProgress.length} items:`,
    renderIssueList(snapshot.categories.inProgress).trimEnd(),
    "",
    `BLOCKED/STALE - ${snapshot.categories.blockedOrStale.length} items:`,
    renderIssueList(snapshot.categories.blockedOrStale).trimEnd(),
    "",
    `BACKLOG - ${snapshot.categories.backlog.length} items:`,
    renderIssueList(snapshot.categories.backlog).trimEnd(),
    "",
    "---",
    "VERIFICATION NOTE: This seed path rejects the May 25, 2026 failure mode where MEA-1044 emitted all-zero categories while MEA-1043 and the live API showed 148 open issues: 25 in review, 98 blocked, 24 todo/backlog, and 1 in progress.",
    "",
    "INSTRUCTIONS: Write the standup summary as a comment on this issue. Use Slack markdown format. Post ONLY the summary - no extra commentary.",
  ];

  return lines.filter((line) => line !== undefined).join("\n").replace(/\n{3,}/g, "\n\n");
}

async function apiFetchJson({ apiUrl, apiKey }, path, init = {}) {
  const res = await fetch(`${apiUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const message = typeof body === "object" && body && "error" in body ? body.error : text;
    throw new Error(`Paperclip API ${res.status}: ${message}`);
  }
  return body;
}

async function loadCanonicalDeploymentInput(client, companyId) {
  const routines = await apiFetchJson(client, `/api/companies/${companyId}/routines`);
  const routine = routines.find((candidate) => candidate.title === "Daily Engineering Standup" && candidate.status === "active");
  const linkedIssue = routine?.lastRun?.linkedIssue;
  if (!linkedIssue || linkedIssue.status !== "done") {
    throw new Error("Canonical Daily Engineering Standup routine has no completed latest run to source deployment context from.");
  }
  const comments = await apiFetchJson(client, `/api/issues/${linkedIssue.id}/comments?order=asc`);
  const deploymentComment = latestDeploymentSectionFromComments(comments);
  if (!deploymentComment) {
    throw new Error(`Canonical standup ${linkedIssue.identifier} has no DEPLOYMENTS section.`);
  }
  return {
    sourceIssueId: linkedIssue.id,
    sourceIssueIdentifier: linkedIssue.identifier,
    sourceCommentId: deploymentComment.commentId,
    section: deploymentComment.section,
  };
}

async function loadIssuesForStandup(client, companyId, limit) {
  const statusQueries = [
    "backlog,todo,in_progress,in_review,blocked",
    "done",
  ];
  const issueById = new Map();
  for (const statuses of statusQueries) {
    const rows = await apiFetchJson(
      client,
      `/api/companies/${companyId}/issues?status=${encodeURIComponent(statuses)}&limit=${limit}&includeRoutineExecutions=true`,
    );
    if (rows.length >= limit) {
      throw new Error(`Issue fetch for status=${statuses} returned ${rows.length} rows, which reached --limit. Increase --limit before generating a standup seed.`);
    }
    for (const row of rows) {
      issueById.set(row.id, row);
    }
  }
  return [...issueById.values()];
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const apiUrl = args.apiUrl ?? process.env.PAPERCLIP_API_URL;
  const apiKey = args.apiKey ?? process.env.PAPERCLIP_API_KEY;
  const companyId = args.companyId ?? process.env.PAPERCLIP_COMPANY_ID;
  if (!apiUrl || !apiKey || !companyId) {
    throw new Error("Missing API configuration. Set PAPERCLIP_API_URL, PAPERCLIP_API_KEY, and PAPERCLIP_COMPANY_ID or pass flags.");
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) {
    throw new Error("--limit must be a positive integer");
  }

  const client = { apiUrl, apiKey };
  const [issues, agents] = await Promise.all([
    loadIssuesForStandup(client, companyId, args.limit),
    apiFetchJson(client, `/api/companies/${companyId}/agents`),
  ]);
  const snapshot = buildStandupSnapshot({
    issues,
    agents,
    now: args.date ? new Date(args.date) : new Date(),
  });

  let deploymentInput;
  try {
    deploymentInput = await loadCanonicalDeploymentInput(client, companyId);
  } catch (error) {
    if (args.requireDeploymentSource) throw error;
    deploymentInput = {
      sourceIssueIdentifier: null,
      section: `Deployment source unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const description = renderStandupIssueDescription(snapshot, deploymentInput);

  if (!args.create) {
    console.log(description);
    return;
  }

  if (!args.assigneeAgentId) {
    throw new Error("--create requires --assignee-agent-id");
  }

  const title = `CEO Standup - ${new Date(snapshot.generatedAt).toLocaleDateString("en-US", {
    month: "long",
    day: "2-digit",
    year: "numeric",
    timeZone: "America/Chicago",
  })}`;
  const issue = await apiFetchJson(client, `/api/companies/${companyId}/issues`, {
    method: "POST",
    headers: process.env.PAPERCLIP_RUN_ID ? { "X-Paperclip-Run-Id": process.env.PAPERCLIP_RUN_ID } : {},
    body: JSON.stringify({
      title,
      description,
      status: "todo",
      priority: "medium",
      assigneeAgentId: args.assigneeAgentId,
      goalId: args.goalId,
      parentId: args.parentId,
    }),
  });
  console.log(JSON.stringify({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
