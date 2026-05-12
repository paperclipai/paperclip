import { and, asc, eq, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueThreadInteractions } from "@paperclipai/db";
import type {
  IssueFinalDeliveryPayload,
  IssueFinalDeliveryResult,
  IssueThreadInteractionStatus,
} from "@paperclipai/shared";
import {
  issueFinalDeliveryPayloadSchema,
  issueFinalDeliveryResultSchema,
} from "@paperclipai/shared";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 60_000;
const DEFAULT_CLAIM_LEASE_MS = 5 * 60_000;
const MAX_ERROR_LENGTH = 4_000;
const TELEGRAM_MESSAGE_LIMIT = 4_096;
const SLACK_MESSAGE_LIMIT = 40_000;

type IssueThreadInteractionRow = typeof issueThreadInteractions.$inferSelect;

export interface FinalDeliveryPendingInteraction {
  id: string;
  companyId: string;
  issueId: string;
  status: IssueThreadInteractionStatus;
  payload: IssueFinalDeliveryPayload;
  result: IssueFinalDeliveryResult | null;
}

export interface FinalDeliverySendContext {
  text: string;
  attemptCount: number;
  now: Date;
}

export interface FinalDeliveryTransport {
  supports?(payload: IssueFinalDeliveryPayload): boolean;
  send(
    payload: IssueFinalDeliveryPayload,
    context: FinalDeliverySendContext,
  ): Promise<{ externalMessageId?: string | null }>;
}

export interface FinalDeliveryClaim {
  attemptCount: number;
  claimToken: string;
  claimedAt: Date;
  claimExpiresAt: Date;
}

export interface FinalDeliveryStore {
  listPendingFinalDeliveries(args: { limit: number }): Promise<FinalDeliveryPendingInteraction[]>;
  claimForDelivery(
    interaction: FinalDeliveryPendingInteraction,
    claim: FinalDeliveryClaim,
  ): Promise<FinalDeliveryPendingInteraction | null>;
  markDelivered(
    interaction: FinalDeliveryPendingInteraction,
    result: IssueFinalDeliveryResult,
  ): Promise<void>;
  markRetry(
    interaction: FinalDeliveryPendingInteraction,
    result: IssueFinalDeliveryResult,
  ): Promise<void>;
  markFailed(
    interaction: FinalDeliveryPendingInteraction,
    result: IssueFinalDeliveryResult,
  ): Promise<void>;
}

export interface IssueFinalDeliverySenderOptions {
  store: FinalDeliveryStore;
  transport: FinalDeliveryTransport;
  now?: () => Date;
  maxAttempts?: number;
  retryBaseMs?: number;
  claimLeaseMs?: number;
}

export interface ProcessFinalDeliveryResult {
  scanned: number;
  attempted: number;
  delivered: number;
  retrying: number;
  failed: number;
  skipped: number;
}

export interface FinalDeliveryWorkerHandle {
  tick(): Promise<ProcessFinalDeliveryResult>;
  stop(): void;
}

export interface FinalDeliveryWorkerOptions extends IssueFinalDeliverySenderOptions {
  intervalMs?: number;
  limit?: number;
  logger?: Pick<typeof console, "info" | "warn" | "error">;
}

export function formatIssueFinalDeliveryMessage(payload: IssueFinalDeliveryPayload): string {
  const lines = [payload.message.body.trim()];
  const visibleArtifacts = payload.artifacts.filter((artifact) => artifact.title.trim().length > 0);
  if (visibleArtifacts.length > 0) {
    lines.push("", "Evidence:");
    for (const artifact of visibleArtifacts) {
      const primary = artifact.isPrimary ? " (primary)" : "";
      const summary = artifact.summary ? ` — ${artifact.summary.trim()}` : "";
      const url = artifact.url ? `\n  ${artifact.url}` : "";
      lines.push(`- ${artifact.title}${primary}${summary}${url}`);
    }
  }
  return lines.join("\n").trim();
}

