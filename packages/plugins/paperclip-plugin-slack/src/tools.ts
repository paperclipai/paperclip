/**
 * Direct Slack-API tool handlers (Task 9).
 *
 * Each handler reads the bot (or user) token at call time via
 * `ctx.secrets.resolve(...)`, calls a single helper from `slack-api.ts`, then
 * maps the raw Slack response onto a slimmed `{ output: ... } | { error }`
 * shape so agents see only the relevant fields. Success/error metrics are
 * emitted on every call under `slack.tool.<name>.{success|error}`.
 *
 * The 11 tools registered here are intended for direct agent invocation —
 * unlike the orchestration handlers (escalate, handoff, etc.) which are
 * higher-level workflows wired in `worker.ts`.
 */
import type {
  PluginContext,
  PluginToolDeclaration,
  ToolResult,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";
import * as slack from "./slack-api.js";
import {
  SLACK_POST_MESSAGE_DECLARATION,
  SLACK_UPDATE_MESSAGE_DECLARATION,
  SLACK_REACT_DECLARATION,
  SLACK_SEND_DM_DECLARATION,
  SLACK_LIST_CHANNELS_DECLARATION,
  SLACK_JOIN_CHANNEL_DECLARATION,
  SLACK_LIST_USERS_DECLARATION,
  SLACK_GET_USER_INFO_DECLARATION,
  SLACK_GET_THREAD_REPLIES_DECLARATION,
  SLACK_SEARCH_MESSAGES_DECLARATION,
  SLACK_UPLOAD_FILE_DECLARATION,
} from "./tool-declarations.js";

export interface RegisterToolsOptions {
  /** Secret reference to the Slack bot token (xoxb-…). Required. */
  slackTokenRef: string;
  /**
   * Optional secret reference to a Slack user token (xoxp-…). Required only
   * for `slack_search_messages` (bot tokens cannot use the search API). When
   * unset, the search handler still registers but returns a guidance error
   * at call time.
   */
  slackUserTokenRef?: string;
}

/**
 * Internal handler return shape. The host-side `ToolResult` only carries
 * `content`/`data`/`error`; we expose a richer `output` field for the
 * direct-callable Slack tools and cast at the registration boundary.
 */
type SlackToolResult = { output: unknown } | { error: string };

type SlackToolHandler = (
  params: unknown,
  runCtx: ToolRunContext,
) => Promise<SlackToolResult>;

/**
 * Small helper to collapse the boilerplate `ctx.tools.register(name, decl, fn)`
 * call signature when the handler matches the declaration. Use this for both
 * the existing orchestration tools and the new Slack-API tools so the wiring
 * is uniform.
 */
export function registerTool(
  ctx: PluginContext,
  decl: PluginToolDeclaration,
  fn: (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>,
): void {
  ctx.tools.register(decl.name, decl, fn);
}

function asToolResult(result: SlackToolResult): ToolResult {
  // The SDK's ToolResult interface is { content?, data?, error? }. Per the
  // existing 8 orchestration handlers in worker.ts, success results return
  // `content: JSON.stringify(...)` so agents see the response as readable
  // text. We mirror that pattern here and also expose the raw structured
  // payload as `data` so any consumer that wants typed access can use it.
  if ("error" in result) return { error: result.error };
  return {
    content: JSON.stringify(result.output),
    data: result.output,
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function pickChannel(
  raw: unknown,
): { id?: string; name?: string; is_private?: boolean; is_archived?: boolean } {
  const c = (raw ?? {}) as Record<string, unknown>;
  return {
    id: asString(c.id),
    name: asString(c.name),
    is_private:
      typeof c.is_private === "boolean" ? c.is_private : undefined,
    is_archived:
      typeof c.is_archived === "boolean" ? c.is_archived : undefined,
  };
}

function pickUser(raw: unknown): {
  id?: string;
  name?: string;
  real_name?: string;
  email?: string;
  is_bot?: boolean;
  deleted?: boolean;
} {
  const u = (raw ?? {}) as Record<string, unknown>;
  const profile = (u.profile ?? {}) as Record<string, unknown>;
  return {
    id: asString(u.id),
    name: asString(u.name),
    real_name: asString(u.real_name),
    email: asString(profile.email),
    is_bot: typeof u.is_bot === "boolean" ? u.is_bot : undefined,
    deleted: typeof u.deleted === "boolean" ? u.deleted : undefined,
  };
}

function nextCursor(meta: unknown): string {
  const m = (meta ?? {}) as Record<string, unknown>;
  return asString(m.next_cursor) ?? "";
}

export function registerTools(
  ctx: PluginContext,
  opts: RegisterToolsOptions,
): void {
  const readBotToken = () => ctx.secrets.resolve(opts.slackTokenRef);
  const readUserToken = (): Promise<string | null> =>
    opts.slackUserTokenRef
      ? ctx.secrets.resolve(opts.slackUserTokenRef)
      : Promise.resolve(null);

  const wrap = (
    name: string,
    decl: PluginToolDeclaration,
    handler: SlackToolHandler,
  ) => {
    ctx.tools.register(decl.name, decl, async (params, runCtx) => {
      try {
        const result = await handler(params, runCtx);
        if ("error" in result) {
          await ctx.metrics.write(`slack.tool.${name}.error`, 1);
        } else {
          await ctx.metrics.write(`slack.tool.${name}.success`, 1);
        }
        return asToolResult(result);
      } catch (err) {
        await ctx.metrics.write(`slack.tool.${name}.error`, 1);
        const message = err instanceof Error ? err.message : String(err);
        return asToolResult({ error: message });
      }
    });
  };

  // --- slack_post_message --------------------------------------------------
  wrap("slack_post_message", SLACK_POST_MESSAGE_DECLARATION, async (params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const channel = String(p.channel ?? "");
    const text = asString(p.text) ?? "";
    const blocks = Array.isArray(p.blocks)
      ? (p.blocks as Array<Record<string, unknown>>)
      : undefined;
    const threadTs = asString(p.thread_ts);
    const token = await readBotToken();
    const result = await slack.postMessage(
      ctx,
      token,
      channel,
      { text, blocks },
      threadTs ? { threadTs } : undefined,
    );
    if (!result.ok) {
      return { error: result.error ?? "slack_post_message failed" };
    }
    return { output: { ts: result.ts, channel } };
  });

  // --- slack_update_message ------------------------------------------------
  wrap(
    "slack_update_message",
    SLACK_UPDATE_MESSAGE_DECLARATION,
    async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const channel = String(p.channel ?? "");
      const ts = String(p.ts ?? "");
      const text = asString(p.text) ?? "";
      const blocks = Array.isArray(p.blocks)
        ? (p.blocks as Array<Record<string, unknown>>)
        : undefined;
      const token = await readBotToken();
      const result = await slack.updateMessage(ctx, token, channel, ts, {
        text,
        blocks,
      });
      if (!result.ok) {
        return { error: result.error ?? "slack_update_message failed" };
      }
      return { output: { ts, channel } };
    },
  );

  // --- slack_react ---------------------------------------------------------
  wrap("slack_react", SLACK_REACT_DECLARATION, async (params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const channel = String(p.channel ?? "");
    const timestamp = String(p.timestamp ?? "");
    const name = String(p.name ?? "");
    const token = await readBotToken();
    const result = await slack.reactionsAdd(
      ctx,
      token,
      channel,
      timestamp,
      name,
    );
    if (!result.ok) {
      return { error: result.error ?? "slack_react failed" };
    }
    return { output: { ok: true } };
  });

  // --- slack_send_dm -------------------------------------------------------
  wrap("slack_send_dm", SLACK_SEND_DM_DECLARATION, async (params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const user = String(p.user ?? "");
    const text = asString(p.text) ?? "";
    const blocks = Array.isArray(p.blocks)
      ? (p.blocks as Array<Record<string, unknown>>)
      : undefined;
    const token = await readBotToken();
    // `conversations.open` only accepts user IDs (or a comma list of them).
    // If the agent passed an email, resolve it via `users.lookupByEmail` first
    // so the declaration's "user ID OR email" contract holds.
    let userId = user;
    if (user.includes("@")) {
      const lookup = await slack.usersLookupByEmail(ctx, token, user);
      const looked = (lookup.user as { id?: string } | undefined) ?? undefined;
      if (!lookup.ok || !looked?.id) {
        return { error: lookup.error ?? `slack_send_dm: cannot resolve email ${user}` };
      }
      userId = looked.id;
    }
    const opened = await slack.conversationsOpen(ctx, token, userId);
    if (!opened.ok || !opened.channel?.id) {
      return { error: opened.error ?? "slack_send_dm failed" };
    }
    const dmChannel = opened.channel.id;
    const result = await slack.postMessage(ctx, token, dmChannel, {
      text,
      blocks,
    });
    if (!result.ok) {
      return { error: result.error ?? "slack_send_dm failed" };
    }
    return { output: { ts: result.ts, channel: dmChannel } };
  });

  // --- slack_list_channels -------------------------------------------------
  wrap(
    "slack_list_channels",
    SLACK_LIST_CHANNELS_DECLARATION,
    async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const types = asString(p.types);
      const cursor = asString(p.cursor);
      const limit = asNumber(p.limit);
      const filter = asString(p.name_filter)?.toLowerCase();
      const token = await readBotToken();
      const result = await slack.conversationsList(ctx, token, {
        types,
        cursor,
        limit,
      });
      if (!result.ok) {
        return { error: result.error ?? "slack_list_channels failed" };
      }
      const raw = Array.isArray(result.channels) ? result.channels : [];
      let slimmed = raw.map((c) => pickChannel(c));
      if (filter) {
        slimmed = slimmed.filter((c) =>
          (c.name ?? "").toLowerCase().includes(filter),
        );
      }
      return {
        output: {
          channels: slimmed,
          next_cursor: nextCursor(result.response_metadata),
        },
      };
    },
  );

  // --- slack_join_channel --------------------------------------------------
  wrap("slack_join_channel", SLACK_JOIN_CHANNEL_DECLARATION, async (params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const channel = String(p.channel ?? "");
    const token = await readBotToken();
    const result = await slack.conversationsJoin(ctx, token, channel);
    if (!result.ok) {
      return { error: result.error ?? "slack_join_channel failed" };
    }
    const ch = pickChannel(result.channel);
    return { output: { channel: { id: ch.id, name: ch.name } } };
  });

  // --- slack_list_users ----------------------------------------------------
  wrap("slack_list_users", SLACK_LIST_USERS_DECLARATION, async (params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const cursor = asString(p.cursor);
    const limit = asNumber(p.limit);
    const token = await readBotToken();
    const result = await slack.usersList(ctx, token, { cursor, limit });
    if (!result.ok) {
      return { error: result.error ?? "slack_list_users failed" };
    }
    const raw = Array.isArray(result.members) ? result.members : [];
    const members = raw
      .map((m) => pickUser(m))
      .filter((m) => !m.is_bot && !m.deleted);
    return {
      output: {
        members,
        next_cursor: nextCursor(result.response_metadata),
      },
    };
  });

  // --- slack_get_user_info -------------------------------------------------
  wrap(
    "slack_get_user_info",
    SLACK_GET_USER_INFO_DECLARATION,
    async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const user = String(p.user ?? "");
      const token = await readBotToken();
      const lookup = user.includes("@")
        ? await slack.usersLookupByEmail(ctx, token, user)
        : await slack.usersInfo(ctx, token, user);
      if (!lookup.ok) {
        return { error: lookup.error ?? "slack_get_user_info failed" };
      }
      return { output: pickUser(lookup.user) };
    },
  );

  // --- slack_get_thread_replies --------------------------------------------
  wrap(
    "slack_get_thread_replies",
    SLACK_GET_THREAD_REPLIES_DECLARATION,
    async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const channel = String(p.channel ?? "");
      const threadTs = String(p.thread_ts ?? "");
      const cursor = asString(p.cursor);
      const limit = asNumber(p.limit);
      const token = await readBotToken();
      const result = await slack.conversationsReplies(
        ctx,
        token,
        channel,
        threadTs,
        { cursor, limit },
      );
      if (!result.ok) {
        return { error: result.error ?? "slack_get_thread_replies failed" };
      }
      const raw = Array.isArray(result.messages) ? result.messages : [];
      const messages = raw.map((m) => {
        const r = (m ?? {}) as Record<string, unknown>;
        return {
          user: asString(r.user),
          ts: asString(r.ts),
          text: asString(r.text),
          thread_ts: asString(r.thread_ts),
        };
      });
      return {
        output: {
          messages,
          next_cursor: nextCursor(result.response_metadata),
        },
      };
    },
  );

  // --- slack_search_messages ----------------------------------------------
  wrap(
    "slack_search_messages",
    SLACK_SEARCH_MESSAGES_DECLARATION,
    async (params) => {
      const userToken = await readUserToken();
      if (!userToken) {
        return {
          error:
            "slack_search_messages requires a user token (xoxp-). Configure slackUserTokenRef in plugin settings.",
        };
      }
      const p = (params ?? {}) as Record<string, unknown>;
      const query = String(p.query ?? "");
      const count = asNumber(p.count);
      const sort =
        p.sort === "score" || p.sort === "timestamp"
          ? (p.sort as "score" | "timestamp")
          : undefined;
      const result = await slack.searchMessages(ctx, userToken, query, {
        count,
        sort,
      });
      if (!result.ok) {
        return { error: result.error ?? "slack_search_messages failed" };
      }
      const messages = (result.messages ?? {}) as Record<string, unknown>;
      const matchesRaw = Array.isArray(messages.matches)
        ? (messages.matches as Array<Record<string, unknown>>)
        : [];
      const matches = matchesRaw.map((m) => {
        const channelRaw = m.channel;
        let channelId: string | undefined;
        if (typeof channelRaw === "string") {
          channelId = channelRaw;
        } else if (channelRaw && typeof channelRaw === "object") {
          channelId = asString((channelRaw as Record<string, unknown>).id);
        }
        return {
          ts: asString(m.ts),
          channel: channelId,
          text: asString(m.text),
          user: asString(m.user),
          permalink: asString(m.permalink),
        };
      });
      const total =
        typeof messages.total === "number" ? messages.total : matches.length;
      return { output: { matches, total } };
    },
  );

  // --- slack_upload_file ---------------------------------------------------
  wrap("slack_upload_file", SLACK_UPLOAD_FILE_DECLARATION, async (params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const channel = String(p.channel ?? "");
    const filename = String(p.filename ?? "");
    const contentBase64 = asString(p.content_base64);
    const sourceUrl = asString(p.source_url);
    const title = asString(p.title);
    if (!contentBase64 && !sourceUrl) {
      return {
        error: "slack_upload_file requires content_base64 or source_url",
      };
    }
    let bytes: Uint8Array;
    if (contentBase64) {
      bytes = Buffer.from(contentBase64, "base64");
    } else {
      const res = await ctx.http.fetch(sourceUrl as string, { method: "GET" });
      if (res.status >= 400) {
        return { error: `failed to fetch source_url (status ${res.status})` };
      }
      const buf = await res.arrayBuffer();
      bytes = new Uint8Array(buf);
    }
    const token = await readBotToken();
    const step1 = await slack.filesGetUploadURLExternal(
      ctx,
      token,
      filename,
      bytes.byteLength,
    );
    if (!step1.ok || !step1.upload_url || !step1.file_id) {
      return { error: step1.error ?? "slack_upload_file failed" };
    }
    const putRes = await ctx.http.fetch(step1.upload_url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes as unknown as BodyInit,
    });
    if (putRes.status >= 400) {
      return {
        error: `slack_upload_file PUT failed (status ${putRes.status})`,
      };
    }
    const step3 = await slack.filesCompleteUploadExternal(
      ctx,
      token,
      [{ id: step1.file_id, title: title ?? filename }],
      channel,
    );
    if (!step3.ok) {
      return { error: step3.error ?? "slack_upload_file failed" };
    }
    const filesRaw = Array.isArray(step3.files) ? step3.files : [];
    const files = filesRaw.map((f) => {
      const r = (f ?? {}) as Record<string, unknown>;
      return {
        id: asString(r.id),
        name: asString(r.name),
        permalink: asString(r.permalink),
      };
    });
    return { output: { files } };
  });
}
