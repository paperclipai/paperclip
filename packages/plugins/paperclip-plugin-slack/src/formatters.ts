import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { SlackBlock, SlackMessage } from "./slack-api.js";
import type { EscalationRecord } from "./types.js";

let dashboardBase = "http://localhost:3100";

export function setBaseUrl(url: string): void {
  dashboardBase = url.replace(/\/+$/, "");
}

function contextFooter(timestamp?: string): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [
    { type: "mrkdwn", text: "Paperclip" },
  ];
  if (timestamp) {
    elements.push({
      type: "mrkdwn",
      text: `<!date^${Math.floor(new Date(timestamp).getTime() / 1000)}^{date_short_pretty} at {time}|${timestamp}>`,
    });
  }
  return { type: "context", elements };
}

function viewButton(label: string, url: string): Record<string, unknown> {
  return {
    type: "button",
    text: { type: "plain_text", text: label },
    url,
  };
}

// --- Block formatting helpers ---
export function formatAsBlocks(text: string, toolName?: string): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  if (toolName) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Tool: \`${toolName}\`` }],
    });
  }
  const parts = text.split(/(```[\s\S]*?```)/g);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
      const inner = trimmed.slice(3, -3).replace(/^\w*\n/, "");
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `\`\`\`${inner}\`\`\`` },
      });
    } else {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: trimmed },
      });
    }
  }
  return blocks;
}

// --- Event formatters ---
export function formatIssueCreated(event: PluginEvent): SlackMessage {
  const p = event.payload as Record<string, unknown>;
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "Untitled");
  const description = p.description ? String(p.description).slice(0, 300) : null;
  const status = p.status ? String(p.status) : null;
  const priority = p.priority ? String(p.priority) : null;
  const assigneeName = p.assigneeName ? String(p.assigneeName) : null;
  const projectName = p.projectName ? String(p.projectName) : null;
  const fields: Array<{ type: string; text: string }> = [];
  if (status) fields.push({ type: "mrkdwn", text: `*Status*\n\`${status}\`` });
  if (priority) fields.push({ type: "mrkdwn", text: `*Priority*\n\`${priority}\`` });
  if (assigneeName) fields.push({ type: "mrkdwn", text: `*Assignee*\n${assigneeName}` });
  if (projectName) fields.push({ type: "mrkdwn", text: `*Project*\n${projectName}` });
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: description
          ? `*New issue created*\n*${identifier}* ${title}\n> ${description}`
          : `*New issue created*\n*${identifier}* ${title}`,
      },
      accessory: viewButton("View Issue", `${dashboardBase}/issues/${event.entityId}`),
    },
  ];
  if (fields.length > 0) {
    blocks.push({ type: "section", fields });
  }
  blocks.push(contextFooter(event.occurredAt));
  return {
    text: `New issue: ${identifier} - ${title}`,
    blocks,
  };
}

export function formatIssueDone(event: PluginEvent): SlackMessage {
  const p = event.payload as Record<string, unknown>;
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "");
  const fields: Array<{ type: string; text: string }> = [];
  if (p.status) fields.push({ type: "mrkdwn", text: `*Status*\n\`${String(p.status)}\`` });
  if (p.priority) fields.push({ type: "mrkdwn", text: `*Priority*\n\`${String(p.priority)}\`` });
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Issue completed* :white_check_mark:\n*${identifier}* ${title} is now done.`,
      },
      accessory: viewButton("View Issue", `${dashboardBase}/issues/${event.entityId}`),
    },
  ];
  if (fields.length > 0) {
    blocks.push({ type: "section", fields });
  }
  blocks.push(contextFooter(event.occurredAt));
  return {
    text: `Issue done: ${identifier}`,
    blocks,
  };
}

export function formatApprovalCreated(event: PluginEvent): SlackMessage {
  const p = event.payload as Record<string, unknown>;
  const approvalType = String(p.type ?? "unknown");
  const approvalId = String(p.approvalId ?? event.entityId);
  const title = String(p.title ?? "");
  const description = p.description ? String(p.description) : null;
  const agentName = p.agentName ? String(p.agentName) : null;
  const issueIds = Array.isArray(p.issueIds) ? (p.issueIds as unknown[]) : [];
  const fields: Array<{ type: string; text: string }> = [];
  if (agentName) fields.push({ type: "mrkdwn", text: `*Agent*\n${agentName}` });
  fields.push({ type: "mrkdwn", text: `*Type*\n\`${approvalType}\`` });
  if (issueIds.length > 0) {
    fields.push({ type: "mrkdwn", text: `*Linked Issues*\n${issueIds.join(", ")}` });
  }
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: description
          ? `*Approval requested* :rotating_light:\n${title ? `*${title}*\n` : ""}${description}`
          : `*Approval requested* :rotating_light:${title ? `\n*${title}*` : ""}`,
      },
    },
  ];
  if (fields.length > 0) {
    blocks.push({ type: "section", fields });
  }
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Approve" },
        style: "primary",
        action_id: "approval_approve",
        value: approvalId,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Reject" },
        style: "danger",
        action_id: "approval_reject",
        value: approvalId,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "View" },
        url: `${dashboardBase}/approvals/${approvalId}`,
        action_id: "approval_view",
      },
    ],
  });
  blocks.push(contextFooter(event.occurredAt));
  return {
    text: `Approval needed (${approvalType}) for ${issueIds.length} issue(s)`,
    blocks,
  };
}