export function shouldAttemptFinalDelivery(
  interaction: FinalDeliveryPendingInteraction,
  now = new Date(),
): boolean {
  if (interaction.result?.outcome === "delivered") return false;

  if (interaction.status === "sending") {
    const claimExpiresAt = interaction.result?.claimExpiresAt;
    if (!claimExpiresAt) return false;
    const expiry = Date.parse(claimExpiresAt);
    if (!Number.isFinite(expiry)) return false;
    return expiry <= now.getTime();
  }

  if (interaction.status !== "pending") return false;
  const nextAttemptAt = interaction.result?.nextAttemptAt;
  if (!nextAttemptAt) return true;
  const next = Date.parse(nextAttemptAt);
  if (!Number.isFinite(next)) return true;
  return next <= now.getTime();
}

export function createIssueFinalDeliverySender(options: IssueFinalDeliverySenderOptions) {
  const now = options.now ?? (() => new Date());
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const retryBaseMs = Math.max(1, Math.floor(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS));
  const claimLeaseMs = Math.max(1, Math.floor(options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS));

  async function processOne(interaction: FinalDeliveryPendingInteraction): Promise<"delivered" | "retrying" | "failed" | "skipped"> {
    const currentNow = now();
    if (!shouldAttemptFinalDelivery(interaction, currentNow)) return "skipped";
    if (options.transport.supports?.(interaction.payload) === false) return "skipped";

    const proposedAttemptCount = (interaction.result?.attemptCount ?? 0) + 1;
    const claimExpiresAt = new Date(currentNow.getTime() + claimLeaseMs);
    const claimedInteraction = await options.store.claimForDelivery(interaction, {
      attemptCount: proposedAttemptCount,
      claimToken: createFinalDeliveryClaimToken(interaction, proposedAttemptCount, currentNow),
      claimedAt: currentNow,
      claimExpiresAt,
    });
    if (!claimedInteraction) return "skipped";

    const attemptCount = Math.max(1, claimedInteraction.result?.attemptCount ?? proposedAttemptCount);
    const text = formatIssueFinalDeliveryMessage(claimedInteraction.payload);

    try {
      const response = await options.transport.send(claimedInteraction.payload, {
        text,
        attemptCount,
        now: currentNow,
      });
      await options.store.markDelivered(claimedInteraction, {
        version: 1,
        outcome: "delivered",
        deliveredAt: currentNow.toISOString(),
        externalMessageId: response.externalMessageId ?? null,
        error: null,
        attemptCount,
        lastAttemptAt: currentNow.toISOString(),
        nextAttemptAt: null,
      });
      return "delivered";
    } catch (err) {
      const error = sanitizeFinalDeliveryError(err);
      const retryable = isRetryableFinalDeliveryError(err) && attemptCount < maxAttempts;
      const result: IssueFinalDeliveryResult = {
        version: 1,
        outcome: "failed",
        deliveredAt: null,
        externalMessageId: null,
        error,
        attemptCount,
        lastAttemptAt: currentNow.toISOString(),
        nextAttemptAt: retryable
          ? new Date(currentNow.getTime() + retryDelayMs(attemptCount, retryBaseMs)).toISOString()
          : null,
        retryable,
        terminal: !retryable,
      };

      if (retryable) {
        await options.store.markRetry(claimedInteraction, result);
        return "retrying";
      }
      await options.store.markFailed(claimedInteraction, result);
      return "failed";
    }
  }

  return {
    async processPendingFinalDeliveries(args: { limit?: number } = {}): Promise<ProcessFinalDeliveryResult> {
      const limit = Math.max(1, Math.floor(args.limit ?? 25));
      const interactions = await options.store.listPendingFinalDeliveries({ limit });
      const result: ProcessFinalDeliveryResult = {
        scanned: interactions.length,
        attempted: 0,
        delivered: 0,
        retrying: 0,
        failed: 0,
        skipped: 0,
      };

      for (const interaction of interactions) {
        if (!shouldAttemptFinalDelivery(interaction, now()) || options.transport.supports?.(interaction.payload) === false) {
          result.skipped += 1;
          continue;
        }
        result.attempted += 1;
        const outcome = await processOne(interaction);
        result[outcome] += 1;
      }
      return result;
    },
  };
}

