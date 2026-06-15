import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  awaitingHumanBridgeInboundEvents,
  awaitingHumanBridges,
  activityLog,
  companies,
  issueComments,
  issues,
} from "@paperclipai/db";
import type {
  AskUserQuestionsInteraction,
  IssueThreadInteraction,
} from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import { finalizeAcceptedInteractionResolution, isClosedIssueStatus } from "./issue-interaction-resolution-effects.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import {
  classifyRequestConfirmationReply,
  renderAskUserQuestionsBody,
  renderRequestConfirmationBody,
} from "./awaiting-human-handoff.js";
import type { AwaitingHumanNotificationPayload } from "./awaiting-human-notifications.js";
import type { AwaitingHumanBridgeAdapter, AwaitingHumanBridgePollEvent } from "./awaiting-human-bridge-registry.js";
import type { StorageService } from "../storage/types.js";
export type { AwaitingHumanBridgeAdapter, AwaitingHumanBridgePollEvent };

type AwaitingHumanBridgeDeps = {
  resolveProviderForCompany(companyId: string): Promise<string>;
  resolveAdapter(provider: string): AwaitingHumanBridgeAdapter;
  hasAdapter(provider: string): boolean;
  storage?: StorageService;
  requestWakeup?: (input: {
    companyId: string;
    agentId: string;
    payload: Record<string, unknown>;
    reason: string;
    requestedByActorType: "system" | "user" | "agent";
    requestedByActorId: string;
  }) => Promise<void>;
};

type BridgePollSummary = {
  checked: number;
  approved: number;
  rejected: number;
  replies: number;
  noSignal: number;
  failed: number;
  skipped: number;
  approvedIssueIds: string[];
  approvedInteractionIds: string[];
};

function emptySummary(): BridgePollSummary {
  return {
    checked: 0,
    approved: 0,
    rejected: 0,
    replies: 0,
    noSignal: 0,
    failed: 0,
    skipped: 0,
    approvedIssueIds: [],
    approvedInteractionIds: [],
  };
}

const AWAITING_HUMAN_POLL_FAILURE_BACKOFF_MS = 5 * 60 * 1000;

function parseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstNonEmptyString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = readNonEmptyString(value);
    if (normalized) return normalized;
  }
  return null;
}

function truncateText(value: string, maxLength: number) {
  const compact = value.trim().replace(/\s+/g, " ");
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatProviderLabel(provider: string) {
  const normalized = provider.trim();
  if (normalized.length === 0) return "Reply";
  return normalized
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function buildReplyReceivedBody(provider: string, replyBody: string) {
  return `${formatProviderLabel(provider)} reply received:\n\n${replyBody}`;
}

function buildApprovalSignalCommentBody(provider: string, replyBody: string) {
  return buildReplyReceivedBody(provider, replyBody);
}

function normalizeForMatch(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const AFFIRMATIVE_KEYWORDS = [
  "yes",
  "yep",
  "yeah",
  "yup",
  "approve",
  "approved",
  "ok",
  "okay",
  "true",
  "correct",
  "affirmative",
  "full",
  "complete",
  "rendered",
  "displayed",
  "visible",
  "mirror",
  "mirrored",
] as const;

const NEGATIVE_KEYWORDS = [
  "no",
  "nope",
  "nah",
  "reject",
  "rejected",
  "unapproved",
  "decline",
  "declined",
  "false",
  "incorrect",
  "partial",
  "partially",
  "not",
  "missing",
  "failed",
] as const;

function tokenizeNormalized(value: string) {
  if (!value) return [];
  return value.split(/\s+/).filter(Boolean);
}

function isWithinEditDistance(a: string, b: string, maxDistance: number) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > maxDistance) return false;
  if (maxDistance < 1) return false;

  const prev = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let next = [i];
    let rowMin = next[0] as number;
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (prev[j] as number) + 1,
        (next[j - 1] as number) + 1,
        (prev[j - 1] as number) + substitutionCost,
      );
      next.push(value);
      rowMin = Math.min(rowMin, value);
    }
    for (let j = 0; j < next.length; j += 1) {
      prev[j] = next[j] as number;
    }
  }
  return (prev[b.length] as number) <= maxDistance;
}

function tokenLooselyMatchesKeyword(token: string, keyword: string) {
  if (token === keyword) return true;
  if (keyword.length <= 4) {
    return isWithinEditDistance(token, keyword, 1);
  }
  return isWithinEditDistance(token, keyword, 3);
}

function replyIntentScore(normalized: string, keywords: readonly string[]) {
  const tokens = tokenizeNormalized(normalized);
  let score = 0;
  for (const token of tokens) {
    if (keywords.some((keyword) => tokenLooselyMatchesKeyword(token, keyword))) {
      score += 1;
    }
  }
  return score;
}

function detectReplyIntent(value: string): "affirmative" | "negative" | null {
  const normalized = normalizeForMatch(value);
  if (!normalized) return null;
  if (
    normalized.includes("not approved")
    || normalized.includes("unapproved")
    || normalized.includes("not rendered")
    || normalized.includes("no mirror")
  ) {
    return "negative";
  }

  const positiveScore = replyIntentScore(normalized, AFFIRMATIVE_KEYWORDS);
  const negativeScore = replyIntentScore(normalized, NEGATIVE_KEYWORDS);
  if (positiveScore === 0 && negativeScore === 0) return null;
  if (positiveScore > negativeScore) return "affirmative";
  if (negativeScore > positiveScore) return "negative";
  return null;
}

function parseReplyByQuestionIndex(replyBody: string) {
  const segments = new Map<number, string>();
  const matches = [...replyBody.matchAll(/\bq(?:uestion)?\s*(\d+)\b/gi)];
  if (matches.length === 0) return segments;

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    if (!current) continue;
    const questionIndex = Number.parseInt(current[1] ?? "", 10);
    if (!Number.isInteger(questionIndex) || questionIndex < 1) continue;
    const start = (current.index ?? 0) + current[0].length;
    const next = matches[index + 1];
    const end = next?.index ?? replyBody.length;
    const segment = replyBody.slice(start, end).trim();
    if (segment.length > 0) {
      segments.set(questionIndex, segment);
    }
  }
  return segments;
}

function classifyOptionIntent(option: { id: string; label: string; description?: string | null }) {
  const normalized = normalizeForMatch(`${option.id} ${option.label} ${option.description ?? ""}`);
  if (!normalized) return null;
  if (normalized.startsWith("not ") || normalized.includes(" no ") || normalized.includes(" reject ")) {
    return "negative" as const;
  }
  const positiveScore = replyIntentScore(normalized, AFFIRMATIVE_KEYWORDS);
  const negativeScore = replyIntentScore(normalized, NEGATIVE_KEYWORDS);
  if (positiveScore === 0 && negativeScore === 0) return null;
  if (positiveScore > negativeScore) return "affirmative" as const;
  if (negativeScore > positiveScore) return "negative" as const;
  if (negativeScore > 0) return "negative" as const;
  return null;
}

function resolveOptionByIntent(
  question: AskUserQuestionsInteraction["payload"]["questions"][number],
  intent: "affirmative" | "negative",
) {
  if (question.selectionMode !== "single" || question.options.length < 2) return null;
  const candidates = question.options
    .map((option) => ({ optionId: option.id, intent: classifyOptionIntent(option) }))
    .filter((entry): entry is { optionId: string; intent: "affirmative" | "negative" } => Boolean(entry.intent));
  if (candidates.length < 2) return null;

  const positive = candidates.find((entry) => entry.intent === "affirmative")?.optionId ?? null;
  const negative = candidates.find((entry) => entry.intent === "negative")?.optionId ?? null;
  if (!positive || !negative || positive === negative) return null;
  return intent === "affirmative" ? positive : negative;
}

function optionMatchesReply(reply: string, option: { id: string; label: string; description?: string | null }) {
  const candidates = [option.id, option.label, option.description ?? ""]
    .map((value) => normalizeForMatch(value))
    .filter((value) => value.length > 0);
  for (const candidate of candidates) {
    if (candidate.length === 1) continue;
    if (reply === candidate) return true;
    if (reply.startsWith(`${candidate} `)) return true;
    if (reply.endsWith(` ${candidate}`)) return true;
    if (reply.includes(` ${candidate} `)) return true;
  }
  return false;
}

function getFallbackReplyOptionId(question: AskUserQuestionsInteraction["payload"]["questions"][number]) {
  const commentLike = question.options.find((option) => {
    const normalizedId = normalizeForMatch(option.id);
    const normalizedLabel = normalizeForMatch(option.label);
    return normalizedId === "comment"
      || normalizedLabel.includes("comment")
      || normalizedLabel.includes("follow up")
      || normalizedLabel.includes("free text");
  });
  if (commentLike) return commentLike.id;
  if (question.required && question.options.length === 1) {
    return question.options[0]?.id ?? null;
  }
  return null;
}

function buildAskUserQuestionsResponseFromReply(input: {
  interaction: AskUserQuestionsInteraction;
  replyBody: string;
}) {
  const normalizedReply = normalizeForMatch(input.replyBody);
  if (!normalizedReply) return null;
  const replyByQuestionIndex = parseReplyByQuestionIndex(input.replyBody);
  const globalIntent = detectReplyIntent(input.replyBody);

  const answers: Array<{ questionId: string; optionIds: string[] }> = [];
  for (const [index, question] of input.interaction.payload.questions.entries()) {
    const scopedReply = replyByQuestionIndex.get(index + 1) ?? input.replyBody;
    const normalizedScopedReply = normalizeForMatch(scopedReply);
    const matched = question.options
      .filter((option) => optionMatchesReply(normalizedScopedReply || normalizedReply, option))
      .map((option) => option.id);

    const unique = [...new Set(matched)];
    if (unique.length === 0) {
      const intent = detectReplyIntent(scopedReply) ?? globalIntent;
      if (intent) {
        const intentOptionId = resolveOptionByIntent(question, intent);
        if (intentOptionId) unique.push(intentOptionId);
      }
    }

    if (unique.length === 0) {
      const fallback = getFallbackReplyOptionId(question);
      if (fallback) {
        unique.push(fallback);
      }
    }

    if (unique.length === 0) {
      if (question.required) {
        return null;
      }
      continue;
    }

    const optionIds = question.selectionMode === "single" ? [unique[0] as string] : unique;
    answers.push({
      questionId: question.id,
      optionIds,
    });
  }

  if (answers.length === 0) return null;
  return {
    answers,
    summaryMarkdown: input.replyBody.trim(),
  };
}

