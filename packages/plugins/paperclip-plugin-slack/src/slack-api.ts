import type { PluginContext } from "@paperclipai/plugin-sdk";

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  fields?: Array<{ type: string; text: string }>;
  elements?: unknown[];
  accessory?: unknown;
}

export interface SlackMessage {
  text: string;
  blocks?: Array<SlackBlock | Record<string, unknown>>;
}

type SlackCtx = Pick<PluginContext, "http" | "logger">;
type SlackHttpResponse = Awaited<ReturnType<SlackCtx["http"]["fetch"]>>;

const SLACK_API_BASE = "https://slack.com/api";
const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set<number>([429, 500, 502, 503]);

// Slack error codes that signal a configuration gap the operator was already
// warned about at Test Configuration time (see validateSlackConfig in worker.ts).
// Demote to debug at runtime to avoid log spam — the validator owns the user-
// visible signal.
const LOW_SIGNAL_SLACK_ERRORS = new Set<string>([
  "missing_scope",
  "not_in_channel",
  "channel_not_visible",
]);

function logSlackApiError(
  ctx: SlackCtx,
  message: string,
  error: string | undefined,
  meta: Record<string, unknown>,
): void {
  const payload = { ...meta, error };
  if (error && LOW_SIGNAL_SLACK_ERRORS.has(error)) {
    ctx.logger.debug(message, payload);
    return;
  }
  ctx.logger.warn(message, payload);
}

async function fetchWithRetry(
  ctx: SlackCtx,
  url: string,
  init: Parameters<PluginContext["http"]["fetch"]>[1],
): Promise<SlackHttpResponse> {
  let lastResponse: SlackHttpResponse | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      let delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
      if (lastResponse?.status === 429) {
        const retryAfter = lastResponse.headers?.get?.("Retry-After");
        if (retryAfter) delay = Math.max(Number(retryAfter) * 1000, delay);
      }
      await new Promise((r) => setTimeout(r, delay));
    }
    const response = await ctx.http.fetch(url, init);
    if (!RETRYABLE_STATUS.has(response.status)) return response;
    lastResponse = response;
    ctx.logger.warn("Retryable HTTP error", { url, status: response.status, attempt });
  }
  return lastResponse!;
}

export async function postMessage(
  ctx: SlackCtx,
  token: string,
  channelId: string,
  message: SlackMessage,
  opts?: { threadTs?: string },
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const payload: Record<string, unknown> = {
    channel: channelId,
    text: message.text,
    blocks: message.blocks,
  };
  if (opts?.threadTs) {
    payload.thread_ts = opts.threadTs;
  }
  const response = await fetchWithRetry(ctx, `${SLACK_API_BASE}/chat.postMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as { ok: boolean; ts?: string; error?: string };
  if (!body.ok) {
    logSlackApiError(ctx, "Slack API error", body.error, { channelId });
  }
  return body;
}

export async function updateMessage(
  ctx: SlackCtx,
  token: string,
  channelId: string,
  ts: string,
  message: SlackMessage,
): Promise<{ ok: boolean; error?: string }> {
  const payload: Record<string, unknown> = {
    channel: channelId,
    ts,
    text: message.text,
  };
  if (message.blocks) {
    payload.blocks = message.blocks;
  }
  const response = await fetchWithRetry(ctx, `${SLACK_API_BASE}/chat.update`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as { ok: boolean; error?: string };
  if (!body.ok) {
    logSlackApiError(ctx, "Slack chat.update failed", body.error, { channelId, ts });
  }
  return body;
}

/**
 * Open a Slack modal (`views.open`) in response to a `block_actions` interaction.
 * `triggerId` comes from the interaction payload and is valid for ~3s, so this
 * must be called promptly when handling the button click. `view` is a Block Kit
 * view object (type `modal`, with `callback_id`, `title`, `blocks`, `submit`).
 */
export async function openModal(
  ctx: SlackCtx,
  token: string,
  triggerId: string,
  view: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const response = await fetchWithRetry(ctx, `${SLACK_API_BASE}/views.open`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ trigger_id: triggerId, view }),
  });
  const body = (await response.json()) as { ok: boolean; error?: string };
  if (!body.ok) {
    logSlackApiError(ctx, "Slack views.open failed", body.error, { triggerId });
  }
  return body;
}

export async function respondToAction(
  ctx: SlackCtx,
  token: string,
  responseUrl: string,
  message: SlackMessage,
): Promise<{ ok: boolean; error?: string }> {
  const response = await fetchWithRetry(ctx, responseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replace_original: true,
      text: message.text,
      blocks: message.blocks,
    }),
  });
  const body = (await response.json()) as { ok: boolean; error?: string };
  if (!body.ok) {
    logSlackApiError(ctx, "Slack action response error", body.error, { responseUrl });
  }
  return body;
}

export async function respondEphemeral(
  ctx: SlackCtx,
  responseUrl: string,
  message: SlackMessage,
): Promise<void> {
  await fetchWithRetry(ctx, responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      response_type: "ephemeral",
      text: message.text,
      blocks: message.blocks,
    }),
  });
}

export async function getFileInfo(
  ctx: SlackCtx,
  token: string,
  fileId: string,
): Promise<{ url: string; mimetype: string; name: string } | null> {
  const response = await fetchWithRetry(ctx, `${SLACK_API_BASE}/files.info?file=${fileId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as {
    ok: boolean;
    file?: { url_private_download?: string; mimetype?: string; name?: string };
  };
  if (!body.ok || !body.file) return null;
  return {
    url: body.file.url_private_download ?? "",
    mimetype: body.file.mimetype ?? "",
    name: body.file.name ?? "",
  };
}

export async function downloadFile(
  ctx: SlackCtx,
  token: string,
  url: string,
): Promise<ArrayBuffer | null> {
  const response = await ctx.http.fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status !== 200) return null;
  return response.arrayBuffer();
}

export async function reactionsAdd(
  ctx: SlackCtx,
  token: string,
  channel: string,
  timestamp: string,
  name: string,
): Promise<{ ok: boolean; error?: string }> {
  const response = await fetchWithRetry(ctx, `${SLACK_API_BASE}/reactions.add`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, timestamp, name }),
  });
  const body = (await response.json()) as { ok: boolean; error?: string };
  if (!body.ok) {
    logSlackApiError(ctx, "Slack API error", body.error, { channel, timestamp, name });
  }
  return body;
}

