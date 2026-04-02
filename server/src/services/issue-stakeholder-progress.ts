import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, authUsers } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const PRIMARY_WEBHOOK_ENV = "PAPERCLIP_STAKEHOLDER_PROGRESS_SLACK_WEBHOOK_URL";
const FALLBACK_WEBHOOK_ENV = "PAPERCLIP_STAKEHOLDER_SLACK_WEBHOOK_URL";
const REQUEST_TIMEOUT_MS = 5000;

export type IssueStakeholderProgressEvent = "done" | "blocked" | "returned_to_requester";

export interface IssueStakeholderProgressIssueSnapshot {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdByUserId: string | null;
}

export interface NotifyIssueStakeholderProgressInput {
  existingIssue: IssueStakeholderProgressIssueSnapshot;
  issue: IssueStakeholderProgressIssueSnapshot;
  comment?: string | null;
  baseUrl?: string | null;
}

interface BuildIssueStakeholderProgressSlackMessageInput {
  event: IssueStakeholderProgressEvent;
  issue: IssueStakeholderProgressIssueSnapshot;
  comment?: string | null;
  assigneeLabel: string;
  baseUrl?: string | null;
}

function normalizeBaseUrl(baseUrl?: string | null): string {
  const resolved =
    baseUrl?.trim() ||
    process.env.PAPERCLIP_PUBLIC_URL?.trim() ||
    process.env.PAPERCLIP_API_URL?.trim() ||
    "";
  return resolved.replace(/\/+$/, "");
}

function slackEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function summarizeComment(comment?: string | null): string | null {
  if (!comment) return null;
  const normalized = comment
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? truncate(normalized, 280) : null;
}

function fallbackSummary(event: IssueStakeholderProgressEvent): string {
  switch (event) {
    case "done":
      return "Work finished and is ready for the next step.";
    case "blocked":
      return "Work is blocked and needs attention.";
    case "returned_to_requester":
      return "Work was handed back to the requesting user for review.";
  }
}

function issuePath(issue: IssueStakeholderProgressIssueSnapshot): string | null {
  if (issue.identifier) {
    const prefix = issue.identifier.split("-")[0]?.trim();
    if (prefix) return `/${prefix}/issues/${issue.identifier}`;
  }
  return null;
}

function statusHeadline(event: IssueStakeholderProgressEvent): string {
  switch (event) {
    case "done":
      return "Issue completed";
    case "blocked":
      return "Issue blocked";
    case "returned_to_requester":
      return "Issue returned to requester";
  }
}

function fallbackTextHeadline(event: IssueStakeholderProgressEvent): string {
  switch (event) {
    case "done":
      return "completed";
    case "blocked":
      return "blocked";
    case "returned_to_requester":
      return "returned to requester";
  }
}

function assigneeFallbackLabel(userId: string | null, agentId: string | null): string {
  if (userId) {
    if (userId === "local-board") return "Board";
    return userId.slice(0, 5);
  }
  if (agentId) return agentId.slice(0, 8);
  return "Unassigned";
}

export function selectIssueStakeholderProgressEvent(
  existingIssue: IssueStakeholderProgressIssueSnapshot,
  issue: IssueStakeholderProgressIssueSnapshot,
): IssueStakeholderProgressEvent | null {
  const returnedToRequester =
    issue.assigneeAgentId === null &&
    !!issue.assigneeUserId &&
    !!existingIssue.createdByUserId &&
    issue.assigneeUserId === existingIssue.createdByUserId &&
    (issue.assigneeAgentId !== existingIssue.assigneeAgentId ||
      issue.assigneeUserId !== existingIssue.assigneeUserId);

  if (returnedToRequester) return "returned_to_requester";
  if (existingIssue.status !== issue.status && issue.status === "blocked") return "blocked";
  if (existingIssue.status !== issue.status && issue.status === "done") return "done";
  return null;
}

