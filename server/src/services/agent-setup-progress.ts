import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentSetupProgress, type AgentSetupProgressItemRecord } from "@paperclipai/db";
import {
  AGENT_SETUP_PROGRESS_LIMITS,
  type AgentSetupProgress,
  type AgentSetupProgressHandoff,
  type AgentSetupProgressPurpose,
  type AgentSetupProgressStatus,
  type FinishAgentSetup,
  type SetAgentSetupChecklist,
  type UpdateAgentSetupItem,
} from "@paperclipai/shared";
import { HttpError, conflict, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { publishLiveEvent } from "./live-events.js";

/**
 * Checklists that a person's own agent fills in while it sets something up for
 * them (see `@paperclipai/shared` agent-setup-progress). The board creates one
 * and gets a token for the agent; the agent's writes are checked against the
 * token's hash and pushed to the page as a live event.
 */

type Row = typeof agentSetupProgress.$inferSelect;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function toProgress(row: Row): AgentSetupProgress {
  return {
    id: row.id,
    companyId: row.companyId,
    purpose: row.purpose as AgentSetupProgressPurpose,
    subjectId: row.subjectId,
    status: row.status,
    items: row.items,
    summary: row.summary,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The agent's URLs: the item URL keeps `{key}` for the agent to fill in. */
export function agentSetupProgressUrls(origin: string, id: string): AgentSetupProgressHandoff["urls"] {
  const base = `${origin.replace(/\/+$/, "")}/api/agent-setup-progress/${id}`;
  return { checklist: `${base}/checklist`, item: `${base}/items/{key}`, finish: `${base}/finish` };
}

/**
 * Until the agent finishes, a checklist with steps is in progress, even with every step ticked off:
 * only the finish carries the summary (such as the role ARN), and the page keeps refreshing until then.
 */
function statusFor(items: AgentSetupProgressItemRecord[]): AgentSetupProgressStatus {
  return items.length === 0 ? "waiting" : "in_progress";
}

export function agentSetupProgressService(db: Db, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());

  function publish(row: Row) {
    publishLiveEvent({ companyId: row.companyId, type: "agent_setup_progress.updated", payload: { progressId: row.id } });
  }

  /** The row the agent's token opens, still open for writes. Any mismatch reads as not found. */
  async function openForAgent(id: string, authorization: string | undefined): Promise<Row> {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
    const [row] = token ? await db.select().from(agentSetupProgress).where(eq(agentSetupProgress.id, id)) : [];
    const expected = row ? Buffer.from(row.tokenHash, "hex") : null;
    const given = token ? Buffer.from(hashToken(token), "hex") : null;
    if (!row || !expected || !given || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new HttpError(401, "This setup progress link is not valid. Copy the setup prompt from Paperclip again.", { code: "agent_setup_progress_unauthorized" });
    }
    if (row.expiresAt.getTime() <= now().getTime()) {
      throw new HttpError(410, "This setup progress link expired. Copy the setup prompt from Paperclip again.", { code: "agent_setup_progress_expired" });
    }
    if (row.status === "done" || row.status === "failed") {
      // Finished is final: a late or retried update must not make the page show work in progress again.
      throw conflict("This setup already finished.", { code: "agent_setup_progress_finished" });
    }
    if (row.updateCount >= AGENT_SETUP_PROGRESS_LIMITS.maxUpdates) {
      throw new HttpError(429, "This setup checklist has had too many updates.", { code: "agent_setup_progress_update_limit" });
    }
    return row;
  }

  /** Saves the agent's change; the update counter guards against two writes racing. */
  async function save(
    row: Row,
    change: { items: AgentSetupProgressItemRecord[]; status?: AgentSetupProgressStatus; summary?: string | null },
    activity: { action: string; details: Record<string, unknown> },
  ) {
    const [saved] = await db.update(agentSetupProgress).set({
      items: change.items,
      status: change.status ?? statusFor(change.items),
      ...(change.summary !== undefined ? { summary: change.summary } : {}),
      updateCount: sql`${agentSetupProgress.updateCount} + 1`,
      updatedAt: now(),
    }).where(and(eq(agentSetupProgress.id, row.id), eq(agentSetupProgress.updateCount, row.updateCount))).returning();
    if (!saved) throw conflict("The checklist changed at the same time. Send the update again.", { code: "agent_setup_progress_conflict" });
    // Every change the agent makes is on the activity history; the token never is.
    await logActivity(db, {
      companyId: row.companyId, actorType: "system", actorId: "agent-setup", action: activity.action,
      entityType: "agent_setup_progress", entityId: row.id, details: { purpose: row.purpose, ...activity.details },
    });
    publish(saved);
    return toProgress(saved);
  }

  return {
    async create(input: {
      companyId: string;
      purpose: AgentSetupProgressPurpose;
      subjectId?: string | null;
      userId: string | null;
      origin: string;
    }): Promise<AgentSetupProgressHandoff> {
      // Expired checklists are only history: as a company makes a new one, drop its own that are a day
      // past expiry, a few at a time. Another company's rows are never touched.
      const stale = await db.select({ id: agentSetupProgress.id }).from(agentSetupProgress)
        .where(and(
          eq(agentSetupProgress.companyId, input.companyId),
          lt(agentSetupProgress.expiresAt, new Date(now().getTime() - 24 * 60 * 60 * 1000)),
        )).limit(100);
      if (stale.length > 0) {
        await db.delete(agentSetupProgress).where(and(
          eq(agentSetupProgress.companyId, input.companyId),
          inArray(agentSetupProgress.id, stale.map((row) => row.id)),
        ));
      }
      const token = `pcsp_${randomBytes(32).toString("base64url")}`;
      const [row] = await db.insert(agentSetupProgress).values({
        companyId: input.companyId,
        purpose: input.purpose,
        subjectId: input.subjectId ?? null,
        tokenHash: hashToken(token),
        createdByUserId: input.userId,
        expiresAt: new Date(now().getTime() + AGENT_SETUP_PROGRESS_LIMITS.lifetimeMs),
      }).returning();
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "user",
        actorId: input.userId ?? "board",
        action: "agent_setup_progress.created",
        entityType: "agent_setup_progress",
        entityId: row!.id,
        details: { purpose: input.purpose, subjectId: input.subjectId ?? null },
      });
      return { progress: toProgress(row!), token, urls: agentSetupProgressUrls(input.origin, row!.id) };
    },

    /**
     * Removes checklists more than a day past expiry, across companies. Runs once at server start
     * (reconstructing cleanup from the rows, never as a recurring scan), so companies that stopped
     * using agent setup do not keep dead rows; creating a checklist also cleans its own company.
     */
    async sweepExpired(options: { batchSize?: number; maxBatches?: number } = {}): Promise<number> {
      // Batches keep each delete small; the cap keeps a very large backlog from holding up startup
      // (whatever is left goes at the next start, or as each company creates a checklist).
      const batchSize = options.batchSize ?? 1000;
      const maxBatches = options.maxBatches ?? 50;
      const cutoff = new Date(now().getTime() - 24 * 60 * 60 * 1000);
      let removed = 0;
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const stale = await db.select({ id: agentSetupProgress.id }).from(agentSetupProgress)
          .where(lt(agentSetupProgress.expiresAt, cutoff)).limit(batchSize);
        if (stale.length === 0) break;
        await db.delete(agentSetupProgress).where(inArray(agentSetupProgress.id, stale.map((row) => row.id)));
        removed += stale.length;
        if (stale.length < batchSize) break;
      }
      return removed;
    },

    /** The checklist and who started it (for the read check; not part of the API response). */
    async get(id: string): Promise<(AgentSetupProgress & { createdByUserId: string | null }) | null> {
      const [row] = await db.select().from(agentSetupProgress).where(eq(agentSetupProgress.id, id));
      return row ? { ...toProgress(row), createdByUserId: row.createdByUserId } : null;
    },

    async setChecklist(id: string, authorization: string | undefined, input: SetAgentSetupChecklist) {
      const row = await openForAgent(id, authorization);
      const items = input.items.map((item) => ({
        key: item.key, title: item.title, status: item.status ?? "pending", detail: item.detail ?? null,
      }));
      return save(row, { items, summary: null }, {
        action: row.items.length === 0 ? "agent_setup_progress.started" : "agent_setup_progress.checklist_replaced",
        details: { itemCount: items.length },
      });
    },

    async updateItem(id: string, key: string, authorization: string | undefined, input: UpdateAgentSetupItem) {
      const row = await openForAgent(id, authorization);
      if (!row.items.some((item) => item.key === key)) {
        throw notFound(`The checklist has no item "${key}". Set the checklist first, then update its items by key.`);
      }
      const items = row.items.map((item) => item.key === key
        // Omitted keeps the detail; null clears it.
        ? { ...item, status: input.status, detail: input.detail === undefined ? item.detail : input.detail }
        : item);
      return save(row, { items }, { action: "agent_setup_progress.item_updated", details: { key, status: input.status } });
    },

    async finish(id: string, authorization: string | undefined, input: FinishAgentSetup) {
      const row = await openForAgent(id, authorization);
      if (row.items.length === 0 && input.status === "done") {
        throw unprocessable("Set the checklist before finishing.", { code: "agent_setup_progress_empty" });
      }
      // The agent's finish is the verdict: done ticks off every step (it recovered from any that failed),
      // so a finished setup never shows open or failed steps; failed keeps the steps as they were.
      const items = input.status === "done"
        ? row.items.map((item) => ({ ...item, status: "done" as const }))
        : row.items;
      return save(row, { items, status: input.status, summary: input.summary ?? null }, {
        action: "agent_setup_progress.finished", details: { status: input.status },
      });
    },
  };
}
