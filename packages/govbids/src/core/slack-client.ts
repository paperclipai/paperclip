import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

const SLACK_API = "https://slack.com/api";

export interface SlackClientOptions {
  botToken: string;
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export class SlackError extends Error {
  constructor(
    public endpoint: string,
    public slackError: string,
  ) {
    super(`Slack ${endpoint} failed: ${slackError}`);
    this.name = "SlackError";
  }
}

export class SlackClient {
  constructor(private opts: SlackClientOptions) {}

  private get authHeader() {
    return { Authorization: `Bearer ${this.opts.botToken}` };
  }

  async authTest(): Promise<{ user: string; team: string; botId: string }> {
    const res = await fetch(`${SLACK_API}/auth.test`, { headers: this.authHeader });
    const json = (await res.json()) as SlackApiResponse;
    if (!json.ok) throw new SlackError("auth.test", json.error ?? "unknown");
    return {
      user: String(json.user ?? ""),
      team: String(json.team ?? ""),
      botId: String(json.bot_id ?? ""),
    };
  }

  /**
   * Resolve a Slack channel name or ID to a channel ID.
   * Accepts "#name", "name", or a literal "C..." / "G..." ID (returned unchanged).
   */
  async resolveChannelId(nameOrId: string): Promise<string> {
    const trimmed = nameOrId.replace(/^#/, "").trim();
    if (/^[CGD][A-Z0-9]+$/.test(trimmed)) return trimmed;

    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const url = new URL(`${SLACK_API}/conversations.list`);
      url.searchParams.set("types", "public_channel,private_channel");
      url.searchParams.set("limit", "200");
      url.searchParams.set("exclude_archived", "true");
      if (cursor) url.searchParams.set("cursor", cursor);

      const res = await fetch(url, { headers: this.authHeader });
      const json = (await res.json()) as SlackApiResponse;
      if (!json.ok) throw new SlackError("conversations.list", json.error ?? "unknown");

      const channels = (json.channels ?? []) as Array<{ id: string; name: string }>;
      const match = channels.find((c) => c.name === trimmed);
      if (match) return match.id;

      cursor = (json.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
      if (!cursor) break;
    }

    throw new Error(
      `Slack channel not found: "${nameOrId}". The bot must be a member of the channel and have channels:read / groups:read scope.`,
    );
  }

  async postMessage(opts: {
    channelId: string;
    text: string;
    blocks?: unknown[];
  }): Promise<{ ts: string; channel: string }> {
    const res = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: "POST",
      headers: {
        ...this.authHeader,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: opts.channelId,
        text: opts.text,
        blocks: opts.blocks,
      }),
    });
    const json = (await res.json()) as SlackApiResponse;
    if (!json.ok) throw new SlackError("chat.postMessage", json.error ?? "unknown");
    return { ts: String(json.ts ?? ""), channel: String(json.channel ?? "") };
  }

  /**
   * Upload a file to a Slack channel via the modern external-upload flow.
   * (files.upload was deprecated in March 2025.)
   */
  async uploadFile(opts: {
    channelId: string;
    filePath: string;
    title?: string;
    initialComment?: string;
  }): Promise<void> {
    const filename = basename(opts.filePath);
    const stats = await stat(opts.filePath);
    const bytes = await readFile(opts.filePath);

    // 1. Get an upload URL.
    const getUrl = new URL(`${SLACK_API}/files.getUploadURLExternal`);
    getUrl.searchParams.set("filename", filename);
    getUrl.searchParams.set("length", String(stats.size));
    const getRes = await fetch(getUrl, { headers: this.authHeader });
    const getJson = (await getRes.json()) as SlackApiResponse & {
      upload_url?: string;
      file_id?: string;
    };
    if (!getJson.ok || !getJson.upload_url || !getJson.file_id) {
      throw new SlackError("files.getUploadURLExternal", getJson.error ?? "unknown");
    }

    // 2. POST raw bytes to the signed upload URL.
    const upRes = await fetch(getJson.upload_url, {
      method: "POST",
      body: bytes,
    });
    if (!upRes.ok) {
      throw new Error(
        `Slack file upload to signed URL failed: HTTP ${upRes.status} ${upRes.statusText}`,
      );
    }

    // 3. Complete the upload — attaches the file to the channel.
    const completeRes = await fetch(`${SLACK_API}/files.completeUploadExternal`, {
      method: "POST",
      headers: {
        ...this.authHeader,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        files: [{ id: getJson.file_id, title: opts.title ?? filename }],
        channel_id: opts.channelId,
        initial_comment: opts.initialComment,
      }),
    });
    const completeJson = (await completeRes.json()) as SlackApiResponse;
    if (!completeJson.ok) {
      throw new SlackError("files.completeUploadExternal", completeJson.error ?? "unknown");
    }
  }
}
