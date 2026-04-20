import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { escapeMarkdownV2, truncateAtWord } from "./telegram-api.js";
import type { IssueEventPayload, ApprovalEventPayload, AgentRunEventPayload } from "./types.js";

function esc(s: string) {
  return escapeMarkdownV2(s);
}
function bold(s: string) {
  return `*${esc(s)}*`;
}
function code(s: string) {
  return `\`${esc(s)}\``;
}

export function formatIssueCreated(event: PluginEvent<IssueEventPayload>) {
  const p = event.payload;
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "Untitled");
  const status = p.status ? String(p.status) : null;
  const priority = p.priority ? String(p.priority) : null;
  const assigneeName = p.assigneeName ? String(p.assigneeName) : null;
  const projectName = p.projectName ? String(p.projectName) : null;

  const lines = [`${esc("\u{1f4cb}")} ${bold("Issue Created")}: ${bold(identifier)}`, bold(title)];
  const meta: string[] = [];
  if (status) meta.push(`Status: ${code(status)}`);
  if (priority) meta.push(`Priority: ${code(priority)}`);
  if (assigneeName) meta.push(`Assignee: ${esc(assigneeName)}`);
  if (projectName) meta.push(`Project: ${esc(projectName)}`);
  if (meta.length > 0) lines.push(meta.join(" \\| "));
  if (p.description) {
    const desc = truncateAtWord(String(p.description), 200);
    lines.push(`\n${esc(">")} ${esc(desc)}`);
  }

  return {
    text: lines.join("\n"),
    options: { parseMode: "MarkdownV2" as const },
  };
}

export function formatIssueDone(event: PluginEvent<IssueEventPayload>) {
  const p = event.payload;
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "");
  return {
    text: [
      `${esc("\u2705")} ${bold("Issue Completed")}: ${bold(identifier)}`,
      `${bold(title)} ${esc("is now done.")}`,
    ].join("\n"),
    options: { parseMode: "MarkdownV2" as const },
  };
}

export function formatApprovalCreated(event: PluginEvent<ApprovalEventPayload>) {
  const p = event.payload;
  const approvalType = String(p.type ?? "unknown");
  const approvalId = String(p.approvalId ?? event.entityId);
  const title = String(p.title ?? "Approval Requested");
  const description = p.description ? String(p.description) : null;
  const agentName = p.agentName ? String(p.agentName) : null;

  const lines = [`${esc("\u{1f514}")} ${bold("Approval Requested")}`, bold(title)];
  if (agentName) lines.push(`Agent: ${esc(agentName)} \\| Type: ${code(approvalType)}`);
  if (description) lines.push(`\n${esc(truncateAtWord(description, 300))}`);

  // Add linked issues if present
  const linkedIssues = Array.isArray(p.linkedIssues) ? p.linkedIssues : [];
  if (linkedIssues.length > 0) {
    lines.push(`\n${bold(`Linked Issues (${String(linkedIssues.length)})`)}`);
    for (const issue of linkedIssues.slice(0, 5)) {
      const issueParts = [`${bold(String(issue.identifier ?? "?"))} ${esc(String(issue.title ?? ""))}`];
      const issueMeta: string[] = [];
      if (issue.status) issueMeta.push(String(issue.status));
      if (issue.priority) issueMeta.push(String(issue.priority));
      if (issue.assignee) issueMeta.push(`-> ${String(issue.assignee)}`);
      if (issueMeta.length > 0) issueParts.push(`\\(${esc(issueMeta.join(" | "))}\\)`);
      lines.push(issueParts.join(" "));
    }
  }

  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2" as const,
      inlineKeyboard: [
        [
          { text: "Approve", callback_data: `approve_${approvalId}` },
          { text: "Reject", callback_data: `reject_${approvalId}` },
        ],
      ],
    },
  };
}

export function formatAgentError(event: PluginEvent<AgentRunEventPayload>) {
  const p = event.payload;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);
  const errorMessage = String(p.error ?? p.message ?? "Unknown error");
  return {
    text: [
      `${esc("\u274c")} ${bold("Agent Error")}`,
      `${bold(agentName)} ${esc("encountered an error")}`,
      `\n${code(truncateAtWord(errorMessage, 500))}`,
    ].join("\n"),
    options: { parseMode: "MarkdownV2" as const },
  };
}

export function formatAgentRunStarted(event: PluginEvent<AgentRunEventPayload>) {
  const p = event.payload;
  const agentName = String(p.agentName ?? event.entityId);
  return {
    text: `${esc("\u25b6\ufe0f")} ${bold(agentName)} ${esc("started a new run")}`,
    options: { parseMode: "MarkdownV2" as const, disableNotification: true },
  };
}

export function formatAgentRunFinished(event: PluginEvent<AgentRunEventPayload>) {
  const p = event.payload;
  const agentName = String(p.agentName ?? event.entityId);
  return {
    text: `${esc("\u23f9\ufe0f")} ${bold(agentName)} ${esc("completed successfully")}`,
    options: { parseMode: "MarkdownV2" as const, disableNotification: true },
  };
}
