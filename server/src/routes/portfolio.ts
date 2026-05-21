import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { portfolioItems } from "@paperclipai/db";
import { createPortfolioItemSchema, updatePortfolioItemSchema } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity } from "../services/index.js";

export function portfolioRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/portfolio", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const items = await db
      .select()
      .from(portfolioItems)
      .where(eq(portfolioItems.companyId, companyId))
      .orderBy(desc(portfolioItems.sortOrder), desc(portfolioItems.createdAt));
    res.json(items);
  });

  router.get("/companies/:companyId/portfolio/:id", async (req, res) => {
    const { companyId, id } = req.params as { companyId: string; id: string };
    assertCompanyAccess(req, companyId);
    const item = await db
      .select()
      .from(portfolioItems)
      .where(and(eq(portfolioItems.id, id), eq(portfolioItems.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!item) throw notFound("Portfolio item not found");
    res.json(item);
  });

  router.post("/companies/:companyId/portfolio", validate(createPortfolioItemSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const item = await db
      .insert(portfolioItems)
      .values({ ...req.body, companyId })
      .returning()
      .then((rows) => rows[0]);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "portfolio.created",
      entityType: "portfolio_item",
      entityId: item.id,
      details: { title: item.title },
    });
    res.status(201).json(item);
  });

  router.put("/companies/:companyId/portfolio/:id", validate(updatePortfolioItemSchema), async (req, res) => {
    const { companyId, id } = req.params as { companyId: string; id: string };
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const item = await db
      .update(portfolioItems)
      .set({ ...req.body, updatedAt: new Date() })
      .where(and(eq(portfolioItems.id, id), eq(portfolioItems.companyId, companyId)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!item) throw notFound("Portfolio item not found");
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "portfolio.updated",
      entityType: "portfolio_item",
      entityId: item.id,
      details: { title: item.title },
    });
    res.json(item);
  });

  router.delete("/companies/:companyId/portfolio/:id", async (req, res) => {
    const { companyId, id } = req.params as { companyId: string; id: string };
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const item = await db
      .delete(portfolioItems)
      .where(and(eq(portfolioItems.id, id), eq(portfolioItems.companyId, companyId)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!item) throw notFound("Portfolio item not found");
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "portfolio.deleted",
      entityType: "portfolio_item",
      entityId: item.id,
      details: { title: item.title },
    });
    res.json({ ok: true });
  });

  return router;
}