export async function conversationsList(
  ctx: SlackCtx,
  token: string,
  opts?: {
    types?: string;
    cursor?: string;
    limit?: number;
    exclude_archived?: boolean;
  },
): Promise<{ ok: boolean; error?: string; channels?: unknown[]; response_metadata?: unknown }> {
  const params = new URLSearchParams();
  if (opts?.types !== undefined) params.append("types", opts.types);
  if (opts?.cursor !== undefined) params.append("cursor", opts.cursor);
  if (opts?.limit !== undefined) params.append("limit", String(opts.limit));
  if (opts?.exclude_archived !== undefined)
    params.append("exclude_archived", String(opts.exclude_archived));
  const qs = params.toString();
  const url = qs
    ? `${SLACK_API_BASE}/conversations.list?${qs}`
    : `${SLACK_API_BASE}/conversations.list`;
  const response = await fetchWithRetry(ctx, url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as {
    ok: boolean;
    error?: string;
    channels?: unknown[];
    response_metadata?: unknown;
  };
  if (!body.ok) {
    logSlackApiError(ctx, "Slack API error", body.error, { endpoint: "conversations.list" });
  }
  return body;
}

export async function conversationsReplies(
  ctx: SlackCtx,
  token: string,
  channel: string,
  ts: string,
  opts?: { cursor?: string; limit?: number },
): Promise<{ ok: boolean; error?: string; messages?: unknown[]; response_metadata?: unknown }> {
  const params = new URLSearchParams();
  params.append("channel", channel);
  params.append("ts", ts);
  if (opts?.cursor !== undefined) params.append("cursor", opts.cursor);
  if (opts?.limit !== undefined) params.append("limit", String(opts.limit));
  const url = `${SLACK_API_BASE}/conversations.replies?${params.toString()}`;
  const response = await fetchWithRetry(ctx, url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as {
    ok: boolean;
    error?: string;
    messages?: unknown[];
    response_metadata?: unknown;
  };
  if (!body.ok) {
    logSlackApiError(ctx, "Slack API error", body.error, { channel, ts });
  }
  return body;
}

export async function conversationsJoin(
  ctx: SlackCtx,
  token: string,
  channel: string,
): Promise<{ ok: boolean; error?: string; channel?: unknown }> {
  const response = await fetchWithRetry(ctx, `${SLACK_API_BASE}/conversations.join`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel }),
  });
  const body = (await response.json()) as {
    ok: boolean;
    error?: string;
    channel?: unknown;
  };
  if (!body.ok) {
    logSlackApiError(ctx, "Slack API error", body.error, { channel });
  }
  return body;
}

export async function conversationsOpen(
  ctx: SlackCtx,
  token: string,
  users: string,
): Promise<{ ok: boolean; error?: string; channel?: { id?: string } }> {
  const response = await fetchWithRetry(ctx, `${SLACK_API_BASE}/conversations.open`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ users }),
  });
  const body = (await response.json()) as {
    ok: boolean;
    error?: string;
    channel?: { id?: string };
  };
  if (!body.ok) {
    logSlackApiError(ctx, "Slack API error", body.error, { users });
  }
  return body;
}

