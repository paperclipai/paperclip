import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { pushSubscriptionService } from "./push-subscriptions.js";
import { createWebPushTransport, type PushTransport } from "./push-transport.js";
import { subscribeGlobalLiveEvents } from "./live-events.js";

/** Phase 1 allowlist — the only activity action that triggers a push. See SAG-7600 plan §2. */
const ALLOWLISTED_ACTIONS: ReadonlySet<string> = new Set(["issue.thread_interaction_created"]);
const IMMEDIATE_EVENT_TYPES = new Set(["issue.user_assigned", "issue.interaction.pending"]);
const DIGEST_EVENT_TYPES = new Set(["issue.blocked", "issue.stale"]);
const MAX_IMMEDIATE_DEDUP_ENTRIES = 10_000;
const immediateDedup = new Map<string, number>();
const digestBuffer = new Map<string, { blocked: number; stale: number }>();
const digestTimers = new Map<string, ReturnType<typeof setTimeout>>();
let fanoutCleanup: (() => void) | null = null;

export interface PushFanoutActivityContext {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  responsibleUserId: string | null;
  activityLogId: string;
  details: Record<string, unknown> | null;
}

let configuredTransport: PushTransport | null = null;
let warnedNoVapid = false;

export function configurePushFanout(config: {
  vapidPublicKey: string | undefined;
  vapidPrivateKey: string | undefined;
  vapidSubject: string | undefined;
}): void {
  if (config.vapidPublicKey && config.vapidPrivateKey && config.vapidSubject) {
    configuredTransport = createWebPushTransport({
      publicKey: config.vapidPublicKey,
      privateKey: config.vapidPrivateKey,
      subject: config.vapidSubject,
    });
    warnedNoVapid = false;
    return;
  }
  configuredTransport = null;
  if (!warnedNoVapid) {
    warnedNoVapid = true;
    logger.info("push-fanout: VAPID keys not configured — push notifications are a no-op");
  }
}

/** Test-only: inject a mock transport in place of whatever configurePushFanout last set. */
export function setPushTransportForTests(transport: PushTransport | null): void {
  configuredTransport = transport;
}

function envHours(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  return Number.isFinite(value) ? Math.max(1, value) : fallback;
}

