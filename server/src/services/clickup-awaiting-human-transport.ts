import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { resolveApprovalFlowRoute } from "./approval-flow-routing.js";
import type {
  AwaitingHumanNotificationPayload,
  AwaitingHumanNotificationResult,
  AwaitingHumanNotificationReviewFile,
  SendAwaitingHumanNotificationInput,
} from "./awaiting-human-notifications.js";
import { awaitingHumanSettingsService } from "./awaiting-human-settings.js";
import type { AwaitingHumanBridgePollEvent } from "./awaiting-human-bridge-registry.js";
import { normalizeClickUpAttachmentTaskId } from "./clickup-awaiting-human-settings-adapter.js";

// ClickUp's Chat API accepts message and reply content up to 40,000 characters.
const CLICKUP_CHAT_MESSAGE_MAX_CHARS = 40_000;
const CLICKUP_CHAT_REPLY_MESSAGE_MAX_CHARS = 40_000;
// Reserve space for the reply title and required CTA instructions.
const CLICKUP_CHAT_REPLY_BODY_MAX_CHARS = 38_000;
const MAX_TITLE_LENGTH = 40_000;
const MAX_REVIEWER_DIRECT_MESSAGE_TITLE_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 40_000;
const MAX_DETAIL_BULLETS = 10_000;
const MAX_BULLET_LENGTH = 40_000;
const DEFAULT_CLICKUP_TIMEOUT_SEC = 30;
const MAX_CLICKUP_REPLY_PAGES = 100;
const CLICKUP_ATTACHMENT_FILE_FIELD = "attachment[0]";

export interface ClickUpTransportTestNotification {
  title: string;
  summary: string;
  link: string;
  body?: string | null;
  cta?: string | null;
  reviewerTargets?: Array<{
    label: string;
    userId: string | null | undefined;
  }>;
}

type ClickUpChatConfig = {
  personalToken: string;
  workspaceId: string;
  channelId: string;
  primaryReviewerUserId: string;
  secondaryReviewerUserId: string;
};

export type ClickUpAwaitingHumanConfigOverrides = {
  personalToken?: string | null;
  workspaceId?: string | null;
  channelId?: string | null;
  attachmentTaskId?: string | null;
  primaryReviewerUserId?: string | null;
  secondaryReviewerUserId?: string | null;
};

export function resolveClickUpAttachmentTaskId(
  overrides?: ClickUpAwaitingHumanConfigOverrides,
) {
  return normalizeClickUpAttachmentTaskId(overrides?.attachmentTaskId);
}

type ClickUpApiStatus = "sent" | "skipped" | "failed";

export interface ClickUpChatMessageReply {
  id: string | null;
  parentMessageId: string | null;
  reactionsUrl: string | null;
  content: string | null;
  dateMs: number | null;
}

type ClickUpTransportMessageResult = AwaitingHumanNotificationResult & {
  messageLink: string | null;
};

type ClickUpReviewerTarget = {
  label: string;
  userId: string;
  displayName: string | null;
};

type ClickUpReviewerInput = {
  label: string;
  userId: string | null | undefined;
  displayName?: string | null;
};

function compactWhitespace(value: string) {
  return value.split(/\s+/).filter(Boolean).join(" ");
}

