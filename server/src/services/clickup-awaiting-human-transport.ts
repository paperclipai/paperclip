import type { Db } from "@paperclipai/db";
import { awaitingHumanSettingsService } from "./awaiting-human-settings.js";

const CLICKUP_CHAT_MESSAGE_MAX_CHARS = 1_800;
const MAX_TITLE_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 280;
const MAX_DETAIL_BULLETS = 5;
const MAX_BULLET_LENGTH = 220;
const DEFAULT_CLICKUP_TIMEOUT_SEC = 30;
const CLICKUP_ATTACHMENT_FILE_FIELD = "attachment[0]";
export interface AwaitingHumanNotificationReviewFile {
  source: "artifact" | "document";
  deliverableId: string;
  title: string;
  filename: string;
  contentType: string;
  byteSize: number;
  contentPath: string;
  deliverableUrl: string;
  clickupTaskUrl?: string | null;
  clickupAttachmentId?: string | null;
  attachmentId?: string | null;
  objectKey?: string | null;
  sha256?: string | null;
}

export interface AwaitingHumanNotificationPayload {
  title: string;
  summary: string;
  link: string;
  cta: string;
  labels: string[];
  kind?: string | null;
  audience?: string | null;
  body?: string | null;
  reviewFile?: AwaitingHumanNotificationReviewFile | null;
}

export interface SendAwaitingHumanNotificationInput {
  companyId: string;
  issueId: string;
  handoffKind: "request_confirmation" | "ask_user_questions" | "human_owned_blocker";
  notification: AwaitingHumanNotificationPayload;
}

export interface ClickUpTransportTestNotification {
  title: string;
  summary: string;
  link: string;
  body?: string | null;
  cta?: string | null;
}

export interface AwaitingHumanNotificationResult {
  status: "sent" | "skipped" | "failed" | "enqueued";
  channel: "clickup-chat";
  detail: string;
  externalId?: string | null;
}

type ClickUpChatConfig = {
  personalToken: string;
  workspaceId: string;
  channelId: string;
  reviewListId: string;
};

export type ClickUpAwaitingHumanConfigOverrides = {
  personalToken?: string | null;
  workspaceId?: string | null;
  channelId?: string | null;
};

type ClickUpApiStatus = "sent" | "skipped" | "failed";

export interface ClickUpChatMessageReply {
  id: string | null;
  messageId: string | null;
  reactionsUrl: string | null;
  content: string | null;
}

export interface ClickUpChatMessageReaction {
  name: string;
  count: number;
}

export interface ClickUpAwaitingHumanBridgeEvent {
  kind: "reply" | "approval_signal" | "reject_signal";
  externalEventId: string;
  externalMessageId: string;
  body?: string | null;
  metadata?: Record<string, unknown>;
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
    .filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1]?.length > 0));
  if (lines.length === 0) return null;
  const limited = lines.slice(0, MAX_DETAIL_BULLETS * 6).map((line) => truncateText(line, MAX_BULLET_LENGTH));
  return trimTotal(limited.join("\n"), 1_000);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function readCompanyClickUpOverrides(
  db: Db,
  companyId: string,
): Promise<ClickUpAwaitingHumanConfigOverrides & {
  bridgeEnabled: boolean;
  provider: string | null;
}> {
  const resolved = await awaitingHumanSettingsService(db).resolveClickUpRuntimeConfig(companyId);
  return {
    bridgeEnabled: resolved.enabled,
    provider: resolved.provider,
    personalToken: resolved.personalToken,
    workspaceId: resolved.workspaceId,
    channelId: resolved.channelId,
  };
}

function readClickUpChatConfig(overrides?: ClickUpAwaitingHumanConfigOverrides): ClickUpChatConfig {
  const personalToken = overrides?.personalToken?.trim()
    || process.env.CLICKUP_PERSONAL_TOKEN?.trim()
    || "";
  const workspaceId = overrides?.workspaceId?.trim()
    || process.env.CLICKUP_WORKSPACE_ID?.trim()
    || "";
  const overrideChannelId = overrides?.channelId?.trim() ?? "";
  const channelId = overrideChannelId
    || process.env.CLICKUP_AWAITING_HUMAN_CHANNEL_ID?.trim()
    || process.env.CLICKUP_ENGINEERING_CHANNEL_ID?.trim()
    || "";
  return {
    personalToken,
    workspaceId,
    channelId,
    reviewListId: process.env.CLICKUP_AWAITING_HUMAN_REVIEW_LIST_ID?.trim() ?? "",
  };
}

