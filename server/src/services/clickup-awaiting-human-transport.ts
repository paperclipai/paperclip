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

const CLICKUP_CHAT_MESSAGE_MAX_CHARS = 1_800;
const MAX_TITLE_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 280;
const MAX_DETAIL_BULLETS = 5;
const MAX_BULLET_LENGTH = 220;
const DEFAULT_CLICKUP_TIMEOUT_SEC = 30;
const CLICKUP_ATTACHMENT_FILE_FIELD = "attachment[0]";

export interface ClickUpTransportTestNotification {
  title: string;
  summary: string;
  link: string;
  body?: string | null;
  cta?: string | null;
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
}

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
  return trimTotal(limited.join("\n"), 1_000);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
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
  links: ClickUpReplyMessageLinksResponse;
};

type ClickUpGetChatMessageRepliesResponse = {
  data: ClickUpReplyMessageResponse[];
  next_cursor: string;
};

function extractReplyRows(payload: ClickUpGetChatMessageRepliesResponse): ClickUpChatMessageReply[] {
  return payload.data.map((row) => ({
    id: row.id,
    parentMessageId: row.parent_message,
    reactionsUrl: row.links.reactions,
    content: row.content,
  }));
}
function formatClickUpUserMention(userId: string | null | undefined) {
  const trimmed = readString(userId);
  return trimmed ? `clickup://user/${trimmed}` : null;
}

function formatApprovalStage(stage: "primary" | "final") {
  return stage === "primary" ? "primary review" : "final check";
}

function renderApprovalContextSection(
  notification: AwaitingHumanNotificationPayload,
  config: ClickUpChatConfig,
) {
  const approvalContext = notification.approvalContext;
  if (!approvalContext) return null;
  const route = resolveApprovalFlowRoute(approvalContext, config);
  const lines: string[] = [];

  if (route.approvalName) {
    lines.push(`Approval: ${route.approvalName}`);
  }
  lines.push(`Approval stage: ${formatApprovalStage(route.approvalStage)}`);

  const currentReviewerMention = formatClickUpUserMention(route.currentReviewerUserId);
  if (currentReviewerMention) {
    lines.push(`Reviewer: ${currentReviewerMention}`);
  } else {
    lines.push("Reviewer: not configured");
  }

  if (route.nextReviewerUserId) {
    const nextReviewerMention = formatClickUpUserMention(route.nextReviewerUserId);
    lines.push(`Next reviewer: ${nextReviewerMention ?? "not configured"}`);
  }

  if (route.approvalStage === "primary" && route.requiresSecondReview) {
    const nextReviewerMention = formatClickUpUserMention(route.nextReviewerUserId);
    lines.push(
      `Next step: ${currentReviewerMention ?? "the reviewer"} checks first, then ${nextReviewerMention ?? "the secondary reviewer"} handles the final check if approved.`,
    );
  } else if (route.approvalStage === "final" && route.requiresSecondReview) {
    lines.push(
      `Next step: ${currentReviewerMention ?? "the reviewer"} handles the final check after the primary review clears.`,
    );
  } else {
    lines.push(`Next step: ${currentReviewerMention ?? "the reviewer"} handles the approval.`);
  }

  return lines.join("\n");
}

function renderClickUpMessage(notification: AwaitingHumanNotificationPayload, config: ClickUpChatConfig) {
  const title = truncateText(notification.title, MAX_TITLE_LENGTH);
  const bodySection = formatBodySection(notification.body);
  const approvalSection = renderApprovalContextSection(notification, config);
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

  if (!bodySection && notification.cta.trim().length > 0) {
    lines.push("");
    lines.push(truncateText(notification.cta, 180));
  }

  return trimTotal(lines.join("\n"), CLICKUP_CHAT_MESSAGE_MAX_CHARS);
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

  if (notification.cta?.trim()) {
    lines.push("");
    lines.push(truncateText(notification.cta, 180));
  }

  lines.push(`Open in Bizbox: ${notification.link.trim()}`);

  return trimTotal(lines.join("\n"), CLICKUP_CHAT_MESSAGE_MAX_CHARS);
}

async function postClickUpChatMessage(
  content: string,
  overrides?: ClickUpAwaitingHumanConfigOverrides,
): Promise<AwaitingHumanNotificationResult> {
  const config = readClickUpChatConfig(overrides);
  if (!config.personalToken) {
    return {
      status: "skipped",
      channel: "clickup-chat",
      detail: "missing-credential: CLICKUP_PERSONAL_TOKEN",
    };
  }
  if (!config.workspaceId) {
    return {
      status: "skipped",
      channel: "clickup-chat",
      detail: "missing-target: CLICKUP_WORKSPACE_ID",
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
      };
    }

    const externalId = response.text.trim().length > 0
      ? parseClickUpCreateChatMessageResponse(response.text).messageId
      : null;

    return {
      status: "sent",
      channel: "clickup-chat",
      detail: "sent",
      externalId,
    };
  } catch (error) {
    return {
      status: "failed",
      channel: "clickup-chat",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function sendAwaitingHumanNotification(
  input: SendAwaitingHumanNotificationInput,
  overrides?: ClickUpAwaitingHumanConfigOverrides,
): Promise<AwaitingHumanNotificationResult> {
  const config = readClickUpChatConfig(overrides);
  return postClickUpChatMessage(
    renderClickUpMessage(input.notification, config),
    overrides,
  );
}

export async function sendClickUpTransportTestMessage(
  notification: ClickUpTransportTestNotification,
  overrides?: ClickUpAwaitingHumanConfigOverrides,
): Promise<AwaitingHumanNotificationResult> {
  return postClickUpChatMessage(
    renderClickUpTransportTestMessage(notification),
    overrides,
  );
}

type ClickUpCreateChatMessageResponse = {
  id: string;
};

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

function parseClickUpCreateChatMessageResponse(rawText: string) {
  const payload = JSON.parse(rawText) as ClickUpCreateChatMessageResponse;
  return {
    messageId: payload.id,
  };
}

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

  const response = await fetchClickUpJson(
    config,
    `/chat/messages/${encodeURIComponent(messageId)}/replies`,
  );
  if (response.status === "failed") {
    return { status: "failed", detail: response.detail, replies: [] };
  }

  return {
    status: "sent",
    detail: "ok",
    replies: extractReplyRows(response.payload as ClickUpGetChatMessageRepliesResponse),
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

export { readCompanyClickUpOverrides, readClickUpChatConfig };