function inQuietHours(): boolean {
  const start = Number.parseInt(process.env.PAPERCLIP_PUSH_QUIET_START ?? "22", 10);
  const end = Number.parseInt(process.env.PAPERCLIP_PUSH_QUIET_END ?? "7", 10);
  const hour = new Date().getHours();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return hour >= 22 || hour < 7;
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

function millisUntilQuietHoursEnd(): number {
  const end = Number.parseInt(process.env.PAPERCLIP_PUSH_QUIET_END ?? "7", 10);
  const now = new Date();
  const next = new Date(now);
  next.setHours(Number.isFinite(end) ? end : 7, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function isDuplicate(issueId: string, eventType: string): boolean {
  const key = `${issueId}:${eventType}`;
  const now = Date.now();
  const ttlMs = envHours("PAPERCLIP_PUSH_DEDUP_TTL_HOURS", 4) * 3_600_000;
  const last = immediateDedup.get(key);
  if (last !== undefined && now - last < ttlMs) return true;

  // The cache is process-global: prune expired entries and cap retained keys so
  // high-cardinality issue events cannot turn deduplication into an unbounded
  // memory sink in a long-lived server.
  if (immediateDedup.size >= MAX_IMMEDIATE_DEDUP_ENTRIES) {
    for (const [entryKey, seenAt] of immediateDedup) {
      if (now - seenAt >= ttlMs) immediateDedup.delete(entryKey);
    }
    while (immediateDedup.size >= MAX_IMMEDIATE_DEDUP_ENTRIES) {
      const oldestKey = immediateDedup.keys().next().value;
      if (oldestKey === undefined) break;
      immediateDedup.delete(oldestKey);
    }
  }

  immediateDedup.set(key, now);
  return false;
}

async function recordFanoutFailures(
  db: Db,
  activityLogId: string,
  failures: ReadonlyArray<{ endpoint: string; error: string }>,
): Promise<void> {
  try {
    const [row] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.id, activityLogId));
    const mergedDetails = { ...(row?.details ?? {}), pushFanoutFailures: failures };
    await db.update(activityLog).set({ details: mergedDetails }).where(eq(activityLog.id, activityLogId));
  } catch (err) {
    logger.warn({ err, activityLogId }, "push-fanout: failed to record delivery failure against activity_log row");
  }
}

function isDeadEndpointStatus(statusCode: unknown): boolean {
  return statusCode === 404 || statusCode === 410;
}

async function sendToSubscriptions(
  db: Db,
  subscriptions: Awaited<ReturnType<ReturnType<typeof pushSubscriptionService>["listActiveForCompany"]>>,
  payload: unknown,
  activityLogId?: string,
): Promise<void> {
  const transport = configuredTransport;
  if (!transport || subscriptions.length === 0) return;
  const failures: Array<{ endpoint: string; error: string }> = [];
  await Promise.all(subscriptions.map(async (sub) => {
    try {
      await transport.send(sub, payload);
    } catch (err) {
      if (isDeadEndpointStatus((err as { statusCode?: number } | undefined)?.statusCode)) {
        await pushSubscriptionService(db).revokeByEndpoint(sub.endpoint);
      }
      failures.push({ endpoint: sub.endpoint, error: err instanceof Error ? err.message : String(err) });
    }
  }));
  if (activityLogId && failures.length) await recordFanoutFailures(db, activityLogId, failures);
}

/** Start the live-event fanout once for this process. */
export function initPushFanout(db: Db): () => void {
  fanoutCleanup?.();
  fanoutCleanup = subscribeGlobalLiveEvents((event) => { void handleLiveEvent(db, event); });
  return () => { fanoutCleanup?.(); fanoutCleanup = null; };
}

export function __resetPushFanoutForTests(): void {
  immediateDedup.clear();
  digestBuffer.clear();
  for (const timer of digestTimers.values()) clearTimeout(timer);
  digestTimers.clear();
  fanoutCleanup?.();
  fanoutCleanup = null;
}

function scheduleDigestFlush(db: Db, companyId: string, delayMs: number): void {
  if (digestTimers.has(companyId)) return;
  digestTimers.set(companyId, setTimeout(() => {
    digestTimers.delete(companyId);
    void flushDigest(db, companyId);
  }, delayMs));
}

async function flushDigest(db: Db, companyId: string): Promise<void> {
  const digest = digestBuffer.get(companyId);
  if (!digest) return;
  if (inQuietHours()) {
    scheduleDigestFlush(db, companyId, millisUntilQuietHoursEnd());
    return;
  }
  digestBuffer.delete(companyId);
  const subs = await pushSubscriptionService(db).listActiveForCompany(companyId);
  await sendToSubscriptions(db, subs, {
    title: `${digest.blocked} blocked, ${digest.stale} stale — tap to view`,
    body: "Issues need your attention",
    data: { kind: "digest", blockedCount: digest.blocked, staleCount: digest.stale },
  });
}

async function handleLiveEvent(db: Db, event: LiveEvent): Promise<void> {
  const payload = event.payload;
  const issueId = typeof payload.issueId === "string" ? payload.issueId : null;
  if (!issueId) return;
  if (IMMEDIATE_EVENT_TYPES.has(event.type)) {
    const userId = typeof payload.responsibleUserId === "string" ? payload.responsibleUserId : null;
    if (!userId || isDuplicate(issueId, event.type)) return;
    const subs = await pushSubscriptionService(db).listActiveForUser(event.companyId, userId);
    await sendToSubscriptions(db, subs, {
      title: event.type === "issue.user_assigned" ? "Action needed" : "Your input is needed",
      body: typeof payload.issueTitle === "string" ? payload.issueTitle : "An issue needs your attention",
      data: { issueId, eventType: event.type },
    });
    return;
  }
  if (!DIGEST_EVENT_TYPES.has(event.type)) return;
  const digest = digestBuffer.get(event.companyId) ?? { blocked: 0, stale: 0 };
  if (event.type === "issue.blocked") digest.blocked += 1;
  else digest.stale += 1;
  digestBuffer.set(event.companyId, digest);
  scheduleDigestFlush(db, event.companyId, envHours("PAPERCLIP_PUSH_DIGEST_INTERVAL_HOURS", 4) * 3_600_000);
}

/**
 * Resolves opted-in (subscribed, non-revoked) devices for the activity's
 * responsible user and sends one push per device. Never throws — callers
 * (logActivity) fire this without awaiting, so all errors are swallowed here
 * after being logged / recorded against the origin activity_log row.
 */
export async function firePushFanoutForActivity(
  db: Db,
  ctx: PushFanoutActivityContext,
  transport: PushTransport | null = configuredTransport,
): Promise<void> {
  try {
    if (!ALLOWLISTED_ACTIONS.has(ctx.action)) return;
    if (!ctx.responsibleUserId) return;
    if (!transport) {
      logger.debug({ activityLogId: ctx.activityLogId }, "push-fanout: no transport configured, skipping send");
      return;
    }

    const subs = await pushSubscriptionService(db).listActiveForUser(ctx.companyId, ctx.responsibleUserId);
    if (subs.length === 0) return;

    const payload = {
      title: "Your input is needed",
      body: `Action: ${ctx.action}`,
      data: {
        issueId: ctx.entityType === "issue" ? ctx.entityId : null,
        action: ctx.action,
        interactionId: ctx.details?.interactionId ?? null,
      },
    };

    const failures: Array<{ endpoint: string; error: string }> = [];

    await Promise.all(subs.map(async (sub) => {
      try {
        await transport.send(sub, payload);
      } catch (err) {
        const statusCode = (err as { statusCode?: number } | undefined)?.statusCode;
        if (isDeadEndpointStatus(statusCode)) {
          await pushSubscriptionService(db).revokeByEndpoint(sub.endpoint);
        }
        failures.push({ endpoint: sub.endpoint, error: err instanceof Error ? err.message : String(err) });
        logger.warn({ err, activityLogId: ctx.activityLogId, endpoint: sub.endpoint }, "push-fanout: send failed");
      }
    }));

    if (failures.length > 0) {
      await recordFanoutFailures(db, ctx.activityLogId, failures);
    }
  } catch (err) {
    logger.warn({ err, activityLogId: ctx.activityLogId }, "push-fanout: unexpected fanout error");
  }
}
