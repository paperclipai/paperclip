import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goalRelations, goalTargets, goals, roadmapBlockEdges, roadmapBlockLinks, roadmapBlocks } from "@paperclipai/db";
import type { CreateGoalRelation, CreateGoalTarget, CreateRoadmapBlock, CreateRoadmapBlockEdge, CreateRoadmapBlockLink, PromoteRoadmapBlock, UpdateGoalTarget, UpdateRoadmapBlock } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { getDefaultCompanyGoal } from "./goals.js";

export function goalTargetService(db: Db) {
  return {
    list: (companyId: string) =>
      db.select().from(goalTargets)
        .where(eq(goalTargets.companyId, companyId))
        .orderBy(asc(goalTargets.sortOrder), asc(goalTargets.createdAt)),

    getById: (id: string) =>
      db.select().from(goalTargets).where(eq(goalTargets.id, id)).then((rows) => rows[0] ?? null),

    create: async (goalId: string, data: CreateGoalTarget) => {
      const goal = await db.select().from(goals).where(eq(goals.id, goalId)).then((rows) => rows[0] ?? null);
      if (!goal) throw notFound("Goal not found");
      if (data.parentId) {
        const parent = await db.select().from(goalTargets)
          .where(and(eq(goalTargets.id, data.parentId), eq(goalTargets.goalId, goalId)))
          .then((rows) => rows[0] ?? null);
        if (!parent) throw unprocessable("parentId must be a target of the same goal");
      }
      return db.insert(goalTargets).values({
        companyId: goal.companyId,
        goalId,
        parentId: data.parentId ?? null,
        text: data.text,
        checked: data.checked ?? false,
        sortOrder: data.sortOrder ?? 0,
      }).returning().then((rows) => rows[0]);
    },

    update: async (id: string, data: UpdateGoalTarget) => {
      const existing = await db.select().from(goalTargets).where(eq(goalTargets.id, id)).then((rows) => rows[0] ?? null);
      if (!existing) return null;
      if (data.parentId) {
        if (data.parentId === id) throw unprocessable("A target cannot be its own parent");
        const parent = await db.select().from(goalTargets)
          .where(eq(goalTargets.id, data.parentId))
          .then((rows) => rows[0] ?? null);
        if (!parent || parent.companyId !== existing.companyId) throw unprocessable("Invalid parentId");
      }
      if (data.goalId) {
        const goal = await db.select().from(goals)
          .where(and(eq(goals.id, data.goalId), eq(goals.companyId, existing.companyId)))
          .then((rows) => rows[0] ?? null);
        if (!goal) throw unprocessable("Invalid goalId");
      }
      return db.update(goalTargets)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(goalTargets.id, id))
        .returning().then((rows) => rows[0] ?? null);
    },

    remove: (id: string) =>
      db.delete(goalTargets).where(eq(goalTargets.id, id)).returning().then((rows) => rows[0] ?? null),
  };
}