function normalizeReactionName(value: unknown) {
  const raw = readString(value);
  if (!raw) return null;
  return raw.toLowerCase().replaceAll(" ", "_");
}

function extractReplyText(row: Record<string, unknown>, postData: Record<string, unknown> | null) {
  const direct = readString(row.content)
    ?? readString(row.message)
    ?? readString(row.text)
    ?? readString(row.body);
  if (direct) return direct;

  if (!postData) return null;

  const nestedContent = postData.content;
  if (typeof nestedContent === "string") {
    return readString(nestedContent);
  }
  if (nestedContent && typeof nestedContent === "object" && !Array.isArray(nestedContent)) {
    const nested = nestedContent as Record<string, unknown>;
    return readString(nested.text)
      ?? readString(nested.content)
      ?? readString(nested.markdown)
      ?? readString(nested.plaintext);
  }

  return readString(postData.message)
    ?? readString(postData.text)
    ?? readString(postData.body);
}

async function fetchText(url: string, init: RequestInit, timeoutSec = DEFAULT_CLICKUP_TIMEOUT_SEC) {
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
): Promise<{ status: "ok"; payload: unknown } | { status: "failed"; detail: string }> {
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

function extractReplyRows(payload: unknown): ClickUpChatMessageReply[] {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const rows = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(record?.replies)
      ? record.replies
      : Array.isArray(payload)
        ? payload
        : [];

  return rows.map((entry) => {
    const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const postData = row.post_data && typeof row.post_data === "object"
      ? row.post_data as Record<string, unknown>
      : row.postData && typeof row.postData === "object"
        ? row.postData as Record<string, unknown>
        : null;
    const links = row.links && typeof row.links === "object" ? row.links as Record<string, unknown> : null;
    return {
      id: readString(row.id),
      messageId:
        readString(row.message_id)
        ?? readString(row.messageId)
        ?? (postData ? readString(postData.message_id) : null)
        ?? (postData ? readString(postData.messageId) : null),
      reactionsUrl: links ? readString(links.reactions) : null,
      content: extractReplyText(row, postData),
    };
  });
}

function extractReactionRows(payload: unknown): ClickUpChatMessageReaction[] {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const rows = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(record?.reactions)
      ? record.reactions
      : Array.isArray(payload)
        ? payload
        : [];

  const flattened: ClickUpChatMessageReaction[] = [];
  for (const entry of rows) {
    const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const directName = normalizeReactionName(row.name ?? row.reaction ?? row.emoji ?? row.emoji_name);
    if (directName) {
      const count = typeof row.count === "number"
        ? row.count
        : typeof row.total === "number"
          ? row.total
          : Array.isArray(row.users)
            ? row.users.length
            : 1;
      flattened.push({ name: directName, count: Math.max(0, count) });
      continue;
    }
    const emoji = row.emoji && typeof row.emoji === "object" ? row.emoji as Record<string, unknown> : null;
    const nestedName = normalizeReactionName(emoji?.name ?? emoji?.shortcode ?? emoji?.alias);
    if (nestedName) {
      flattened.push({
        name: nestedName,
        count: Array.isArray(row.users) ? row.users.length : 1,
      });
    }
  }
  return flattened;
}

function renderClickUpMessage(notification: AwaitingHumanNotificationPayload) {
  const title = truncateText(notification.title, MAX_TITLE_LENGTH);
  const bodySection = formatBodySection(notification.body);
  const lines = [`**${title}**`];

  if (bodySection) {
    lines.push("");
    lines.push(bodySection);
  } else if (notification.summary.trim().length > 0) {
    lines.push("");
    lines.push(truncateText(notification.summary, MAX_SUMMARY_LENGTH));
  }

  if (notification.reviewFile) {
    lines.push("");
    lines.push(`Review file: ${notification.reviewFile.filename}`);
    lines.push(`Bizbox deliverable: ${notification.reviewFile.deliverableUrl}`);
    if (notification.reviewFile.clickupTaskUrl) {
      lines.push(`ClickUp review task: ${notification.reviewFile.clickupTaskUrl}`);
      if (notification.reviewFile.clickupAttachmentId) {
        lines.push("Review file attached on the ClickUp task.");
      }
    }
  }

  if (!bodySection && notification.cta.trim().length > 0) {
    lines.push("");
    lines.push(truncateText(notification.cta, 180));
  }

  return trimTotal(lines.join("\n"), CLICKUP_CHAT_MESSAGE_MAX_CHARS);
}

function renderClickUpTransportTestMessage(notification: ClickUpTransportTestNotification) {
  const title = truncateText(notification.title, MAX_TITLE_LENGTH);
  const summary = truncateText(notification.summary, MAX_SUMMARY_LENGTH);
  const bodySection = formatBodySection(notification.body);
  const lines = [
    `**${title}**`,
    "",
    summary,
  ];

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
    return { status: "skipped", channel: "clickup-chat", detail: "missing-credential: CLICKUP_PERSONAL_TOKEN" };
  }
  if (!config.workspaceId) {
    return { status: "skipped", channel: "clickup-chat", detail: "missing-target: CLICKUP_WORKSPACE_ID" };
  }

  try {
    const channelId = config.channelId.trim();
    if (!channelId) {
      return {
        status: "skipped",
        channel: "clickup-chat",
        detail: "missing-target: CLICKUP_AWAITING_HUMAN_CHANNEL_ID (or CLICKUP_ENGINEERING_CHANNEL_ID)",
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

    const payload = response.text.trim().length > 0
      ? JSON.parse(response.text) as { id?: unknown; data?: { id?: unknown } }
      : {};
    const externalId = typeof payload.data?.id === "string"
      ? payload.data.id
      : typeof payload.id === "string"
        ? payload.id
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
  return postClickUpChatMessage(renderClickUpMessage(input.notification), overrides);
}

export async function sendClickUpTransportTestMessage(
  notification: ClickUpTransportTestNotification,
  overrides?: ClickUpAwaitingHumanConfigOverrides,
): Promise<AwaitingHumanNotificationResult> {
  return postClickUpChatMessage(renderClickUpTransportTestMessage(notification), overrides);
}

function parseClickUpTaskResponse(rawText: string): { taskId: string; taskUrl: string | null } {
  const payload = JSON.parse(rawText) as Record<string, unknown>;
  const taskId = readString(payload.id);
  if (!taskId) throw new Error("clickup review task response missing id");
  return {
    taskId,
    taskUrl: readString(payload.url),
  };
}

function findFirstAttachmentLike(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstAttachmentLike(item);
      if (found) return found;
    }
    return null;
  }
  const row = value as Record<string, unknown>;
  if (readString(row.id) || readString(row.url)) return row;
  for (const child of Object.values(row)) {
    const found = findFirstAttachmentLike(child);
    if (found) return found;
  }
  return null;
}

export async function createClickUpReviewTask(config: ClickUpAwaitingHumanConfigOverrides, notification: AwaitingHumanNotificationPayload) {
  const resolved = readClickUpChatConfig(config);
  if (!resolved.reviewListId) {
    throw new Error("missing-target: CLICKUP_AWAITING_HUMAN_REVIEW_LIST_ID");
  }
  const body = renderClickUpMessage(notification);
  const response = await fetchText(
    `https://api.clickup.com/api/v2/list/${encodeURIComponent(resolved.reviewListId)}/task`,
    {
      method: "POST",
      headers: {
        Authorization: resolved.personalToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: truncateText(notification.title, 120),
        description: body,
        notify_all: false,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`clickup review task create failed:${response.status}:${truncateText(response.text, 240)}`);
  }
  return parseClickUpTaskResponse(response.text);
}

export async function uploadClickUpReviewFile(
  config: ClickUpAwaitingHumanConfigOverrides,
  taskId: string,
  reviewFile: AwaitingHumanNotificationReviewFile,
  body: Buffer,
) {
  const resolved = readClickUpChatConfig(config);
  const form = new FormData();
  form.append(
    CLICKUP_ATTACHMENT_FILE_FIELD,
    new Blob([new Uint8Array(body)], { type: reviewFile.contentType }),
    reviewFile.filename,
  );
  form.append("filename", reviewFile.filename);
  const response = await fetchText(
    `https://api.clickup.com/api/v3/workspaces/${encodeURIComponent(resolved.workspaceId)}/attachments/${encodeURIComponent(taskId)}/attachments`,
    {
      method: "POST",
      headers: {
        Authorization: resolved.personalToken,
      },
      body: form,
    },
  );
  if (!response.ok) {
    throw new Error(`clickup review file upload failed:${response.status}:${truncateText(response.text, 240)}`);
  }
  const payload = response.text.trim().length > 0 ? JSON.parse(response.text) : {};
  const attachment = findFirstAttachmentLike(payload);
  const attachmentId = readString(attachment?.id);
  if (!attachmentId) {
    throw new Error(`clickup review file upload response missing attachment id:${truncateText(response.text, 240)}`);
  }
  return {
    attachmentId,
    attachmentUrl: readString(attachment?.url) ?? readString(attachment?.url_w_query),
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
    replies: extractReplyRows(response.payload),
  };
}

export async function getClickUpChatMessageReactions(
  messageId: string,
  overrides?: ClickUpAwaitingHumanConfigOverrides,
): Promise<{
  status: ClickUpApiStatus;
  detail: string;
  reactions: ClickUpChatMessageReaction[];
}> {
  const config = readClickUpChatConfig(overrides);
  if (!config.personalToken) {
    return {
      status: "skipped",
      detail: "missing-credential: CLICKUP_PERSONAL_TOKEN",
      reactions: [],
    };
  }
  if (!config.workspaceId) {
    return {
      status: "skipped",
      detail: "missing-target: CLICKUP_WORKSPACE_ID",
      reactions: [],
    };
  }

  const response = await fetchClickUpJson(
    config,
    `/chat/messages/${encodeURIComponent(messageId)}/reactions`,
  );
  if (response.status === "failed") {
    return { status: "failed", detail: response.detail, reactions: [] };
  }

  return {
    status: "sent",
    detail: "ok",
    reactions: extractReactionRows(response.payload),
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

  if (response.status === 400 && /already exists/i.test(response.text)) {
    return {
      status: "sent",
      detail: "already-exists",
    };
  }

  return {
    status: "failed",
    detail: `http-error:${response.status}:${truncateText(response.text, 240)}`,
  };
}

export async function addClickUpChatMessageReactionByUrl(
  reactionUrl: string,
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
  const reactionName = reaction.trim();
  if (!reactionName) {
    return {
      status: "skipped",
      detail: "missing-target: reaction",
    };
  }

  try {
    return await postClickUpChatMessageReaction(reactionUrl, reactionName, config.personalToken);
  } catch (error) {
    return {
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
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

    if (response.ok || response.status === 404) {
      return {
        status: "sent",
        detail: response.ok ? "deleted" : "not-found",
      };
    }

    return {
      status: "failed",
      detail: `http-error:${response.status}:${truncateText(response.text, 240)}`,
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
): Promise<{ status: ClickUpApiStatus; detail: string; events: ClickUpAwaitingHumanBridgeEvent[] }> {
  const config = readClickUpChatConfig(overrides);
  if (!config.personalToken) {
    return { status: "skipped", detail: "missing-credential: CLICKUP_PERSONAL_TOKEN", events: [] };
  }
  if (!config.workspaceId) {
    return { status: "skipped", detail: "missing-target: CLICKUP_WORKSPACE_ID", events: [] };
  }

  const repliesResult = await getClickUpChatMessageReplies(messageId, overrides);
  if (repliesResult.status === "failed" || repliesResult.status === "skipped") {
    return { status: repliesResult.status, detail: repliesResult.detail, events: [] };
  }

  const events: ClickUpAwaitingHumanBridgeEvent[] = [];
  for (const reply of repliesResult.replies) {
    const replyId = readString(reply.id) ?? readString(reply.messageId);
    const replyBody = readString(reply.content);
    if (!replyId || !replyBody) continue;
    events.push({
      kind: "reply",
      externalEventId: replyId,
      externalMessageId: messageId,
      body: replyBody,
      metadata: {
        clickupReplyId: replyId,
        ...(reply.reactionsUrl ? { clickupReplyReactionsUrl: reply.reactionsUrl } : {}),
      },
    });
  }

  if (events.length > 0) {
    return { status: "sent", detail: "replies-detected", events };
  }

  return { status: "sent", detail: "no-replies", events: [] };
}

export {
  readCompanyClickUpOverrides,
  readClickUpChatConfig,
};