export function createIssueFinalDeliveryDbStore(db: Db): FinalDeliveryStore {
  return {
    async listPendingFinalDeliveries(args) {
      const nowIso = new Date().toISOString();
      const rows = await db
        .select()
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.kind, "final_delivery"),
          finalDeliveryAttemptableSql(nowIso),
        ))
        .orderBy(asc(issueThreadInteractions.createdAt))
        .limit(args.limit);
      return rows
        .map(hydrateAttemptableFinalDelivery)
        .filter((interaction): interaction is FinalDeliveryPendingInteraction => interaction !== null)
        .filter((interaction) => shouldAttemptFinalDelivery(interaction));
    },
    async claimForDelivery(interaction, claim) {
      const claimedAtIso = claim.claimedAt.toISOString();
      const claimResult = finalDeliveryClaimResultSql(claim);
      const rows = await db
        .update(issueThreadInteractions)
        .set({
          status: "sending",
          result: claimResult,
          resolvedAt: null,
          updatedAt: claim.claimedAt,
        })
        .where(and(
          eq(issueThreadInteractions.id, interaction.id),
          eq(issueThreadInteractions.kind, "final_delivery"),
          finalDeliveryAttemptableSql(claimedAtIso),
        ))
        .returning();
      const row = rows[0];
      return row ? hydrateFinalDelivery(row) : null;
    },
    async markDelivered(interaction, result) {
      await updateFinalDeliveryInteraction(db, interaction, "accepted", result, new Date(result.deliveredAt ?? result.lastAttemptAt ?? Date.now()));
    },
    async markRetry(interaction, result) {
      await updateFinalDeliveryInteraction(db, interaction, "pending", result, null);
    },
    async markFailed(interaction, result) {
      await updateFinalDeliveryInteraction(db, interaction, "failed", result, new Date(result.lastAttemptAt ?? Date.now()));
    },
  };
}

export function createIssueFinalDeliveryTransportFromEnv(env: NodeJS.ProcessEnv = process.env): FinalDeliveryTransport | null {
  const telegramToken = readEnv(env, "PAPERCLIP_TELEGRAM_BOT_TOKEN") ?? readEnv(env, "TELEGRAM_BOT_TOKEN");
  const slackToken = readEnv(env, "PAPERCLIP_SLACK_BOT_TOKEN") ?? readEnv(env, "SLACK_BOT_TOKEN");
  const telegramApiBaseUrl = readEnv(env, "PAPERCLIP_TELEGRAM_API_BASE_URL") ?? "https://api.telegram.org";
  const slackApiBaseUrl = readEnv(env, "PAPERCLIP_SLACK_API_BASE_URL") ?? "https://slack.com/api";

  if (!telegramToken && !slackToken) return null;

  return {
    supports(payload) {
      if (payload.destination.platform === "telegram") return Boolean(telegramToken);
      return Boolean(slackToken);
    },
    async send(payload, context) {
      if (payload.destination.platform === "telegram") {
        if (!telegramToken) throw new Error("Telegram final delivery token is not configured");
        return sendTelegramFinalDelivery({ payload, text: context.text, token: telegramToken, apiBaseUrl: telegramApiBaseUrl });
      }
      if (!slackToken) throw new Error("Slack final delivery token is not configured");
      return sendSlackFinalDelivery({ payload, text: context.text, token: slackToken, apiBaseUrl: slackApiBaseUrl });
    },
  };
}

