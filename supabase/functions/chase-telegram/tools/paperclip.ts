import { escapeHtml, issueLink } from "../lib/html.ts";
import { paperclipGet } from "../lib/api.ts";
import type {
  PaperclipAgent,
  PaperclipIssue,
  PaperclipApproval,
  QueryResult,
} from "../types.ts";

const COMPANY_ID = Deno.env.get("PAPERCLIP_COMPANY_ID") ?? "";

// ─── Query handlers ──────────────────────────────────────────────────

export async function handleBlockedQuery(): Promise<QueryResult> {
  const issues = await paperclipGet<PaperclipIssue[]>(
    `/api/companies/${COMPANY_ID}/issues?status=blocked`,
  );
  if (issues.length === 0) {
    return { text: "All clear — nothing is currently blocked." };
  }
  const lines = issues.map((i) =>
    `• ${issueLink(i.identifier)} — ${escapeHtml(i.title)} (${i.priority})`
  );
  return {
    text: [
      `<b>Blocked Issues (${issues.length})</b>`,
      "",
      ...lines,
      "",
      `<i>Use /detail ISSUE-123 to learn more about a specific issue.</i>`,
    ].join("\n"),
  };
}

export async function handleApprovalsQuery(): Promise<QueryResult> {
  const approvals = await paperclipGet<PaperclipApproval[]>(
    `/api/companies/${COMPANY_ID}/approvals?status=pending`,
  );
  if (approvals.length === 0) {
    return { text: "No pending approvals right now." };
  }
  const lines = approvals.map((a) => {
    const title = a.payload?.title ?? a.title ?? "Untitled";
    const rec = a.payload?.recommendedAction
      ? ` — <i>${escapeHtml(a.payload.recommendedAction)}</i>`
      : "";
    return `• ${escapeHtml(title)}${rec}`;
  });
  return {
    text: [
      `<b>Pending Approvals (${approvals.length})</b>`,
      "",
      ...lines,
    ].join("\n"),
  };
}

export async function handleAgentsQuery(): Promise<QueryResult> {
  const agents = await paperclipGet<PaperclipAgent[]>(
    `/api/companies/${COMPANY_ID}/agents`,
  );
  if (agents.length === 0) {
    return { text: "No agents found." };
  }
  const lines = agents.map((a) =>
    `• <b>${escapeHtml(a.name)}</b> — ${escapeHtml(a.title ?? a.role ?? "No title")}`
  );
  return {
    text: [
      `<b>Agents (${agents.length})</b>`,
      "",
      ...lines,
    ].join("\n"),
  };
}

export async function handleDetailQuery(identifier: string): Promise<QueryResult> {
  const resolvedId = /^\d+$/.test(identifier) ? `CRE-${identifier}` : identifier;
  const issues = await paperclipGet<PaperclipIssue[]>(
    `/api/companies/${COMPANY_ID}/issues?q=${encodeURIComponent(resolvedId)}&limit=5`,
  );
  const match = issues.find(
    (i) => i.identifier.toUpperCase() === resolvedId.toUpperCase(),
  );
  if (!match) {
    return { text: `Could not find issue <code>${escapeHtml(resolvedId)}</code>. Check the identifier and try again.` };
  }

  const issue = await paperclipGet<PaperclipIssue>(
    `/api/issues/${match.id}`,
  );

  const lines: string[] = [];

  lines.push(`<b>${issueLink(issue.identifier)} — ${escapeHtml(issue.title)}</b>`);
  lines.push(`Status: <code>${issue.status}</code>  |  Priority: <code>${issue.priority}</code>`);

  if (issue.description) {
    const summary = issue.description
      .replace(/<[^>]+>/g, "")
      .split("\n")
      .map((l: string) => l.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(" ")
      .slice(0, 300);
    if (summary) {
      lines.push("");
      lines.push(escapeHtml(summary));
    }
  }

  if (issue.blockedBy && issue.blockedBy.length > 0) {
    lines.push("");
    for (const blocker of issue.blockedBy) {
      lines.push(`Blocked by: ${issueLink(blocker.identifier, blocker.title || blocker.identifier)}`);
    }
  }

  lines.push("");
  if (issue.status === "blocked") {
    lines.push("<i>Check who owns the blocker above or reassign if stale.</i>");
  } else if (issue.status === "in_review") {
    lines.push("<i>This issue is awaiting review.</i>");
  } else if (issue.status === "todo") {
    lines.push("<i>Ready to be picked up.</i>");
  } else if (issue.status === "in_progress") {
    lines.push("<i>Work is in progress.</i>");
  }

  lines.push("");
  lines.push(issueLink(issue.identifier, "Open in Paperclip →"));

  return { text: lines.join("\n") };
}

export async function handleSearchQuery(query: string): Promise<QueryResult> {
  const issues = await paperclipGet<PaperclipIssue[]>(
    `/api/companies/${COMPANY_ID}/issues?q=${encodeURIComponent(query)}&limit=5`,
  );
  if (issues.length === 0) {
    return { text: `No results found for "${escapeHtml(query)}".` };
  }
  const lines = issues.map((i) =>
    `• ${issueLink(i.identifier)} — ${escapeHtml(i.title)} (${i.status})`
  );
  return {
    text: [
      `<b>Search results for "${escapeHtml(query)}"</b>`,
      "",
      ...lines,
    ].join("\n"),
  };
}

export async function handleOverviewQuery(): Promise<QueryResult> {
  const [agents, blocked] = await Promise.all([
    paperclipGet<PaperclipAgent[]>(`/api/companies/${COMPANY_ID}/agents`).catch(() => []),
    paperclipGet<PaperclipIssue[]>(
      `/api/companies/${COMPANY_ID}/issues?status=blocked`,
    ).catch(() => []),
  ]);
  return {
    text: [
      `<b>Company Overview</b>`,
      "",
      `Agents: ${agents.length}`,
      `Blocked issues: ${blocked.length}`,
      blocked.length > 0
        ? `\n<i>Use /blocked to see blocked items.</i>`
        : "\nAll systems nominal.",
    ].join("\n"),
  };
}

export async function handleAgentIssuesQuery(
  agentName: string,
): Promise<QueryResult> {
  const agents = await paperclipGet<PaperclipAgent[]>(
    `/api/companies/${COMPANY_ID}/agents`,
  );
  const nameLower = agentName.toLowerCase();
  const agent = agents.find(
    (a) => a.name.toLowerCase().includes(nameLower),
  );
  if (!agent) {
    return {
      text: `Could not find an agent matching "${escapeHtml(agentName)}". Use /agents to see the team.`,
    };
  }
  const issues = await paperclipGet<PaperclipIssue[]>(
    `/api/companies/${COMPANY_ID}/issues?assigneeAgentId=${encodeURIComponent(agent.id)}&status=in_progress,todo,in_review&limit=10`,
  );
  if (issues.length === 0) {
    return {
      text: `${escapeHtml(agent.name)} has no assigned issues right now.`,
    };
  }
  const lines = issues.map((i) =>
    `• ${issueLink(i.identifier)} — ${escapeHtml(i.title)} (${i.status})`
  );
  return {
    text: [
      `<b>${escapeHtml(agent.name)}'s Issues (${issues.length})</b>`,
      "",
      ...lines,
    ].join("\n"),
  };
}
