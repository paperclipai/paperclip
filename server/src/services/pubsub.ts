import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gte, gt, inArray, isNull, isNotNull, like, lte, ne, notInArray, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests, agents, activityLog, companies, heartbeatRuns, pubsubActivityReceipts, pubsubMessages, pubsubNonces, pubsubObservers,
  pubsubOutbox, pubsubSubscriptions, pubsubTrust, type Db,
} from "@paperclipai/db";
import {
  canonicalPubsubJson,
  PUBSUB_INBOUND_RETENTION_MS,
  PUBSUB_MAX_PENDING_INBOX,
  PUBSUB_MAX_PENDING_INBOX_BYTES,
  PUBSUB_MAX_PENDING_WAKES,
  PUBSUB_DELIVERY_MAX_ATTEMPTS,
  PUBSUB_NONCE_RETENTION_MS,
  PUBSUB_PEER_MAX_RATE_MESSAGES,
  PUBSUB_RATE_WINDOW_MS,
  PUBSUB_VISIBILITY_TIMEOUT_MS,
  PUBSUB_WAKE_STALE_MS,
  pubsubEnvelopeSchema,
  pubsubIdSchema,
  pubsubPublishSchema,
  pubsubSubscribeSchema,
  pubsubTopicBindsEndpoints,
  pubsubTopicMatches,
  pubsubTopicSchema,
  pubsubTrustSchema,
  type PubsubEnvelope, type PubsubIdentity, type PubsubItem, type PubsubPage,
} from "@paperclipai/shared";
import { badRequest, conflict, forbidden, notFound, tooManyRequests } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { normalizePubsubPublicKey, pubsubDeliveryUrl, pubsubMessageDigest, signPubsubEnvelope, verifyPubsubEnvelope } from "./pubsub-crypto.js";
import { loadPubsubIdentity, type PubsubSigningIdentity } from "./pubsub-identity.js";
export { ensurePubsubIdentity } from "./pubsub-identity.js";
import { logActivity } from "./activity-log.js";
import { assertPublicRemoteHttpEndpoint, type RemoteHttpEndpointLookup } from "./remote-http-endpoint-guard.js";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";
import { PUBSUB_BUDGET_PAUSE_CANCELLATION, PUBSUB_DELIVERED_WAKE_STATUSES, PUBSUB_SETTLED_RUN_STATUSES, pubsubRunIsLive } from "./pubsub-wake.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Trust = typeof pubsubTrust.$inferSelect;
type Subscription = typeof pubsubSubscriptions.$inferSelect;
type Message = typeof pubsubMessages.$inferSelect;
export interface PubsubPublishInput {
  companyId: string;
  agentId: string | null;
  role: "ceo" | "board" | "system";
  topic: string;
  payload: unknown;
}
export interface PubsubTrustInput {
  companyId: string;
  peerInstanceId: string;
  peerCompanyId: string;
  publicKey: string;
  url: string;
  topics: string[];
}
/** The durable row fields a wake needs; `envelope` is provenance, never required. */
export interface PubsubInboundMessage {
  id: string;
  topic: string;
  payload: unknown;
  fromInstance: string;
  fromCompany: string;
  fromAgent: string | null;
  fromRole: "ceo" | "board" | "system";
  envelope: PubsubEnvelope | null;
}
export interface PubsubServiceOptions {
  identityPath?: string;
  wake?: (companyId: string, message: PubsubInboundMessage) => Promise<void>;
  visibilityMs?: number;
  /**
   * Operator-managed allowlist of private/reserved hostnames PubSub may deliver
   * to. Peer URLs are checked against the repository's remote-HTTP egress guard
   * at trust-write time and on every dispatch; a URL whose host (or resolved
   * address) is loopback, RFC1918, CGNAT, or other private/reserved space is
   * rejected unless that host is listed here. Defaults to the
   * `PAPERCLIP_PUBSUB_ALLOWED_PRIVATE_HOSTS` env var (comma/space separated).
   * Link-local space (169.254/16, fe80::/10) is denied in every mode.
   */
  privatePeerHosts?: string[];
  /** Test seam for the egress DNS lookup, mirroring `RemoteHttpEndpointGuardOptions.lookup`. */
  peerDnsLookup?: RemoteHttpEndpointLookup;
}
export interface PubsubService {
  identity(): Promise<PubsubIdentity>;
  addTrust(input: PubsubTrustInput): Promise<Trust>;
  revokeTrust(companyId: string, peerInstanceId: string): Promise<void>;
  listTrust(companyId: string): Promise<Trust[]>;
  subscribe(input: { companyId: string; peerInstanceId: string; topic: string }): Promise<Subscription>;
  unsubscribe(companyId: string, id: string): Promise<void>;
  subscriptions(companyId: string): Promise<Subscription[]>;
  publish(input: PubsubPublishInput): Promise<{ id: string; queued: number }>;
  publishActivity(eventId: string, input: PubsubPublishInput): Promise<{ id: string; queued: number }>;
  receive(envelope: unknown): Promise<{ id: string; duplicate: boolean }>;
  inbox(companyId: string, options?: { limit?: number; after?: string; observer?: boolean }): Promise<PubsubPage>;
  ack(companyId: string, id: string): Promise<PubsubItem>;
  history(companyId: string, options: { topic: string; limit?: number; after?: string }): Promise<PubsubPage>;
  addObserver(companyId: string, agentId: string): Promise<void>;
  removeObserver(companyId: string, agentId: string): Promise<void>;
  isObserver(companyId: string, agentId: string): Promise<boolean>;
  start(): Promise<() => Promise<void>>;
  stop(): Promise<void>;
}

