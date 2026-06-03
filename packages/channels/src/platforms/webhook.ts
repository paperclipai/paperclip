import { createHmac } from "node:crypto";
import type { Channel } from "@paperclipai/shared";
import type {
  FetchLike,
  PlatformAdapter,
  PlatformSendInput,
  PlatformSendResult,
} from "../types.js";

export interface WebhookConfig {
  url: string;
  signingSecret?: string;
  /** HTTP header name for the signature. Defaults to `X-Paperclip-Signature`. */
  signatureHeader?: string;
  /** Extra static headers to include on every request. */
  headers?: Record<string, string>;
  /** Per-attempt timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
}

function parseConfig(channel: Channel): WebhookConfig {
  const cfg = channel.config as Record<string, unknown>;
  const url = typeof cfg.url === "string" ? cfg.url : "";
  if (!url) {
    throw new Error("Webhook channel is missing `url` in config");
  }
  return {
    url,
    signingSecret:
      typeof cfg.signingSecret === "string"
        ? cfg.signingSecret
        : typeof cfg.signing_secret === "string"
          ? (cfg.signing_secret as string)
          : undefined,
    signatureHeader:
      typeof cfg.signatureHeader === "string" ? cfg.signatureHeader : "X-Paperclip-Signature",
    headers: typeof cfg.headers === "object" && cfg.headers !== null
      ? (cfg.headers as Record<string, string>)
      : undefined,
    timeoutMs: typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : 10_000,
  };
}

/**
 * Compute an HMAC-SHA256 signature over the JSON body using the channel's
 * signing secret. Format: `sha256=<hex>`. Same convention as Slack/GitHub
 * webhooks so receivers can verify with stock libraries.
 */
export function signWebhookPayload(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export interface CreateWebhookAdapterOptions {
  fetch?: FetchLike;
}

export function createWebhookAdapter(
  opts: CreateWebhookAdapterOptions = {},
): PlatformAdapter {
  const fetchImpl: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));

  async function send(channel: Channel, input: PlatformSendInput): Promise<PlatformSendResult> {
    let config: WebhookConfig;
    try {
      config = parseConfig(channel);
    } catch (err) {
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const payload = {
      channelId: channel.id,
      channelName: channel.name,
      content: input.content,
      metadata: input.metadata ?? {},
      sentAt: new Date().toISOString(),
    };
    const body = JSON.stringify(payload);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(config.headers ?? {}),
    };
    if (config.signingSecret) {
      headers[config.signatureHeader ?? "X-Paperclip-Signature"] = signWebhookPayload(
        config.signingSecret,
        body,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000);
    try {
      const res = await fetchImpl(config.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await safeReadText(res);
        return {
          status: "failed",
          error: `HTTP ${res.status}${text ? `: ${truncate(text, 200)}` : ""}`,
          metadata: { httpStatus: res.status },
        };
      }
      return {
        status: "delivered",
        metadata: { httpStatus: res.status },
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

  return { platform: "webhook", send };
}

async function safeReadText(res: { text: () => Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
