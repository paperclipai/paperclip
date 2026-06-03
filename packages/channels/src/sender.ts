import type { Channel, ChannelMessage } from "@paperclipai/shared";
import { createSlackAdapter } from "./platforms/slack.js";
import { createWebhookAdapter } from "./platforms/webhook.js";
import type {
  ChannelMessageStore,
  FetchLike,
  PlatformAdapter,
  SendOptions,
  SendResult,
} from "./types.js";

export interface SenderDeps {
  /** Persistence for `channel_messages`. */
  store: ChannelMessageStore;
  /**
   * Adapter resolver. Defaults to the built-in registry covering
   * `webhook` and `slack`. Tests/integrations can override to inject
   * stubs or additional platforms.
   */
  resolveAdapter?: (platform: string) => PlatformAdapter | null;
  /** Underlying fetch used by built-in adapters. */
  fetch?: FetchLike;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 200;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSender(deps: SenderDeps): {
  send(channel: Channel, content: string, options?: SendOptions): Promise<SendResult>;
  resolveAdapter(platform: string): PlatformAdapter | null;
} {
  const fallbackRegistry = buildDefaultRegistry(deps.fetch);
  const resolveAdapter =
    deps.resolveAdapter ?? ((platform: string) => fallbackRegistry.get(platform) ?? null);

  async function send(
    channel: Channel,
    content: string,
    options: SendOptions = {},
  ): Promise<SendResult> {
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const backoffBase = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const sleep = options.sleep ?? defaultSleep;
    const metadata = { ...(options.metadata ?? {}) };

    let message: ChannelMessage = await deps.store.create({
      companyId: channel.companyId,
      channelId: channel.id,
      content,
      metadata,
      issueId: options.issueId ?? null,
      agentId: options.agentId ?? null,
    });

    const adapter = resolveAdapter(channel.platform);
    if (!adapter) {
      const failed = await deps.store.updateStatus(message.id, "failed", {
        ...metadata,
        error: `Unsupported platform: ${channel.platform}`,
      });
      return {
        message: failed,
        attempts: 0,
        lastError: `Unsupported platform: ${channel.platform}`,
      };
    }

    let lastError: string | undefined;
    let attempts = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      const result = await adapter.send(channel, { content, metadata });
      if (result.status === "delivered") {
        const merged = { ...metadata, ...(result.metadata ?? {}) };
        message = await deps.store.updateStatus(message.id, "delivered", merged);
        return { message, attempts };
      }
      lastError = result.error;
      // On final attempt persist failure; otherwise back off and retry.
      if (attempt === maxAttempts) {
        const merged = {
          ...metadata,
          ...(result.metadata ?? {}),
          error: lastError ?? "Unknown error",
          attempts,
        };
        message = await deps.store.updateStatus(message.id, "failed", merged);
        return { message, attempts, lastError };
      }
      const delay = backoffBase * 2 ** (attempt - 1);
      await sleep(delay);
    }

    // Defensive — should be unreachable because the loop always returns.
    return { message, attempts, lastError };
  }

  return { send, resolveAdapter };
}

function buildDefaultRegistry(fetchImpl?: FetchLike): Map<string, PlatformAdapter> {
  const registry = new Map<string, PlatformAdapter>();
  registry.set("webhook", createWebhookAdapter({ fetch: fetchImpl }));
  registry.set("slack", createSlackAdapter({ fetch: fetchImpl }));
  return registry;
}
