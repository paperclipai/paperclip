import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { and, eq, gte } from "drizzle-orm";
import type {
  AskUserQuestionsInteraction,
  RequestConfirmationInteraction,
} from "@paperclipai/shared";
import {
  enqueueAwaitingHumanNotification,
  type AwaitingHumanNotificationPayload,
} from "./awaiting-human-notifications.js";
import type { ApprovalFlowContext } from "./approval-flow-routing.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

type AwaitingHumanIssueSnapshot = {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: string;
  updatedAt?: Date | string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
};

type AwaitingHumanActor = {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

type AwaitingHumanBlocker = {
  id: string;
  identifier: string | null;
  title: string;
  assigneeUserId?: string | null;
};

export type AwaitingHumanInteraction =
  | Pick<RequestConfirmationInteraction, "id" | "kind" | "title" | "summary" | "payload">
  | Pick<AskUserQuestionsInteraction, "id" | "kind" | "title" | "summary" | "payload">;

type AwaitingHumanHandoffInput = {
  previousIssue: AwaitingHumanIssueSnapshot;
  updatedIssue: AwaitingHumanIssueSnapshot;
  source: string;
  handoffKind: "request_confirmation" | "ask_user_questions" | "human_owned_blocker";
  actor: AwaitingHumanActor;
  interaction?: AwaitingHumanInteraction | null;
  blockers?: AwaitingHumanBlocker[] | null;
  approvalContext?: ApprovalFlowContext | null;
  emitIssueUpdatedActivity?: boolean;
  delivery?: "enqueue" | "none";
};

function truncateText(value: string, maxLength: number) {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function firstNonEmpty(...values: Array<string | null | undefined>) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function summarizeQuestions(interaction: AwaitingHumanInteraction | null | undefined) {
  if (!interaction || interaction.kind !== "ask_user_questions") return null;
  return `Need answers to ${interaction.payload.questions.length} question(s).`;
}

export function renderAskUserQuestionsBody(
  interaction: AwaitingHumanInteraction | null | undefined,
  link = "",
) {
  if (!interaction || interaction.kind !== "ask_user_questions") return null;
  const lines: string[] = [];
  if (interaction.payload.title?.trim()) {
    lines.push(interaction.payload.title.trim());
    lines.push("");
  }
  interaction.payload.questions.forEach((question, index) => {
    lines.push(`Question ${index + 1}: ${question.prompt}`);
    if (question.helpText?.trim()) {
      lines.push(`Help: ${question.helpText.trim()}`);
    }
    lines.push(`Required: ${question.required ? "Yes" : "No"}`);
    lines.push(`Pick: ${question.selectionMode === "single" ? "One" : "One or more"}`);
    if (question.options.length > 0) {
      lines.push("Options:");
      for (const option of question.options) {
        lines.push(`- ${option.label}${option.description?.trim() ? ` — ${option.description.trim()}` : ""}`);
      }
    }
    if (index < interaction.payload.questions.length - 1) {
      lines.push("");
    }
  });
  const body = lines.join("\n").trim();
  if (!link.trim()) return body || null;
  return body ? `${body}\n\nOpen in Bizbox: ${link.trim()}` : `Open in Bizbox: ${link.trim()}`;
}

export const REQUEST_CONFIRMATION_REPLY_INSTRUCTIONS = [
  "Reply with:",
  "  `Approve`",
  "  `Reject`",
  "  `Change` followed by feedback",
].join("\n");

function normalizeConfirmationReplyText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function classifyRequestConfirmationReply(
  replyBody: string,
): "approve" | "reject" | null {
  const normalizedReply = normalizeConfirmationReplyText(replyBody);
  if (!normalizedReply) return null;

  if (normalizedReply === "approve") return "approve";
  if (normalizedReply === "reject") return "reject";
  if (normalizedReply === "change" || normalizedReply.startsWith("change ")) {
    return "reject";
  }

  return null;
}

function resolveRenderedTargetLink(targetHref: string, link: string) {
  const trimmedTargetHref = targetHref.trim();
  if (!trimmedTargetHref) return null;
  try {
    return new URL(trimmedTargetHref).toString();
  } catch {
    // continue
  }
  if (link.trim()) {
    try {
      return new URL(trimmedTargetHref, link.trim()).toString();
    } catch {
      // continue
    }
  }
  const baseUrl = resolveBaseUrl();
  if (baseUrl) {
    try {
      return new URL(trimmedTargetHref, `${baseUrl}/`).toString();
    } catch {
      // continue
    }
  }
  return trimmedTargetHref;
}

export function renderRequestConfirmationBody(
  interaction: AwaitingHumanInteraction | null | undefined,
  link = "",
) {
  if (!interaction || interaction.kind !== "request_confirmation") return null;
  const lines: string[] = [];
  if (interaction.payload.prompt?.trim()) {
    lines.push(interaction.payload.prompt.trim());
  }
  if (interaction.payload.detailsMarkdown?.trim()) {
    if (lines.length > 0) lines.push("");
    lines.push(interaction.payload.detailsMarkdown.trim());
  }
  if (lines.length > 0) lines.push("");
  lines.push(REQUEST_CONFIRMATION_REPLY_INSTRUCTIONS);
  if (interaction.payload.target?.label?.trim() || interaction.payload.target?.href?.trim()) {
    if (lines.length > 0) lines.push("");
    if (interaction.payload.target.label?.trim()) {
      lines.push(`Target: ${interaction.payload.target.label.trim()}`);
    }
    if (interaction.payload.target.href?.trim()) {
      const renderedTargetLink = resolveRenderedTargetLink(interaction.payload.target.href, link);
      if (renderedTargetLink) {
        lines.push(`Target link: ${renderedTargetLink}`);
      }
    }
  }
  if (lines.length > 0) lines.push("");
  lines.push("Disclaimer:");
  lines.push("It is your responsibility to read and verify this content. Not doing so may result in unattended negative consequence leading to financial loss or brand harm");
  const body = lines.join("\n").trim();
  if (!link.trim()) return body || null;
  return body ? `${body}\n\nOpen in Bizbox: ${link.trim()}` : `Open in Bizbox: ${link.trim()}`;
}

function summarizeBlockers(blockers: AwaitingHumanBlocker[] | null | undefined) {
  if (!blockers || blockers.length === 0) return "Waiting on a human-owned blocking issue.";
  const [first] = blockers;
  if (!first) return "Waiting on a human-owned blocking issue.";
  const label = first.identifier ?? first.title;
  if (blockers.length === 1) {
    return `Waiting on human input to unblock ${label}.`;
  }
  return `Waiting on human input to unblock ${label} and ${blockers.length - 1} other blocker(s).`;
}

function resolveNeedsHumanInput(input: AwaitingHumanHandoffInput) {
  switch (input.handoffKind) {
    case "request_confirmation":
      return truncateText(
        firstNonEmpty(
          input.interaction?.summary,
          input.interaction?.title,
          input.interaction?.kind === "request_confirmation"
            ? input.interaction.payload.prompt
            : null,
        ) ?? "Need a human confirmation before work can continue.",
        220,
      );
    case "ask_user_questions":
      return truncateText(
        firstNonEmpty(
          input.interaction?.summary,
          input.interaction?.title,
          summarizeQuestions(input.interaction),
        ) ?? "Need a human answer before work can continue.",
        220,
      );
    case "human_owned_blocker":
      return truncateText(summarizeBlockers(input.blockers), 220);
  }
}

function resolveIssuePathId(issue: AwaitingHumanIssueSnapshot) {
  return issue.identifier ?? issue.id;
}

function resolveBaseUrl() {
  const configured = process.env.BIZBOX_PUBLIC_URL?.trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().replace(/\/+$/, "");
    } catch {
      return null;
    }
  }
  const apiUrl = process.env.BIZBOX_API_URL?.trim();
  if (!apiUrl) return null;
  try {
    const parsed = new URL(apiUrl);
    if (parsed.pathname === "/api") {
      parsed.pathname = "";
    } else {
      parsed.pathname = parsed.pathname.replace(/\/api\/?$/, "");
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function resolveAudienceUserId(input: AwaitingHumanHandoffInput) {
  if (input.handoffKind !== "human_owned_blocker") return null;
  const userIds = [...new Set(
    (input.blockers ?? [])
      .map((blocker) => blocker.assigneeUserId ?? null)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  )];
  return userIds.length === 1 ? userIds[0] : null;
}

function buildNotification(
  input: AwaitingHumanHandoffInput,
  link: string,
  needsHumanInput: string,
  audienceUserId: string | null,
): AwaitingHumanNotificationPayload {
  const label = input.updatedIssue.identifier ?? truncateText(input.updatedIssue.title, 48);
  const isQuestionHandoff = input.handoffKind === "ask_user_questions";
  const approvalContext = input.approvalContext
    ? {
      approvalName: input.approvalContext.approvalName ?? null,
      approvalStage: input.approvalContext.approvalStage ?? null,
      requiresSecondReview: input.approvalContext.requiresSecondReview ?? null,
    }
    : null;
  return {
    title: truncateText(
      isQuestionHandoff
        ? `${label} needs answers`
        : input.handoffKind === "request_confirmation"
          ? `${label} needs confirmation`
          : `${label} is waiting on human input`,
      120,
    ),
    summary: truncateText(needsHumanInput, 280),
    link,
    cta: isQuestionHandoff
      ? "Reply with answers to the questions below."
      : "Reply with Approve, Reject, or Change followed by feedback.",
    labels: ["awaiting_human", input.handoffKind],
    kind: input.handoffKind,
    interactionId: input.interaction?.id ?? null,
    audience: audienceUserId,
    body: isQuestionHandoff
      ? renderAskUserQuestionsBody(input.interaction, link)
      : input.handoffKind === "request_confirmation"
        ? renderRequestConfirmationBody(input.interaction, link)
        : null,
    approvalContext,
    target: input.handoffKind === "request_confirmation" && input.interaction?.kind === "request_confirmation"
      ? {
        label: input.interaction.payload.target?.label ?? null,
        href: input.interaction.payload.target?.href ?? null,
      }
      : null,
  };
}

function buildDedupeKey(input: AwaitingHumanHandoffInput) {
  if (input.handoffKind === "human_owned_blocker") {
    const blockerIds = [...new Set((input.blockers ?? []).map((blocker) => blocker.id))].sort();
    return `human-blocker:${input.updatedIssue.id}:${blockerIds.join(",")}`;
  }
  return `interaction:${input.interaction?.id ?? input.updatedIssue.id}`;
}

async function hasLoggedAwaitingHumanHandoff(db: Db, input: AwaitingHumanHandoffInput, dedupeKey: string) {
  const cycleStart = input.updatedIssue.updatedAt
    ? new Date(input.updatedIssue.updatedAt)
    : null;
  const rows = await db
    .select({
      createdAt: activityLog.createdAt,
      details: activityLog.details,
    })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, input.updatedIssue.companyId),
      eq(activityLog.action, "issue.awaiting_human.entered"),
      eq(activityLog.entityId, input.updatedIssue.id),
      ...(cycleStart && !Number.isNaN(cycleStart.getTime()) ? [gte(activityLog.createdAt, cycleStart)] : []),
    ));

  return rows.some((row) => {
    if (cycleStart && row.createdAt && row.createdAt < cycleStart) return false;
    const details = row.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) return false;
    return (details as Record<string, unknown>).dedupeKey === dedupeKey;
  });
}

