const CLICKUP_CHAT_MESSAGE_MAX_CHARS = 1_800;
const DEFAULT_CLICKUP_CHANNEL_NAME = "engineering";
const MAX_TITLE_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 280;
const MAX_DETAIL_BULLETS = 5;
const MAX_BULLET_LENGTH = 220;
const CLICKUP_CHANNEL_LOOKUP_PAGE_SIZE = 100;
const DEFAULT_CLICKUP_APPROVAL_POSITIVE_REACTIONS = ["thumbsup", "white_check_mark", "heavy_check_mark"] as const;
const DEFAULT_CLICKUP_APPROVAL_POSITIVE_REPLY_KEYWORDS = [
  "approve",
  "approved",
  "approving",
  "yes",
  "ok",
  "okay",
  "ship it",
  "lgtm",
  "looks good",
  "go ahead",
  "+1",
] as const;
const NEGATED_APPROVAL_PREFIXES = [
  "not",
  "no",
  "never",
  "nope",
  "don t",
  "dont",
  "can t",
  "cant",
  "won t",
  "wont",
] as const;

export interface AwaitingHumanNotificationPayload {
  title: string;
  summary: string;
  link: string;
  cta: string;
  labels: string[];
  kind?: string | null;
  audience?: string | null;
  body?: string | null;
}

export interface SendAwaitingHumanNotificationInput {
  companyId: string;
  issueId: string;
  handoffKind: "request_confirmation" | "ask_user_questions" | "human_owned_blocker";
  notification: AwaitingHumanNotificationPayload;
}

export interface AwaitingHumanNotificationResult {
  status: "sent" | "skipped" | "failed";
  channel: "clickup-chat";
  detail: string;
  externalId?: string | null;
}

type ClickUpChatConfig = {
  personalToken: string;
  workspaceId: string;
  channelId: string;
  channelName: string;
  approvalPositiveReactions: string[];
  approvalPositiveReplyKeywords: string[];
};

type ClickUpApiStatus = "sent" | "skipped" | "failed" | "no_approval";

export interface ClickUpChatMessageReply {
  id: string | null;
  content: string | null;
}

export interface ClickUpChatMessageReaction {
  name: string;
  count: number;
}

export interface ClickUpAwaitingHumanApprovalResult {
  status: ClickUpApiStatus | "approved" | "forward_reply";
  detail: string;
  resolutionSource?: "clickup_reply" | "clickup_reaction";
  clickupReaction?: string | null;
  replies?: ClickUpChatMessageReply[];
}

function truncateText(value: string, maxLength: number) {
  const compact = compactWhitespace(value);
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function compactWhitespace(value: string) {
  return value.split(/\s+/).filter(Boolean).join(" ");
}

function trimTotal(value: string, limit: number) {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function extractBullets(body: string | null | undefined) {
  if (!body) return [] as string[];
  const bullets: string[] = [];
  for (const rawLine of body.split("\n")) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("- ") || line.startsWith("* ")) {
      line = line.slice(2).trim();
    }
    bullets.push(truncateText(line, MAX_BULLET_LENGTH));
    if (bullets.length >= MAX_DETAIL_BULLETS) break;
  }
  return bullets;
}