export function startIssueFinalDeliveryWorker(options: FinalDeliveryWorkerOptions): FinalDeliveryWorkerHandle {
  const sender = createIssueFinalDeliverySender(options);
  const intervalMs = Math.max(1_000, Math.floor(options.intervalMs ?? 30_000));
  const limit = Math.max(1, Math.floor(options.limit ?? 25));
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) {
      return { scanned: 0, attempted: 0, delivered: 0, retrying: 0, failed: 0, skipped: 0 } satisfies ProcessFinalDeliveryResult;
    }
    running = true;
    try {
      const result = await sender.processPendingFinalDeliveries({ limit });
      if (result.attempted > 0) {
        options.logger?.info({ ...result }, "final delivery worker processed interactions");
      }
      return result;
    } catch (err) {
      options.logger?.error({ err: sanitizeFinalDeliveryError(err) }, "final delivery worker tick failed");
      return { scanned: 0, attempted: 0, delivered: 0, retrying: 0, failed: 0, skipped: 0 } satisfies ProcessFinalDeliveryResult;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  void tick();

  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function hydrateAttemptableFinalDelivery(row: IssueThreadInteractionRow): FinalDeliveryPendingInteraction | null {
  const hydrated = hydrateFinalDelivery(row);
  if (!hydrated) return null;
  if (hydrated.status !== "pending" && hydrated.status !== "sending") return null;
  return hydrated;
}

function hydrateFinalDelivery(row: IssueThreadInteractionRow): FinalDeliveryPendingInteraction | null {
  if (row.kind !== "final_delivery") return null;
  const payload = issueFinalDeliveryPayloadSchema.safeParse(row.payload);
  if (!payload.success) return null;
  const result = row.result == null ? null : issueFinalDeliveryResultSchema.safeParse(row.result);
  if (result && !result.success) return null;
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    status: row.status as IssueThreadInteractionStatus,
    payload: payload.data,
    result: result ? result.data : null,
  };
}

function finalDeliveryAttemptableSql(nowIso: string) {
  return or(
    and(
      eq(issueThreadInteractions.status, "pending"),
      or(
        sql`${issueThreadInteractions.result} IS NULL`,
        sql`${issueThreadInteractions.result} ->> 'nextAttemptAt' IS NULL`,
        sql`${issueThreadInteractions.result} ->> 'nextAttemptAt' = ''`,
        sql`${issueThreadInteractions.result} ->> 'nextAttemptAt' <= ${nowIso}`,
      ),
    ),
    and(
      eq(issueThreadInteractions.status, "sending"),
      sql`${issueThreadInteractions.result} ->> 'claimExpiresAt' IS NOT NULL`,
      sql`${issueThreadInteractions.result} ->> 'claimExpiresAt' != ''`,
      sql`${issueThreadInteractions.result} ->> 'claimExpiresAt' <= ${nowIso}`,
    ),
  );
}

function finalDeliveryClaimResultSql(claim: FinalDeliveryClaim) {
  return sql<IssueFinalDeliveryResult>`jsonb_build_object(
    'version', 1,
    'outcome', 'sending',
    'deliveredAt', null,
    'externalMessageId', null,
    'error', null,
    'attemptCount', (
      CASE
        WHEN ${issueThreadInteractions.result} ->> 'attemptCount' ~ '^[0-9]+$'
          THEN (${issueThreadInteractions.result} ->> 'attemptCount')::int
        ELSE 0
      END
    ) + 1,
    'lastAttemptAt', ${claim.claimedAt.toISOString()},
    'nextAttemptAt', null,
    'claimToken', ${claim.claimToken},
    'claimedAt', ${claim.claimedAt.toISOString()},
    'claimExpiresAt', ${claim.claimExpiresAt.toISOString()}
  )`;
}

async function updateFinalDeliveryInteraction(
  db: Db,
  interaction: FinalDeliveryPendingInteraction,
  status: IssueThreadInteractionStatus,
  result: IssueFinalDeliveryResult,
  resolvedAt: Date | null,
) {
  const claimToken = interaction.result?.claimToken ?? null;
  if (interaction.status === "sending" && !claimToken) {
    return;
  }
  await db
    .update(issueThreadInteractions)
    .set({
      status,
      result,
      resolvedAt,
      updatedAt: new Date(),
    })
    .where(and(
      eq(issueThreadInteractions.id, interaction.id),
      eq(issueThreadInteractions.kind, "final_delivery"),
      eq(issueThreadInteractions.status, interaction.status),
      claimToken ? sql`${issueThreadInteractions.result} ->> 'claimToken' = ${claimToken}` : sql`true`,
    ));
}

