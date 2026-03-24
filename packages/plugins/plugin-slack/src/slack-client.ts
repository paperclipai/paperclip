import type { PluginHttpClient } from "@paperclipai/plugin-sdk";
import type { SlackBlock } from "./utils/message-format.js";

const SLACK_API = "https://slack.com/api";

// ---------------------------------------------------------------------------
// Response types (minimal)
// ---------------------------------------------------------------------------

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

interface PostMessageResponse extends SlackApiResponse {
  channel: string;
  ts: string;
}

interface AuthTestResponse extends SlackApiResponse {
  user_id?: string;
  user?: string;
  team?: string;
  team_id?: string;
  bot_id?: string;
}

interface ConversationsListResponse extends SlackApiResponse {
  channels?: Array<{ id: string; name: string; is_member: boolean }>;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Thin Slack Web API client that routes all HTTP calls through
 * `ctx.http.fetch` so the host can audit and trace outbound requests.
 */
export class SlackClient {
  constructor(
    private readonly token: string,
    private readonly http: PluginHttpClient,
  ) {}

  /**
   * Post a message to a channel (or thread).
   * @returns `{ ts, channel }` of the posted message.
   */
  async postMessage(
    channel: string,
    text: string,
    blocks?: SlackBlock[],
    threadTs?: string,
  ): Promise<{ ts: string; channel: string }> {
    const body: Record<string, unknown> = { channel, text };
    if (blocks && blocks.length > 0) body.blocks = blocks;
    if (threadTs) body.thread_ts = threadTs;

    const res = await this.call<PostMessageResponse>("chat.postMessage", body);
    if (!res.ok || !res.ts) {
      throw new Error(`chat.postMessage failed: ${res.error ?? "unknown error"}`);
    }
    return { ts: res.ts, channel: res.channel };
  }

  /**
   * Update an existing message.
   */
  async updateMessage(
    channel: string,
    ts: string,
    text: string,
    blocks?: SlackBlock[],
  ): Promise<void> {
    const body: Record<string, unknown> = { channel, ts, text };
    if (blocks && blocks.length > 0) body.blocks = blocks;
    const res = await this.call<SlackApiResponse>("chat.update", body);
    if (!res.ok) {
      throw new Error(`chat.update failed: ${res.error ?? "unknown error"}`);
    }
  }

  /**
   * Add a reaction emoji to a message.
   */
  async addReaction(channel: string, ts: string, emoji: string): Promise<void> {
    const res = await this.call<SlackApiResponse>("reactions.add", {
      channel,
      timestamp: ts,
      name: emoji,
    });
    // already_reacted is not a real error
    if (!res.ok && res.error !== "already_reacted") {
      throw new Error(`reactions.add failed: ${res.error ?? "unknown error"}`);
    }
  }

  /**
   * List joined channels (paginated, returns first page up to 200).
   */
  async listChannels(): Promise<Array<{ id: string; name: string }>> {
    const res = await this.call<ConversationsListResponse>("conversations.list", {
      types: "public_channel,private_channel",
      limit: 200,
      exclude_archived: true,
    });
    if (!res.ok) {
      throw new Error(`conversations.list failed: ${res.error ?? "unknown error"}`);
    }
    return (res.channels ?? []).map((ch) => ({ id: ch.id, name: ch.name }));
  }

  /**
   * Verify this token is valid and return basic identity info.
   */
  async authTest(): Promise<{ ok: boolean; userId?: string; botId?: string; error?: string }> {
    const res = await this.call<AuthTestResponse>("auth.test", {});
    return {
      ok: res.ok,
      userId: res.user_id,
      botId: res.bot_id,
      error: res.error,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async call<T extends SlackApiResponse>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.http.fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Slack API HTTP ${response.status} for ${method}`);
    }

    return response.json() as Promise<T>;
  }
}