export function formatApprovalResolved(
  approvalId: string,
  approved: boolean,
  userId: string,
): SlackMessage {
  const action = approved ? "Approved" : "Rejected";
  const emoji = approved ? ":white_check_mark:" : ":x:";
  return {
    text: `${action} by ${userId}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *${action}* by <@${userId}>`,
        },
        accessory: viewButton("View", `${dashboardBase}/approvals/${approvalId}`),
      },
    ],
  };
}

export function formatAgentError(event: PluginEvent): SlackMessage {
  const p = event.payload as Record<string, unknown>;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);
  const errorMessage = String(p.error ?? p.message ?? "Unknown error");
  return {
    text: `Agent error: ${agentName}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Agent error* :warning:\n*${agentName}* encountered an error:\n\`\`\`${errorMessage.slice(0, 500)}\`\`\``,
        },
      },
      contextFooter(event.occurredAt),
    ],
  };
}

export function formatAgentConnected(event: PluginEvent): SlackMessage {
  const p = event.payload as Record<string, unknown>;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);
  return {
    text: `Agent online: ${agentName}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Agent online* :white_check_mark:\n*${agentName}* is now connected and ready.`,
        },
      },
      contextFooter(event.occurredAt),
    ],
  };
}

export function formatBudgetThreshold(event: PluginEvent): SlackMessage {
  const p = event.payload as Record<string, unknown>;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);
  const spent = p.spent != null ? String(p.spent) : "?";
  const budget = p.budget != null ? String(p.budget) : "?";
  const pct = p.percentUsed != null ? String(p.percentUsed) : "?";
  return {
    text: `Budget alert: ${agentName} at ${pct}%`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Budget threshold reached* :chart_with_upwards_trend:\n*${agentName}* has used *${pct}%* of budget ($${spent} / $${budget})`,
        },
      },
      contextFooter(event.occurredAt),
    ],
  };
}

export function formatOnboardingMilestone(event: PluginEvent): SlackMessage {
  const p = event.payload as Record<string, unknown>;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);
  const milestone = String(p.milestone ?? "first heartbeat");
  return {
    text: `Milestone: ${agentName} - ${milestone}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Onboarding milestone* :tada:\n*${agentName}* achieved: ${milestone}`,
        },
      },
      contextFooter(event.occurredAt),
    ],
  };
}

export function formatDailyDigest(stats: {
  tasksCompleted: number;
  tasksCreated: number;
  agentsActive: number;
  totalCost: string;
  topAgent: string;
}): SlackMessage {
  return {
    text: `Daily digest: ${stats.tasksCompleted} tasks completed, $${stats.totalCost} spent`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Daily Activity Digest" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Tasks completed*\n${stats.tasksCompleted}` },
          { type: "mrkdwn", text: `*Tasks created*\n${stats.tasksCreated}` },
          { type: "mrkdwn", text: `*Active agents*\n${stats.agentsActive}` },
          { type: "mrkdwn", text: `*Total cost*\n$${stats.totalCost}` },
        ],
      },
      ...(stats.topAgent
        ? [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Top performer:* ${stats.topAgent}`,
              },
            },
          ]
        : []),
      { type: "divider" },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Paperclip - Daily Digest" }],
      },
    ],
  };
}

// --- Escalation formatters ---
export function formatEscalationMessage(escalation: EscalationRecord): SlackMessage {
  const blocks: Array<Record<string, unknown>> = [];
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `Escalation from ${escalation.agentName ?? "Agent"}` },
  });
  const fields: Array<{ type: string; text: string }> = [
    { type: "mrkdwn", text: `*Reason*\n${escalation.reason}` },
  ];
  if (escalation.confidence != null) {
    fields.push({ type: "mrkdwn", text: `*Confidence*\n${escalation.confidence}` });
  }
  blocks.push({ type: "section", fields });
  if (escalation.conversationHistory && escalation.conversationHistory.length > 0) {
    const lastMessages = escalation.conversationHistory.slice(-5);
    const historyText = lastMessages
      .map((msg) => `${msg.role}: ${msg.text}`)
      .join("\n");
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `*Recent conversation*\n${historyText.slice(0, 2000)}` },
      ],
    });
  }
  if (escalation.agentReasoning) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Agent reasoning*\n${escalation.agentReasoning}`,
      },
    });
  }
  if (escalation.suggestedReply) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Suggested reply*\n> ${escalation.suggestedReply}`,
      },
    });
  }
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Use Suggested Reply" },
        style: "primary",
        action_id: "escalation_use_suggested",
        value: escalation.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Reply to Customer" },
        action_id: "escalation_reply",
        value: escalation.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Override Agent" },
        action_id: "escalation_override",
        value: escalation.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Dismiss" },
        style: "danger",
        action_id: "escalation_dismiss",
        value: escalation.id,
      },
    ],
  });
  return {
    text: `Escalation from ${escalation.agentName ?? "Agent"}: ${escalation.reason}`,
    blocks,
  };
}

export function formatEscalationResolved(
  escalationId: string,
  action: string,
  userId: string,
): SlackMessage {
  const emoji =
    action === "dismiss" || action === "escalation_dismiss"
      ? ":x:"
      : ":white_check_mark:";
  const label =
    action === "escalation_use_suggested"
      ? "Used suggested reply"
      : action === "escalation_override"
        ? "Overrode agent"
        : action === "escalation_dismiss"
          ? "Dismissed"
          : "Replied";
  return {
    text: `Escalation ${label} by ${userId}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *Escalation ${label}* by <@${userId}>`,
        },
      },
    ],
  };
}
