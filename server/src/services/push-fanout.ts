import { subscribeGlobalLiveEvents } from "./live-events.js";
import { webPushService } from "./web-push.js";
import { logger } from "../middleware/logger.js";
import type { Db } from "@paperclipai/db";

// Dedup store for immediate-lane pushes: key = `companyId:issueId:eventType`, value = last-sent ms
const immediateDedup = new Map<string, number>();

function getDedupTtlMs(): number {
  const hours = parseInt(process.env.PAPERCLIP_PUSH_DEDUP_TTL_HOURS ?? "4", 10);
  return (isNaN(hours) ? 4 : Math.max(1, hours)) * 60 * 60 * 1000;
}

function pruneExpiredDedupEntries(now: number, ttlMs: number): void {
  for (const [key, timestamp] of immediateDedup.entries()) {
    if (now - timestamp >= ttlMs) {
      immediateDedup.delete(key);
    }
  }
}

function isDuped(companyId: string, issueId: string, eventType: string): boolean {
  const key = `${companyId}:${issueId}:${eventType}`;
  const now = Date.now();
  const ttlMs = getDedupTtlMs();
  pruneExpiredDedupEntries(now, ttlMs);
  const last = immediateDedup.get(key);
  if (last !== undefined && now - last < ttlMs) return true;
  immediateDedup.set(key, now);
  return false;
}

// Quiet-hours helpers
function getQuietHours(): { start: number; end: number } {
  const start = parseInt(process.env.PAPERCLIP_PUSH_QUIET_START ?? "22", 10);
  const end = parseInt(process.env.PAPERCLIP_PUSH_QUIET_END ?? "7", 10);
  return {
    start: isNaN(start) ? 22 : start,
    end: isNaN(end) ? 7 : end,
  };
}

function isInQuietHours(): boolean {
  const { start, end } = getQuietHours();
  const hour = new Date().getHours();
  // handles midnight wrap-around (e.g. 22–7)
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

// Digest-lane buffer
interface DigestItem {
  companyId: string;
  issueId: string;
  issueTitle: string;
  issueIdentifier: string;
  kind: "blocked" | "stale";
  queuedAt: number;
}

const digestBuffer: DigestItem[] = [];
const lastDigestFlushAt = new Map<string, number>();

export function __resetPushFanoutForTests(): void {
  immediateDedup.clear();
  digestBuffer.splice(0, digestBuffer.length);
  lastDigestFlushAt.clear();
}

function getDigestFlushIntervalMs(): number {
  // min interval between digest flushes (default 4 h → ≤2 flushes per 8-h active window)
  const hours = parseInt(process.env.PAPERCLIP_PUSH_DIGEST_INTERVAL_HOURS ?? "4", 10);
  return (isNaN(hours) ? 4 : Math.max(1, hours)) * 60 * 60 * 1000;
}

async function maybeFlushDigest(push: ReturnType<typeof webPushService>, companyId: string): Promise<void> {
  const companyDigestItems = digestBuffer.filter((item) => item.companyId === companyId);
  if (companyDigestItems.length === 0) return;
  if (isInQuietHours()) return; // digest always defers to next window
  if (Date.now() - (lastDigestFlushAt.get(companyId) ?? 0) < getDigestFlushIntervalMs()) return;

  const blockedCount = companyDigestItems.filter((i) => i.kind === "blocked").length;
  const staleCount = companyDigestItems.filter((i) => i.kind === "stale").length;
  const parts: string[] = [];
  if (blockedCount > 0) parts.push(`${blockedCount} blocked`);
  if (staleCount > 0) parts.push(`${staleCount} stale`);

  logger.info({ companyId, blockedCount, staleCount }, "push-fanout: flushing digest");

  await push.sendToBoard(companyId, {
    title: `${parts.join(", ")} — tap to view`,
    body: "Issues need your attention",
    data: { kind: "digest", blockedCount, staleCount },
  });

  for (let index = digestBuffer.length - 1; index >= 0; index--) {
    if (digestBuffer[index]?.companyId === companyId) {
      digestBuffer.splice(index, 1);
    }
  }
  lastDigestFlushAt.set(companyId, Date.now());
}

export function initPushFanout(db: Db): () => void {
  const push = webPushService(db);

  const unsubscribe = subscribeGlobalLiveEvents((event) => {
    void (async () => {
      try {
        const { type, payload } = event;
        const companyId = event.companyId;
        const issueId = typeof payload.issueId === "string" ? payload.issueId : undefined;
        if (!issueId) return;

        const issueIdentifier = typeof payload.issueIdentifier === "string" ? payload.issueIdentifier : issueId;
        const issueTitle = typeof payload.issueTitle === "string" ? payload.issueTitle : "";

        if (type === "issue.user_assigned" || type === "issue.interaction.pending") {
          if (isDuped(companyId, issueId, type)) {
            logger.debug({ companyId, issueId, type }, "push-fanout: deduped immediate event");
            return;
          }

          // Immediate lane — assignment overrides quiet hours per spec; interactions follow same rule.
          const title =
            type === "issue.user_assigned"
              ? `Action needed: ${issueIdentifier}`
              : `Your input needed: ${issueIdentifier}`;

          await push.sendToBoard(companyId, { title, body: issueTitle, data: { issueId, eventType: type } });
          logger.info({ companyId, issueId, type }, "push-fanout: sent immediate push");
        }

        if (type === "issue.blocked" || type === "issue.stale") {
          if (!lastDigestFlushAt.has(companyId)) {
            // Start each company digest window at first queued item.
            lastDigestFlushAt.set(companyId, Date.now());
          }
          digestBuffer.push({
            companyId,
            issueId,
            issueTitle,
            issueIdentifier,
            kind: type === "issue.blocked" ? "blocked" : "stale",
            queuedAt: Date.now(),
          });
          await maybeFlushDigest(push, companyId);
        }
      } catch (err) {
        logger.warn({ err, eventType: event.type }, "push-fanout: error handling live event");
      }
    })();
  });

  // Periodic digest-flush check (every minute) so digest isn't gated solely on new events.
  const flushTimer = setInterval(() => {
    if (digestBuffer.length > 0) {
      for (const companyId of new Set(digestBuffer.map((item) => item.companyId))) {
        void maybeFlushDigest(push, companyId).catch((err) => {
          logger.warn({ err, companyId }, "push-fanout: periodic digest flush failed");
        });
      }
    }
  }, 60_000);
  flushTimer.unref?.();

  return () => {
    unsubscribe();
    clearInterval(flushTimer);
  };
}
