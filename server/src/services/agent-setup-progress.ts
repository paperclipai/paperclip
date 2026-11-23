import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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

/** Overall status follows the items until the agent says it finished. */
function statusFor(items: AgentSetupProgressItemRecord[]): AgentSetupProgressStatus {
  if (items.length === 0) return "waiting";
  if (items.some((item) => item.status === "failed")) return "in_progress";
  return items.every((item) => item.status === "done") ? "done" : "in_progress";
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
    if (row.updateCount >= AGENT_SETUP_PROGRESS_LIMITS.maxUpdates) {
      throw new HttpError(429, "This setup checklist has had too many updates.", { code: "agent_setup_progress_update_limit" });
    }
    return row;
  }

  /** Saves the agent's change; the update counter guards against two writes racing. */
  async function save(row: Row, change: { items: AgentSetupProgressItemRecord[]; status?: AgentSetupProgressStatus; summary?: string | null }) {
    const [saved] = await db.update(agentSetupProgress).set({
      items: change.items,
      status: change.status ?? statusFor(change.items),
      ...(change.summary !== undefined ? { summary: change.summary } : {}),
      updateCount: sql`${agentSetupProgress.updateCount} + 1`,
      updatedAt: now(),
    }).where(and(eq(agentSetupProgress.id, row.id), eq(agentSetupProgress.updateCount, row.updateCount))).returning();
    if (!saved) throw conflict("The checklist changed at the same time. Send the update again.", { code: "agent_setup_progress_conflict" });
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

    async get(id: string): Promise<AgentSetupProgress | null> {
      const [row] = await db.select().from(agentSetupProgress).where(eq(agentSetupProgress.id, id));
      return row ? toProgress(row) : null;
    },

    async setChecklist(id: string, authorization: string | undefined, input: SetAgentSetupChecklist) {
      const row = await openForAgent(id, authorization);
      const items = input.items.map((item) => ({
        key: item.key, title: item.title, status: item.status ?? "pending", detail: item.detail ?? null,
      }));
      const saved = await save(row, { items, summary: null });
      if (row.items.length === 0) {
        await logActivity(db, {
          companyId: row.companyId, actorType: "system", actorId: "agent-setup", action: "agent_setup_progress.started",
          entityType: "agent_setup_progress", entityId: row.id, details: { purpose: row.purpose, itemCount: items.length },
        });
      }
      return saved;
    },

    async updateItem(id: string, key: string, authorization: string | undefined, input: UpdateAgentSetupItem) {
      const row = await openForAgent(id, authorization);
      if (!row.items.some((item) => item.key === key)) {
        throw notFound(`The checklist has no item "${key}". Set the checklist first, then update its items by key.`);
      }
      const items = row.items.map((item) => item.key === key
        ? { ...item, status: input.status, detail: input.detail ?? item.detail }
        : item);
      return save(row, { items });
    },

    async finish(id: string, authorization: string | undefined, input: FinishAgentSetup) {
      const row = await openForAgent(id, authorization);
      if (row.items.length === 0 && input.status === "done") {
        throw unprocessable("Set the checklist before finishing.", { code: "agent_setup_progress_empty" });
      }
      // Finishing done ticks off what is left, so the page never shows a finished setup with open steps.
      const items = input.status === "done"
        ? row.items.map((item) => item.status === "failed" ? item : { ...item, status: "done" as const })
        : row.items;
      const saved = await save(row, { items, status: input.status, summary: input.summary ?? null });
      await logActivity(db, {
        companyId: row.companyId, actorType: "system", actorId: "agent-setup", action: "agent_setup_progress.finished",
        entityType: "agent_setup_progress", entityId: row.id, details: { purpose: row.purpose, status: input.status },
      });
      return saved;
    },
  };
}