function readClickUpChatConfig(): ClickUpChatConfig {
  const positiveReactions = (process.env.CLICKUP_APPROVAL_POSITIVE_REACTIONS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const positiveReplyKeywords = (process.env.CLICKUP_APPROVAL_POSITIVE_REPLY_KEYWORDS ?? "")
    .split(",")
    .map((value) => compactWhitespace(value.trim().toLowerCase()))
    .filter(Boolean);
  return {
    personalToken: process.env.CLICKUP_PERSONAL_TOKEN?.trim() ?? "",
    workspaceId: process.env.CLICKUP_WORKSPACE_ID?.trim() ?? "",
    channelId: process.env.CLICKUP_ENGINEERING_CHANNEL_ID?.trim() ?? "",
    channelName: process.env.CLICKUP_ENGINEERING_CHANNEL_NAME?.trim() || DEFAULT_CLICKUP_CHANNEL_NAME,
    approvalPositiveReactions: positiveReactions.length > 0
      ? [...new Set(positiveReactions)]
      : [...DEFAULT_CLICKUP_APPROVAL_POSITIVE_REACTIONS],
    approvalPositiveReplyKeywords: positiveReplyKeywords.length > 0
      ? [...new Set(positiveReplyKeywords)]
      : [...DEFAULT_CLICKUP_APPROVAL_POSITIVE_REPLY_KEYWORDS],
  };
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeReactionName(value: unknown) {
  const raw = readString(value);
  if (!raw) return null;
  return raw.toLowerCase().replaceAll(" ", "_");
}

function normalizeReplyContent(value: string | null | undefined) {
  if (!value) return "";
  return compactWhitespace(value.toLowerCase().replace(/[^\p{L}\p{N}\s+]+/gu, " "));
}

function hasNegatedApprovalPrefix(content: string, keywordStart: number) {
  const prefix = content.slice(0, keywordStart).trimEnd();
  if (!prefix) return false;
  return NEGATED_APPROVAL_PREFIXES.some((negation) => prefix.endsWith(negation));
}

function replySignalsApproval(reply: ClickUpChatMessageReply, config: ClickUpChatConfig) {
  const content = normalizeReplyContent(reply.content);
  if (!content) return false;
  return config.approvalPositiveReplyKeywords.some((keyword) => {
    if (content === keyword) return true;
    const searchToken = ` ${keyword} `;
    const includePositions: number[] = [];
    let searchFrom = 0;
    while (true) {
      const index = content.indexOf(searchToken, searchFrom);
      if (index === -1) break;
      includePositions.push(index + 1);
      searchFrom = index + 1;
    }

    const matchPositions = [
      content.startsWith(`${keyword} `) ? 0 : -1,
      ...includePositions,
      content.endsWith(` ${keyword}`) ? content.length - keyword.length : -1,
    ].filter((position) => position >= 0);

    return matchPositions.some((position) => !hasNegatedApprovalPrefix(content, position));
  });
}

async function fetchClickUpJson(
  config: ClickUpChatConfig,
  path: string,
): Promise<{ status: "ok"; payload: unknown } | { status: "failed"; detail: string }> {
  try {
    const response = await fetch(
      `https://api.clickup.com/api/v3/workspaces/${encodeURIComponent(config.workspaceId)}${path}`,
      {
        headers: {
          Authorization: config.personalToken,
        },
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
    return {
      id: readString(row.id),
      content: readString(row.content) ?? readString(row.message) ?? readString(row.text),
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
  const summary = truncateText(notification.summary, MAX_SUMMARY_LENGTH);
  const bullets = extractBullets(notification.body);
  const contextLine = [
    notification.kind?.trim() || null,
    notification.audience?.trim() || null,
  ].filter((value): value is string => Boolean(value)).join(" · ");
  const lines = [
    `**${title}**`,
    "",
    summary,
  ];

  if (contextLine) {
    lines.push("");
    lines.push(`Context: ${contextLine}`);
  }

  if (notification.labels.length > 0) {
    lines.push(`Labels: ${notification.labels.join(", ")}`);
  }

  if (bullets.length > 0) {
    lines.push("");
    lines.push("Key points:");
    lines.push(...bullets.map((bullet) => `- ${bullet}`));
  }

  lines.push("");
  lines.push(`Source: ${notification.link.trim()}`);

  if (notification.cta.trim().length > 0) {
    lines.push(`Next step: ${truncateText(notification.cta, 180)}`);
  }

  return trimTotal(lines.join("\n"), CLICKUP_CHAT_MESSAGE_MAX_CHARS);
}

async function resolveClickUpChannelId(config: ClickUpChatConfig): Promise<string | null> {
  if (config.channelId) return config.channelId;
  if (!config.personalToken || !config.workspaceId || !config.channelName) return null;

  const normalizedTarget = config.channelName.trim().toLowerCase();
  for (let page = 1; page <= 100; page += 1) {
    const url = new URL(
      `https://api.clickup.com/api/v3/workspaces/${encodeURIComponent(config.workspaceId)}/chat/channels`,
    );
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(CLICKUP_CHANNEL_LOOKUP_PAGE_SIZE));

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: config.personalToken,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`channel-lookup-failed:${response.status}:${truncateText(body, 240)}`);
    }

    const payload = await response.json() as { data?: Array<{ id?: unknown; name?: unknown }> };
    const channels = payload.data ?? [];
    for (const channel of channels) {
      const name = typeof channel.name === "string" ? channel.name.trim().toLowerCase() : "";
      if (name === normalizedTarget) {
        const id = typeof channel.id === "string" ? channel.id.trim() : String(channel.id ?? "").trim();
        if (id) return id;
      }
    }

    if (channels.length < CLICKUP_CHANNEL_LOOKUP_PAGE_SIZE) {
      return null;
    }
  }

  return null;
}

export async function sendAwaitingHumanNotification(
  input: SendAwaitingHumanNotificationInput,
): Promise<AwaitingHumanNotificationResult> {
  const config = readClickUpChatConfig();
  if (!config.personalToken) {
    return { status: "skipped", channel: "clickup-chat", detail: "missing-credential: CLICKUP_PERSONAL_TOKEN" };
  }
  if (!config.workspaceId) {
    return { status: "skipped", channel: "clickup-chat", detail: "missing-target: CLICKUP_WORKSPACE_ID" };
  }

  try {
    const channelId = await resolveClickUpChannelId(config);
    if (!channelId) {
      return {
        status: "skipped",
        channel: "clickup-chat",
        detail: `missing-target: CLICKUP_ENGINEERING_CHANNEL_ID or ${config.channelName}`,
      };
    }

    const response = await fetch(
      `https://api.clickup.com/api/v3/workspaces/${encodeURIComponent(config.workspaceId)}/chat/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: config.personalToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "message",
          content: renderClickUpMessage(input.notification),
          content_format: "text/md",
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      return {
        status: "failed",
        channel: "clickup-chat",
        detail: `http-error:${response.status}:${truncateText(body, 240)}`,
      };
    }

    const payload = await response.json() as { id?: unknown; data?: { id?: unknown } };
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

export async function getClickUpChatMessageReplies(messageId: string): Promise<{
  status: ClickUpApiStatus;
  detail: string;
  replies: ClickUpChatMessageReply[];
}> {
  const config = readClickUpChatConfig();
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

export async function getClickUpChatMessageReactions(messageId: string): Promise<{
  status: ClickUpApiStatus;
  detail: string;
  reactions: ClickUpChatMessageReaction[];
}> {
  const config = readClickUpChatConfig();
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

export async function detectClickUpAwaitingHumanApproval(
  messageId: string,
): Promise<ClickUpAwaitingHumanApprovalResult> {
  const config = readClickUpChatConfig();
  if (!config.personalToken) {
    return { status: "skipped", detail: "missing-credential: CLICKUP_PERSONAL_TOKEN" };
  }
  if (!config.workspaceId) {
    return { status: "skipped", detail: "missing-target: CLICKUP_WORKSPACE_ID" };
  }

  const repliesResult = await getClickUpChatMessageReplies(messageId);
  if (repliesResult.status === "skipped") {
    return {
      status: repliesResult.status,
      detail: repliesResult.detail,
    };
  }
  const availableReplies = repliesResult.status === "sent" ? repliesResult.replies : [];
  const approvingReply = availableReplies.find((reply) => replySignalsApproval(reply, config));
  if (approvingReply) {
    return {
      status: "approved",
      detail: "positive-reply-detected",
      resolutionSource: "clickup_reply",
    };
  }
  const forwardableReplies = availableReplies.filter((reply) => normalizeReplyContent(reply.content).length > 0);

  const reactionsResult = await getClickUpChatMessageReactions(messageId);
  if (reactionsResult.status === "failed" || reactionsResult.status === "skipped") {
    if (forwardableReplies.length > 0) {
      return {
        status: "forward_reply",
        detail: "non-approval-reply-detected",
        resolutionSource: "clickup_reply",
        replies: forwardableReplies,
      };
    }
    if (repliesResult.status === "failed") {
      return {
        status: repliesResult.status,
        detail: repliesResult.detail,
      };
    }
    return {
      status: reactionsResult.status,
      detail: reactionsResult.detail,
    };
  }

  const positiveSet = new Set(config.approvalPositiveReactions);
  const matchingReaction = reactionsResult.reactions.find((reaction) =>
    reaction.count > 0 && positiveSet.has(reaction.name)
  );
  if (matchingReaction) {
    return {
      status: "approved",
      detail: "positive-reaction-detected",
      resolutionSource: "clickup_reaction",
      clickupReaction: matchingReaction.name,
    };
  }
  if (forwardableReplies.length > 0) {
    return {
      status: "forward_reply",
      detail: "non-approval-reply-detected",
      resolutionSource: "clickup_reply",
      replies: forwardableReplies,
    };
  }
  if (repliesResult.status === "failed") {
    return {
      status: repliesResult.status,
      detail: repliesResult.detail,
    };
  }

  return {
    status: "no_approval",
    detail: "no-approval-signal",
  };
}