function pageOptions(options: { limit?: number; after?: string }) {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw badRequest("PubSub limit must be between 1 and 100");
  let cursor: { createdAt: Date; id: string } | undefined;
  if (options.after) {
    try {
      if (options.after.length > 256) throw new Error("Long cursor");
      const value = JSON.parse(Buffer.from(options.after, "base64url").toString("utf8"));
      const id = pubsubIdSchema.parse(value.id);
      const createdAt = new Date(value.createdAt);
      if (createdAt.toISOString() !== value.createdAt) throw new Error("Invalid cursor date");
      cursor = { id, createdAt };
    } catch { throw badRequest("Invalid PubSub cursor"); }
  }
  const predicate = cursor ? or(gt(pubsubMessages.createdAt, cursor.createdAt),
    and(eq(pubsubMessages.createdAt, cursor.createdAt), gt(pubsubMessages.id, cursor.id))) : undefined;
  return { limit, predicate };
}
function messageItem(row: Message): PubsubItem {
  return {
    id: row.id, topic: row.topic, payload: row.payload,
    fromInstance: row.fromInstance, fromCompany: row.fromCompany, fromAgent: row.fromAgent, fromRole: row.fromRole,
    createdAt: row.createdAt.toISOString(), ackedAt: row.ackedAt?.toISOString() ?? null,
    deliveryCount: row.deliveryCount,
  };
}
function messagePage(rows: Message[], limit: number): PubsubPage {
  const items = rows.slice(0, limit).map(messageItem);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last
    ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString("base64url") : null };
}
function retryDelay(attempts: number): number {
  return Math.min(30000, 250 * 2 ** Math.min(attempts, 7));
}
/**
 * A delivery failure whose `permanent` verdict says it will not self-heal:
 * the peer HTTP-rejected the envelope (4xx other than 429 backpressure) or
 * the egress guard rejected the destination (private/reserved address the
 * operator has not allowlisted). Only permanent failures consume the delivery
 * attempt budget; transient failures (peer offline, connection refused,
 * timeouts, 5xx, 429) retry indefinitely with capped backoff, so a peer
 * outage of any length never loses a queued message to budget exhaustion.
 */
class PubsubDeliveryError extends Error {
  constructor(message: string, readonly permanent: boolean) {
    super(message);
  }
}