function shouldWakeAssigneeForInteractionResolution(
  interaction: Pick<IssueThreadInteraction, "continuationPolicy" | "status">,
) {
  if (
    interaction.continuationPolicy !== "wake_assignee"
    && interaction.continuationPolicy !== "wake_assignee_on_accept"
  ) return false;
  if (interaction.continuationPolicy === "wake_assignee_on_accept" && interaction.status !== "accepted") return false;
  if (interaction.status === "expired") return false;
  return true;
}

export function shouldWakeOnReplyIssueStatus(issueStatus: string | null | undefined) {
  return Boolean(issueStatus && issueStatus !== "backlog" && !isClosedIssueStatus(issueStatus));
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

function buildBridgeNotification(input: {
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  companyPrefix: string | null;
  interaction: Awaited<ReturnType<ReturnType<typeof issueThreadInteractionService>["getById"]>>;
}) {
  const { interaction } = input;
  if (!interaction || (interaction.kind !== "request_confirmation" && interaction.kind !== "ask_user_questions")) {
    return null;
  }
  const label = input.issueIdentifier ?? truncateText(input.issueTitle, 48);
  const baseUrl = resolveBaseUrl();
  const issuePath = input.companyPrefix
    ? `/${input.companyPrefix}/issues/${input.issueIdentifier ?? input.issueId}`
    : `/issues/${input.issueIdentifier ?? input.issueId}`;
  const link = baseUrl ? `${baseUrl}${issuePath}` : "";
  if (interaction.kind === "ask_user_questions") {
    return {
      handoffKind: "ask_user_questions" as const,
      notification: {
        title: truncateText(`${label} needs answers`, 120),
        summary: truncateText(
          firstNonEmptyString(
            interaction.summary,
            interaction.title,
            interaction.payload.title ?? null,
            `Need answers to ${interaction.payload.questions.length} question(s).`,
          ) ?? "Need answers to proceed.",
          280,
        ),
        link,
        cta: "Reply with the needed answers, decisions, or corrections.",
        labels: ["awaiting_human", "ask_user_questions"],
        kind: interaction.kind,
        interactionId: interaction.id,
        body: renderAskUserQuestionsBody(interaction, link),
      } satisfies AwaitingHumanNotificationPayload,
    };
  }
  return {
    handoffKind: "request_confirmation" as const,
    notification: {
      title: truncateText(`${label} needs confirmation`, 120),
      summary: truncateText(
        firstNonEmptyString(
          interaction.summary,
          interaction.title,
          interaction.payload.prompt,
        ) ?? "Need confirmation to proceed.",
        280,
      ),
      link,
      cta: "Reply with Approve, Reject, or Change followed by feedback.",
      labels: ["awaiting_human", "request_confirmation"],
      kind: interaction.kind,
      interactionId: interaction.id,
      approvalContext: interaction.payload.approvalStage
        ? {
          approvalName: interaction.payload.approvalName ?? null,
          approvalStage: interaction.payload.approvalStage,
          requiresSecondReview: interaction.payload.requiresSecondReview ?? false,
        }
        : null,
      target: {
        label: interaction.payload.target?.label ?? null,
        href: interaction.payload.target?.href ?? null,
      },
      body: renderRequestConfirmationBody(interaction, link),
    } satisfies AwaitingHumanNotificationPayload,
  };
}

export function awaitingHumanBridgeService(db: Db, deps: AwaitingHumanBridgeDeps) {
  const interactionsSvc = issueThreadInteractionService(db);

async function prepareBridgeDeliveryNotification(input: {
  db: Db;
  interactionsSvc: ReturnType<typeof issueThreadInteractionService>;
  companyId: string;
  issueId: string;
  interactionId: string;
  notification: AwaitingHumanNotificationPayload;
}): Promise<AwaitingHumanNotificationPayload> {
  let notification: AwaitingHumanNotificationPayload = {
    ...input.notification,
    interactionId: readNonEmptyString(input.notification.interactionId) ?? input.interactionId,
  };

  const interaction = await input.interactionsSvc.getById(input.interactionId);
  if (interaction?.kind === "request_confirmation") {
    const targetHref = readNonEmptyString(notification.target?.href);
    const interactionTargetHref = readNonEmptyString(interaction.payload.target?.href);
    if (!targetHref && interactionTargetHref) {
      notification = {
        ...notification,
        target: {
          label: readNonEmptyString(interaction.payload.target?.label) ?? notification.target?.label ?? null,
          href: interactionTargetHref,
        },
      };
    }
  }

  return notification;
}


  async function insertWakeup(input: {
    companyId: string;
    agentId: string;
    payload: Record<string, unknown>;
    reason?: string;
    requestedByActorType?: "system" | "user" | "agent";
    requestedByActorId?: string;
    dbClient?: Db;
  }) {
    if (deps.requestWakeup) {
      await deps.requestWakeup({
        companyId: input.companyId,
        agentId: input.agentId,
        payload: input.payload,
        reason: input.reason ?? "issue_commented",
        requestedByActorType: input.requestedByActorType ?? "system",
        requestedByActorId: input.requestedByActorId ?? "awaiting_human_bridge",
      });
      return;
    }
    const client = input.dbClient ?? db;
    await client.insert(agentWakeupRequests).values({
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: input.reason ?? "issue_commented",
      payload: input.payload,
      requestedByActorType: input.requestedByActorType ?? "system",
      requestedByActorId: input.requestedByActorId ?? "awaiting_human_bridge",
    });
  }

  async function touchIssueUpdatedAt(issueId: string) {
    await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issueId));
  }

  type RetryBridgeOpenSummary = {
    checked: number;
    reopened: number;
    failed: number;
    skipped: number;
    issueIds: string[];
    interactionIds: string[];
  };

  function emptyRetryBridgeOpenSummary(): RetryBridgeOpenSummary {
    return {
      checked: 0,
      reopened: 0,
      failed: 0,
      skipped: 0,
      issueIds: [],
      interactionIds: [],
    };
  }

  async function closeBridgeRow(input: {
    row: typeof awaitingHumanBridges.$inferSelect;
    outcome?: "approved" | "rejected" | "expired" | "superseded" | "cancelled" | null;
    reason?: string | null;
    notifyAdapter?: boolean;
    dbClient?: Db;
  }) {
    const client = input.dbClient ?? db;
    const [updated] = await client.update(awaitingHumanBridges).set({
      status: "closed",
      closeOutcome: input.outcome ?? null,
      closeReason: input.reason ?? null,
      closedAt: new Date(),
      nextPollAt: null,
      updatedAt: new Date(),
    }).where(eq(awaitingHumanBridges.id, input.row.id)).returning();

    if (input.notifyAdapter !== false) {
      try {
        await deps.resolveAdapter(input.row.provider).close({
          bridgeId: input.row.id,
          externalThreadId: input.row.externalThreadId ?? null,
          externalMessageId: input.row.externalMessageId ?? null,
          outcome: input.outcome ?? null,
          reason: input.reason ?? null,
        });
      } catch (error) {
        logger.warn({
          err: error,
          bridgeId: input.row.id,
          companyId: input.row.companyId,
          issueId: input.row.issueId,
        }, "failed to close awaiting_human bridge adapter after closing row");
      }
    }

    return updated ?? input.row;
  }

  async function finalizeAcceptedResolutionAfterCommit(
    input: Omit<Parameters<typeof finalizeAcceptedInteractionResolution>[0], "db" | "heartbeat" | "logActivity">,
  ) {
    await finalizeAcceptedInteractionResolution({
      db,
      heartbeat: {
        wakeup: async (agentId, wake) => {
          await insertWakeup({
            companyId: input.issue.companyId,
            agentId,
            payload: parseObject(wake.payload),
            reason: wake.reason ?? undefined,
            requestedByActorType: wake.requestedByActorType ?? undefined,
            requestedByActorId: wake.requestedByActorId ?? undefined,
            dbClient: db,
          });
        },
      },
      logActivity,
      ...input,
    });
  }

  async function retryFailedBridgeOpenings() {
    const rows = await db
      .select({
        companyId: activityLog.companyId,
        issueId: activityLog.entityId,
        interactionId: sql<string | null>`${activityLog.details} ->> 'interactionId'`.as("interactionId"),
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.entityType, "issue"),
        eq(activityLog.action, "issue.awaiting_human.bridge_open_failed"),
        sql`cast(${activityLog.details} ->> 'interactionId' as uuid) is not null`,
        sql`not exists (
          select 1
          from ${awaitingHumanBridges}
          where ${awaitingHumanBridges.interactionId} = cast(${activityLog.details} ->> 'interactionId' as uuid)
            and ${awaitingHumanBridges.status} in ('pending_delivery', 'waiting_for_human')
        )`,
      ))
      .orderBy(desc(activityLog.createdAt))
      .limit(200);

    const summary = emptyRetryBridgeOpenSummary();
    const seen = new Set<string>();

    for (const row of rows) {
      const interactionId = readNonEmptyString(row.interactionId);
      if (!interactionId || seen.has(interactionId)) {
        summary.skipped += 1;
        continue;
      }
      seen.add(interactionId);
      summary.checked += 1;

      try {
        const bridgeContext = await resolveOpenForPendingInteractionContext({
          companyId: row.companyId,
          issueId: row.issueId,
          interactionId,
        });
        if (!bridgeContext) {
          summary.skipped += 1;
          continue;
        }

        const [failedBridge] = await db
          .select()
          .from(awaitingHumanBridges)
          .where(and(
            eq(awaitingHumanBridges.companyId, row.companyId),
            eq(awaitingHumanBridges.interactionId, interactionId),
            eq(awaitingHumanBridges.status, "failed"),
          ))
          .orderBy(desc(awaitingHumanBridges.createdAt))
          .limit(1);

        const bridge = failedBridge
          ? await createRetryBridgeRowAndRedeliver({
            bridge: failedBridge,
            companyId: row.companyId,
            issueId: row.issueId,
            interactionId,
            agentId: bridgeContext.agentId,
            handoffKind: bridgeContext.outbound.handoffKind,
            notification: bridgeContext.outbound.notification,
          })
          : await openOrReuseForInteraction({
            companyId: row.companyId,
            issueId: row.issueId,
            interactionId,
            agentId: bridgeContext.agentId,
            handoffKind: bridgeContext.outbound.handoffKind,
            notification: bridgeContext.outbound.notification,
          });

        if (bridge) {
          summary.reopened += 1;
          summary.issueIds.push(row.issueId);
          summary.interactionIds.push(interactionId);
        } else {
          summary.skipped += 1;
        }
      } catch (error) {
        summary.failed += 1;
        const detail = error instanceof Error ? error.message : String(error);
        await logActivity(db, {
          companyId: row.companyId,
          actorType: "system",
          actorId: "awaiting_human_bridge",
          action: "issue.awaiting_human.bridge_open_retry_failed",
          entityType: "issue",
          entityId: row.issueId,
          details: {
            interactionId,
            detail,
          },
        });
      }
    }

    return summary;
  }

  async function forceCloseExpiredBridgeRow(input: {
    row: typeof awaitingHumanBridges.$inferSelect;
    reason: string;
    detail?: string | null;
  }) {
    const now = new Date();
    const [updated] = await db.update(awaitingHumanBridges).set({
      status: "closed",
      closeOutcome: "expired",
      closeReason: input.reason,
      closedAt: now,
      nextPollAt: null,
      lastError: input.detail ?? null,
      updatedAt: now,
    }).where(eq(awaitingHumanBridges.id, input.row.id)).returning();
    return updated ?? input.row;
  }

  async function deliverBridgeRow(input: {
    row: typeof awaitingHumanBridges.$inferSelect;
    companyId: string;
    issueId: string;
    interactionId: string;
    agentId: string;
    handoffKind: "request_confirmation" | "ask_user_questions";
    notification: AwaitingHumanNotificationPayload;
    }) {
    const adapter = deps.resolveAdapter(input.row.provider);
    const notification = await prepareBridgeDeliveryNotification({
      db,
      interactionsSvc,
      companyId: input.companyId,
      issueId: input.issueId,
      interactionId: input.interactionId,
      notification: input.notification,
    });
    let delivered;
    try {
      delivered = await adapter.send({
        bridgeId: input.row.id,
        companyId: input.companyId,
        issueId: input.issueId,
        interactionId: input.interactionId,
        agentId: input.agentId,
        handoffKind: input.handoffKind,
        notification,
        storage: deps.storage,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await db.update(awaitingHumanBridges).set({
        status: "failed",
        lastError: detail,
        updatedAt: new Date(),
      }).where(eq(awaitingHumanBridges.id, input.row.id));
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: "awaiting_human_bridge",
        action: "issue.awaiting_human.bridge_open_failed",
        entityType: "issue",
        entityId: input.issueId,
        details: {
          bridgeId: input.row.id,
          interactionId: input.interactionId,
          provider: input.row.provider,
          handoffKind: input.handoffKind,
          detail,
        },
      });
      throw error;
    }

    const [updated] = await db.update(awaitingHumanBridges).set({
      status: "waiting_for_human",
      externalThreadId: delivered.externalThreadId,
      externalMessageId: delivered.externalMessageId ?? null,
      nextPollAt: delivered.nextPollAt ?? null,
      lastError: null,
      updatedAt: new Date(),
    }).where(eq(awaitingHumanBridges.id, input.row.id)).returning();

    return {
      ...(updated ?? input.row),
      delivery: {
        reviewFile: delivered.reviewFile ?? notification.reviewFile ?? null,
      },
    };
  }

  async function createRetryBridgeRowAndRedeliver(input: {
    bridge: typeof awaitingHumanBridges.$inferSelect;
    companyId: string;
    issueId: string;
    interactionId: string;
    agentId: string;
    handoffKind: "request_confirmation" | "ask_user_questions";
    notification: AwaitingHumanNotificationPayload;
  }) {
    const created = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const [inserted] = await txDb.insert(awaitingHumanBridges).values({
        companyId: input.companyId,
        issueId: input.issueId,
        interactionId: input.interactionId,
        agentId: input.agentId,
        provider: input.bridge.provider,
        status: "pending_delivery",
      }).onConflictDoNothing({
        target: awaitingHumanBridges.interactionId,
        where: inArray(awaitingHumanBridges.status, ["pending_delivery", "waiting_for_human"]),
      }).returning();

      if (!inserted) {
        return null;
      }

      await closeBridgeRow({
        row: input.bridge,
        outcome: "superseded",
        notifyAdapter: false,
        dbClient: txDb,
      });

      return inserted;
    });

    if (!created) {
      return null;
    }

    try {
      await deps.resolveAdapter(input.bridge.provider).close({
        bridgeId: input.bridge.id,
        externalThreadId: input.bridge.externalThreadId ?? null,
        externalMessageId: input.bridge.externalMessageId ?? null,
        outcome: "failed",
        reason: input.bridge.lastError ?? null,
      });
    } catch (error) {
      logger.warn({
        err: error,
        bridgeId: input.bridge.id,
        companyId: input.companyId,
        issueId: input.issueId,
      }, "failed to close retried awaiting_human failed bridge adapter");
    }

    return deliverBridgeRow({
      row: created,
      companyId: input.companyId,
      issueId: input.issueId,
      interactionId: input.interactionId,
      agentId: input.agentId,
      handoffKind: input.handoffKind,
      notification: input.notification,
    });
  }

  async function closeOpenBridgesForIssue(input: {
    companyId: string;
    issueId: string;
    outcome?: "approved" | "rejected" | "expired" | "superseded" | "cancelled" | null;
    reason?: string | null;
  }) {
    const rows = await db.select().from(awaitingHumanBridges).where(and(
      eq(awaitingHumanBridges.companyId, input.companyId),
      eq(awaitingHumanBridges.issueId, input.issueId),
      inArray(awaitingHumanBridges.status, ["pending_delivery", "waiting_for_human"]),
    ));

    let closedCount = 0;
    for (const row of rows) {
      try {
        await closeBridgeRow({
          row,
          outcome: input.outcome ?? "superseded",
          reason: input.reason ?? null,
        });
        closedCount += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await logActivity(db, {
          companyId: input.companyId,
          actorType: "system",
          actorId: "system",
          agentId: null,
          runId: null,
          action: "issue.awaiting_human.bridge_close_failed",
          entityType: "issue",
          entityId: input.issueId,
          details: {
            bridgeId: row.id,
            provider: row.provider,
            outcome: input.outcome ?? "superseded",
            reason: input.reason ?? null,
            detail,
          },
        });
      }
    }

    return { closedCount };
  }

  async function addSystemIssueComment(input: {
    companyId: string;
    issueId: string;
    interactionId: string;
    body: string;
  }) {
    const [comment] = await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      authorAgentId: null,
      authorUserId: null,
      createdByRunId: null,
      body: input.body,
    }).returning();
    await touchIssueUpdatedAt(input.issueId);
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "awaiting_human_bridge",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: input.issueId,
      details: {
        commentId: comment?.id,
        bodySnippet: input.body.slice(0, 120),
        interactionId: input.interactionId,
      },
    });
    return comment;
  }

  async function logBridgePollError(input: {
    row: typeof awaitingHumanBridges.$inferSelect;
    error: unknown;
    phase: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const detail = input.error instanceof Error ? input.error.message : String(input.error);
    const stack = input.error instanceof Error ? input.error.stack : null;

    logger.error({
      err: input.error,
      phase: input.phase,
      bridgeId: input.row.id,
      companyId: input.row.companyId,
      issueId: input.row.issueId,
      interactionId: input.row.interactionId,
      provider: input.row.provider,
      externalMessageId: input.row.externalMessageId ?? null,
    }, "awaiting_human bridge poll error");

    await db.update(awaitingHumanBridges).set({
      lastError: detail,
      lastPolledAt: now,
      nextPollAt: new Date(now.getTime() + AWAITING_HUMAN_POLL_FAILURE_BACKOFF_MS),
      updatedAt: now,
    }).where(eq(awaitingHumanBridges.id, input.row.id));

    await logActivity(db, {
      companyId: input.row.companyId,
      actorType: "system",
      actorId: "awaiting_human_bridge",
      action: "issue.awaiting_human.bridge_poll_failed",
      entityType: "issue",
      entityId: input.row.issueId,
      details: {
        bridgeId: input.row.id,
        interactionId: input.row.interactionId,
        phase: input.phase,
        detail,
        stack: stack ? stack.slice(0, 500) : null,
        externalMessageId: input.row.externalMessageId ?? null,
      },
    });
  }

  async function resolveOpenForPendingInteractionContext(input: {
    companyId: string;
    issueId: string;
    interactionId: string;
  }) {
    const interaction = await interactionsSvc.getById(input.interactionId);
    if (
      !interaction
      || interaction.companyId !== input.companyId
      || interaction.issueId !== input.issueId
      || interaction.status !== "pending"
      || (interaction.kind !== "request_confirmation" && interaction.kind !== "ask_user_questions")
    ) {
      return null;
    }

    const [issue, company] = await Promise.all([
      db.select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        identifier: issues.identifier,
        title: issues.title,
      }).from(issues).where(and(
        eq(issues.id, input.issueId),
        eq(issues.companyId, input.companyId),
      )).limit(1).then((rows) => rows[0] ?? null),
      db.select({ issuePrefix: companies.issuePrefix }).from(companies).where(eq(companies.id, input.companyId)).limit(1).then((rows) => rows[0] ?? null),
    ]);
    if (!issue || issue.status !== "awaiting_human") return null;

    const agentId = issue.assigneeAgentId ?? interaction.createdByAgentId ?? null;
    const outbound = buildBridgeNotification({
      issueId: issue.id,
      issueIdentifier: issue.identifier ?? null,
      issueTitle: issue.title,
      companyPrefix: company?.issuePrefix ?? null,
      interaction,
    });
    if (!agentId || !outbound) return null;
    return {
      issue,
      interaction,
      agentId,
      outbound,
    };
  }

  async function openForPendingInteraction(input: {
    companyId: string;
    issueId: string;
    interactionId: string;
  }) {
    const context = await resolveOpenForPendingInteractionContext(input);
    if (!context) return null;

    try {
      return await openOrReuseForInteraction({
        companyId: input.companyId,
        issueId: input.issueId,
        interactionId: input.interactionId,
        agentId: context.agentId,
        handoffKind: context.outbound.handoffKind,
        notification: context.outbound.notification,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "awaiting-human-bridge-disabled") {
        return null;
      }
      throw error;
    }
  }

  const openOrReuseForInteraction = async (input: {
    companyId: string;
    issueId: string;
    interactionId: string;
    agentId: string;
    handoffKind: "request_confirmation" | "ask_user_questions";
    notification: AwaitingHumanNotificationPayload;
  }) => {
    const [existing] = await db
      .select()
      .from(awaitingHumanBridges)
      .where(and(
        eq(awaitingHumanBridges.companyId, input.companyId),
        eq(awaitingHumanBridges.interactionId, input.interactionId),
        inArray(awaitingHumanBridges.status, ["pending_delivery", "waiting_for_human"]),
      ))
      .limit(1);
    if (existing) return existing;

    const provider = await deps.resolveProviderForCompany(input.companyId);
    const [created] = await db.insert(awaitingHumanBridges).values({
      companyId: input.companyId,
      issueId: input.issueId,
      interactionId: input.interactionId,
      agentId: input.agentId,
      provider,
      status: "pending_delivery",
    }).onConflictDoNothing({
      target: awaitingHumanBridges.interactionId,
      where: inArray(awaitingHumanBridges.status, ["pending_delivery", "waiting_for_human"]),
    }).returning();

    if (!created) {
      const [existingAfterConflict] = await db
        .select()
        .from(awaitingHumanBridges)
        .where(and(
          eq(awaitingHumanBridges.companyId, input.companyId),
          eq(awaitingHumanBridges.interactionId, input.interactionId),
          inArray(awaitingHumanBridges.status, ["pending_delivery", "waiting_for_human"]),
        ))
        .orderBy(awaitingHumanBridges.createdAt)
        .limit(1);
      if (!existingAfterConflict) {
        throw new Error("Failed to reopen existing awaiting human bridge after conflict");
      }
      return existingAfterConflict;
    }

    return deliverBridgeRow({
      row: created,
      companyId: input.companyId,
      issueId: input.issueId,
      interactionId: input.interactionId,
      agentId: input.agentId,
      handoffKind: input.handoffKind,
      notification: input.notification,
    });
  };

  return {
    openOrReuseForInteraction,

    retryFailedBridgeOpenings,

    openForPendingInteraction,

    async attachOrReuseExistingDelivery(input: {
      companyId: string;
      issueId: string;
      interactionId: string;
      agentId: string;
      provider: string;
      externalMessageId: string;
      externalThreadId?: string | null;
    }) {
      const [existing] = await db
        .select()
        .from(awaitingHumanBridges)
        .where(and(
          eq(awaitingHumanBridges.companyId, input.companyId),
          eq(awaitingHumanBridges.interactionId, input.interactionId),
          inArray(awaitingHumanBridges.status, ["pending_delivery", "waiting_for_human"]),
        ))
        .orderBy(awaitingHumanBridges.createdAt)
        .limit(1);
      if (existing) {
        return {
          bridge: existing,
          reusedExisting: true as const,
        };
      }

      const [created] = await db.insert(awaitingHumanBridges).values({
        companyId: input.companyId,
        issueId: input.issueId,
        interactionId: input.interactionId,
        agentId: input.agentId,
        provider: input.provider,
        status: "waiting_for_human",
        externalMessageId: input.externalMessageId,
        externalThreadId: input.externalThreadId ?? null,
        nextPollAt: new Date(),
      }).onConflictDoNothing({
        target: awaitingHumanBridges.interactionId,
        where: inArray(awaitingHumanBridges.status, ["pending_delivery", "waiting_for_human"]),
      }).returning();
      if (created) {
        return {
          bridge: created,
          reusedExisting: false as const,
        };
      }
      const [existingAfterConflict] = await db
        .select()
        .from(awaitingHumanBridges)
        .where(and(
          eq(awaitingHumanBridges.companyId, input.companyId),
          eq(awaitingHumanBridges.interactionId, input.interactionId),
          inArray(awaitingHumanBridges.status, ["pending_delivery", "waiting_for_human"]),
      ))
      .orderBy(awaitingHumanBridges.createdAt)
      .limit(1);
      if (!existingAfterConflict) {
        throw new Error("Failed to attach existing awaiting human delivery bridge");
      }
      return {
        bridge: existingAfterConflict,
        reusedExisting: true as const,
      };
    },

    async reconcileDeliveredInteractions(input: Array<{
      companyId: string;
      issueId: string;
      interactionId: string;
      assigneeAgentId: string | null;
      createdByAgentId: string | null;
      handoffDetails: unknown;
    }>) {
      const summary = emptySummary();
      const now = new Date();

      for (const candidate of input) {
        const details = parseObject(candidate.handoffDetails);
        const delivery = parseObject(details.notificationDelivery);
        const messageId = readNonEmptyString(delivery.externalId);
        const provider = typeof delivery.channel === "string" ? delivery.channel.split("-")[0] : null;
        if (
          !provider
          || !deps.hasAdapter(provider)
          || (delivery.status !== "sent" && delivery.status !== "enqueued")
          || !messageId
        ) {
          summary.skipped += 1;
          continue;
        }

        const wakeAgentId = candidate.assigneeAgentId ?? candidate.createdByAgentId ?? null;
        if (!wakeAgentId) {
          summary.skipped += 1;
          continue;
        }

        let bridgeId: string | null = null;
        try {
          const { bridge, reusedExisting } = await this.attachOrReuseExistingDelivery({
            companyId: candidate.companyId,
            issueId: candidate.issueId,
            interactionId: candidate.interactionId,
            agentId: wakeAgentId,
            provider,
            externalMessageId: messageId,
          });
          bridgeId = bridge.id;
          if (reusedExisting && bridge.nextPollAt && bridge.nextPollAt > now) {
            summary.skipped += 1;
            continue;
          }
          const bridgeResult = await this.pollBridge(bridge.id, now);
          if (bridgeResult.failed === 0) {
            summary.checked += bridgeResult.checked;
          } else {
            logger.warn({
              err: new Error("bridge poll failed during delivered interaction reconciliation"),
              companyId: candidate.companyId,
              issueId: candidate.issueId,
              interactionId: candidate.interactionId,
              bridgeId,
            }, "failed to reconcile delivered awaiting human interaction");
          }
          summary.approved += bridgeResult.approved;
          summary.rejected += bridgeResult.rejected;
          summary.replies += bridgeResult.replies;
          summary.noSignal += bridgeResult.noSignal;
          summary.failed += bridgeResult.failed;
          summary.skipped += bridgeResult.skipped;
          summary.approvedIssueIds.push(...bridgeResult.approvedIssueIds);
          summary.approvedInteractionIds.push(...bridgeResult.approvedInteractionIds);
        } catch (error) {
          logger.warn({
            err: error,
            companyId: candidate.companyId,
            issueId: candidate.issueId,
            interactionId: candidate.interactionId,
            bridgeId,
          }, "failed to reconcile delivered awaiting human interaction");
          if (bridgeId) {
            const detail = error instanceof Error ? error.message : String(error);
            await db.update(awaitingHumanBridges).set({
              lastError: detail,
              nextPollAt: new Date(now.getTime() + AWAITING_HUMAN_POLL_FAILURE_BACKOFF_MS),
              updatedAt: now,
            }).where(eq(awaitingHumanBridges.id, bridgeId));
          }
          summary.failed += 1;
        }
      }

      return summary;
    },

    async reconcilePendingConfirmations() {
      const result = {
        checked: 0,
        approved: 0,
        rejected: 0,
        failed: 0,
        skipped: 0,
        noApproval: 0,
        replies: 0,
        issueIds: [] as string[],
        interactionIds: [] as string[],
      };

      const polled = await this.pollActiveBridges();
      result.checked += polled.checked;
      result.approved += polled.approved;
      result.rejected += polled.rejected;
      result.failed += polled.failed;
      result.skipped += polled.skipped;
      result.noApproval += polled.noSignal;
      result.replies += polled.replies;
      result.issueIds.push(...polled.approvedIssueIds);
      result.interactionIds.push(...polled.approvedInteractionIds);

      return result;
    },

    async pollBridge(bridgeId: string, now = new Date()) {
      const [row] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, bridgeId)).limit(1);
      const summary = emptySummary();
      if (!row || row.status !== "waiting_for_human") return summary;

      summary.checked += 1;
      const [issue] = await db.select({
        status: issues.status,
      }).from(issues).where(eq(issues.id, row.issueId)).limit(1);
      if (issue && isClosedIssueStatus(issue.status)) {
        await closeBridgeRow({
          row,
          outcome: issue.status === "cancelled" ? "cancelled" : "superseded",
          reason: `Issue already marked ${issue.status}.`,
        });
        summary.skipped += 1;
        return summary;
      }

      const adapter = deps.resolveAdapter(row.provider);
      let polled;
      try {
        polled = await adapter.poll({
          bridgeId: row.id,
          externalThreadId: row.externalThreadId ?? null,
          externalMessageId: row.externalMessageId ?? null,
        });
      } catch (error) {
        await logBridgePollError({ row, error, phase: "adapter_poll", now });
        summary.failed += 1;
        return summary;
      }

      if (polled.status === "failed") {
        await logBridgePollError({
          row,
          error: new Error(polled.detail),
          phase: "adapter_poll_failed_status",
          now,
        });
        await addSystemIssueComment({
          companyId: row.companyId,
          issueId: row.issueId,
          interactionId: row.interactionId,
          body: `Awaiting human bridge failed: ${polled.detail}`,
        });
        await db.update(awaitingHumanBridges).set({
          status: "failed",
          lastError: polled.detail,
          updatedAt: now,
        }).where(eq(awaitingHumanBridges.id, row.id));
        summary.failed += 1;
        return summary;
      }
      if (polled.status === "skipped") {
        await db.update(awaitingHumanBridges).set({
          lastPolledAt: now,
          lastError: null,
          nextPollAt: new Date(now.getTime() + 60_000),
          updatedAt: now,
        }).where(eq(awaitingHumanBridges.id, row.id));
        summary.skipped += 1;
        return summary;
      }
      if (polled.events.length === 0) {
        await db.update(awaitingHumanBridges).set({
          lastPolledAt: now,
          lastError: null,
          nextPollAt: new Date(now.getTime() + 60_000),
          updatedAt: now,
        }).where(eq(awaitingHumanBridges.id, row.id));
        summary.noSignal += 1;
        return summary;
      }

      for (const event of polled.events) {
        const externalEventId = readNonEmptyString(event.externalEventId);
        if (!externalEventId) {
          throw new Error("Awaiting human bridge poll event missing externalEventId");
        }

        if (event.kind === "reply") {
          const replyBody = event.body?.trim() || null;
          const replyProcessing = await db.transaction(async (tx) => {
            const txDb = tx as unknown as Db;
            const txInteractionsSvc = issueThreadInteractionService(txDb);
            const [recorded] = await tx.insert(awaitingHumanBridgeInboundEvents).values({
              bridgeId: row.id,
              interactionId: row.interactionId,
              eventKind: event.kind,
              externalEventId,
              externalMessageId: event.externalMessageId?.trim() || null,
              externalThreadId: event.externalThreadId?.trim() || null,
              payload: { ...(event.raw ?? {}), ...(event.metadata ?? {}) },
            }).onConflictDoNothing({
              target: [awaitingHumanBridgeInboundEvents.interactionId, awaitingHumanBridgeInboundEvents.externalEventId],
              where: sql`${awaitingHumanBridgeInboundEvents.externalEventId} IS NOT NULL`,
            }).returning({ id: awaitingHumanBridgeInboundEvents.id });

            if (!recorded) {
              return {
                duplicate: true as const,
                emptyBody: false as const,
                commentId: null as string | null,
                resolvedInteraction: null as IssueThreadInteraction | null,
                body: null as string | null,
                acceptedResolution: null,
                rejectionWakeAgentId: null as string | null,
              };
            }

            if (!replyBody) {
              return {
                duplicate: false as const,
                emptyBody: true as const,
                commentId: null as string | null,
                resolvedInteraction: null as IssueThreadInteraction | null,
                body: null as string | null,
                acceptedResolution: null,
                rejectionWakeAgentId: null as string | null,
              };
            }

            const currentInteraction = await interactionsSvc.getById(row.interactionId);
            const responsePayload = (
              currentInteraction
              && currentInteraction.kind === "ask_user_questions"
              && currentInteraction.status === "pending"
            )
                ? buildAskUserQuestionsResponseFromReply({
                  interaction: currentInteraction,
                  replyBody,
                })
              : null;

            const body = buildReplyReceivedBody(row.provider, replyBody);
            const [comment] = await tx.insert(issueComments).values({
              companyId: row.companyId,
              issueId: row.issueId,
              authorAgentId: null,
              authorUserId: null,
              createdByRunId: null,
              body,
            }).returning();

            await tx
              .update(issues)
              .set({ updatedAt: new Date() })
              .where(eq(issues.id, row.issueId));

            let resolvedInteraction: IssueThreadInteraction | null = null;
            let issueForResolution: {
              id: string;
              companyId: string;
              projectId: string | null;
              goalId: string | null;
              status: string;
              assigneeAgentId: string | null;
              assigneeUserId: string | null;
              identifier: string | null;
              title: string;
            } | null = null;
            if (responsePayload) {
              const providerLabel = formatProviderLabel(row.provider);
              resolvedInteraction = await txInteractionsSvc.answerQuestions({
                id: row.issueId,
                companyId: row.companyId,
              }, row.interactionId, responsePayload, { actorType: "system" });
              await txDb.update(awaitingHumanBridges).set({
                status: "closed",
                closeOutcome: "superseded",
                closeReason: `Interaction answered via ${providerLabel} reply.`,
                closedAt: new Date(),
                nextPollAt: null,
                updatedAt: new Date(),
              }).where(eq(awaitingHumanBridges.id, row.id));
            } else if (
              currentInteraction
              && currentInteraction.kind === "request_confirmation"
              && currentInteraction.status === "pending"
            ) {
              const decision = classifyRequestConfirmationReply(replyBody);
              if (!decision) {
                return {
                  duplicate: false as const,
                  emptyBody: false as const,
                  commentId: comment?.id ?? null,
                  resolvedInteraction: null as IssueThreadInteraction | null,
                  body,
                  acceptedResolution: null,
                  rejectionWakeAgentId: null as string | null,
                };
              }
              [issueForResolution] = await tx
                .select({
                  id: issues.id,
                  companyId: issues.companyId,
                  projectId: issues.projectId,
                  goalId: issues.goalId,
                  status: issues.status,
                  assigneeAgentId: issues.assigneeAgentId,
                  assigneeUserId: issues.assigneeUserId,
                  identifier: issues.identifier,
                  title: issues.title,
                })
                .from(issues)
                .where(eq(issues.id, row.issueId))
                .limit(1);

              if (decision === "approve" && issueForResolution) {
                const accepted = await txInteractionsSvc.acceptInteraction(
                  {
                    id: issueForResolution.id,
                    companyId: issueForResolution.companyId,
                    projectId: issueForResolution.projectId,
                    goalId: issueForResolution.goalId,
                  },
                  row.interactionId,
                  {},
                  { actorType: "system" },
                );
                resolvedInteraction = accepted.interaction;
                await txDb.update(awaitingHumanBridges).set({
                  status: "closed",
                  closeOutcome: "approved",
                  closeReason: replyBody,
                  closedAt: new Date(),
                  nextPollAt: null,
                  updatedAt: new Date(),
                }).where(eq(awaitingHumanBridges.id, row.id));
                return {
                  duplicate: false as const,
                  commentId: comment?.id ?? null,
                  body,
                  resolvedInteraction,
                  acceptedResolution: {
                    issue: issueForResolution,
                    interaction: accepted.interaction,
                    createdIssues: accepted.createdIssues,
                    continuationIssue: accepted.continuationIssue,
                    actor: {
                      actorType: "system" as const,
                      actorId: "awaiting_human_bridge",
                      agentId: null,
                      runId: null,
                    },
                    source: "awaiting_human.bridge_reply",
                    metadata: {
                      resolutionSource: "confirmation_keyword_reply",
                      externalMessageId: row.externalMessageId ?? null,
                      externalEventId: externalEventId ?? null,
                    },
                  },
                  rejectionWakeAgentId: null as string | null,
                };
              } else {
                resolvedInteraction = await txInteractionsSvc.rejectInteraction({
                  id: row.issueId,
                  companyId: row.companyId,
                }, row.interactionId, {
                  reason: replyBody,
                }, { actorType: "system" });
                await txDb.update(awaitingHumanBridges).set({
                  status: "closed",
                  closeOutcome: "rejected",
                  closeReason: replyBody,
                  closedAt: new Date(),
                  nextPollAt: null,
                  updatedAt: new Date(),
                }).where(eq(awaitingHumanBridges.id, row.id));
              }
            }

            return {
              duplicate: false as const,
              commentId: comment?.id ?? null,
              body,
              resolvedInteraction,
              acceptedResolution: null,
              rejectionWakeAgentId: resolvedInteraction?.status === "rejected"
                ? (issueForResolution?.assigneeAgentId ?? row.agentId)
                : null,
            };
          });

          if (replyProcessing.duplicate) continue;
          if (replyProcessing.emptyBody) continue;

          const answeredInteraction = replyProcessing.resolvedInteraction ?? null;

          const body = replyProcessing.body ?? buildReplyReceivedBody(row.provider, replyBody!);
          const [issueRow] = await db.select({
            status: issues.status,
            identifier: issues.identifier,
            title: issues.title,
          }).from(issues).where(eq(issues.id, row.issueId)).limit(1);

          let shouldReturnAnswered = false;
          let shouldReturnApproved = false;
          let shouldReturnRejected = false;

          try {
            if (replyProcessing.acceptedResolution) {
              await finalizeAcceptedResolutionAfterCommit(replyProcessing.acceptedResolution);
            }

            await logActivity(db, {
              companyId: row.companyId,
              actorType: "system",
              actorId: "awaiting_human_bridge",
              action: "issue.comment_added",
              entityType: "issue",
              entityId: row.issueId,
              details: {
                commentId: replyProcessing.commentId,
                bodySnippet: body.slice(0, 120),
                identifier: issueRow?.identifier ?? null,
                issueTitle: issueRow?.title ?? null,
                interactionId: row.interactionId,
                forwardingOrigin: "awaiting_human.bridge_reply",
                externalMessageId: row.externalMessageId ?? null,
                externalEventId: externalEventId ?? null,
              },
            });

            if (
              answeredInteraction?.kind === "ask_user_questions"
              && answeredInteraction.status === "answered"
            ) {
              await logActivity(db, {
                companyId: row.companyId,
                actorType: "system",
                actorId: "awaiting_human_bridge",
                action: "issue.thread_interaction_answered",
                entityType: "issue",
                entityId: row.issueId,
                details: {
                  interactionId: answeredInteraction.id,
                  interactionKind: answeredInteraction.kind,
                  interactionStatus: answeredInteraction.status,
                  answeredQuestionCount: answeredInteraction.result?.answers?.length ?? 0,
                  resolutionSource: "bridge_reply",
                  externalMessageId: row.externalMessageId ?? null,
                  externalEventId: externalEventId ?? null,
                },
              });

              const [issueAfterAnswer] = await db.select({
                assigneeAgentId: issues.assigneeAgentId,
                status: issues.status,
              }).from(issues).where(eq(issues.id, row.issueId)).limit(1);

              if (
                issueAfterAnswer?.assigneeAgentId
                && issueAfterAnswer.status !== "backlog"
                && !isClosedIssueStatus(issueAfterAnswer.status)
                && shouldWakeAssigneeForInteractionResolution(answeredInteraction)
              ) {
                await insertWakeup({
                  companyId: row.companyId,
                  agentId: issueAfterAnswer.assigneeAgentId,
                  payload: {
                    issueId: row.issueId,
                    interactionId: answeredInteraction.id,
                    interactionKind: answeredInteraction.kind,
                    interactionStatus: answeredInteraction.status,
                    sourceCommentId: answeredInteraction.sourceCommentId ?? null,
                    sourceRunId: answeredInteraction.sourceRunId ?? null,
                    mutation: "interaction",
                  },
                });
              }

              shouldReturnAnswered = true;
            } else if (
              answeredInteraction?.kind === "request_confirmation"
              && answeredInteraction.status === "accepted"
            ) {
              shouldReturnApproved = true;
            } else if (
              answeredInteraction?.kind === "request_confirmation"
              && answeredInteraction.status === "rejected"
            ) {
              await logActivity(db, {
                companyId: row.companyId,
                actorType: "system",
                actorId: "awaiting_human_bridge",
                action: "issue.thread_interaction_rejected",
                entityType: "issue",
                entityId: row.issueId,
                details: {
                  interactionId: answeredInteraction.id,
                  interactionKind: answeredInteraction.kind,
                  interactionStatus: answeredInteraction.status,
                  rejectionReason: answeredInteraction.result?.reason ?? replyBody,
                  resolutionSource: "bridge_reply",
                  externalMessageId: row.externalMessageId ?? null,
                  externalEventId: externalEventId ?? null,
                },
              });

              if (replyProcessing.rejectionWakeAgentId) {
                await insertWakeup({
                  companyId: row.companyId,
                  agentId: replyProcessing.rejectionWakeAgentId,
                  payload: {
                    issueId: row.issueId,
                    interactionId: row.interactionId,
                    interactionStatus: answeredInteraction.status,
                    mutation: "interaction",
                  },
                });
              }

              shouldReturnRejected = true;
            } else if (shouldWakeOnReplyIssueStatus(issueRow?.status)) {
              await insertWakeup({
                companyId: row.companyId,
                agentId: row.agentId,
                payload: {
                  issueId: row.issueId,
                  interactionId: row.interactionId,
                  commentId: replyProcessing.commentId,
                  mutation: "comment",
                },
              });
            }
          } finally {
            const closeOutcome = answeredInteraction?.kind === "ask_user_questions"
              && answeredInteraction.status === "answered"
              ? "superseded"
              : answeredInteraction?.kind === "request_confirmation"
                && answeredInteraction.status === "accepted"
                ? "approved"
                : answeredInteraction?.kind === "request_confirmation"
                  && answeredInteraction.status === "rejected"
                  ? "rejected"
                  : null;
            if (closeOutcome) {
              const closeReason = answeredInteraction?.kind === "ask_user_questions"
                && answeredInteraction.status === "answered"
                ? `Interaction answered via ${formatProviderLabel(row.provider)} reply.`
                : answeredInteraction?.kind === "request_confirmation"
                  && (answeredInteraction.status === "accepted" || answeredInteraction.status === "rejected")
                  ? replyBody
                  : null;
              await this.closeBridge({
                bridgeId: row.id,
                outcome: closeOutcome,
                reason: closeReason,
              });
            }
          }

          if (shouldReturnAnswered) {
            summary.replies += 1;
            return summary;
          }

          if (shouldReturnApproved) {
            summary.approved += 1;
            summary.approvedIssueIds.push(row.issueId);
            summary.approvedInteractionIds.push(row.interactionId);
            return summary;
          }

          if (shouldReturnRejected) {
            summary.rejected += 1;
            return summary;
          }

          summary.replies += 1;
          continue;
        }

        const [issue] = await db.select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          goalId: issues.goalId,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          identifier: issues.identifier,
          title: issues.title,
        }).from(issues).where(eq(issues.id, row.issueId)).limit(1);
        if (!issue) continue;

        if (event.kind === "approval_signal") {
          const approvalReplyBody = event.body?.trim() || null;
          const currentInteraction = await interactionsSvc.getById(row.interactionId);
          if (
            currentInteraction
            && currentInteraction.kind === "ask_user_questions"
            && currentInteraction.status === "pending"
          ) {
            if (!approvalReplyBody) {
              summary.skipped += 1;
              continue;
            }
            const eventMetadata = event.metadata ?? {};
            const questionsApproval = await db.transaction(async (tx) => {
              const [recorded] = await tx.insert(awaitingHumanBridgeInboundEvents).values({
                bridgeId: row.id,
                interactionId: row.interactionId,
                eventKind: event.kind,
                externalEventId,
                externalMessageId: event.externalMessageId?.trim() || null,
                externalThreadId: event.externalThreadId?.trim() || null,
                payload: { ...(event.raw ?? {}), ...eventMetadata },
              }).onConflictDoNothing({
                target: [awaitingHumanBridgeInboundEvents.interactionId, awaitingHumanBridgeInboundEvents.externalEventId],
                where: sql`${awaitingHumanBridgeInboundEvents.externalEventId} IS NOT NULL`,
              }).returning({ id: awaitingHumanBridgeInboundEvents.id });

              if (!recorded) {
                return {
                  duplicate: true as const,
                  commentId: null as string | null,
                  commentBody: null as string | null,
                };
              }

              const commentBody = buildApprovalSignalCommentBody(row.provider, approvalReplyBody);
              const [comment] = await tx.insert(issueComments).values({
                companyId: row.companyId,
                issueId: row.issueId,
                authorAgentId: null,
                authorUserId: null,
                createdByRunId: null,
                body: commentBody,
              }).returning();
              await tx
                .update(issues)
                .set({ updatedAt: new Date() })
                .where(eq(issues.id, row.issueId));

              return {
                duplicate: false as const,
                commentId: comment?.id ?? null,
                commentBody,
              };
            });

            if (questionsApproval.duplicate) {
              summary.skipped += 1;
              continue;
            }

            await logActivity(db, {
              companyId: row.companyId,
              actorType: "system",
              actorId: "awaiting_human_bridge",
              action: "issue.comment_added",
              entityType: "issue",
              entityId: row.issueId,
              details: {
                commentId: questionsApproval.commentId,
                bodySnippet: questionsApproval.commentBody.slice(0, 120),
                identifier: issue.identifier,
                issueTitle: issue.title,
                interactionId: row.interactionId,
                forwardingOrigin: "awaiting_human.bridge_approval_signal",
                externalMessageId: row.externalMessageId ?? null,
                externalEventId,
              },
            });

            if (shouldWakeOnReplyIssueStatus(issue.status)) {
              await insertWakeup({
                companyId: row.companyId,
                agentId: row.agentId,
                payload: {
                  issueId: row.issueId,
                  interactionId: row.interactionId,
                  commentId: questionsApproval.commentId,
                  mutation: "comment",
                },
              });
            }

            await db.update(awaitingHumanBridges).set({
              lastPolledAt: now,
              nextPollAt: new Date(now.getTime() + 60_000),
              updatedAt: now,
            }).where(eq(awaitingHumanBridges.id, row.id));
            summary.replies += 1;
            continue;
          }

          if (
            currentInteraction
            && currentInteraction.kind === "request_confirmation"
            && currentInteraction.status === "pending"
          ) {
            if (!approvalReplyBody) {
              summary.skipped += 1;
              continue;
            }
            const decision = classifyRequestConfirmationReply(approvalReplyBody);
            const confirmationReplyProcessing = await db.transaction(async (tx) => {
              const txDb = tx as unknown as Db;
              const txInteractionsSvc = issueThreadInteractionService(txDb);
              const [recorded] = await tx.insert(awaitingHumanBridgeInboundEvents).values({
                bridgeId: row.id,
                interactionId: row.interactionId,
                eventKind: event.kind,
                externalEventId,
                externalMessageId: event.externalMessageId?.trim() || null,
                externalThreadId: event.externalThreadId?.trim() || null,
                payload: { ...(event.raw ?? {}), ...(event.metadata ?? {}) },
              }).onConflictDoNothing({
                target: [awaitingHumanBridgeInboundEvents.interactionId, awaitingHumanBridgeInboundEvents.externalEventId],
                where: sql`${awaitingHumanBridgeInboundEvents.externalEventId} IS NOT NULL`,
              }).returning({ id: awaitingHumanBridgeInboundEvents.id });

              if (!recorded) {
                return {
                  duplicate: true as const,
                  commentId: null as string | null,
                  commentBody: null as string | null,
                  resolvedInteraction: null as IssueThreadInteraction | null,
                  acceptedResolution: null,
                  rejectionWakeAgentId: null as string | null,
                };
              }

              const commentBody = buildReplyReceivedBody(row.provider, approvalReplyBody);
              const [comment] = await tx.insert(issueComments).values({
                companyId: row.companyId,
                issueId: row.issueId,
                authorAgentId: null,
                authorUserId: null,
                createdByRunId: null,
                body: commentBody,
              }).returning();
              await tx
                .update(issues)
                .set({ updatedAt: new Date() })
                .where(eq(issues.id, row.issueId));

              if (!decision) {
                return {
                  duplicate: false as const,
                  commentId: comment?.id ?? null,
                  commentBody,
                  resolvedInteraction: null as IssueThreadInteraction | null,
                  acceptedResolution: null,
                  rejectionWakeAgentId: null as string | null,
                };
              }

              let resolvedInteraction: IssueThreadInteraction | null = null;
              if (decision === "approve") {
                const accepted = await txInteractionsSvc.acceptInteraction({
                  id: issue.id,
                  companyId: issue.companyId,
                  projectId: issue.projectId,
                  goalId: issue.goalId,
                }, row.interactionId, {}, { actorType: "system" });
                resolvedInteraction = accepted.interaction;
                await txDb.update(awaitingHumanBridges).set({
                  status: "closed",
                  closeOutcome: "approved",
                  closeReason: approvalReplyBody,
                  closedAt: new Date(),
                  nextPollAt: null,
                  updatedAt: new Date(),
                }).where(eq(awaitingHumanBridges.id, row.id));
                return {
                  duplicate: false as const,
                  commentId: comment?.id ?? null,
                  commentBody,
                  resolvedInteraction,
                  acceptedResolution: {
                    issue,
                    interaction: accepted.interaction,
                    createdIssues: accepted.createdIssues,
                    continuationIssue: accepted.continuationIssue,
                    actor: {
                      actorType: "system" as const,
                      actorId: "awaiting_human_bridge",
                      agentId: null,
                      runId: null,
                    },
                    source: "awaiting_human.bridge_approval_signal",
                    metadata: {
                      resolutionSource: typeof event.metadata?.resolutionSource === "string" ? event.metadata.resolutionSource : null,
                      externalMessageId: row.externalMessageId ?? null,
                      externalEventId: externalEventId ?? null,
                    },
                  },
                  rejectionWakeAgentId: null as string | null,
                };
              } else {
                resolvedInteraction = await txInteractionsSvc.rejectInteraction({
                  id: issue.id,
                  companyId: issue.companyId,
                }, row.interactionId, {
                  reason: approvalReplyBody,
                }, { actorType: "system" });
                await txDb.update(awaitingHumanBridges).set({
                  status: "closed",
                  closeOutcome: "rejected",
                  closeReason: approvalReplyBody,
                  closedAt: new Date(),
                  nextPollAt: null,
                  updatedAt: new Date(),
                }).where(eq(awaitingHumanBridges.id, row.id));
                return {
                  duplicate: false as const,
                  commentId: comment?.id ?? null,
                  commentBody,
                  resolvedInteraction,
                  acceptedResolution: null,
                  rejectionWakeAgentId: issue.assigneeAgentId ?? row.agentId,
                };
              }
            });

            if (confirmationReplyProcessing.duplicate) {
              summary.skipped += 1;
              continue;
            }

            if (confirmationReplyProcessing.commentBody) {
              await logActivity(db, {
                companyId: row.companyId,
                actorType: "system",
                actorId: "awaiting_human_bridge",
                action: "issue.comment_added",
                entityType: "issue",
                entityId: row.issueId,
                details: {
                  commentId: confirmationReplyProcessing.commentId,
                  bodySnippet: confirmationReplyProcessing.commentBody.slice(0, 120),
                  identifier: issue.identifier,
                  issueTitle: issue.title,
                  interactionId: row.interactionId,
                  forwardingOrigin: "awaiting_human.bridge_approval_signal",
                  externalMessageId: row.externalMessageId ?? null,
                  externalEventId,
                },
              });
            }

            try {
              if (confirmationReplyProcessing.acceptedResolution) {
                await finalizeAcceptedResolutionAfterCommit(confirmationReplyProcessing.acceptedResolution);
              }

              if (confirmationReplyProcessing.rejectionWakeAgentId) {
                await insertWakeup({
                  companyId: row.companyId,
                  agentId: confirmationReplyProcessing.rejectionWakeAgentId,
                  payload: {
                    issueId: row.issueId,
                    interactionId: row.interactionId,
                    interactionStatus: confirmationReplyProcessing.resolvedInteraction?.status ?? null,
                    mutation: "interaction",
                  },
                });
              } else if (
                !confirmationReplyProcessing.resolvedInteraction
                && shouldWakeOnReplyIssueStatus(issue.status)
              ) {
                await insertWakeup({
                  companyId: row.companyId,
                  agentId: row.agentId,
                  payload: {
                    issueId: row.issueId,
                    interactionId: row.interactionId,
                    commentId: confirmationReplyProcessing.commentId,
                    mutation: "comment",
                  },
                });
              }

              if (confirmationReplyProcessing.resolvedInteraction?.status === "accepted") {
                summary.approved += 1;
                summary.approvedIssueIds.push(row.issueId);
                summary.approvedInteractionIds.push(row.interactionId);
                return summary;
              }

              if (confirmationReplyProcessing.resolvedInteraction?.status === "rejected") {
                summary.rejected += 1;
                return summary;
              }

              await db.update(awaitingHumanBridges).set({
                lastPolledAt: now,
                nextPollAt: new Date(now.getTime() + 60_000),
                updatedAt: now,
              }).where(eq(awaitingHumanBridges.id, row.id));
              summary.replies += 1;
              continue;
            } finally {
              const closeOutcome = confirmationReplyProcessing.resolvedInteraction?.status === "accepted"
                ? "approved"
                : confirmationReplyProcessing.resolvedInteraction?.status === "rejected"
                  ? "rejected"
                  : null;
              if (closeOutcome) {
                await this.closeBridge({
                  bridgeId: row.id,
                  outcome: closeOutcome,
                  reason: approvalReplyBody,
                });
              }
            }
          }

          const approvalProcessing = await db.transaction(async (tx) => {
            const txDb = tx as unknown as Db;
            const txInteractionsSvc = issueThreadInteractionService(txDb);
            const [recorded] = await tx.insert(awaitingHumanBridgeInboundEvents).values({
              bridgeId: row.id,
              interactionId: row.interactionId,
              eventKind: event.kind,
              externalEventId,
              externalMessageId: event.externalMessageId?.trim() || null,
              externalThreadId: event.externalThreadId?.trim() || null,
              payload: { ...(event.raw ?? {}), ...(event.metadata ?? {}) },
            }).onConflictDoNothing({
              target: [awaitingHumanBridgeInboundEvents.interactionId, awaitingHumanBridgeInboundEvents.externalEventId],
              where: sql`${awaitingHumanBridgeInboundEvents.externalEventId} IS NOT NULL`,
            }).returning({ id: awaitingHumanBridgeInboundEvents.id });

            if (!recorded) {
              return {
                duplicate: true as const,
                commentId: null as string | null,
                commentBody: null as string | null,
                acceptedResolution: null,
              };
            }

            let commentId: string | null = null;
            let commentBody: string | null = null;
            if (approvalReplyBody) {
              commentBody = buildReplyReceivedBody(row.provider, approvalReplyBody);
              const [comment] = await tx.insert(issueComments).values({
                companyId: row.companyId,
                issueId: row.issueId,
                authorAgentId: null,
                authorUserId: null,
                createdByRunId: null,
                body: commentBody,
              }).returning();
              commentId = comment?.id ?? null;
              await tx
                .update(issues)
                .set({ updatedAt: new Date() })
                .where(eq(issues.id, row.issueId));
            }

            const { interaction, createdIssues, continuationIssue } = await txInteractionsSvc.acceptInteraction({
              id: issue.id,
              companyId: issue.companyId,
              projectId: issue.projectId,
              goalId: issue.goalId,
            }, row.interactionId, {}, { actorType: "system" });

            return {
              duplicate: false as const,
              commentId,
              commentBody,
              acceptedResolution: {
                issue,
                interaction,
                createdIssues,
                continuationIssue,
                actor: {
                  actorType: "system" as const,
                  actorId: "awaiting_human_bridge",
                  agentId: null,
                  runId: null,
                },
                source: "awaiting_human.bridge_approval",
                metadata: {
                  resolutionSource: typeof event.metadata?.resolutionSource === "string" ? event.metadata.resolutionSource : null,
                  externalMessageId: row.externalMessageId ?? null,
                  externalEventId: externalEventId ?? null,
                },
              },
            };
          });
          if (approvalProcessing.duplicate) {
            await closeBridgeRow({
              row,
              outcome: "approved",
              reason: event.body?.trim() || null,
              notifyAdapter: false,
            });
            return summary;
          }
          if (approvalProcessing.commentBody) {
            await logActivity(db, {
              companyId: row.companyId,
              actorType: "system",
              actorId: "awaiting_human_bridge",
              action: "issue.comment_added",
              entityType: "issue",
              entityId: row.issueId,
              details: {
                commentId: approvalProcessing.commentId,
                bodySnippet: approvalProcessing.commentBody.slice(0, 120),
                identifier: issue.identifier,
                issueTitle: issue.title,
                interactionId: row.interactionId,
                forwardingOrigin: "awaiting_human.bridge_reply",
                externalMessageId: row.externalMessageId ?? null,
                externalEventId: externalEventId ?? null,
              },
            });
          }
          try {
            if (approvalProcessing.acceptedResolution) {
              await finalizeAcceptedResolutionAfterCommit(approvalProcessing.acceptedResolution);
            }
          } finally {
            await this.closeBridge({
              bridgeId: row.id,
              outcome: "approved",
              reason: event.body?.trim() || null,
            });
          }
          summary.approved += 1;
          summary.approvedIssueIds.push(row.issueId);
          summary.approvedInteractionIds.push(row.interactionId);
          return summary;
        }

        if (event.kind === "reject_signal") {
          const rejectionReplyBody = event.body?.trim() || null;
          const rejectionProcessing = await db.transaction(async (tx) => {
            const txDb = tx as unknown as Db;
            const txInteractionsSvc = issueThreadInteractionService(txDb);
            const [recorded] = await tx.insert(awaitingHumanBridgeInboundEvents).values({
              bridgeId: row.id,
              interactionId: row.interactionId,
              eventKind: event.kind,
              externalEventId,
              externalMessageId: event.externalMessageId?.trim() || null,
              externalThreadId: event.externalThreadId?.trim() || null,
              payload: { ...(event.raw ?? {}), ...(event.metadata ?? {}) },
            }).onConflictDoNothing({
              target: [awaitingHumanBridgeInboundEvents.interactionId, awaitingHumanBridgeInboundEvents.externalEventId],
              where: sql`${awaitingHumanBridgeInboundEvents.externalEventId} IS NOT NULL`,
            }).returning({ id: awaitingHumanBridgeInboundEvents.id });

            if (!recorded) {
              return {
                duplicate: true as const,
                commentId: null as string | null,
                commentBody: null as string | null,
                rejectionWakeAgentId: null as string | null,
                interactionStatus: null as string | null,
              };
            }

            let commentId: string | null = null;
            let commentBody: string | null = null;
            if (rejectionReplyBody) {
              commentBody = buildReplyReceivedBody(row.provider, rejectionReplyBody);
              const [comment] = await tx.insert(issueComments).values({
                companyId: row.companyId,
                issueId: row.issueId,
                authorAgentId: null,
                authorUserId: null,
                createdByRunId: null,
                body: commentBody,
              }).returning();
              commentId = comment?.id ?? null;
              await tx
                .update(issues)
                .set({ updatedAt: new Date() })
                .where(eq(issues.id, row.issueId));
            }

            const interaction = await txInteractionsSvc.rejectInteraction({
              id: issue.id,
              companyId: issue.companyId,
            }, row.interactionId, {
              reason: event.body?.trim() || undefined,
            }, { actorType: "system" });

            const rejectionWakeAgentId = issue.assigneeAgentId ?? row.agentId;
            if (rejectionWakeAgentId) {
              await insertWakeup({
                companyId: row.companyId,
                agentId: rejectionWakeAgentId,
                payload: {
                  issueId: row.issueId,
                  interactionId: row.interactionId,
                  interactionStatus: interaction.status,
                  mutation: "interaction",
                },
                dbClient: deps.requestWakeup ? undefined : txDb,
              });
            }

            return {
              duplicate: false as const,
              commentId,
              commentBody,
              rejectionWakeAgentId: null as string | null,
              interactionStatus: interaction.status,
            };
          });
          if (rejectionProcessing.duplicate) {
            await closeBridgeRow({
              row,
              outcome: "rejected",
              reason: event.body?.trim() || null,
              notifyAdapter: false,
            });
            return summary;
          }
          if (rejectionProcessing.commentBody) {
            await logActivity(db, {
              companyId: row.companyId,
              actorType: "system",
              actorId: "awaiting_human_bridge",
              action: "issue.comment_added",
              entityType: "issue",
              entityId: row.issueId,
              details: {
                commentId: rejectionProcessing.commentId,
                bodySnippet: rejectionProcessing.commentBody.slice(0, 120),
                identifier: issue.identifier,
                issueTitle: issue.title,
                interactionId: row.interactionId,
                forwardingOrigin: "awaiting_human.bridge_reply",
                externalMessageId: row.externalMessageId ?? null,
                externalEventId: externalEventId ?? null,
              },
            });
          }
          try {
            if (rejectionProcessing.rejectionWakeAgentId) {
              await insertWakeup({
                companyId: row.companyId,
                agentId: rejectionProcessing.rejectionWakeAgentId,
                payload: {
                  issueId: row.issueId,
                  interactionId: row.interactionId,
                  interactionStatus: rejectionProcessing.interactionStatus ?? null,
                  mutation: "interaction",
                },
              });
            }
          } finally {
            await this.closeBridge({
              bridgeId: row.id,
              outcome: "rejected",
              reason: event.body?.trim() || null,
            });
          }
          summary.rejected += 1;
          return summary;
        }
      }

      await db.update(awaitingHumanBridges).set({
        lastPolledAt: now,
        nextPollAt: new Date(now.getTime() + 60_000),
        updatedAt: now,
      }).where(eq(awaitingHumanBridges.id, row.id));
      return summary;
    },

    async pollActiveBridges(now = new Date()) {
      const rows = await db
        .select()
        .from(awaitingHumanBridges)
        .where(and(
          eq(awaitingHumanBridges.status, "waiting_for_human"),
          lte(awaitingHumanBridges.nextPollAt, now),
        ))
        .orderBy(asc(awaitingHumanBridges.nextPollAt), asc(awaitingHumanBridges.createdAt))
        .limit(200);

      const summary = emptySummary();
      for (const row of rows) {
        try {
          const result = await this.pollBridge(row.id, now);
          summary.checked += result.checked;
          summary.approved += result.approved;
          summary.rejected += result.rejected;
          summary.replies += result.replies;
          summary.noSignal += result.noSignal;
          summary.failed += result.failed;
          summary.skipped += result.skipped;
          summary.approvedIssueIds.push(...result.approvedIssueIds);
          summary.approvedInteractionIds.push(...result.approvedInteractionIds);
        } catch (error) {
          await logBridgePollError({ row, error, phase: "poll_bridge", now });
          summary.failed += 1;
        }
      }
      return summary;
    },

    async expireWaitingBridges(now = new Date(), maxAgeMs = 24 * 60 * 60 * 1000) {
      const deadline = new Date(now.getTime() - maxAgeMs);
      const rows = await db.select().from(awaitingHumanBridges).where(and(
        inArray(awaitingHumanBridges.status, ["pending_delivery", "waiting_for_human", "failed"]),
        lte(awaitingHumanBridges.createdAt, deadline),
      )).orderBy(asc(awaitingHumanBridges.createdAt)).limit(200);

      for (const row of rows) {
        const expiredBody = row.status === "failed"
          ? "Awaiting human bridge failed to deliver before a human response was received."
          : "Awaiting human bridge timed out before a human response was received.";
        let interaction: Awaited<ReturnType<typeof interactionsSvc.rejectInteraction>> | null = null;
        let forceCloseRow = false;
        let failureDetail: string | null = null;

        try {
          interaction = await interactionsSvc.rejectInteraction({
            id: row.issueId,
            companyId: row.companyId,
          }, row.interactionId, {
            reason: expiredBody,
          }, { actorType: "system" });
        } catch (error) {
          forceCloseRow = true;
          failureDetail = error instanceof Error ? error.message : String(error);
          await logActivity(db, {
            companyId: row.companyId,
            actorType: "system",
            actorId: "awaiting_human_bridge",
            action: "issue.awaiting_human.bridge_expire_reject_failed",
            entityType: "issue",
            entityId: row.issueId,
            details: {
              bridgeId: row.id,
              interactionId: row.interactionId,
              provider: row.provider,
              detail: failureDetail,
            },
          });
        }

        try {
          await this.closeBridge({
            bridgeId: row.id,
            outcome: "expired",
            reason: expiredBody,
          });
        } catch (error) {
          forceCloseRow = true;
          failureDetail = failureDetail ?? (error instanceof Error ? error.message : String(error));
          await logActivity(db, {
            companyId: row.companyId,
            actorType: "system",
            actorId: "awaiting_human_bridge",
            action: "issue.awaiting_human.bridge_expire_failed",
            entityType: "issue",
            entityId: row.issueId,
            details: {
              bridgeId: row.id,
              interactionId: row.interactionId,
              provider: row.provider,
              detail: failureDetail,
            },
          });
        }

        const interactionStatus = interaction?.status ?? null;
        if (row.agentId) {
          try {
            await insertWakeup({
              companyId: row.companyId,
              agentId: row.agentId,
              payload: {
                bridgeId: row.id,
                issueId: row.issueId,
                interactionId: row.interactionId,
                interactionStatus,
                mutation: "interaction",
                expirationReason: expiredBody,
              },
            });
          } catch (wakeupError) {
            const wakeupDetail = wakeupError instanceof Error ? wakeupError.message : String(wakeupError);
            await logActivity(db, {
              companyId: row.companyId,
              actorType: "system",
              actorId: "awaiting_human_bridge",
              action: "issue.awaiting_human.bridge_expire_wakeup_failed",
              entityType: "issue",
              entityId: row.issueId,
              details: {
                bridgeId: row.id,
                interactionId: row.interactionId,
                provider: row.provider,
                detail: wakeupDetail,
              },
            });
          }
        }
        try {
          await addSystemIssueComment({
            companyId: row.companyId,
            issueId: row.issueId,
            interactionId: row.interactionId,
            body: expiredBody,
          });
        } catch (commentError) {
          const commentDetail = commentError instanceof Error ? commentError.message : String(commentError);
          await logActivity(db, {
            companyId: row.companyId,
            actorType: "system",
            actorId: "awaiting_human_bridge",
            action: "issue.awaiting_human.bridge_expire_comment_failed",
            entityType: "issue",
            entityId: row.issueId,
            details: {
              bridgeId: row.id,
              interactionId: row.interactionId,
              provider: row.provider,
              detail: commentDetail,
            },
          });
        }
        if (!interaction) {
          await logActivity(db, {
            companyId: row.companyId,
            actorType: "system",
            actorId: "awaiting_human_bridge",
            action: "issue.awaiting_human.bridge_expire_stuck",
            entityType: "issue",
            entityId: row.issueId,
            details: {
              bridgeId: row.id,
              interactionId: row.interactionId,
              provider: row.provider,
              detail: failureDetail,
              agentId: row.agentId ?? null,
              interactionStatus,
            },
          });
        }

        if (forceCloseRow) {
          try {
            await forceCloseExpiredBridgeRow({
              row,
              reason: expiredBody,
              detail: failureDetail,
            });
          } catch (forceCloseError) {
            const forceCloseDetail = forceCloseError instanceof Error ? forceCloseError.message : String(forceCloseError);
            await logActivity(db, {
              companyId: row.companyId,
              actorType: "system",
              actorId: "awaiting_human_bridge",
              action: "issue.awaiting_human.bridge_expire_force_close_failed",
              entityType: "issue",
              entityId: row.issueId,
              details: {
                bridgeId: row.id,
                interactionId: row.interactionId,
                provider: row.provider,
                detail: forceCloseDetail,
              },
            });
          }
        }
      }
    },

    async closeBridge(input: {
      bridgeId: string;
      outcome?: "approved" | "rejected" | "expired" | "superseded" | "cancelled" | null;
      reason?: string | null;
    }) {
      const [row] = await db.select().from(awaitingHumanBridges).where(eq(awaitingHumanBridges.id, input.bridgeId)).limit(1);
      if (!row) return null;
      return closeBridgeRow({ row, outcome: input.outcome ?? null, reason: input.reason ?? null });
    },

    async closeOpenBridgesForIssue(input: {
      companyId: string;
      issueId: string;
      outcome?: "approved" | "rejected" | "expired" | "superseded" | "cancelled" | null;
      reason?: string | null;
    }) {
      return closeOpenBridgesForIssue(input);
    },
  };
}
