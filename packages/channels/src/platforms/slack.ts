import type { Channel } from "@paperclipai/shared";
import type {
  FetchLike,
  PlatformAdapter,
  PlatformSendInput,
  PlatformSendResult,
} from "../types.js";

export interface SlackConfig {
  botToken: string;
  channel: string;
  timeoutMs?: number;
}

function parseConfig(channel: Channel): SlackConfig {
  const cfg = channel.config as Record<string, unknown>;
  const botToken =
    typeof cfg.botToken === "string"
      ? cfg.botToken
      : typeof cfg.bot_token === "string"
        ? (cfg.bot_token as string)
        : "";
  const slackChannel =
    typeof cfg.channel === "string"
      ? cfg.channel
      : typeof cfg.channelId === "string"
        ? (cfg.channelId as string)
        : "";
  if (!botToken) {
    throw new Error("Slack channel is missing `botToken` in config");
  }
  if (!slackChannel) {
    throw new Error("Slack channel is missing `channel` (channel id or name) in config");
  }
  return {
    botToken,
    channel: slackChannel,
    timeoutMs: typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : 10_000,
  };
}

/**
 * Convert a small subset of Markdown into Slack's `mrkdwn` flavor.
 * Slack mrkdwn diverges from CommonMark on these tokens — translating
 * them up-front is good enough for notification payloads. Unsupported
 * constructs (tables, blockquotes) are left as-is.
 */
export function markdownToSlackMrkdwn(input: string): string {
  let out = input;

  // Links: [label](url) → <url|label>
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, "<$2|$1>");

  // Bold: **text** or __text__ → *text*
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "*$1*");
  out = out.replace(/(^|[^_])__([^_\n]+)__/g, "$1*$2*");

  // Italic: single *text* or _text_ → _text_
  // The bold pass above already collapsed **…** to *…*, so we keep single * as italics in mrkdwn.
  // No-op for *…*, but normalize single underscores to a consistent shape.
  // (Nothing to do — Slack accepts _text_ for italics natively.)

  // Headings: # Heading → *Heading*
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Unordered list dashes/asterisks → bullet
  out = out.replace(/^\s*[-*]\s+/gm, "• ");

  return out;
}

interface SlackPostMessageResponse {
  ok: boolean;
  error?: string;
  channel?: string;
  ts?: string;
  message?: { ts?: string; thread_ts?: string };
}

export interface CreateSlackAdapterOptions {
  fetch?: FetchLike;
  apiBaseUrl?: string;
}

export function createSlackAdapter(opts: CreateSlackAdapterOptions = {}): PlatformAdapter {
  const fetchImpl: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const apiBaseUrl = opts.apiBaseUrl ?? "https://slack.com/api";

  async function send(channel: Channel, input: PlatformSendInput): Promise<PlatformSendResult> {
    let config: SlackConfig;
    try {
      config = parseConfig(channel);
    } catch (err) {
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const threadTs =
      typeof input.metadata?.thread_ts === "string"
        ? (input.metadata.thread_ts as string)
        : undefined;

    const body: Record<string, unknown> = {
      channel: config.channel,
      text: markdownToSlackMrkdwn(input.content),
      mrkdwn: true,
    };
    if (threadTs) body.thread_ts = threadTs;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000);
    try {
      const res = await fetchImpl(`${apiBaseUrl}/chat.postMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${config.botToken}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        return {
          status: "failed",
          error: `HTTP ${res.status}`,
          metadata: { httpStatus: res.status },
        };
      }
      const json = (await res.json()) as SlackPostMessageResponse;
      if (!json.ok) {
        return {
          status: "failed",
          error: `slack: ${json.error ?? "unknown_error"}`,
        };
      }
      const ts = json.ts ?? json.message?.ts;
      return {
        status: "delivered",
        metadata: {
          channel: json.channel ?? config.channel,
          ts,
          thread_ts: json.message?.thread_ts ?? threadTs ?? ts,
        },
      };
    } catch (err) {
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { platform: "slack", send };
}