function retryDelayMs(attemptCount: number, retryBaseMs: number): number {
  const exponent = Math.max(0, attemptCount - 1);
  return retryBaseMs * (2 ** exponent);
}

function createFinalDeliveryClaimToken(
  interaction: FinalDeliveryPendingInteraction,
  attemptCount: number,
  claimedAt: Date,
): string {
  return `final_delivery:${interaction.id}:${attemptCount}:${claimedAt.getTime()}`;
}

class FinalDeliveryTransportError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: { retryable: boolean; status?: number }) {
    super(message);
    this.name = "FinalDeliveryTransportError";
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

function isRetryableFinalDeliveryError(err: unknown): boolean {
  if (err instanceof FinalDeliveryTransportError) {
    return err.retryable;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/not configured|invalid_auth|not_authed|missing_scope|forbidden|unauthori[sz]ed|bad request|channel_not_found|chat not found/i.test(message)) {
    return false;
  }
  return true;
}

function isRetryableTransportStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isRetryableSlackError(error: string): boolean {
  return new Set(["ratelimited", "rate_limited", "internal_error", "fatal_error", "service_unavailable", "request_timeout"]).has(error);
}

function sanitizeFinalDeliveryError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .slice(0, MAX_ERROR_LENGTH);
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

async function sendTelegramFinalDelivery(args: {
  payload: IssueFinalDeliveryPayload;
  text: string;
  token: string;
  apiBaseUrl: string;
}): Promise<{ externalMessageId?: string | null }> {
  if (args.payload.destination.platform !== "telegram") {
    throw new Error("Telegram transport received non-Telegram final delivery payload");
  }
  const endpoint = `${args.apiBaseUrl.replace(/\/$/, "")}/bot${args.token}/sendMessage`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: args.payload.destination.chatId,
      message_thread_id: args.payload.destination.threadId ?? undefined,
      text: truncateForTransport(args.text, TELEGRAM_MESSAGE_LIMIT),
      disable_web_page_preview: false,
    }),
  });
  const body = await safeJson(response);
  if (!response.ok || body?.ok === false) {
    const apiStatus = typeof body?.error_code === "number" ? body.error_code : response.status;
    const apiError = extractApiError(body);
    throw new FinalDeliveryTransportError(`Telegram sendMessage failed (${response.status}): ${apiError}`, {
      status: apiStatus,
      retryable: isRetryableTransportStatus(apiStatus),
    });
  }
  const messageId = body?.result?.message_id;
  return { externalMessageId: messageId == null ? null : String(messageId) };
}

async function sendSlackFinalDelivery(args: {
  payload: IssueFinalDeliveryPayload;
  text: string;
  token: string;
  apiBaseUrl: string;
}): Promise<{ externalMessageId?: string | null }> {
  if (args.payload.destination.platform !== "slack") {
    throw new Error("Slack transport received non-Slack final delivery payload");
  }
  const endpoint = `${args.apiBaseUrl.replace(/\/$/, "")}/chat.postMessage`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: args.payload.destination.channelId,
      thread_ts: args.payload.destination.threadTs ?? undefined,
      text: truncateForTransport(args.text, SLACK_MESSAGE_LIMIT),
    }),
  });
  const body = await safeJson(response);
  if (!response.ok || body?.ok === false) {
    const apiError = extractApiError(body);
    const retryable = !response.ok
      ? isRetryableTransportStatus(response.status)
      : isRetryableSlackError(apiError);
    throw new FinalDeliveryTransportError(`Slack chat.postMessage failed (${response.status}): ${apiError}`, {
      status: response.status,
      retryable,
    });
  }
  const ts = body?.ts;
  return { externalMessageId: typeof ts === "string" ? ts : null };
}

async function safeJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function extractApiError(body: any): string {
  if (!body || typeof body !== "object") return "unknown error";
  if (typeof body.description === "string") return body.description.slice(0, 500);
  if (typeof body.error === "string") return body.error.slice(0, 500);
  return "unknown error";
}

function truncateForTransport(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 24)).trimEnd()}\n\n[message truncated]`;
}
