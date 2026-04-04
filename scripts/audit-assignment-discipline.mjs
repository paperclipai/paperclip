#!/usr/bin/env node

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

const apiBase = process.env.PAPERCLIP_API_URL?.trim();
const companyId = process.env.PAPERCLIP_COMPANY_ID?.trim();
const apiKey = process.env.PAPERCLIP_API_KEY?.trim();

if (!apiBase || !companyId || !apiKey) {
  console.error(
    "Missing required environment. Set PAPERCLIP_API_URL, PAPERCLIP_COMPANY_ID, and PAPERCLIP_API_KEY.",
  );
  process.exit(1);
}

const jsonOutput = args.has("--json");
const failOnDrift = args.has("--fail-on-drift");
const trackedAgentStatuses = ["running", "idle"];
const maxInProgressArg = rawArgs.find((arg) => arg.startsWith("--max-in-progress="));
const maxInProgressPerAgent = maxInProgressArg
  ? Number.parseInt(maxInProgressArg.split("=")[1] ?? "", 10)
  : 2;

if (!Number.isInteger(maxInProgressPerAgent) || maxInProgressPerAgent < 1) {
  console.error("Invalid --max-in-progress value. Use a positive integer.");
  process.exit(1);
}

async function getJson(pathname) {
  const response = await fetch(`${apiBase}${pathname}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${pathname}: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function unwrapList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.value)) return payload.value;
  throw new Error("Expected array or { value: array } response payload.");
}

function summarizeAgents(agents, runnableIssues) {
  return agents
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      title: agent.title,
      urlKey: agent.urlKey,
      runnableCount: runnableIssues.filter((issue) => issue.assigneeAgentId === agent.id).length,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function summarizeInProgressByAgent(agents, inProgressIssues) {
  return agents
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      title: agent.title,
      urlKey: agent.urlKey,
      inProgressCount: inProgressIssues.filter((issue) => issue.assigneeAgentId === agent.id).length,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function formatAgent(agent) {
  return `${agent.name} (${agent.title})`;
}

const ACTIVE_CHILD_STATUSES = ["todo", "in_progress", "blocked", "in_review"];

function isSameDay(dateStr, referenceDate) {
  const d = new Date(dateStr);
  return (
    d.getUTCFullYear() === referenceDate.getUTCFullYear() &&
    d.getUTCMonth() === referenceDate.getUTCMonth() &&
    d.getUTCDate() === referenceDate.getUTCDate()
  );
}

try {
  const [agentsPayload, openIssuesPayload, runnableIssuesPayload, inProgressIssuesPayload, allIssuesPayload] =
    await Promise.all([
      getJson(`/api/companies/${companyId}/agents`),
      getJson(`/api/companies/${companyId}/issues?status=todo,in_progress,blocked`),
      getJson(`/api/companies/${companyId}/issues?status=todo,in_progress`),
      getJson(`/api/companies/${companyId}/issues?status=in_progress`),
      getJson(`/api/companies/${companyId}/issues?status=todo,in_progress,blocked,in_review,done,cancelled`),
    ]);

  const agents = unwrapList(agentsPayload);
  const openIssues = unwrapList(openIssuesPayload);
  const runnableIssues = unwrapList(runnableIssuesPayload);
  const inProgressIssues = unwrapList(inProgressIssuesPayload);
  const allIssues = unwrapList(allIssuesPayload);

  const runningAgents = agents.filter((agent) => agent.status === "running");
  const openUnassignedIssues = openIssues
    .filter((issue) => !issue.assigneeAgentId && !issue.assigneeUserId)
    .map((issue) => ({
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
    }))
    .sort((left, right) => left.identifier.localeCompare(right.identifier));

  const activeAgents = agents.filter((agent) => trackedAgentStatuses.includes(agent.status));
  const runnableCountsByActiveAgent = summarizeAgents(activeAgents, runnableIssues);
  const idleActiveAgents = runnableCountsByActiveAgent.filter((agent) => agent.runnableCount === 0);
  const inProgressCountsByActiveAgent = summarizeInProgressByAgent(activeAgents, inProgressIssues);
  const overloadedActiveAgents = inProgressCountsByActiveAgent.filter(
    (agent) => agent.inProgressCount > maxInProgressPerAgent,
  );

  // Stale-parent drift detection:
  // An in_progress parent is "stale" when it has children (in any status) but
  // none of those children are in an active state (todo/in_progress/blocked/in_review)
  // AND the parent was not updated today (no same-day holding note).
  const childrenByParent = new Map();
  for (const issue of allIssues) {
    if (!issue.parentId) continue;
    if (!childrenByParent.has(issue.parentId)) {
      childrenByParent.set(issue.parentId, []);
    }
    childrenByParent.get(issue.parentId).push(issue);
  }

  const today = new Date();
  const staleParentIssues = inProgressIssues
    .filter((issue) => {
      const children = childrenByParent.get(issue.id);
      if (!children || children.length === 0) return false;
      const hasActiveChild = children.some((child) => ACTIVE_CHILD_STATUSES.includes(child.status));
      if (hasActiveChild) return false;
      if (issue.updatedAt && isSameDay(issue.updatedAt, today)) return false;
      return true;
    })
    .map((issue) => ({
      identifier: issue.identifier,
      title: issue.title,
      assigneeAgentId: issue.assigneeAgentId,
      childCount: childrenByParent.get(issue.id).length,
      updatedAt: issue.updatedAt,
    }))
    .sort((left, right) => left.identifier.localeCompare(right.identifier));

  const summary = {
    generatedAt: new Date().toISOString(),
    companyId,
    trackedAgentStatuses,
    maxInProgressPerAgent,
    openUnassignedCount: openUnassignedIssues.length,
    idleActiveAgentCount: idleActiveAgents.length,
    overloadedActiveAgentCount: overloadedActiveAgents.length,
    staleParentCount: staleParentIssues.length,
    openUnassignedIssues,
    idleActiveAgents,
    overloadedActiveAgents,
    staleParentIssues,
    runnableCountsByActiveAgent,
    inProgressCountsByActiveAgent,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log("Assignment discipline audit");
    console.log(`- Open unassigned issues: ${summary.openUnassignedCount}`);
    if (summary.openUnassignedCount > 0) {
      for (const issue of summary.openUnassignedIssues) {
        console.log(`  - ${issue.identifier} [${issue.status}] ${issue.title}`);
      }
    }

    console.log(
      `- Active agents with 0 runnable todo/in_progress issues: ${summary.idleActiveAgentCount}`,
    );
    if (summary.idleActiveAgentCount > 0) {
      for (const agent of summary.idleActiveAgents) {
        console.log(`  - ${formatAgent(agent)}`);
      }
    }

    console.log(
      `- Active agents over max ${summary.maxInProgressPerAgent} in_progress issues: ${summary.overloadedActiveAgentCount}`,
    );
    if (summary.overloadedActiveAgentCount > 0) {
      for (const agent of summary.overloadedActiveAgents) {
        console.log(`  - ${formatAgent(agent)}: ${agent.inProgressCount}`);
      }
    }

    console.log(
      `- Stale in_progress parents (all children done/cancelled, no same-day update): ${summary.staleParentCount}`,
    );
    if (summary.staleParentCount > 0) {
      for (const issue of summary.staleParentIssues) {
        console.log(`  - ${issue.identifier} (${issue.childCount} children) ${issue.title}`);
      }
    }

    console.log("- Runnable counts by active agent:");
    for (const agent of summary.runnableCountsByActiveAgent) {
      console.log(`  - ${formatAgent(agent)}: ${agent.runnableCount}`);
    }

    console.log("- In-progress counts by active agent:");
    for (const agent of summary.inProgressCountsByActiveAgent) {
      console.log(`  - ${formatAgent(agent)}: ${agent.inProgressCount}`);
    }
  }

  if (
    failOnDrift &&
    (
      summary.openUnassignedCount > 0 ||
      summary.idleActiveAgentCount > 0 ||
      summary.overloadedActiveAgentCount > 0 ||
      summary.staleParentCount > 0
    )
  ) {
    process.exit(2);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Assignment discipline audit failed: ${message}`);
  process.exit(1);
}
