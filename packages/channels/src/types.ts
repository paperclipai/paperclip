import type {
  Channel,
  ChannelMessage,
  ChannelMessageStatus,
} from "@paperclipai/shared";

/**
 * Input passed to platform adapters to send a single outbound message.
 * Independent of how the message is persisted.
 */
export interface PlatformSendInput {
  content: string;
  /** Platform-specific metadata coming in (e.g. parent thread_ts for replies). */
  metadata?: Record<string, unknown>;
}

/**
 * Result returned by a platform adapter after a single send attempt.
 * `metadata` is merged into the stored message metadata when delivered.
 */
export interface PlatformSendResult {
  status: "delivered" | "failed";
  metadata?: Record<string, unknown>;
  error?: string;
}

/**
 * Adapter contract for a single outbound platform (slack/webhook/...).
 * Adapters are pure: they take a channel config + input and return a result.
 * Persistence + retry policy live in the sender.
 */
export interface PlatformAdapter {
  readonly platform: string;
  send(channel: Channel, input: PlatformSendInput): Promise<PlatformSendResult>;
}

/**
 * Pluggable HTTP fetch — kept abstract so tests can stub it without globals.
 */
export type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

/**
 * Persistence contract used by the sender. Implementations wrap the
 * `channel_messages` table (or any other store). Keeping it abstract here
 * lets the package stay DB-free.
 */
export interface ChannelMessageStore {
  create(input: {
    companyId: string;
    channelId: string;
    content: string;
    metadata: Record<string, unknown>;
    issueId?: string | null;
    agentId?: string | null;
  }): Promise<ChannelMessage>;
  updateStatus(
    id: string,
    status: ChannelMessageStatus,
    metadata: Record<string, unknown>,
  ): Promise<ChannelMessage>;
}

export interface SendOptions {
  issueId?: string | null;
  agentId?: string | null;
  metadata?: Record<string, unknown>;
  /** Override retry attempts (default 3). */
  maxAttempts?: number;
  /** Override base backoff in ms (default 200). */
  backoffBaseMs?: number;
  /** Wait callback — overridden in tests to skip real delays. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SendResult {
  message: ChannelMessage;
  attempts: number;
  lastError?: string;
}