export function buildIssueStakeholderProgressSlackMessage(
  input: BuildIssueStakeholderProgressSlackMessageInput,
): { text: string; blocks: Array<Record<string, unknown>> } {
  const summary = summarizeComment(input.comment) ?? fallbackSummary(input.event);
  const escapedTitle = slackEscape(input.issue.title);
  const escapedSummary = slackEscape(summary);
  const escapedAssignee = slackEscape(input.assigneeLabel);
  const resolvedBaseUrl = normalizeBaseUrl(input.baseUrl);
  const path = issuePath(input.issue);
  const issueLabel = input.issue.identifier ?? input.issue.id;
  const escapedIssueLabel = slackEscape(issueLabel);
  const issueLink = resolvedBaseUrl && path ? `${resolvedBaseUrl}${path}` : "";
  const issueLine =
    issueLink && path
      ? `<${issueLink}|${escapedIssueLabel}> ${escapedTitle}`
      : `*${escapedIssueLabel}* ${escapedTitle}`;

  const text =
    `Stakeholder progress update: ${issueLabel} ${input.issue.title} ` +
    `is ${fallbackTextHeadline(input.event)} (status: ${input.issue.status}, assignee: ${input.assigneeLabel}). ` +
    `Summary: ${summary}` +
    (issueLink ? ` ${issueLink}` : "");

  return {
    text,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Stakeholder progress update*\n${issueLine}`,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Event*\n${slackEscape(statusHeadline(input.event))}`,
          },
          {
            type: "mrkdwn",
            text: `*Status*\n${slackEscape(input.issue.status)}`,
          },
          {
            type: "mrkdwn",
            text: `*Assignee*\n${escapedAssignee}`,
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Summary*\n${escapedSummary}`,
        },
      },
    ],
  };
}

async function resolveAssigneeLabel(
  db: Db,
  issue: IssueStakeholderProgressIssueSnapshot,
): Promise<string> {
  if (issue.assigneeAgentId) {
    const agent = await db
      .select({ name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, issue.companyId)))
      .then((rows) => rows[0] ?? null);
    if (agent?.name) return agent.name;
  }

  if (issue.assigneeUserId) {
    const user = await db
      .select({ name: authUsers.name })
      .from(authUsers)
      .where(eq(authUsers.id, issue.assigneeUserId))
      .then((rows) => rows[0] ?? null);
    if (user?.name) return user.name;
  }

  return assigneeFallbackLabel(issue.assigneeUserId, issue.assigneeAgentId);
}

function resolveWebhookUrl(): string {
  return (
    process.env[PRIMARY_WEBHOOK_ENV]?.trim() ||
    process.env[FALLBACK_WEBHOOK_ENV]?.trim() ||
    ""
  );
}

async function readResponseText(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    return text ? truncate(text, 500) : null;
  } catch {
    return null;
  }
}

export async function notifyIssueStakeholderProgress(
  db: Db,
  input: NotifyIssueStakeholderProgressInput,
): Promise<void> {
  const event = selectIssueStakeholderProgressEvent(input.existingIssue, input.issue);
  if (!event) return;

  const webhookUrl = resolveWebhookUrl();
  if (!webhookUrl) {
    logger.info(
      {
        issueId: input.issue.id,
        identifier: input.issue.identifier,
        event,
        env: PRIMARY_WEBHOOK_ENV,
      },
      "stakeholder progress slack webhook is not configured; skipping notification",
    );
    return;
  }

  const assigneeLabel = await resolveAssigneeLabel(db, input.issue);
  const payload = buildIssueStakeholderProgressSlackMessage({
    event,
    issue: input.issue,
    comment: input.comment,
    assigneeLabel,
    baseUrl: input.baseUrl,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn(
        {
          issueId: input.issue.id,
          identifier: input.issue.identifier,
          event,
          status: response.status,
          body: await readResponseText(response),
        },
        "stakeholder progress slack notification failed",
      );
    }
  } catch (err) {
    logger.warn(
      {
        err,
        issueId: input.issue.id,
        identifier: input.issue.identifier,
        event,
      },
      "stakeholder progress slack notification errored",
    );
  } finally {
    clearTimeout(timeout);
  }
}