export async function maybeLogAwaitingHumanHandoff(
  db: Db,
  input: AwaitingHumanHandoffInput,
) {
  if (input.updatedIssue.status !== "awaiting_human") return false;

  const issuePathId = resolveIssuePathId(input.updatedIssue);
  const issuePath = `/issues/${issuePathId}`;
  const baseUrl = resolveBaseUrl();
  const issueUrl = baseUrl ? new URL(issuePath, `${baseUrl}/`).toString() : null;
  const needsHumanInput = resolveNeedsHumanInput(input);
  const dedupeKey = buildDedupeKey(input);
  if (await hasLoggedAwaitingHumanHandoff(db, input, dedupeKey)) return false;
  const audienceUserId = resolveAudienceUserId(input);
  const notificationLink = issueUrl ?? issuePath;
  const notification = buildNotification(input, notificationLink, needsHumanInput, audienceUserId);
  const firstBlocker = input.blockers?.[0] ?? null;

  if (input.emitIssueUpdatedActivity) {
    await logActivity(db, {
      companyId: input.updatedIssue.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId ?? null,
      runId: input.actor.runId ?? null,
      action: "issue.updated",
      entityType: "issue",
      entityId: input.updatedIssue.id,
      details: {
        identifier: input.updatedIssue.identifier,
        status: "awaiting_human",
        previousStatus: input.previousIssue.status,
        assigneeAgentId: input.updatedIssue.assigneeAgentId ?? null,
        assigneeUserId: input.updatedIssue.assigneeUserId ?? null,
        source: input.source,
        interactionId: input.interaction?.id ?? null,
        interactionKind: input.interaction?.kind ?? null,
        blockerIssueId: firstBlocker?.id ?? null,
        blockerIdentifier: firstBlocker?.identifier ?? null,
        _previous: {
          status: input.previousIssue.status,
          assigneeAgentId: input.previousIssue.assigneeAgentId ?? null,
          assigneeUserId: input.previousIssue.assigneeUserId ?? null,
        },
      },
    });
  }

  const delivery = input.delivery === "none"
    ? {
      status: "skipped",
      channel: "audit-only",
      detail: "audit-only",
      externalId: null,
    }
    : await enqueueAwaitingHumanNotification(db, {
      companyId: input.updatedIssue.companyId,
      issueId: input.updatedIssue.id,
      dedupeKey,
      handoffKind: input.handoffKind,
      notification,
    });

  if (
    input.delivery !== "none"
    && delivery.status !== "sent"
    && delivery.status !== "enqueued"
  ) {
    logger.warn(
      {
        companyId: input.updatedIssue.companyId,
        issueId: input.updatedIssue.id,
        handoffKind: input.handoffKind,
        dedupeKey,
        channel: delivery.channel,
        detail: delivery.detail,
      },
      "awaiting_human notification was not delivered",
    );
  }

  await logActivity(db, {
    companyId: input.updatedIssue.companyId,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    agentId: input.actor.agentId ?? null,
    runId: input.actor.runId ?? null,
    action: "issue.awaiting_human.entered",
    entityType: "issue",
    entityId: input.updatedIssue.id,
    details: {
      issueId: input.updatedIssue.id,
      issueIdentifier: input.updatedIssue.identifier,
      issueTitle: input.updatedIssue.title,
      issuePathId,
      issuePath,
      issueUrl,
      previousStatus: input.previousIssue.status,
      status: "awaiting_human",
      source: input.source,
      handoffKind: input.handoffKind,
      needsHumanInput,
      audienceUserId,
      interactionId: input.interaction?.id ?? null,
      interactionKind: input.interaction?.kind ?? null,
      blockerIssueId: firstBlocker?.id ?? null,
      blockerIdentifier: firstBlocker?.identifier ?? null,
      approvalContext: input.approvalContext ?? null,
      dedupeKey,
      notification,
      notificationDelivery: {
        status: delivery.status,
        channel: delivery.channel,
        detail: delivery.detail,
        externalId: delivery.externalId ?? null,
      },
    },
  });

  return delivery.status === "sent" || delivery.status === "enqueued" || input.delivery === "none";
}