export async function usersList(
  ctx: SlackCtx,
  token: string,
  opts?: { cursor?: string; limit?: number },
): Promise<{ ok: boolean; error?: string; members?: unknown[]; response_metadata?: unknown }> {
  const params = new URLSearchParams();
  if (opts?.cursor !== undefined) params.append("cursor", opts.cursor);
  if (opts?.limit !== undefined) params.append("limit", String(opts.limit));
  const qs = params.toString();
  const url = qs ? `${SLACK_API_BASE}/users.list?${qs}` : `${SLACK_API_BASE}/users.list`;
  const response = await fetchWithRetry(ctx, url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as {
    ok: boolean;
    error?: string;
    members?: unknown[];
    response_metadata?: unknown;
  };
  if (!body.ok) {
    logSlackApiError(ctx, "Slack API error", body.error, { endpoint: "users.list" });
  }
  return body;
}

export async function authTest(
  ctx: SlackCtx,
  token: string,
): Promise<{
  ok: boolean;
  error?: string;
  team?: string;
  team_id?: string;
  user?: string;
  user_id?: string;
  bot_id?: string;
}> {
  const response = await fetchWithRetry(ctx, `${SLACK_API_BASE}/auth.test`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as {
    ok: boolean;
    error?: string;
    team?: string;
    team_id?: string;
    user?: string;
    user_id?: string;
    bot_id?: string;
  };
  if (!body.ok) {
    logSlackApiError(ctx, "Slack API error", body.error, { endpoint: "auth.test" });
  }
  return body;
}

export async function conversationsInfo(
  ctx: SlackCtx,
  token: string,
  channel: string,
): Promise<{ ok: boolean; error?: string; channel?: { id: string; name?: string; is_archived?: boolean } }> {
  const params = new URLSearchParams({ channel });
  const response = await fetchWithRetry(
    ctx,
    `${SLACK_API_BASE}/conversations.info?${params.toString()}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  const body = (await response.json()) as {
    ok: boolean;
    error?: string;
    channel?: { id: string; name?: string; is_archived?: boolean };
  };
  if (!body.ok) {
    logSlackApiError(ctx, "Slack API error", body.error, { channel, endpoint: "conversations.info" });
  }
  return body;
}

export async function usersInfo(
  ctx: SlackCtx,
  token: string,
  user: string,
): Promise<{ ok: boolean; error?: string; user?: unknown }> {
  const params = new URLSearchParams({ user });
  const response = await fetchWithRetry(
    ctx,
    `${SLACK_API_BASE}/users.info?${params.toString()}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  const body = (await response.json()) as {
    ok: boolean;
    error?: string;
    user?: unknown;
  };
  if (!body.ok) {
    logSlackApiError(ctx, "Slack API error", body.error, { user });
  }
  return body;
}

export async function usersLookupByEmail(
  ctx: SlackCtx,
  token: string,
  email: string,
): Promise<{ ok: boolean; error?: string; user?: unknown }> {
  const params = new URLSearchParams({ email });
  const response = await fetchWithRetry(
    ctx,
    `${SLACK_API_BASE}/users.lookupByEmail?${params.toString()}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  const body = (await response.json()) as {
    ok: boolean;
    error?: string;
    user?: unknown;
  };
  if (!body.ok) {
    logSlackApiError(ctx, "Slack API error", body.error, { email });
  }
  return body;
}

export async function searchMessages(
  ctx: SlackCtx,
  userToken: string,
  query: string,
  opts?: { count?: number; sort?: "score" | "timestamp" },
): Promise<{ ok: boolean; error?: string; messages?: unknown }> {
  const params = new URLSearchParams();
  params.append("query", query);
  if (opts?.count !== undefined) params.append("count", String(opts.count));
  if (opts?.sort !== undefined) params.append("sort", opts.sort);
  const url = `${SLACK_API_BASE}/search.messages?${params.toString()}`;
  const response = await fetchWithRetry(ctx, url, {
    method: "GET",
    headers: { Authorization: `Bearer ${userToken}` },
  });
  const body = (await response.json()) as {
    ok: boolean;
    error?: string;
    messages?: unknown;
  };
  if (!body.ok) {
    logSlackApiError(ctx, "Slack API error", body.error, { endpoint: "search.messages" });
  }
  return body;
}

export async function filesGetUploadURLExternal(
  ctx: SlackCtx,
  token: string,
  filename: string,
  length: number,
): Promise<{ ok: boolean; error?: string; upload_url?: string; file_id?: string }> {
  const params = new URLSearchParams();
  params.append("filename", filename);
  params.append("length", String(length));
  const response = await fetchWithRetry(ctx, `${SLACK_API_BASE}/files.getUploadURLExternal`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const body = (await response.json()) as {
    ok: boolean;
    error?: string;
    upload_url?: string;
    file_id?: string;
  };
  if (!body.ok) {
    logSlackApiError(ctx, "Slack API error", body.error, { filename });
  }
  return body;
}

export async function filesCompleteUploadExternal(
  ctx: SlackCtx,
  token: string,
  files: Array<{ id: string; title?: string }>,
  channel?: string,
): Promise<{ ok: boolean; error?: string; files?: unknown[] }> {
  const response = await fetchWithRetry(ctx, `${SLACK_API_BASE}/files.completeUploadExternal`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      files: JSON.stringify(files),
      channels: channel,
    }),
  });
  const body = (await response.json()) as {
    ok: boolean;
    error?: string;
    files?: unknown[];
  };
  if (!body.ok) {
    logSlackApiError(ctx, "Slack API error", body.error, { channel });
  }
  return body;
}
