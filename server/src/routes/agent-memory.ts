import { Router } from "express";
import type { Db } from "@ironworksai/db";
import { agentMemoryEntries, agents as agentsTable } from "@ironworksai/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { MEMORY_TYPES, type MemoryType } from "@ironworksai/shared";
import { badRequest, notFound } from "../errors.js";
import { assertCanWrite, assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity, createAgentDocument } from "../services/index.js";

export function agentMemoryRoutes(db: Db) {
  const router = Router();

  /** Shared helper to verify agent exists and belongs to company. */
  async function resolveAgent(companyId: string, agentId: string) {
    const agent = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(and(eq(agentsTable.id, agentId), eq(agentsTable.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  // ── GET /companies/:companyId/agents/:agentId/memory ────────────────────────
  router.get("/companies/:companyId/agents/:agentId/memory", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    await resolveAgent(companyId, agentId);

    const rows = await db
      .select()
      .from(agentMemoryEntries)
      .where(
        and(
          eq(agentMemoryEntries.agentId, agentId),
          eq(agentMemoryEntries.companyId, companyId),
          isNull(agentMemoryEntries.archivedAt),
        ),
      )
      .orderBy(desc(agentMemoryEntries.createdAt))
      .limit(200);

    res.json(rows);
  });

  // ── POST /companies/:companyId/agents/:agentId/memory ───────────────────────
  router.post("/companies/:companyId/agents/:agentId/memory", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    await assertCanWrite(req, companyId, db);
    await resolveAgent(companyId, agentId);

    const {
      memoryType,
      category,
      content,
      sourceIssueId,
      sourceProjectId,
      confidence,
      expiresAt,
    } = req.body as Record<string, unknown>;

    if (!content || typeof content !== "string") {
      throw badRequest("content is required");
    }

    const resolvedType = (typeof memoryType === "string" && MEMORY_TYPES.includes(memoryType as MemoryType))
      ? memoryType as string
      : "semantic";

    const row = await db
      .insert(agentMemoryEntries)
      .values({
        agentId,
        companyId,
        memoryType: resolvedType,
        category: typeof category === "string" ? category : null,
        content: content as string,
        sourceIssueId: typeof sourceIssueId === "string" ? sourceIssueId : null,
        sourceProjectId: typeof sourceProjectId === "string" ? sourceProjectId : null,
        confidence: typeof confidence === "number" && confidence >= 0 && confidence <= 100 ? confidence : 80,
        expiresAt: typeof expiresAt === "string" ? new Date(expiresAt) : null,
      })
      .returning()
      .then((rows) => rows[0]!);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent_memory.created",
      entityType: "agent_memory_entry",
      entityId: row.id,
      details: { agentId, memoryType: resolvedType },
    });

    res.status(201).json(row);
  });

  // ── PATCH /companies/:companyId/agents/:agentId/memory/:entryId ─────────────
  router.patch("/companies/:companyId/agents/:agentId/memory/:entryId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    const entryId = req.params.entryId as string;
    await assertCanWrite(req, companyId, db);
    await resolveAgent(companyId, agentId);

    const existing = await db
      .select()
      .from(agentMemoryEntries)
      .where(
        and(
          eq(agentMemoryEntries.id, entryId),
          eq(agentMemoryEntries.agentId, agentId),
          eq(agentMemoryEntries.companyId, companyId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!existing) {
      throw notFound("Memory entry not found");
    }

    const { memoryType, category, content, confidence, expiresAt } = req.body as Record<string, unknown>;

    const updates: Record<string, unknown> = {};
    if (typeof memoryType === "string" && MEMORY_TYPES.includes(memoryType as MemoryType)) {
      updates.memoryType = memoryType;
    }
    if (typeof category === "string") updates.category = category;
    if (typeof content === "string") updates.content = content;
    if (typeof confidence === "number" && confidence >= 0 && confidence <= 100) updates.confidence = confidence;
    if (typeof expiresAt === "string") updates.expiresAt = new Date(expiresAt);
    if (expiresAt === null) updates.expiresAt = null;

    const updated = await db
      .update(agentMemoryEntries)
      .set(updates)
      .where(
        and(
          eq(agentMemoryEntries.id, entryId),
          eq(agentMemoryEntries.agentId, agentId),
          eq(agentMemoryEntries.companyId, companyId),
        ),
      )
      .returning()
      .then((rows) => rows[0]!);

    res.json(updated);
  });

  // ── DELETE /companies/:companyId/agents/:agentId/memory/:entryId ────────────
  // Soft archive - sets archived_at instead of deleting.
  router.delete("/companies/:companyId/agents/:agentId/memory/:entryId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    const entryId = req.params.entryId as string;
    await assertCanWrite(req, companyId, db);
    await resolveAgent(companyId, agentId);

    const existing = await db
      .select({ id: agentMemoryEntries.id })
      .from(agentMemoryEntries)
      .where(
        and(
          eq(agentMemoryEntries.id, entryId),
          eq(agentMemoryEntries.agentId, agentId),
          eq(agentMemoryEntries.companyId, companyId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!existing) {
      throw notFound("Memory entry not found");
    }

    await db
      .update(agentMemoryEntries)
      .set({ archivedAt: new Date() })
      .where(eq(agentMemoryEntries.id, entryId));

    res.json({ ok: true });
  });

  // ── POST /companies/:companyId/agents/:agentId/memory/:entryId/promote ───
  // Promote a memory entry to a company-wide knowledge page.
  router.post("/companies/:companyId/agents/:agentId/memory/:entryId/promote", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    const entryId = req.params.entryId as string;
    await assertCanWrite(req, companyId, db);
    await resolveAgent(companyId, agentId);

    // 1. Fetch the memory entry
    const existing = await db
      .select()
      .from(agentMemoryEntries)
      .where(
        and(
          eq(agentMemoryEntries.id, entryId),
          eq(agentMemoryEntries.agentId, agentId),
          eq(agentMemoryEntries.companyId, companyId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!existing) {
      throw notFound("Memory entry not found");
    }

    if (existing.archivedAt) {
      throw badRequest("Memory entry is already archived");
    }

    // 2. Create a company-wide knowledge page
    const title = existing.category
      ? existing.category.charAt(0).toUpperCase() + existing.category.slice(1)
      : "Promoted Memory";
    const slugBase = (existing.category ?? "promoted-memory")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    const slug = `promoted-${slugBase}-${entryId.replace(/-/g, "").slice(0, 8)}`;

    const body = [
      `# ${title}`,
      "",
      `**Source:** Agent memory (promoted to company knowledge)`,
      `**Original type:** ${existing.memoryType}`,
      `**Confidence:** ${existing.confidence}/100`,
      "",
      "## Content",
      existing.content,
    ].join("\n");

    const pageId = await createAgentDocument(db, {
      agentId,
      companyId,
      title,
      content: body,
      documentType: "promoted-memory",
      slug,
      visibility: "company",
      autoGenerated: false,
      createdByUserId: "system",
    });

    // 3. Archive the original memory entry
    await db
      .update(agentMemoryEntries)
      .set({ archivedAt: new Date() })
      .where(eq(agentMemoryEntries.id, entryId));

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent_memory.promoted",
      entityType: "knowledge_page",
      entityId: pageId,
      details: { memoryEntryId: entryId, agentId },
    });

    res.status(201).json({ id: pageId, title, slug });
  });

  return router;
}
