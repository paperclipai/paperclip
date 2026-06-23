import { and, arrayOverlaps, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentMemories, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import type {
  AgentMemory,
  AgentMemoryType,
  CreateAgentMemory,
  RecallAgentMemory,
  CorrectAgentMemory,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

type AgentMemoryRow = typeof agentMemories.$inferSelect;

/**
 * Lightweight redaction so secret-looking values never land in long-term memory.
 * Memory is durable and replayed into future runs, so a leaked credential here
 * is a persistent exposure (see doc/plans/2026-06-22-agent-long-term-memory.md).
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style keys
  /\b(?:gh[opsu]|github_pat)_[A-Za-z0-9_]{20,}\b/g, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}\b/g, // JWT-ish
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted-secret]");
  }
  return out;
}

function toAgentMemory(row: AgentMemoryRow): AgentMemory {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    type: row.type as AgentMemoryType,
    title: row.title,
    body: row.body,
    status: row.status as AgentMemory["status"],
    confidence: row.confidence,
    tags: row.tags ?? [],
    sourceRunId: row.sourceRunId ?? null,
    sourceIssueId: row.sourceIssueId ?? null,
    sourceCommentId: row.sourceCommentId ?? null,
    recallCount: row.recallCount,
    lastRecalledAt: row.lastRecalledAt ?? null,
    supersedesMemoryId: row.supersedesMemoryId ?? null,
    supersededByMemoryId: row.supersededByMemoryId ?? null,
    createdByActorType: row.createdByActorType ?? null,
    createdByActorId: row.createdByActorId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    forgottenAt: row.forgottenAt ?? null,
  };
}

export interface MemoryActor {
  actorType: "agent" | "user" | "system";
  actorId: string;
}

export function agentMemoryService(db: Db) {
  /**
   * Verify caller-supplied provenance ids reference resources in this company (and,
   * for runs, this agent) so callers cannot attach memory provenance to unrelated
   * tenant/resource ids and corrupt audit lineage. Internal callers (consolidation)
   * pass ids they already queried in-scope and skip this.
   */
  async function assertProvenanceInScope(companyId: string, agentId: string, input: CreateAgentMemory): Promise<void> {
    if (input.sourceRunId) {
      const ok = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.id, input.sourceRunId),
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.agentId, agentId),
          ),
        )
        .then((rows) => rows.length > 0);
      if (!ok) throw unprocessable("sourceRunId does not reference a run for this agent");
    }
    if (input.sourceIssueId) {
      const ok = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, input.sourceIssueId), eq(issues.companyId, companyId)))
        .then((rows) => rows.length > 0);
      if (!ok) throw unprocessable("sourceIssueId does not reference an issue in this company");
    }
    if (input.sourceCommentId) {
      const ok = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(and(eq(issueComments.id, input.sourceCommentId), eq(issueComments.companyId, companyId)))
        .then((rows) => rows.length > 0);
      if (!ok) throw unprocessable("sourceCommentId does not reference a comment in this company");
    }
  }

  async function getOwnedRow(companyId: string, agentId: string, memoryId: string): Promise<AgentMemoryRow> {
    const row = await db
      .select()
      .from(agentMemories)
      .where(and(eq(agentMemories.id, memoryId), eq(agentMemories.agentId, agentId), eq(agentMemories.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Memory not found");
    return row;
  }

  async function write(
    companyId: string,
    agentId: string,
    input: CreateAgentMemory,
    actor: MemoryActor,
    status: "staged" | "active" = "active",
  ): Promise<AgentMemory> {
    const [row] = await db
      .insert(agentMemories)
      .values({
        companyId,
        agentId,
        type: input.type,
        title: redactSecrets(input.title),
        body: redactSecrets(input.body),
        status,
        confidence: input.confidence ?? 0,
        tags: (input.tags ?? []).map((tag) => redactSecrets(tag)),
        sourceRunId: input.sourceRunId ?? null,
        sourceIssueId: input.sourceIssueId ?? null,
        sourceCommentId: input.sourceCommentId ?? null,
        createdByActorType: actor.actorType,
        createdByActorId: actor.actorId,
      })
      .returning();
    return toAgentMemory(row);
  }

  /** Recall active memories, optionally filtered by type/tags/free-text, and bump recall stats. */
  async function recall(companyId: string, agentId: string, query: RecallAgentMemory): Promise<AgentMemory[]> {
    const conditions = [
      eq(agentMemories.companyId, companyId),
      eq(agentMemories.agentId, agentId),
      eq(agentMemories.status, "active"),
    ];
    if (query.type) conditions.push(eq(agentMemories.type, query.type));
    if (query.tags && query.tags.length > 0) {
      // Postgres array overlap: row tags intersect requested tags.
      conditions.push(arrayOverlaps(agentMemories.tags, query.tags));
    }
    if (query.query && query.query.length > 0) {
      const like = `%${query.query.toLowerCase()}%`;
      conditions.push(sql`(lower(${agentMemories.title}) like ${like} or lower(${agentMemories.body}) like ${like})`);
    }
    const rows = await db
      .select()
      .from(agentMemories)
      .where(and(...conditions))
      .orderBy(desc(agentMemories.confidence), desc(agentMemories.updatedAt))
      .limit(query.limit ?? 20);

    if (rows.length > 0) {
      const ids = rows.map((row) => row.id);
      await db
        .update(agentMemories)
        .set({ recallCount: sql`${agentMemories.recallCount} + 1`, lastRecalledAt: new Date() })
        .where(and(eq(agentMemories.companyId, companyId), inArray(agentMemories.id, ids)));
    }
    return rows.map(toAgentMemory);
  }

  /** Board-facing list, including staged/forgotten when requested. */
  async function list(
    companyId: string,
    agentId: string,
    opts: { includeForgotten?: boolean } = {},
  ): Promise<AgentMemory[]> {
    const conditions = [eq(agentMemories.companyId, companyId), eq(agentMemories.agentId, agentId)];
    if (!opts.includeForgotten) {
      conditions.push(sql`${agentMemories.status} <> 'forgotten'`);
    }
    const rows = await db
      .select()
      .from(agentMemories)
      .where(and(...conditions))
      .orderBy(desc(agentMemories.updatedAt));
    return rows.map(toAgentMemory);
  }

  async function forget(
    companyId: string,
    agentId: string,
    memoryId: string,
    _actor: MemoryActor,
  ): Promise<AgentMemory> {
    await getOwnedRow(companyId, agentId, memoryId);
    const [row] = await db
      .update(agentMemories)
      .set({ status: "forgotten", forgottenAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentMemories.id, memoryId), eq(agentMemories.companyId, companyId)))
      .returning();
    return toAgentMemory(row);
  }

  /** Correct a memory: write a replacement and forget+link the old one. */
  async function correct(
    companyId: string,
    agentId: string,
    memoryId: string,
    input: CorrectAgentMemory,
    actor: MemoryActor,
  ): Promise<AgentMemory> {
    const existing = await getOwnedRow(companyId, agentId, memoryId);
    const replacement = await write(
      companyId,
      agentId,
      {
        type: existing.type as AgentMemoryType,
        title: input.title,
        body: input.body,
        tags: input.tags ?? existing.tags ?? [],
        confidence: input.confidence ?? existing.confidence,
        sourceRunId: existing.sourceRunId ?? null,
        sourceIssueId: existing.sourceIssueId ?? null,
        sourceCommentId: existing.sourceCommentId ?? null,
      },
      actor,
      "active",
    );
    await db
      .update(agentMemories)
      .set({ supersedesMemoryId: existing.id })
      .where(eq(agentMemories.id, replacement.id));
    await db
      .update(agentMemories)
      .set({ status: "forgotten", forgottenAt: new Date(), supersededByMemoryId: replacement.id, updatedAt: new Date() })
      .where(and(eq(agentMemories.id, existing.id), eq(agentMemories.companyId, companyId)));
    return { ...replacement, supersedesMemoryId: existing.id };
  }

  /** Render the active memories of an agent as an inspectable MEMORY.md document. */
  async function renderMarkdown(companyId: string, agentId: string): Promise<string> {
    const memories = await list(companyId, agentId);
    const active = memories.filter((m) => m.status === "active");
    const byType: Record<AgentMemoryType, AgentMemory[]> = {
      semantic: [],
      procedural: [],
      lesson: [],
      episodic: [],
    };
    for (const m of active) byType[m.type]?.push(m);

    const sectionTitles: Record<AgentMemoryType, string> = {
      semantic: "Facts",
      procedural: "Procedures",
      lesson: "Lessons",
      episodic: "Episodes",
    };
    const order: AgentMemoryType[] = ["semantic", "procedural", "lesson", "episodic"];
    const lines: string[] = ["# Memory", ""];
    for (const type of order) {
      const items = byType[type];
      if (!items || items.length === 0) continue;
      lines.push(`## ${sectionTitles[type]}`, "");
      for (const m of items) {
        const tagSuffix = m.tags.length > 0 ? ` _(${m.tags.join(", ")})_` : "";
        lines.push(`- **${m.title}** — ${m.body}${tagSuffix}`);
      }
      lines.push("");
    }
    if (active.length === 0) lines.push("_No memories yet._", "");
    return lines.join("\n");
  }

  /** Compact summary string for injection into an agent run context (fat mode). */
  async function buildContextSummary(companyId: string, agentId: string, limit = 30): Promise<string> {
    const memories = await list(companyId, agentId);
    const active = memories
      .filter((m) => m.status === "active")
      .sort((a, b) => b.confidence - a.confidence || b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);
    if (active.length === 0) return "";
    const lines = active.map((m) => `- [${m.type}] ${m.title}: ${m.body}`);
    return ["Long-term memory (most relevant):", ...lines].join("\n");
  }

  /**
   * Full memory section injected into every run (issue #6): the recall summary
   * (when the agent has memories) plus an always-present guide telling the agent
   * how to write durable memories. Without the write guide, agents are never told
   * that the control-plane memory exists, so they can read but never capitalize.
   */
  async function buildRunMemorySection(companyId: string, agentId: string, limit = 30): Promise<string> {
    const summary = await buildContextSummary(companyId, agentId, limit);
    return [summary, renderMemoryUsageGuide(agentId)].filter((part) => part.length > 0).join("\n\n");
  }

  return {
    write,
    recall,
    list,
    forget,
    correct,
    renderMarkdown,
    buildContextSummary,
    buildRunMemorySection,
    assertProvenanceInScope,
    redactSecrets,
  };
}

/**
 * Always-on instruction block teaching an agent to write to its durable,
 * cross-run long-term memory. The agent already calls the control-plane API with
 * `$PAPERCLIP_API_URL` and `Authorization: Bearer $PAPERCLIP_API_KEY`; this just
 * documents the memory endpoint and bakes in the agent's own id.
 */
export function renderMemoryUsageGuide(agentId: string): string {
  return [
    "Your long-term memory (durable, private to you, re-surfaced at the start of future runs):",
    `- To remember a fact, decision, or lesson, POST $PAPERCLIP_API_URL/api/agents/${agentId}/memories`,
    '  with your usual `Authorization: Bearer $PAPERCLIP_API_KEY` header and JSON body',
    '  {"type":"semantic|episodic|procedural|lesson","title":"...","body":"...","tags":["..."],"confidence":0-100}.',
    "- Capture durable knowledge proactively; it resurfaces automatically in later runs (no need to re-read issues).",
    "- Secrets are redacted on write. To revise a memory, POST .../memories/:id/correct; to drop one, .../memories/:id/forget.",
  ].join("\n");
}