function truncateText(value: string, maxLength: number) {
  const compact = compactWhitespace(value);
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function trimTotal(value: string, limit: number) {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function formatBodySection(body: string | null | undefined) {
  if (!body) return null;
  const lines = body
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(
      (line, index, all) =>
        line.length > 0 || (index > 0 && all[index - 1]?.length > 0),
    );
  if (lines.length === 0) return null;
  const limited = lines
    .slice(0, MAX_DETAIL_BULLETS * 6)
    .map((line) => truncateText(line, MAX_BULLET_LENGTH));
  return trimTotal(limited.join("\n"), CLICKUP_CHAT_MESSAGE_MAX_CHARS);
}

function formatFullBodySection(body: string | null | undefined) {
  if (!body) return null;
  const lines = body
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(
      (line, index, all) =>
        line.length > 0 || (index > 0 && all[index - 1]?.length > 0),
    );
  if (lines.length === 0) return null;
  return trimTotal(lines.join("\n"), CLICKUP_CHAT_REPLY_BODY_MAX_CHARS);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readClickUpUserName(payload: Record<string, unknown>) {
  const member = payload.member && typeof payload.member === "object"
    ? payload.member as Record<string, unknown>
    : null;
  const user = member?.user && typeof member.user === "object"
    ? member.user as Record<string, unknown>
    : payload.user && typeof payload.user === "object"
      ? payload.user as Record<string, unknown>
      : null;
  if (!user) return null;
  return readString(user.username) ?? readString(user.name);
}

function parseClickUpCreateChatMessageResponse(rawText: string) {
  const payload = JSON.parse(rawText) as Record<string, unknown>;
  const data = payload.data && typeof payload.data === "object"
    ? payload.data as Record<string, unknown>
    : payload;
  const messageId = readString(data.id) ?? readString(payload.id);
  if (!messageId) {
    throw new Error(`clickup chat message response missing message id:${rawText.slice(0, 240)}`);
  }
  const replyLink = readString(
    (data.links && typeof data.links === "object" ? (data.links as Record<string, unknown>).replies : null)
      ?? (payload.links && typeof payload.links === "object" ? (payload.links as Record<string, unknown>).replies : null),
  );
  return {
    messageId,
    messageLink: replyLink ?? readString(data.url) ?? readString(payload.url) ?? null,
  };
}

function buildClickUpChatMessageAppUrl(
  workspaceId: string,
  channelId: string,
  messageId: string,
) {
  const trimmedWorkspaceId = workspaceId.trim();
  const trimmedChannelId = channelId.trim();
  const trimmedMessageId = messageId.trim();
  if (!trimmedWorkspaceId || !trimmedChannelId || !trimmedMessageId) return null;
  return `https://app.clickup.com/${encodeURIComponent(trimmedWorkspaceId)}/chat/r/${encodeURIComponent(trimmedChannelId)}/t/${encodeURIComponent(trimmedMessageId)}`;
}

function parseClickUpCreateChatChannelResponse(rawText: string) {
  const payload = JSON.parse(rawText) as Record<string, unknown>;
  const data = payload.data && typeof payload.data === "object"
    ? payload.data as Record<string, unknown>
    : payload;
  const channelId = readString(data.id) ?? readString(payload.id);
  if (!channelId) {
    throw new Error(`clickup DM channel response missing channel id:${rawText.slice(0, 240)}`);
  }
  return { channelId };
}

async function fetchClickUpUserDisplayName(
  config: ClickUpChatConfig,
  userId: string,
) {
  const response = await fetchText(
    `https://api.clickup.com/api/v2/team/${encodeURIComponent(config.workspaceId)}/user/${encodeURIComponent(userId)}`,
    {
      method: "GET",
      headers: {
        Authorization: config.personalToken,
        Accept: "application/json",
      },
    },
  );
  if (!response.ok || !response.text.trim()) return null;
  try {
    const payload = JSON.parse(response.text) as Record<string, unknown>;
    const name = readClickUpUserName(payload);
    return name && name.trim().length > 0 ? name.trim() : null;
  } catch {
    return null;
  }
}

async function resolveClickUpReviewerTargets(
  config: ClickUpChatConfig,
  reviewers: Array<{ label: string; userId: string | null | undefined }>,
): Promise<ClickUpReviewerTarget[]> {
  const targets = reviewers
    .map((reviewer) => {
      const userId = readString(reviewer.userId);
      return userId ? { label: reviewer.label, userId } : null;
    })
    .filter((reviewer): reviewer is { label: string; userId: string } => reviewer !== null);

  return Promise.all(targets.map(async (reviewer) => ({
    label: reviewer.label,
    userId: reviewer.userId,
    displayName: await fetchClickUpUserDisplayName(config, reviewer.userId),
  })));
}

function isClickUpReviewerTarget(
  reviewer: ClickUpReviewerTarget | null,
): reviewer is ClickUpReviewerTarget {
  return reviewer !== null;
}

async function createClickUpDirectMessageChannel(
  config: ClickUpChatConfig,
  userId: string,
) {
  const response = await fetchText(
    `https://api.clickup.com/api/v3/workspaces/${encodeURIComponent(config.workspaceId)}/chat/channels/direct_message`,
    {
      method: "POST",
      headers: {
        Authorization: config.personalToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_ids: [userId],
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`http-error:${response.status}:${truncateText(response.text, 240)}`);
  }
  return parseClickUpCreateChatChannelResponse(response.text);
}

async function sendClickUpDirectMessage(
  config: ClickUpChatConfig,
  channelId: string,
  content: string,
) {
  const response = await fetchText(
    `https://api.clickup.com/api/v3/workspaces/${encodeURIComponent(config.workspaceId)}/chat/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: config.personalToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "message",
        content,
        content_format: "text/md",
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`http-error:${response.status}:${truncateText(response.text, 240)}`);
  }

  return parseClickUpCreateChatMessageResponse(response.text);
}

async function maybeSendClickUpReviewerDirectMessages(input: {
  config: ClickUpChatConfig;
  title: string;
  threadLink?: string | null;
  reviewers: ClickUpReviewerInput[];
}) {
  const targets = input.reviewers
    .map((reviewer) => {
      const userId = readString(reviewer.userId);
      return userId
        ? {
          label: reviewer.label,
          userId,
          displayName: reviewer.displayName ?? null,
        }
        : null;
    })
    .filter(isClickUpReviewerTarget);

  for (const reviewer of targets) {
    try {
      const displayName = reviewer.displayName ?? reviewer.userId;
      const dmChannel = await createClickUpDirectMessageChannel(input.config, reviewer.userId);
      const dmContent = [
        `Hi ${displayName},`,
        "",
        `You were notified in ClickUp about ${truncateText(input.title, MAX_REVIEWER_DIRECT_MESSAGE_TITLE_LENGTH)}.`,
      ];
      if (input.threadLink) {
        dmContent.push("", `Original approval thread: ${input.threadLink}`);
      }
      await sendClickUpDirectMessage(
        input.config,
        dmChannel.channelId,
        trimTotal(dmContent.join("\n"), CLICKUP_CHAT_MESSAGE_MAX_CHARS),
      );
    } catch (error) {
      logger.warn({
        userId: reviewer.userId,
        label: reviewer.label,
        err: error,
      }, "clickup awaiting human reviewer DM failed");
    }
  }
}

async function readCompanyClickUpOverrides(
  db: Db,
  companyId: string,
): Promise<
  ClickUpAwaitingHumanConfigOverrides & {
    bridgeEnabled: boolean;
    provider: string | null;
  }
> {
  const resolved =
    await awaitingHumanSettingsService(db).resolveClickUpRuntimeConfig(
      companyId,
    );
  return {
    bridgeEnabled: resolved.enabled,
    provider: resolved.provider,
    personalToken: resolved.personalToken,
    workspaceId: resolved.workspaceId,
    channelId: resolved.channelId,
    attachmentTaskId: resolved.attachmentTaskId,
    primaryReviewerUserId: resolved.primaryReviewerUserId,
    secondaryReviewerUserId: resolved.secondaryReviewerUserId,
  };
}

function readClickUpChatConfig(
  overrides?: ClickUpAwaitingHumanConfigOverrides,
): ClickUpChatConfig {
  const personalToken =
    overrides?.personalToken?.trim() ||
    process.env.CLICKUP_PERSONAL_TOKEN?.trim() ||
    "";
  const workspaceId =
    overrides?.workspaceId?.trim() ||
    process.env.CLICKUP_WORKSPACE_ID?.trim() ||
    "";
  const overrideChannelId = overrides?.channelId?.trim() ?? "";
  const channelId =
    overrideChannelId ||
    process.env.CLICKUP_AWAITING_HUMAN_CHANNEL_ID?.trim() ||
    process.env.CLICKUP_ENGINEERING_CHANNEL_ID?.trim() ||
    "";
  const primaryReviewerUserId =
    overrides?.primaryReviewerUserId?.trim() ||
    process.env.CLICKUP_AWAITING_HUMAN_PRIMARY_REVIEWER_USER_ID?.trim() ||
    "";
  const secondaryReviewerUserId =
    overrides?.secondaryReviewerUserId?.trim() ||
    process.env.CLICKUP_AWAITING_HUMAN_SECONDARY_REVIEWER_USER_ID?.trim() ||
    "";
  return {
    personalToken,
    workspaceId,
    channelId,
    primaryReviewerUserId,
    secondaryReviewerUserId,
  };
}

async function fetchText(
  url: string,
  init: RequestInit,
  timeoutSec = DEFAULT_CLICKUP_TIMEOUT_SEC,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchClickUpJson(
  config: ClickUpChatConfig,
  path: string,
  timeoutSec = DEFAULT_CLICKUP_TIMEOUT_SEC,
): Promise<
  { status: "ok"; payload: unknown } | { status: "failed"; detail: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const response = await fetch(
      `https://api.clickup.com/api/v3/workspaces/${encodeURIComponent(config.workspaceId)}${path}`,
      {
        headers: {
          Authorization: config.personalToken,
        },
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const body = await response.text();
      return {
        status: "failed",
        detail: `http-error:${response.status}:${truncateText(body, 240)}`,
      };
    }

    return {
      status: "ok",
      payload: await response.json(),
    };
  } catch (error) {
    return {
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

type ClickUpReplyMessageLinksResponse = {
  reactions: string;
  tagged_users: string;
};

type ClickUpReplyMessageResponse = {
  id: string;
  parent_message: string;
  content: string;
  date?: number | string | null;
  date_assigned?: number | string | null;
  links: ClickUpReplyMessageLinksResponse;
};

type ClickUpGetChatMessageRepliesResponse = {
  data?: ClickUpReplyMessageResponse[];
  next_cursor?: string | null;
};

function readNumericValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readClickUpReplyDate(row: ClickUpReplyMessageResponse) {
  return readNumericValue(row.date) ?? readNumericValue(row.date_assigned);
}

function compareClickUpRepliesChronologically(
  a: ClickUpReplyMessageResponse,
  b: ClickUpReplyMessageResponse,
) {
  const aDate = readClickUpReplyDate(a);
  const bDate = readClickUpReplyDate(b);
  if (aDate !== null && bDate !== null && aDate !== bDate) {
    return aDate - bDate;
  }

  const aIdStr = typeof a.id === "string" && a.id.trim().length > 0 ? a.id.trim() : null;
  const bIdStr = typeof b.id === "string" && b.id.trim().length > 0 ? b.id.trim() : null;
  if (aIdStr !== null && bIdStr !== null && aIdStr !== bIdStr) {
    try {
      const cmp = BigInt(aIdStr) - BigInt(bIdStr);
      if (cmp !== 0n) return cmp > 0n ? 1 : -1;
    } catch {
      return aIdStr < bIdStr ? -1 : 1;
    }
  }

  return 0;
}

function extractReplyRowsFromRows(rows: ClickUpReplyMessageResponse[]): ClickUpChatMessageReply[] {
  return [...rows].sort(compareClickUpRepliesChronologically).map((row) => ({
    id: row.id,
    parentMessageId: row.parent_message,
    reactionsUrl: row.links.reactions,
    content: row.content,
    dateMs: readClickUpReplyDate(row),
  }));
}

function extractReplyRows(payload: ClickUpGetChatMessageRepliesResponse): ClickUpChatMessageReply[] {
  return extractReplyRowsFromRows(Array.isArray(payload.data) ? payload.data : []);
}

function formatApprovalStage(stage: "primary" | "final") {
  return stage === "primary" ? "primary review" : "final check";
}

function pickReviewerDisplayName(
  approvalReviewers: ClickUpReviewerTarget[] | undefined,
  reviewerLabel: string,
) {
  const reviewer = approvalReviewers?.find((candidate) => candidate.label === reviewerLabel) ?? null;
  return reviewer?.displayName
    ?? reviewer?.userId
    ?? null;
}

function renderApprovalContextSection(
  notification: AwaitingHumanNotificationPayload,
  config: ClickUpChatConfig,
  approvalReviewers?: ClickUpReviewerTarget[],
) {
  const approvalContext = notification.approvalContext;
  if (!approvalContext) return null;
  const route = resolveApprovalFlowRoute(approvalContext, config);
  const lines: string[] = [];

  if (route.approvalName) {
    lines.push(`Approval: ${route.approvalName}`);
  }
  lines.push(`Approval stage: ${formatApprovalStage(route.approvalStage)}`);

  const reviewerLabel = route.approvalStage === "primary" ? "Primary reviewer" : "Reviewer";
  const currentReviewer = approvalReviewers?.find(
    (candidate) => candidate.userId === route.currentReviewerUserId,
  ) ?? null;
  const currentReviewerDisplayName = currentReviewer?.displayName ?? currentReviewer?.userId ?? null;
  lines.push(route.currentReviewerUserId
    ? `${reviewerLabel}: a direct message will be sent to ${currentReviewerDisplayName ?? "the reviewer"}.`
    : `${reviewerLabel}: not configured.`);

  if (route.requiresSecondReview && route.approvalStage === "primary") {
    const nextReviewerDisplayName = pickReviewerDisplayName(approvalReviewers, "Secondary reviewer");
    lines.push(nextReviewerDisplayName
      ? `Next step: the secondary reviewer, ${nextReviewerDisplayName}, will be notified if the approval is accepted.`
      : "Next step: the secondary reviewer will be notified if the approval is accepted.");
  } else if (route.requiresSecondReview && route.approvalStage === "final") {
    lines.push("Next step: the final reviewer handles the approval after the primary review clears.");
  } else {
    lines.push("Next step: the reviewer handles the approval in ClickUp.");
  }

  return lines.join("\n");
}

function renderClickUpMessage(
  notification: AwaitingHumanNotificationPayload,
  config: ClickUpChatConfig,
  options?: {
    maxChars?: number;
    preserveBody?: boolean;
    includeCtaWithBody?: boolean;
    approvalReviewers?: ClickUpReviewerTarget[];
  },
) {
  const maxChars = options?.maxChars ?? CLICKUP_CHAT_MESSAGE_MAX_CHARS;
  const title = truncateText(notification.title, MAX_TITLE_LENGTH);
  const bodySection = options?.preserveBody
    ? formatFullBodySection(notification.body)
    : formatBodySection(notification.body);
  const approvalSection = renderApprovalContextSection(notification, config, options?.approvalReviewers);
  const lines = [`**${title}**`];

  if (bodySection) {
    lines.push("");
    lines.push(bodySection);
  } else if (notification.summary.trim().length > 0) {
    lines.push("");
    lines.push(truncateText(notification.summary, MAX_SUMMARY_LENGTH));
  }

  if (approvalSection) {
    lines.push("");
    lines.push(approvalSection);
  }

  if (notification.reviewFile) {
    lines.push("");
    lines.push(`Review file: ${notification.reviewFile.filename}`);
    lines.push(`Bizbox deliverable: ${notification.reviewFile.deliverableUrl}`);
    if (notification.reviewFile.clickupAttachmentUrl) {
      lines.push(
        `ClickUp attachment: ${notification.reviewFile.clickupAttachmentUrl}`,
      );
    }
    if (notification.reviewFile.clickupTaskUrl) {
      lines.push(
        `ClickUp review task: ${notification.reviewFile.clickupTaskUrl}`,
      );
      if (notification.reviewFile.clickupAttachmentId) {
        lines.push("Review file attached on the ClickUp task.");
      }
    }
  } else {
    const targetAttachmentUrl = readString(notification.target?.clickupAttachmentUrl);
    if (targetAttachmentUrl) {
      lines.push("");
      lines.push(`ClickUp attachment: ${targetAttachmentUrl}`);
    }
  }

  if ((options?.includeCtaWithBody || !bodySection) && notification.cta.trim().length > 0) {
    lines.push("");
    lines.push(truncateText(notification.cta, MAX_BULLET_LENGTH));
  }

  return trimTotal(lines.join("\n"), maxChars);
}

function renderClickUpTransportTestMessage(
  notification: ClickUpTransportTestNotification,
) {
  const title = truncateText(notification.title, MAX_TITLE_LENGTH);
  const summary = truncateText(notification.summary, MAX_SUMMARY_LENGTH);
  const bodySection = formatBodySection(notification.body);
  const lines = [`**${title}**`, "", summary];

  if (bodySection) {
    lines.push("");
    lines.push(bodySection);
  }

  if (notification.reviewerTargets?.length) {
    const hasConfiguredReviewerTarget = notification.reviewerTargets.some(
      (mention) => readString(mention.userId) !== null,
    );
    if (hasConfiguredReviewerTarget) {
      const reviewerLines = notification.reviewerTargets.map((mention) => {
        return readString(mention.userId)
          ? `${mention.label}: a direct message will be sent`
          : `${mention.label}: not configured`;
      });
      lines.push("");
      lines.push("Reviewer notification test:");
      lines.push(...reviewerLines);
    }
  }

  if (notification.cta?.trim()) {
    lines.push("");
    lines.push(truncateText(notification.cta, MAX_BULLET_LENGTH));
  }

  lines.push(`Open in Bizbox: ${notification.link.trim()}`);

  return trimTotal(lines.join("\n"), CLICKUP_CHAT_MESSAGE_MAX_CHARS);
}

async function postClickUpChatMessage(
  content: string,
  overrides?: ClickUpAwaitingHumanConfigOverrides,
): Promise<ClickUpTransportMessageResult> {
  const config = readClickUpChatConfig(overrides);
  if (!config.personalToken) {
    return {
      status: "skipped",
      channel: "clickup-chat",
      detail: "missing-credential: CLICKUP_PERSONAL_TOKEN",
      messageLink: null,
    };
  }
  if (!config.workspaceId) {
    return {
      status: "skipped",
      channel: "clickup-chat",
      detail: "missing-target: CLICKUP_WORKSPACE_ID",
      messageLink: null,
    };
  }

  try {
    const channelId = config.channelId.trim();
    if (!channelId) {
      return {
        status: "skipped",
        channel: "clickup-chat",
        detail:
          "missing-target: CLICKUP_AWAITING_HUMAN_CHANNEL_ID (or CLICKUP_ENGINEERING_CHANNEL_ID)",
        messageLink: null,
      };
    }

    const response = await fetchText(
      `https://api.clickup.com/api/v3/workspaces/${encodeURIComponent(config.workspaceId)}/chat/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: config.personalToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "message",
          content,
          content_format: "text/md",
        }),
      },
    );

    if (!response.ok) {
      return {
        status: "failed",
        channel: "clickup-chat",
        detail: `http-error:${response.status}:${truncateText(response.text, 240)}`,
        messageLink: null,
      };
    }

    const parsedMessage = response.text.trim().length > 0
      ? parseClickUpCreateChatMessageResponse(response.text)
      : null;

    return {
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId: parsedMessage?.messageId ?? null,
      messageLink: parsedMessage?.messageLink ?? null,
    };
  } catch (error) {
    return {
      status: "failed",
      channel: "clickup-chat",
      detail: error instanceof Error ? error.message : String(error),
      messageLink: null,
    };
  }
}

async function postClickUpChatMessageReply(
  parentMessageId: string,
  content: string,
  overrides?: ClickUpAwaitingHumanConfigOverrides,
): Promise<ClickUpTransportMessageResult> {
  const config = readClickUpChatConfig(overrides);
  if (!config.personalToken) {
    return {
      status: "skipped",
      channel: "clickup-chat",
      detail: "missing-credential: CLICKUP_PERSONAL_TOKEN",
      messageLink: null,
    };
  }
  if (!config.workspaceId) {
    return {
      status: "skipped",
      channel: "clickup-chat",
      detail: "missing-target: CLICKUP_WORKSPACE_ID",
      messageLink: null,
    };
  }

  const messageId = parentMessageId.trim();
  if (!messageId) {
    return {
      status: "skipped",
      channel: "clickup-chat",
      detail: "missing-target: parent-message-id",
      messageLink: null,
    };
  }

  try {
    const response = await fetchText(
      `https://api.clickup.com/api/v3/workspaces/${encodeURIComponent(config.workspaceId)}/chat/messages/${encodeURIComponent(messageId)}/replies`,
      {
        method: "POST",
        headers: {
          Authorization: config.personalToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "message",
          content,
          content_format: "text/md",
        }),
      },
    );

    if (!response.ok) {
      return {
        status: "failed",
        channel: "clickup-chat",
        detail: `http-error:${response.status}:${truncateText(response.text, 240)}`,
        messageLink: null,
      };
    }

    const parsedMessage = response.text.trim().length > 0
      ? parseClickUpCreateChatMessageResponse(response.text)
      : null;

    return {
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId: parsedMessage?.messageId ?? null,
      messageLink: parsedMessage?.messageLink ?? null,
    };
  } catch (error) {
    return {
      status: "failed",
      channel: "clickup-chat",
      detail: error instanceof Error ? error.message : String(error),
      messageLink: null,
    };
  }
}

export async function sendAwaitingHumanNotification(
  input: SendAwaitingHumanNotificationInput,
  overrides?: ClickUpAwaitingHumanConfigOverrides,
): Promise<AwaitingHumanNotificationResult> {
  const config = readClickUpChatConfig(overrides);
  const approvalContext = input.notification.approvalContext;
  const approvalRoute = approvalContext ? resolveApprovalFlowRoute(approvalContext, config) : null;
  const approvalReviewers = approvalRoute
    ? await resolveClickUpReviewerTargets(config, [
      { label: "Primary reviewer", userId: config.primaryReviewerUserId },
      { label: "Secondary reviewer", userId: config.secondaryReviewerUserId },
    ])
    : [];
  const currentReviewerTargets = approvalRoute
    ? approvalReviewers.filter((reviewer) => reviewer.userId === approvalRoute.currentReviewerUserId)
    : [];
  const result = await postClickUpChatMessage(
    renderClickUpMessage(input.notification, config, { approvalReviewers }),
    overrides,
  );
  if (result.status === "sent" && approvalRoute && result.externalId) {
    const threadLink = buildClickUpChatMessageAppUrl(config.workspaceId, config.channelId, result.externalId)
      ?? result.messageLink
      ?? readString(input.notification.link);
    await maybeSendClickUpReviewerDirectMessages({
      config,
      title: input.notification.title,
      threadLink,
      reviewers: currentReviewerTargets,
    });
  }
  const { messageLink: _messageLink, ...publicResult } = result;
  return publicResult;
}

export async function sendAwaitingHumanNotificationReply(
  parentMessageId: string,
  input: SendAwaitingHumanNotificationInput,
  overrides?: ClickUpAwaitingHumanConfigOverrides,
): Promise<AwaitingHumanNotificationResult> {
  const config = readClickUpChatConfig(overrides);
  const result = await postClickUpChatMessageReply(
    parentMessageId,
    renderClickUpMessage(
      input.notification,
      config,
      {
        maxChars: CLICKUP_CHAT_REPLY_MESSAGE_MAX_CHARS,
        preserveBody: true,
        includeCtaWithBody: true,
      },
    ),
    overrides,
  );
  const { messageLink: _messageLink, ...publicResult } = result;
  return publicResult;
}

export async function sendClickUpTransportTestMessage(
  notification: ClickUpTransportTestNotification,
  overrides?: ClickUpAwaitingHumanConfigOverrides,
): Promise<AwaitingHumanNotificationResult> {
  const config = readClickUpChatConfig(overrides);
  const reviewerTargets = notification.reviewerTargets?.length
    ? await resolveClickUpReviewerTargets(config, notification.reviewerTargets)
    : [];
  const result = await postClickUpChatMessage(
    renderClickUpTransportTestMessage(notification),
    overrides,
  );
  if (result.status === "sent" && result.externalId && reviewerTargets.length) {
    const threadLink = buildClickUpChatMessageAppUrl(config.workspaceId, config.channelId, result.externalId)
      ?? result.messageLink
      ?? readString(notification.link);
    await maybeSendClickUpReviewerDirectMessages({
      config,
      title: notification.title,
      threadLink,
      reviewers: reviewerTargets,
    });
  }
  const { messageLink: _messageLink, ...publicResult } = result;
  return publicResult;
}

type ClickUpAttachmentsAttachment = {
  date_updated: number;
  date_created: number;
  extension: string;
  id: string;
  mime_type: string;
  parent_entity_type: string;
  parent_id: string;
  size: number;
  signed: boolean;
  thumbnail_small: string;
  thumbnail_medium: string;
  thumbnail_large: string;
  title: string;
  url: string;
  user_id: number;
};

type ClickUpApiErrorResponse = {
  status: number;
  message: string;
  trace_id: number | null;
  timestamp: number;
};

function parseClickUpAttachmentResponse(rawText: string) {
  const payload = JSON.parse(rawText) as ClickUpAttachmentsAttachment;
  const attachmentId = readString(payload.id);
  const attachmentUrl = readString(payload.url);
  if (!attachmentId) {
    throw new Error(
      `clickup review file upload response missing attachment id:${truncateText(rawText, 240)}`,
    );
  }
  if (!attachmentUrl) {
    throw new Error(
      `clickup review file upload response missing attachment url:${truncateText(rawText, 240)}`,
    );
  }
  return {
    attachmentId,
    attachmentUrl,
    parentEntityType: readString(payload.parent_entity_type),
    parentId: readString(payload.parent_id),
  };
}

type ClickUpAttachmentUploadTarget = {
  v3EntityId: string;
  v2TaskId: string;
  useCustomTaskIds: boolean;
};

async function resolveClickUpAttachmentUploadTarget(
  config: ClickUpChatConfig,
  configuredTaskId: string,
): Promise<ClickUpAttachmentUploadTarget> {
  const authHeaders = {
    Accept: "application/json",
    Authorization: config.personalToken,
  };
  const customTaskQuery = `?custom_task_ids=true&team_id=${encodeURIComponent(config.workspaceId)}`;
  const customTaskResponse = await fetchText(
    `https://api.clickup.com/api/v2/task/${encodeURIComponent(configuredTaskId)}${customTaskQuery}`,
    { headers: authHeaders },
  );
  if (customTaskResponse.ok) {
    const payload = JSON.parse(customTaskResponse.text) as { id?: string };
    const internalId = readString(payload.id);
    if (internalId) {
      return {
        v3EntityId: internalId,
        v2TaskId: configuredTaskId,
        useCustomTaskIds: true,
      };
    }
  }

  const directTaskResponse = await fetchText(
    `https://api.clickup.com/api/v2/task/${encodeURIComponent(configuredTaskId)}`,
    { headers: authHeaders },
  );
  if (directTaskResponse.ok) {
    const payload = JSON.parse(directTaskResponse.text) as { id?: string };
    const internalId = readString(payload.id) ?? configuredTaskId;
    return {
      v3EntityId: internalId,
      v2TaskId: internalId,
      useCustomTaskIds: false,
    };
  }

  return {
    v3EntityId: configuredTaskId,
    v2TaskId: configuredTaskId,
    useCustomTaskIds: true,
  };
}

function buildClickUpReviewFileUploadForm(
  reviewFile: AwaitingHumanNotificationReviewFile,
  body: Buffer,
  fileFieldName: string,
) {
  const form = new FormData();
  form.append(
    fileFieldName,
    new Blob([new Uint8Array(body)], { type: reviewFile.contentType }),
    reviewFile.filename,
  );
  form.append("filename", reviewFile.filename);
  return form;
}

async function uploadClickUpReviewFileViaV3(
  config: ClickUpChatConfig,
  entityId: string,
  reviewFile: AwaitingHumanNotificationReviewFile,
  body: Buffer,
) {
  return fetchText(
    `https://api.clickup.com/api/v3/workspaces/${encodeURIComponent(config.workspaceId)}/attachments/${encodeURIComponent(entityId)}/attachments`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: config.personalToken,
      },
      body: buildClickUpReviewFileUploadForm(
        reviewFile,
        body,
        CLICKUP_ATTACHMENT_FILE_FIELD,
      ),
    },
  );
}

async function uploadClickUpReviewFileViaV2(
  config: ClickUpChatConfig,
  target: ClickUpAttachmentUploadTarget,
  reviewFile: AwaitingHumanNotificationReviewFile,
  body: Buffer,
) {
  const query = target.useCustomTaskIds
    ? `?custom_task_ids=true&team_id=${encodeURIComponent(config.workspaceId)}`
    : "";
  return fetchText(
    `https://api.clickup.com/api/v2/task/${encodeURIComponent(target.v2TaskId)}/attachment${query}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: config.personalToken,
      },
      body: buildClickUpReviewFileUploadForm(reviewFile, body, "attachment"),
    },
  );
}

function parseClickUpApiErrorMessage(rawText: string) {
  try {
    const payload = JSON.parse(rawText) as ClickUpApiErrorResponse;
    return readString(payload.message);
  } catch {
    return readString(rawText);
  }
}

export async function uploadClickUpReviewFile(
  config: ClickUpAwaitingHumanConfigOverrides,
  entityId: string,
  reviewFile: AwaitingHumanNotificationReviewFile,
  body: Buffer,
) {
  const resolved = readClickUpChatConfig(config);
  const uploadTarget = await resolveClickUpAttachmentUploadTarget(resolved, entityId);
  let response = await uploadClickUpReviewFileViaV3(
    resolved,
    uploadTarget.v3EntityId,
    reviewFile,
    body,
  );
  if (!response.ok && response.status === 404) {
    response = await uploadClickUpReviewFileViaV2(
      resolved,
      uploadTarget,
      reviewFile,
      body,
    );
  }
  if (!response.ok) {
    throw new Error(
      `clickup review file upload failed:${response.status}:${truncateText(response.text, 240)}`,
    );
  }
  if (response.text.trim().length === 0) {
    throw new Error("clickup review file upload response missing body");
  }
  const attachment = parseClickUpAttachmentResponse(response.text);
  return {
    attachmentId: attachment.attachmentId,
    attachmentUrl: attachment.attachmentUrl,
  };
}

export async function getClickUpChatMessageReplies(
  messageId: string,
  overrides?: ClickUpAwaitingHumanConfigOverrides,
): Promise<{
  status: ClickUpApiStatus;
  detail: string;
  replies: ClickUpChatMessageReply[];
}> {
  const config = readClickUpChatConfig(overrides);
  if (!config.personalToken) {
    return {
      status: "skipped",
      detail: "missing-credential: CLICKUP_PERSONAL_TOKEN",
      replies: [],
    };
  }
  if (!config.workspaceId) {
    return {
      status: "skipped",
      detail: "missing-target: CLICKUP_WORKSPACE_ID",
      replies: [],
    };
  }

  const rawReplies: ClickUpReplyMessageResponse[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_CLICKUP_REPLY_PAGES; page += 1) {
    const cursorQuery = cursor
      ? `?${new URLSearchParams({ cursor }).toString()}`
      : "";
    const response = await fetchClickUpJson(
      config,
      `/chat/messages/${encodeURIComponent(messageId)}/replies${cursorQuery}`,
    );
    if (response.status === "failed") {
      return { status: "failed", detail: response.detail, replies: [] };
    }

    const payload = response.payload as ClickUpGetChatMessageRepliesResponse;
    if (Array.isArray(payload.data)) rawReplies.push(...payload.data);
    cursor = readString(payload.next_cursor);
    if (!cursor) break;
  }

  return {
    status: "sent",
    detail: "ok",
    replies: extractReplyRowsFromRows(rawReplies),
  };
}

export async function addClickUpChatMessageReaction(
  messageId: string,
  reaction: string,
  overrides?: ClickUpAwaitingHumanConfigOverrides,
): Promise<{
  status: ClickUpApiStatus;
  detail: string;
}> {
  const config = readClickUpChatConfig(overrides);
  if (!config.personalToken) {
    return {
      status: "skipped",
      detail: "missing-credential: CLICKUP_PERSONAL_TOKEN",
    };
  }
  if (!config.workspaceId) {
    return {
      status: "skipped",
      detail: "missing-target: CLICKUP_WORKSPACE_ID",
    };
  }

  const reactionName = reaction.trim();
  if (!reactionName) {
    return {
      status: "skipped",
      detail: "missing-target: reaction",
    };
  }

  try {
    return await postClickUpChatMessageReaction(
      `https://api.clickup.com/api/v3/workspaces/${encodeURIComponent(config.workspaceId)}/chat/messages/${encodeURIComponent(messageId)}/reactions`,
      reactionName,
      config.personalToken,
    );
  } catch (error) {
    return {
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function postClickUpChatMessageReaction(
  url: string,
  reaction: string,
  personalToken: string,
): Promise<{
  status: ClickUpApiStatus;
  detail: string;
}> {
  const response = await fetchText(url, {
    method: "POST",
    headers: {
      Authorization: personalToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      reaction,
    }),
  });

  if (response.ok) {
    return {
      status: "sent",
      detail: "sent",
    };
  }

  const errorMessage = parseClickUpApiErrorMessage(response.text);
  if (response.status === 400 && errorMessage && /already exists/i.test(errorMessage)) {
    return {
      status: "sent",
      detail: "already-exists",
    };
  }

  return {
    status: "failed",
    detail: `http-error:${response.status}:${truncateText(errorMessage ?? response.text, 240)}`,
  };
}

export async function deleteClickUpChatMessageReaction(
  messageId: string,
  reaction: string,
  overrides?: ClickUpAwaitingHumanConfigOverrides,
): Promise<{
  status: ClickUpApiStatus;
  detail: string;
}> {
  const config = readClickUpChatConfig(overrides);
  if (!config.personalToken) {
    return {
      status: "skipped",
      detail: "missing-credential: CLICKUP_PERSONAL_TOKEN",
    };
  }
  if (!config.workspaceId) {
    return {
      status: "skipped",
      detail: "missing-target: CLICKUP_WORKSPACE_ID",
    };
  }

  const reactionName = reaction.trim();
  if (!reactionName) {
    return {
      status: "skipped",
      detail: "missing-target: reaction",
    };
  }

  try {
    const response = await fetchText(
      `https://api.clickup.com/api/v3/workspaces/${encodeURIComponent(config.workspaceId)}/chat/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionName)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: config.personalToken,
          "Content-Type": "application/json",
        },
      },
    );

    const errorMessage = parseClickUpApiErrorMessage(response.text);
    if (response.ok || response.status === 404) {
      return {
        status: "sent",
        detail: response.ok ? "deleted" : "not-found",
      };
    }

    return {
      status: "failed",
      detail: `http-error:${response.status}:${truncateText(errorMessage ?? response.text, 240)}`,
    };
  } catch (error) {
    return {
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function detectClickUpAwaitingHumanBridgeEvents(
  messageId: string,
  overrides?: ClickUpAwaitingHumanConfigOverrides,
): Promise<{
  status: ClickUpApiStatus;
  detail: string;
  events: AwaitingHumanBridgePollEvent[];
}> {
  const config = readClickUpChatConfig(overrides);
  if (!config.personalToken) {
    return {
      status: "skipped",
      detail: "missing-credential: CLICKUP_PERSONAL_TOKEN",
      events: [],
    };
  }
  if (!config.workspaceId) {
    return {
      status: "skipped",
      detail: "missing-target: CLICKUP_WORKSPACE_ID",
      events: [],
    };
  }

  const repliesResult = await getClickUpChatMessageReplies(
    messageId,
    overrides,
  );
  if (repliesResult.status === "failed" || repliesResult.status === "skipped") {
    return {
      status: repliesResult.status,
      detail: repliesResult.detail,
      events: [],
    };
  }

  const events: AwaitingHumanBridgePollEvent[] = [];
  for (const reply of repliesResult.replies) {
    const replyId = readString(reply.id);
    const replyBody = readString(reply.content);
    if (!replyId) {
      logger.warn(
        { messageId, reply },
        "Skipping ClickUp reply without stable reply.id",
      );
      continue;
    }
    if (!replyBody) continue;
    events.push({
      kind: "reply",
      externalEventId: replyId,
      externalMessageId: messageId,
      body: replyBody,
      metadata: {
        clickupReplyId: replyId,
      },
    });
  }

  if (events.length > 0) {
    return { status: "sent", detail: "replies-detected", events };
  }

  return { status: "sent", detail: "no-replies", events: [] };
}

export async function detectClickUpAwaitingHumanBridgeEventsAfterMessage(
  threadMessageId: string,
  markerMessageId: string,
  overrides?: ClickUpAwaitingHumanConfigOverrides,
): Promise<{
  status: ClickUpApiStatus;
  detail: string;
  events: AwaitingHumanBridgePollEvent[];
}> {
  const threadId = threadMessageId.trim();
  const markerId = markerMessageId.trim();
  if (!threadId) {
    return { status: "skipped", detail: "missing-thread-message-id", events: [] };
  }
  if (!markerId) {
    return { status: "skipped", detail: "missing-marker-message-id", events: [] };
  }

  const repliesResult = await getClickUpChatMessageReplies(threadId, overrides);
  if (repliesResult.status === "failed" || repliesResult.status === "skipped") {
    return {
      status: repliesResult.status,
      detail: repliesResult.detail,
      events: [],
    };
  }

  const events: AwaitingHumanBridgePollEvent[] = [];
  let markerFound = false;
  for (const reply of repliesResult.replies) {
    const replyId = readString(reply.id);
    if (!replyId) {
      logger.warn(
        { messageId: threadId, markerMessageId: markerId, reply },
        "Skipping ClickUp thread reply without stable reply.id",
      );
      continue;
    }
    if (replyId === markerId) {
      markerFound = true;
      continue;
    }
    if (!markerFound) continue;

    const replyBody = readString(reply.content);
    if (!replyBody) continue;
    events.push({
      kind: "reply",
      externalEventId: replyId,
      externalThreadId: threadId,
      externalMessageId: markerId,
      body: replyBody,
      metadata: {
        clickupReplyId: replyId,
        clickupThreadId: threadId,
        clickupQuestionMessageId: markerId,
      },
    });
  }

  if (!markerFound) {
    return { status: "failed", detail: "question-marker-not-found", events: [] };
  }
  if (events.length > 0) {
    return { status: "sent", detail: "replies-detected", events };
  }

  return { status: "sent", detail: "no-replies", events: [] };
}

export { readCompanyClickUpOverrides, readClickUpChatConfig };