export function goalRelationService(db: Db) {
  return {
    list: (companyId: string) =>
      db.select().from(goalRelations).where(eq(goalRelations.companyId, companyId)),

    getById: (id: string) =>
      db.select().from(goalRelations).where(eq(goalRelations.id, id)).then((rows) => rows[0] ?? null),

    create: async (companyId: string, data: CreateGoalRelation) => {
      const from = await db.select().from(goals)
        .where(and(eq(goals.id, data.fromGoalId), eq(goals.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!from) throw unprocessable("fromGoalId not found in this company");
      if (data.toGoalId) {
        const to = await db.select().from(goals)
          .where(and(eq(goals.id, data.toGoalId), eq(goals.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!to) throw unprocessable("toGoalId not found in this company");
      }
      if (data.toTargetId) {
        const target = await db.select().from(goalTargets)
          .where(and(eq(goalTargets.id, data.toTargetId), eq(goalTargets.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!target) throw unprocessable("toTargetId not found in this company");
      }
      return db.insert(goalRelations).values({
        companyId,
        type: data.type,
        fromGoalId: data.fromGoalId,
        toGoalId: data.toGoalId ?? null,
        toTargetId: data.toTargetId ?? null,
      }).returning().then((rows) => rows[0]);
    },

    remove: (id: string) =>
      db.delete(goalRelations).where(eq(goalRelations.id, id)).returning().then((rows) => rows[0] ?? null),
  };
}

export function roadmapService(db: Db) {
  return {
    get: async (companyId: string) => {
      const [blocks, edges, links] = await Promise.all([
        db.select().from(roadmapBlocks)
          .where(eq(roadmapBlocks.companyId, companyId))
          .orderBy(asc(roadmapBlocks.createdAt)),
        db.select().from(roadmapBlockEdges).where(eq(roadmapBlockEdges.companyId, companyId)),
        db.select().from(roadmapBlockLinks)
          .where(eq(roadmapBlockLinks.companyId, companyId))
          .orderBy(asc(roadmapBlockLinks.createdAt)),
      ]);
      return { blocks, edges, links };
    },

    getBlockById: (id: string) =>
      db.select().from(roadmapBlocks).where(eq(roadmapBlocks.id, id)).then((rows) => rows[0] ?? null),

    getEdgeById: (id: string) =>
      db.select().from(roadmapBlockEdges).where(eq(roadmapBlockEdges.id, id)).then((rows) => rows[0] ?? null),

    createBlock: (companyId: string, data: CreateRoadmapBlock) =>
      db.insert(roadmapBlocks).values({
        companyId,
        title: data.title,
        detail: data.detail ?? null,
        status: data.status ?? "planned",
        x: data.x,
        y: data.y,
      }).returning().then((rows) => rows[0]),

    updateBlock: async (id: string, data: UpdateRoadmapBlock) => {
      const existing = await db.select().from(roadmapBlocks).where(eq(roadmapBlocks.id, id)).then((rows) => rows[0] ?? null);
      if (!existing) return null;
      return db.update(roadmapBlocks)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(roadmapBlocks.id, id))
        .returning().then((rows) => rows[0] ?? null);
    },

    getLinkById: (id: string) =>
      db.select().from(roadmapBlockLinks).where(eq(roadmapBlockLinks.id, id)).then((rows) => rows[0] ?? null),

    createLink: async (companyId: string, data: CreateRoadmapBlockLink) => {
      const [block, goal] = await Promise.all([
        db.select().from(roadmapBlocks)
          .where(and(eq(roadmapBlocks.id, data.blockId), eq(roadmapBlocks.companyId, companyId)))
          .then((rows) => rows[0] ?? null),
        db.select().from(goals)
          .where(and(eq(goals.id, data.goalId), eq(goals.companyId, companyId)))
          .then((rows) => rows[0] ?? null),
      ]);
      if (!block) throw unprocessable("blockId not found in this company");
      if (!goal) throw unprocessable("goalId not found in this company");
      const inserted = await db.insert(roadmapBlockLinks)
        .values({ companyId, blockId: data.blockId, goalId: data.goalId })
        .onConflictDoNothing()
        .returning()
        .then((rows) => rows[0] ?? null);
      if (inserted) return inserted;
      // Already linked — return the existing row so the call is idempotent.
      return db.select().from(roadmapBlockLinks)
        .where(and(eq(roadmapBlockLinks.blockId, data.blockId), eq(roadmapBlockLinks.goalId, data.goalId)))
        .then((rows) => rows[0] ?? null);
    },

    removeLink: (id: string) =>
      db.delete(roadmapBlockLinks).where(eq(roadmapBlockLinks.id, id)).returning().then((rows) => rows[0] ?? null),

    removeBlock: (id: string) =>
      db.delete(roadmapBlocks).where(eq(roadmapBlocks.id, id)).returning().then((rows) => rows[0] ?? null),

    createEdge: async (companyId: string, data: CreateRoadmapBlockEdge) => {
      const [from, to] = await Promise.all([
        db.select().from(roadmapBlocks)
          .where(and(eq(roadmapBlocks.id, data.fromBlockId), eq(roadmapBlocks.companyId, companyId)))
          .then((rows) => rows[0] ?? null),
        db.select().from(roadmapBlocks)
          .where(and(eq(roadmapBlocks.id, data.toBlockId), eq(roadmapBlocks.companyId, companyId)))
          .then((rows) => rows[0] ?? null),
      ]);
      if (!from || !to) throw unprocessable("Both edge endpoints must be roadmap blocks in this company");
      return db.insert(roadmapBlockEdges)
        .values({ companyId, fromBlockId: data.fromBlockId, toBlockId: data.toBlockId })
        .onConflictDoNothing()
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    removeEdge: (id: string) =>
      db.delete(roadmapBlockEdges).where(eq(roadmapBlockEdges.id, id)).returning().then((rows) => rows[0] ?? null),

    /** Create an initiative/epic goal from a block and link the block to it. */
    promoteBlock: async (id: string, data: PromoteRoadmapBlock) => {
      const block = await db.select().from(roadmapBlocks).where(eq(roadmapBlocks.id, id)).then((rows) => rows[0] ?? null);
      if (!block) throw notFound("Roadmap block not found");
      if (data.level === "epic" && !data.parentGoalId) {
        throw unprocessable("An epic needs a parentGoalId (its initiative)");
      }
      let parentId = data.parentGoalId ?? null;
      if (parentId) {
        const parent = await db.select().from(goals)
          .where(and(eq(goals.id, parentId), eq(goals.companyId, block.companyId)))
          .then((rows) => rows[0] ?? null);
        if (!parent) throw unprocessable("parentGoalId not found in this company");
      } else if (data.level === "initiative") {
        // Initiatives hang off the company root so the map hierarchy holds.
        parentId = (await getDefaultCompanyGoal(db, block.companyId))?.id ?? null;
      }
      return db.transaction(async (tx) => {
        const [goal] = await tx.insert(goals).values({
          companyId: block.companyId,
          title: data.title ?? block.title,
          description: block.detail,
          level: data.level,
          status: "active",
          parentId,
        }).returning();
        const [link] = await tx.insert(roadmapBlockLinks)
          .values({ companyId: block.companyId, blockId: id, goalId: goal.id })
          .onConflictDoNothing()
          .returning();
        const [updatedBlock] = await tx.update(roadmapBlocks)
          .set({ updatedAt: new Date() })
          .where(eq(roadmapBlocks.id, id))
          .returning();
        return { goal, block: updatedBlock, link: link ?? null };
      });
    },
  };
}