export function createPubsubService(db: Db, options: PubsubServiceOptions = {}): PubsubService {
  const visibilityMs = options.visibilityMs ?? Number(process.env.PAPERCLIP_PUBSUB_VISIBILITY_MS ?? PUBSUB_VISIBILITY_TIMEOUT_MS);
  if (!Number.isFinite(visibilityMs) || visibilityMs < 100 || visibilityMs > 3600000) throw badRequest("Invalid PubSub visibility timeout");
  // Operator-managed private-peer allowlist. Peer URLs are tenant-controlled
  // (board-scope trust writes), so egress to loopback, RFC1918, CGNAT, and other
  // private/reserved space is denied by default; an operator opts in per host.
  const privatePeerHosts: Record<string, true> = Object.fromEntries(
    (options.privatePeerHosts ?? (process.env.PAPERCLIP_PUBSUB_ALLOWED_PRIVATE_HOSTS ?? "").split(/[,\s]+/))
      .map((host) => host.trim().toLowerCase().replace(/\.$/, ""))
      .filter((host) => host.length > 0)
      .map((host) => [host, true] as const),
  );
  let signingIdentity: Promise<PubsubSigningIdentity> | undefined;
  function loadIdentity(): Promise<PubsubSigningIdentity> {
    signingIdentity ??= loadPubsubIdentity(options.identityPath).catch((error) => {
      signingIdentity = undefined;
      throw error;
    });
    return signingIdentity;
  }
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  async function enqueue(tx: Transaction, input: PubsubPublishInput, id: string, local: PubsubSigningIdentity) {
    pubsubIdSchema.parse(input.companyId);
    const parsed = pubsubPublishSchema.parse({ topic: input.topic, payload: input.payload });
    if (parsed.topic.startsWith("fleet.p2p.") && input.role !== "ceo") throw forbidden("P2P publication requires the actual local CEO");
    if (input.role === "ceo") {
      if (!input.agentId) throw forbidden("CEO identity is required");
      const [agent] = await tx.select().from(agents).where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId))).for("share");
      if (!agent || agent.role !== "ceo" || agent.status === "terminated" || agent.status === "pending_approval") throw forbidden("Only the actual local CEO may publish as CEO");
    } else if ((input.role !== "board" && input.role !== "system") || input.agentId !== null) {
      throw forbidden("Invalid PubSub publishing principal");
    }
    const peers = await tx.select().from(pubsubTrust).where(and(eq(pubsubTrust.companyId, input.companyId), isNull(pubsubTrust.revokedAt))).for("share");
    const targets = peers.filter((peer) => peer.topics.some((grant) => pubsubTopicMatches(grant, parsed.topic))
      && pubsubTopicBindsEndpoints(parsed.topic, local.instanceId, peer.peerInstanceId));
    if (parsed.topic.startsWith("fleet.p2p.") && !parsed.topic.split(".").slice(2).includes(local.instanceId)) {
      throw forbidden("P2P topic must include this instance");
    }
    const now = new Date();
    await tx.insert(pubsubMessages).values({
      companyId: input.companyId, id, direction: "outgoing", topic: parsed.topic, payload: parsed.payload === null ? sql`'null'::jsonb` : parsed.payload,
      fromInstance: local.instanceId, fromCompany: input.companyId, fromAgent: input.agentId, fromRole: input.role,
      contentHash: createHash("sha256").update(canonicalPubsubJson({ topic: parsed.topic, payload: parsed.payload })).digest("hex"), createdAt: now,
    });
    if (targets.length) await tx.insert(pubsubOutbox).values(targets.map((peer) => ({
      companyId: input.companyId, messageId: id, peerInstanceId: peer.peerInstanceId, peerCompanyId: peer.peerCompanyId,
    })));
    return { id, queued: targets.length };
  }

  async function deliverPending(): Promise<void> {
    const candidates = await db.select().from(pubsubOutbox).where(and(isNull(pubsubOutbox.deliveredAt),
      isNull(pubsubOutbox.cancelledAt), lte(pubsubOutbox.availableAt, new Date())))
      .orderBy(asc(pubsubOutbox.availableAt), asc(pubsubOutbox.id)).limit(8);
    const dispatched = await Promise.allSettled(candidates.map(async (candidate) => {
      await db.transaction(async (tx) => {
        // Transaction row locks are crash-released leases, with no post-restart expiry gap.
        // Policy is always locked first: revoke cannot return while an authorized POST is in flight.
        const [trust] = await tx.select().from(pubsubTrust).where(and(eq(pubsubTrust.companyId, candidate.companyId), eq(pubsubTrust.peerInstanceId, candidate.peerInstanceId))).for("share");
        const [row] = await tx.select().from(pubsubOutbox).where(and(eq(pubsubOutbox.id, candidate.id),
          isNull(pubsubOutbox.deliveredAt), isNull(pubsubOutbox.cancelledAt), lte(pubsubOutbox.availableAt, new Date())))
          .for("update", { skipLocked: true });
        if (!row) return;
        const [message] = await tx.select().from(pubsubMessages).where(and(eq(pubsubMessages.companyId, row.companyId), eq(pubsubMessages.id, row.messageId)));
        if (!trust || trust.revokedAt || trust.peerCompanyId !== row.peerCompanyId || !message
          || !trust.topics.some((topic) => pubsubTopicMatches(topic, message.topic))) {
          await tx.update(pubsubOutbox).set({ cancelledAt: new Date(), lastError: "Peer trust or topic permission revoked" }).where(eq(pubsubOutbox.id, row.id));
          return;
        }
        try {
          const local = await loadIdentity();
          const envelope = signPubsubEnvelope({
            version: 1, id: message.id, from_instance: message.fromInstance, from_company: message.fromCompany,
            from_agent: message.fromAgent, from_role: message.fromRole, to_instance: row.peerInstanceId,
            to_company: row.peerCompanyId, to_topic: message.topic, payload: message.payload,
            timestamp: new Date().toISOString(), nonce: randomUUID(),
          }, local.privateKey);
          const url = pubsubDeliveryUrl(trust.url);
          // The egress guard validates the peer's resolved address on every
          // dispatch and dials the approved address directly, so a tenant trust
          // URL cannot steer delivery at loopback or private services (a
          // rebinding DNS answer included). Private peers require the exact
          // host on the operator allowlist; link-local is never allowed.
          const response = await guardedRemoteHttpFetch(url, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope),
          }, {
            allowPrivateNetwork: Boolean(privatePeerHosts[new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase()]),
            lookup: options.peerDnsLookup,
            connectTimeoutMs: 5000,
            responseTimeoutMs: 5000,
            error: (guardMessage) => new PubsubDeliveryError(`PubSub peer egress rejected: ${guardMessage}`, true),
          });
          await response.body?.cancel();
          // A peer HTTP rejection of the envelope (4xx other than 429
          // backpressure) will not self-heal; network-level failures, 5xx, and
          // 429 will, so only the former consumes the delivery budget.
          if (!response.ok) throw new PubsubDeliveryError(`PubSub peer returned HTTP ${response.status}`,
            response.status >= 400 && response.status < 500 && response.status !== 429);
          await tx.update(pubsubOutbox).set({ attempts: row.attempts + 1, deliveredAt: new Date(), lastError: null }).where(eq(pubsubOutbox.id, row.id));
        } catch (error) {
          const attempts = row.attempts + 1;
          const lastError = (error instanceof Error ? error.message : String(error)).slice(0, 900);
          const permanent = error instanceof PubsubDeliveryError && error.permanent;
          if (attempts >= PUBSUB_DELIVERY_MAX_ATTEMPTS && permanent) {
            // Delivery budget exhausted on a permanent rejection: abandon the
            // delivery with a visible error instead of retrying forever (the
            // message itself stays in history). Transient failures never
            // consume the budget, so a peer outage of any length cannot lose a
            // queued message — it redelivers when the peer comes back.
            await tx.update(pubsubOutbox).set({ attempts, cancelledAt: new Date(),
              lastError: (lastError + " (delivery budget exhausted: " + attempts + " attempts)").slice(0, 1000),
            }).where(eq(pubsubOutbox.id, row.id));
          } else {
            await tx.update(pubsubOutbox).set({ attempts,
              availableAt: new Date(Date.now() + retryDelay(row.attempts)),
              lastError,
            }).where(eq(pubsubOutbox.id, row.id));
          }
        }
      });
    }));
    for (const result of dispatched) {
      if (result.status === "rejected") logger.error({ err: result.reason }, "PubSub dispatch failed; transaction released for retry");
    }
  }

  async function wakePending(): Promise<void> {
    if (!options.wake) return;
    // The row lock is the lease: it spans durable wake enqueue and is released on process/connection death.
    // An expiry-only lease could let two workers invoke a slow heartbeat callback concurrently.
    for (let count = 0; count < 8; count++) {
      const found = await db.transaction(async (tx) => {
        const [row] = await tx.select().from(pubsubMessages).where(and(eq(pubsubMessages.wakePending, 1), lte(pubsubMessages.wakeAvailableAt, new Date())))
          .orderBy(asc(pubsubMessages.wakeAvailableAt)).limit(1).for("update", { skipLocked: true });
        if (!row) return false;
        try {
          if (row.envelope) {
            await options.wake!(row.companyId, {
              id: row.id, topic: row.topic, payload: row.payload,
              fromInstance: row.fromInstance, fromCompany: row.fromCompany,
              fromAgent: row.fromAgent, fromRole: row.fromRole, envelope: row.envelope,
            });
          }
          await tx.update(pubsubMessages).set({ wakePending: 0 }).where(and(eq(pubsubMessages.companyId, row.companyId), eq(pubsubMessages.id, row.id)));
        } catch (error) {
          await tx.update(pubsubMessages).set({ wakeAttempts: row.wakeAttempts + 1,
            wakeAvailableAt: new Date(Date.now() + retryDelay(row.wakeAttempts)),
          }).where(and(eq(pubsubMessages.companyId, row.companyId), eq(pubsubMessages.id, row.id)));
          logger.warn({ err: error, messageId: row.id }, "PubSub wake enqueue will retry");
        }
        return true;
      });
      if (!found) break;
    }
  }

  /**
   * Re-arm PubSub wakes the heartbeat cancelled after this worker cleared the
   * flag — a budget pause cancels the enqueued wake, and createPubsubWake's
   * receipt verdict treats that cancellation as undelivered. The same verdict
   * the wake guard applies suppresses re-arm: any delivered receipt, or any
   * non-budget (operator) cancellation, for the message's receipts. Without
   * that check a stale skipped/budget-pause receipt from an earlier attempt
   * would re-arm a message whose later attempt already delivered or the
   * operator stopped — re-doing the work every tick, holding the row's
   * `wake_pending` flag against the retention sweep, and stomping the
   * worker's retry backoff. `wake_available_at` only advances when it is in
   * the past, so re-arm never overrides an active backoff.
   */
  async function rearmCancelledWakes(): Promise<void> {
    if (!options.wake) return;
    const receipts = await db.select({
      companyId: agentWakeupRequests.companyId,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
    }).from(agentWakeupRequests).where(and(
      like(agentWakeupRequests.idempotencyKey, "pubsub:%"),
      or(
        eq(agentWakeupRequests.status, "skipped"),
        and(eq(agentWakeupRequests.status, "cancelled"),
          eq(agentWakeupRequests.error, PUBSUB_BUDGET_PAUSE_CANCELLATION))),
    ));
    for (const receipt of receipts) {
      if (!receipt.idempotencyKey) continue;
      const [, companyId, , , messageId] = receipt.idempotencyKey.split(":");
      if (!companyId || !messageId || companyId !== receipt.companyId) continue;
      const [suppressor] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.idempotencyKey, receipt.idempotencyKey),
        or(
          inArray(agentWakeupRequests.status, [...PUBSUB_DELIVERED_WAKE_STATUSES]),
          and(eq(agentWakeupRequests.status, "cancelled"),
            or(isNull(agentWakeupRequests.error), ne(agentWakeupRequests.error, PUBSUB_BUDGET_PAUSE_CANCELLATION))),
        ),
      )).limit(1);
      if (suppressor) continue;
      await db.update(pubsubMessages).set({ wakePending: 1,
        wakeAvailableAt: sql`greatest(${pubsubMessages.wakeAvailableAt}, now())`,
      }).where(and(
        eq(pubsubMessages.companyId, companyId),
        eq(pubsubMessages.id, messageId),
        eq(pubsubMessages.direction, "incoming"),
        eq(pubsubMessages.wakePending, 0),
      ));
    }
  }

  /**
   * Reconcile PubSub wake receipts whose linked run settled before the
   * receipt did. Every executor path commits the run's terminal status before
   * the wake receipt's, so a crash in that window (or any lost receipt write)
   * leaves a non-terminal receipt for a settled run. The wake guard and the
   * delivery verdict both read these receipts: a stale live receipt would hold
   * the company's wake slot — and every inbound delivery's 429 — indefinitely.
   * `deferred_issue_execution` is excluded: those receipts are owned by the
   * issue-execution recovery, not by run settlement.
   */
  async function reconcileSettledWakeReceipts(): Promise<void> {
    if (!options.wake) return;
    const stale = await db
      .select({ wake: agentWakeupRequests, run: heartbeatRuns })
      .from(agentWakeupRequests)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, agentWakeupRequests.runId))
      .where(and(
        like(agentWakeupRequests.idempotencyKey, "pubsub:%"),
        inArray(agentWakeupRequests.status, ["queued", "claimed", "coalesced", "running"]),
        isNotNull(agentWakeupRequests.runId),
        inArray(heartbeatRuns.status, [...PUBSUB_SETTLED_RUN_STATUSES]),
      ))
      .limit(16);
    for (const { wake, run } of stale) {
      const status = run.status === "succeeded" ? "completed"
        : run.status === "skipped" ? "skipped"
          : run.status === "cancelled" || run.status === "interrupted" ? "cancelled"
            : "failed";
      const updated = await db.update(agentWakeupRequests).set({
        status,
        finishedAt: run.finishedAt ?? new Date(),
        error: status === "completed" ? null : (run.error ?? null),
        updatedAt: new Date(),
      }).where(and(
        eq(agentWakeupRequests.id, wake.id),
        inArray(agentWakeupRequests.status, ["queued", "claimed", "coalesced", "running"]),
      )).returning({ id: agentWakeupRequests.id });
      if (updated.length > 0) logger.info({ wakeId: wake.id, runId: run.id, runStatus: run.status }, "PubSub wake receipt reconciled to settled run");
    }
  }

  /**
   * Finalize PubSub wake receipts orphaned together with their run: the
   * linked run is still open but has stopped producing every liveness
   * signal, and the receipt itself has aged past the stale window. Recovery
   * deliberately parks ownership-ambiguous runs (SIGKILL'd controllers,
   * providers whose authority cannot be verified) non-terminal until an
   * operator resolves them, so the settled-run reconciliation above can
   * never reach those pairs; without this sweep their receipts would stay
   * non-terminal forever. The verdict mirrors the wake guard's
   * (pubsubRunIsLive), so the sweep never contradicts a receipt the guard
   * still treats as holding the company slot. The run keeps its own state:
   * if recovery later re-adopts it, its executor path overwrites this
   * receipt with the run's real outcome. `finishedAt` comes from the
   * receipt's last touch — already outside the cooldown window — so
   * finalizing an orphan does not re-block the slot for a wake that never
   * executed. `deferred_issue_execution` is excluded: those receipts are
   * owned by the issue-execution recovery, not by run settlement.
   */
  async function reconcileOrphanedWakeReceipts(): Promise<void> {
    if (!options.wake) return;
    const now = new Date();
    const orphaned = await db
      .select({ wake: agentWakeupRequests, run: heartbeatRuns })
      .from(agentWakeupRequests)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, agentWakeupRequests.runId))
      .where(and(
        like(agentWakeupRequests.idempotencyKey, "pubsub:%"),
        inArray(agentWakeupRequests.status, ["queued", "claimed", "coalesced", "running"]),
        isNotNull(agentWakeupRequests.runId),
        lte(agentWakeupRequests.updatedAt, new Date(now.getTime() - PUBSUB_WAKE_STALE_MS)),
        notInArray(heartbeatRuns.status, [...PUBSUB_SETTLED_RUN_STATUSES]),
        sql`not (${pubsubRunIsLive(now)})`,
      ))
      .limit(16);
    for (const { wake, run } of orphaned) {
      const updated = await db.update(agentWakeupRequests).set({
        status: "failed",
        finishedAt: wake.updatedAt ?? now,
        error: "Orphaned wake: the linked run lost liveness without finalizing",
        updatedAt: now,
      }).where(and(
        eq(agentWakeupRequests.id, wake.id),
        inArray(agentWakeupRequests.status, ["queued", "claimed", "coalesced", "running"]),
      )).returning({ id: agentWakeupRequests.id });
      if (updated.length > 0) logger.info({ wakeId: wake.id, runId: run.id, runStatus: run.status }, "PubSub wake receipt finalized as orphaned");
    }
  }

  /**
   * Bounded retention: expire the replay nonce cache and pruned inbox history.
   * A message whose mandatory CEO wake is still pending is never swept, no
   * matter how long ago it was acked — the wake must be redelivered when a
   * CEO becomes available, and the pending-wake quota bounds the footprint.
   */
  async function sweepRetention(): Promise<void> {
    await db.delete(pubsubNonces).where(lte(pubsubNonces.receivedAt, new Date(Date.now() - PUBSUB_NONCE_RETENTION_MS)));
    await db.delete(pubsubMessages).where(and(
      eq(pubsubMessages.direction, "incoming"),
      eq(pubsubMessages.wakePending, 0),
      isNotNull(pubsubMessages.ackedAt),
      lte(pubsubMessages.ackedAt, new Date(Date.now() - PUBSUB_INBOUND_RETENTION_MS)),
    ));
  }
  function tick(): void {
    if (running) return;
    running = Promise.allSettled([deliverPending(), rearmCancelledWakes(), reconcileSettledWakeReceipts(), reconcileOrphanedWakeReceipts(), wakePending(), sweepRetention()]).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") logger.error({ err: result.reason }, "PubSub worker tick failed; durable work retained");
      }
    }).finally(() => { running = undefined; });
  }

  const service: PubsubService = {
    async identity() {
      const { instanceId, publicKey } = await loadIdentity();
      return { instanceId, publicKey };
    },
    async addTrust(input) {
      pubsubIdSchema.parse(input.companyId);
      const { companyId, ...fields } = input;
      const parsed = pubsubTrustSchema.parse(fields);
      const local = await loadIdentity();
      if (parsed.peerInstanceId === local.instanceId) throw badRequest("A PubSub peer must be a different instance");
      const values = { ...parsed, companyId, publicKey: normalizePubsubPublicKey(parsed.publicKey), url: pubsubDeliveryUrl(parsed.url), revokedAt: null, updatedAt: new Date() };
      // Egress guard at trust write: the URL is tenant-controlled (board
      // scope), so reject destinations that resolve to loopback,
      // private/reserved, or link-local addresses unless the operator
      // allowlisted that exact host. Link-local is denied in every mode.
      // Dispatch re-validates on every attempt against the same policy.
      const deliveryUrl = new URL(values.url);
      await assertPublicRemoteHttpEndpoint(deliveryUrl, {
        allowPrivateNetwork: Boolean(privatePeerHosts[deliveryUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase()]),
        lookup: options.peerDnsLookup,
      }, (guardMessage) => badRequest(guardMessage));
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pubsub-trust:${companyId}:${parsed.peerInstanceId}`}, 0))`);
        const [previous] = await tx.select().from(pubsubTrust).where(and(eq(pubsubTrust.companyId, companyId), eq(pubsubTrust.peerInstanceId, parsed.peerInstanceId))).for("update");
        if (previous && (previous.publicKey !== values.publicKey || previous.peerCompanyId !== values.peerCompanyId)) {
          await tx.delete(pubsubSubscriptions).where(and(eq(pubsubSubscriptions.companyId, companyId), eq(pubsubSubscriptions.peerInstanceId, parsed.peerInstanceId)));
          await tx.update(pubsubOutbox).set({ cancelledAt: new Date() }).where(and(eq(pubsubOutbox.companyId, companyId), eq(pubsubOutbox.peerInstanceId, parsed.peerInstanceId), isNull(pubsubOutbox.deliveredAt)));
        }
        const [row] = await tx.insert(pubsubTrust).values(values).onConflictDoUpdate({ target: [pubsubTrust.companyId, pubsubTrust.peerInstanceId], set: values }).returning();
        return row!;
      });
    },
    async revokeTrust(companyId, peerInstanceId) {
      pubsubIdSchema.parse(companyId); pubsubIdSchema.parse(peerInstanceId);
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pubsub-trust:${companyId}:${peerInstanceId}`}, 0))`);
        await tx.update(pubsubTrust).set({ revokedAt: new Date(), updatedAt: new Date() }).where(and(eq(pubsubTrust.companyId, companyId), eq(pubsubTrust.peerInstanceId, peerInstanceId)));
        await tx.delete(pubsubSubscriptions).where(and(eq(pubsubSubscriptions.companyId, companyId), eq(pubsubSubscriptions.peerInstanceId, peerInstanceId)));
        await tx.update(pubsubOutbox).set({ cancelledAt: new Date() }).where(and(eq(pubsubOutbox.companyId, companyId), eq(pubsubOutbox.peerInstanceId, peerInstanceId), isNull(pubsubOutbox.deliveredAt)));
      });
    },
    async listTrust(companyId) {
      pubsubIdSchema.parse(companyId);
      return db.select().from(pubsubTrust).where(eq(pubsubTrust.companyId, companyId)).orderBy(asc(pubsubTrust.createdAt));
    },
    async subscribe(input) {
      pubsubIdSchema.parse(input.companyId);
      const parsed = pubsubSubscribeSchema.parse({ peerInstanceId: input.peerInstanceId, topic: input.topic });
      const local = await loadIdentity();
      if (!parsed.topic.includes("*") && !pubsubTopicBindsEndpoints(parsed.topic, parsed.peerInstanceId, local.instanceId)) throw forbidden("P2P subscription must bind both instances");
      return db.transaction(async (tx) => {
        const [trust] = await tx.select().from(pubsubTrust).where(and(eq(pubsubTrust.companyId, input.companyId), eq(pubsubTrust.peerInstanceId, parsed.peerInstanceId))).for("share");
        if (!trust || trust.revokedAt || !trust.topics.some((grant) => pubsubTopicMatches(grant, parsed.topic))) throw forbidden("No peer grant permits this subscription");
        await tx.insert(pubsubSubscriptions).values({ companyId: input.companyId, ...parsed }).onConflictDoNothing();
        const [row] = await tx.select().from(pubsubSubscriptions).where(and(eq(pubsubSubscriptions.companyId, input.companyId), eq(pubsubSubscriptions.peerInstanceId, parsed.peerInstanceId), eq(pubsubSubscriptions.topic, parsed.topic)));
        return row!;
      });
    },
    async unsubscribe(companyId, id) {
      pubsubIdSchema.parse(companyId); pubsubIdSchema.parse(id);
      await db.transaction(async (tx) => {
        const [subscription] = await tx.select().from(pubsubSubscriptions).where(and(eq(pubsubSubscriptions.companyId, companyId), eq(pubsubSubscriptions.id, id)));
        if (!subscription) return;
        await tx.select().from(pubsubTrust).where(and(eq(pubsubTrust.companyId, companyId), eq(pubsubTrust.peerInstanceId, subscription.peerInstanceId))).for("update");
        await tx.delete(pubsubSubscriptions).where(and(eq(pubsubSubscriptions.companyId, companyId), eq(pubsubSubscriptions.id, id)));
      });
    },
    async subscriptions(companyId) {
      pubsubIdSchema.parse(companyId);
      return db.select().from(pubsubSubscriptions).where(eq(pubsubSubscriptions.companyId, companyId)).orderBy(asc(pubsubSubscriptions.createdAt));
    },
    async publish(input) {
      // Task events are journal-shaped traffic: only the activity worker may
      // mint them, so board/CEO publication of fleet.task.* is not a public act.
      if (input.topic.startsWith("fleet.task.")) throw forbidden("Task topics are reserved for the activity journal");
      const local = await loadIdentity();
      return db.transaction((tx) => enqueue(tx, input, randomUUID(), local));
    },
    async publishActivity(eventId, input) {
      pubsubIdSchema.parse(eventId);
      if (input.role !== "system" || input.agentId !== null || !input.topic.startsWith("fleet.task.")) throw forbidden("Activity publication is system task traffic only");
      const local = await loadIdentity();
      return db.transaction(async (tx) => {
        const [event] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.id, eventId), eq(activityLog.companyId, input.companyId)));
        if (!event) throw notFound("PubSub source activity not found in company");
        const id = randomUUID();
        const [receipt] = await tx.insert(pubsubActivityReceipts).values({ eventId, topic: input.topic, companyId: input.companyId, messageId: id }).onConflictDoNothing().returning();
        if (!receipt) {
          const [existing] = await tx.select().from(pubsubActivityReceipts).where(and(eq(pubsubActivityReceipts.eventId, eventId), eq(pubsubActivityReceipts.topic, input.topic)));
          return { id: existing!.messageId, queued: 0 };
        }
        return enqueue(tx, input, id, local);
      });
    },
    async receive(input) {
      const parsed = pubsubEnvelopeSchema.safeParse(input);
      if (!parsed.success) throw badRequest("Invalid PubSub envelope", parsed.error.flatten());
      const envelope = parsed.data;
      const local = await loadIdentity();
      if (envelope.to_instance !== local.instanceId || envelope.from_instance === local.instanceId) throw forbidden("PubSub recipient mismatch");
      if (envelope.to_topic.startsWith("fleet.p2p.") && envelope.from_role !== "ceo") throw forbidden("P2P publication requires a CEO sender");
      if (envelope.to_topic.startsWith("fleet.task.") && envelope.from_role !== "system") throw forbidden("Task events require a system sender");
      return db.transaction(async (tx) => {
        const [trust] = await tx.select().from(pubsubTrust).where(and(eq(pubsubTrust.companyId, envelope.to_company), eq(pubsubTrust.peerInstanceId, envelope.from_instance))).for("share");
        if (!trust || trust.revokedAt || trust.peerCompanyId !== envelope.from_company) throw forbidden("PubSub peer is untrusted or revoked for this company");
        // The deliver route is signature-authenticated with no credential rate
        // limit, so verify before the ACL scans: invalid traffic should not pay
        // the cost of the topic-grant and subscription lookups.
        verifyPubsubEnvelope(envelope, trust.publicKey);
        if (!trust.topics.some((grant) => pubsubTopicMatches(grant, envelope.to_topic))) throw forbidden("PubSub peer topic is not granted");
        const subscriptions = await tx.select().from(pubsubSubscriptions).where(and(eq(pubsubSubscriptions.companyId, envelope.to_company), eq(pubsubSubscriptions.peerInstanceId, envelope.from_instance)));
        if (!subscriptions.some((subscription) => pubsubTopicMatches(subscription.topic, envelope.to_topic))) throw forbidden("No explicit PubSub subscription permits this topic");
        // Ingress admission: per-peer rate, wake queue, and pending-inbox quotas
        // are checked under a company-wide lock before the durable insert, so an
        // over-quota peer gets an operator-visible 429 (the sender's outbox
        // retries with backpressure) instead of unbounded storage or CEO wakes.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pubsub-admission:${envelope.to_company}`}, 0))`);
        const contentHash = pubsubMessageDigest(envelope);
        // Idempotent retries resolve before admission: a message already stored
        // durably is re-accepted with its stored content regardless of quota
        // state. A full quota must never turn a lost-response retry into a 429
        // (or let the stored message itself keep the quota full against its own
        // re-send) — the promised duplicate 200 holds even when every quota is
        // exhausted.
        const [existing] = await tx.select().from(pubsubMessages).where(and(
          eq(pubsubMessages.companyId, envelope.to_company),
          eq(pubsubMessages.id, envelope.id),
        ));
        if (existing) {
          if (existing.direction !== "incoming" || existing.contentHash !== contentHash) throw conflict("PubSub message id conflicts with previously received content");
          return { id: envelope.id, duplicate: true };
        }
        const [rate] = await tx.select({ n: sql<number>`count(*)::int` }).from(pubsubMessages).where(and(
          eq(pubsubMessages.companyId, envelope.to_company),
          eq(pubsubMessages.fromInstance, envelope.from_instance),
          eq(pubsubMessages.direction, "incoming"),
          gte(pubsubMessages.createdAt, new Date(Date.now() - PUBSUB_RATE_WINDOW_MS)),
        ));
        if (rate.n >= PUBSUB_PEER_MAX_RATE_MESSAGES) throw tooManyRequests("PubSub peer rate limit exceeded; retry later");
        const [wakeLoad] = await tx.select({ n: sql<number>`count(*)::int` }).from(pubsubMessages).where(and(
          eq(pubsubMessages.companyId, envelope.to_company),
          eq(pubsubMessages.direction, "incoming"),
          eq(pubsubMessages.wakePending, 1),
        ));
        if (wakeLoad.n >= PUBSUB_MAX_PENDING_WAKES) throw tooManyRequests("PubSub wake queue is full; retry later");
        // The byte bound counts the incoming payload as well as stored payloads,
        // so a delivery that lands just under the limit cannot push the inbox
        // over it. The incoming payload is measured through the same jsonb
        // representation as stored rows: canonical JSON and jsonb::text are
        // different units (jsonb expands numeric literals), so comparing the
        // two directly would undercount the stored footprint of large payloads.
        const [incoming] = await tx.select({
          bytes: sql<number>`(select octet_length((${JSON.stringify(envelope.payload)}::jsonb)::text))::int`,
        }).from(companies);
        const [inbox] = await tx.select({
          n: sql<number>`count(*)::int`,
          bytes: sql<number>`coalesce(sum(octet_length(${pubsubMessages.payload}::text)), 0)::int`,
        }).from(pubsubMessages).where(and(
          eq(pubsubMessages.companyId, envelope.to_company),
          eq(pubsubMessages.direction, "incoming"),
          isNull(pubsubMessages.ackedAt),
        ));
        if (inbox.n >= PUBSUB_MAX_PENDING_INBOX || inbox.bytes + incoming.bytes > PUBSUB_MAX_PENDING_INBOX_BYTES) throw tooManyRequests("PubSub pending inbox is full; retry later");
        const [nonce] = await tx.insert(pubsubNonces).values({ companyId: envelope.to_company, peerInstanceId: envelope.from_instance, nonce: envelope.nonce }).onConflictDoNothing().returning();
        if (!nonce) throw conflict("PubSub nonce was already received");
        const [message] = await tx.insert(pubsubMessages).values({
          companyId: envelope.to_company, id: envelope.id, direction: "incoming", topic: envelope.to_topic,
          payload: envelope.payload === null ? sql`'null'::jsonb` : envelope.payload, fromInstance: envelope.from_instance, fromCompany: envelope.from_company,
          fromAgent: envelope.from_agent, fromRole: envelope.from_role, contentHash, envelope,
          createdAt: new Date(), wakePending: 1,
        }).onConflictDoNothing().returning();
        if (!message) {
          // Lost a first-delivery race under the same idempotency resolution:
          // same id, same content is a duplicate; different content is a conflict.
          const [raced] = await tx.select().from(pubsubMessages).where(and(
            eq(pubsubMessages.companyId, envelope.to_company),
            eq(pubsubMessages.id, envelope.id),
          ));
          if (!raced || raced.direction !== "incoming" || raced.contentHash !== contentHash) throw conflict("PubSub message id conflicts with previously received content");
          return { id: envelope.id, duplicate: true };
        }
        // Accepted delivery durably mutates company state (message, nonce,
        // wake queue); AGENTS.md requires an activity entry for mutating
        // endpoints. Written in the same transaction as the message insert so
        // the audit row cannot outlive or lose the delivery it records. The
        // entity id joins to the durable message row, which carries the topic
        // and sender identity; peer topic strings are kept out of the audit
        // details on purpose (dotted fleet topics trip the log redactor's
        // JWT-shape value guard). Duplicate (idempotent retry) acceptances
        // create no rows, so they add no new entries.
        await logActivity(tx as unknown as Db, {
          companyId: envelope.to_company,
          actorType: "system",
          actorId: envelope.from_instance,
          action: "pubsub.delivery_accepted",
          entityType: "pubsub",
          entityId: envelope.id,
        });
        return { id: envelope.id, duplicate: false };
      });
    },
    async inbox(companyId, opts = {}) {
      pubsubIdSchema.parse(companyId);
      const { limit, predicate } = pageOptions(opts);
      const filter = and(eq(pubsubMessages.companyId, companyId), eq(pubsubMessages.direction, "incoming"), isNull(pubsubMessages.ackedAt), predicate,
        opts.observer ? or(like(pubsubMessages.topic, "fleet.chat.%"), like(pubsubMessages.topic, "fleet.p2p.%")) : lte(pubsubMessages.nextVisibleAt, new Date()));
      if (opts.observer) {
        const rows = await db.select().from(pubsubMessages).where(filter).orderBy(asc(pubsubMessages.createdAt), asc(pubsubMessages.id)).limit(limit + 1);
        return messagePage(rows, limit);
      }
      return db.transaction(async (tx) => {
        const rows = await tx.select().from(pubsubMessages).where(filter).orderBy(asc(pubsubMessages.createdAt), asc(pubsubMessages.id)).limit(limit + 1).for("update", { skipLocked: true });
        const selected = rows.slice(0, limit);
        if (selected.length) {
          await tx.update(pubsubMessages).set({ deliveryCount: sql`${pubsubMessages.deliveryCount} + 1`, nextVisibleAt: new Date(Date.now() + visibilityMs) })
            .where(and(eq(pubsubMessages.companyId, companyId), inArray(pubsubMessages.id, selected.map((row) => row.id))));
          for (const row of selected) row.deliveryCount++;
        }
        return messagePage(rows, limit);
      });
    },
    async ack(companyId, id) {
      pubsubIdSchema.parse(companyId); pubsubIdSchema.parse(id);
      const [row] = await db.update(pubsubMessages).set({ ackedAt: sql`coalesce(${pubsubMessages.ackedAt}, now())` }).where(and(eq(pubsubMessages.companyId, companyId), eq(pubsubMessages.id, id), eq(pubsubMessages.direction, "incoming"))).returning();
      if (!row) throw notFound("PubSub inbox message not found");
      return messageItem(row);
    },
    async history(companyId, opts) {
      pubsubIdSchema.parse(companyId); pubsubTopicSchema.parse(opts.topic);
      const { limit, predicate } = pageOptions(opts);
      const rows = await db.select().from(pubsubMessages).where(and(eq(pubsubMessages.companyId, companyId), eq(pubsubMessages.topic, opts.topic), predicate))
        .orderBy(asc(pubsubMessages.createdAt), asc(pubsubMessages.id)).limit(limit + 1);
      return messagePage(rows, limit);
    },
    async addObserver(companyId, agentId) {
      pubsubIdSchema.parse(companyId); pubsubIdSchema.parse(agentId);
      const [agent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
      if (!agent) throw notFound("Observer agent not found in company");
      await db.insert(pubsubObservers).values({ companyId, agentId }).onConflictDoNothing();
    },
    async removeObserver(companyId, agentId) {
      pubsubIdSchema.parse(companyId); pubsubIdSchema.parse(agentId);
      await db.delete(pubsubObservers).where(and(eq(pubsubObservers.companyId, companyId), eq(pubsubObservers.agentId, agentId)));
    },
    async isObserver(companyId, agentId) {
      const [row] = await db.select().from(pubsubObservers).where(and(eq(pubsubObservers.companyId, companyId), eq(pubsubObservers.agentId, agentId)));
      return !!row;
    },
    async start() {
      await loadIdentity();
      if (!timer) { timer = setInterval(tick, 200); timer.unref(); tick(); }
      return service.stop;
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
  return service;
}
