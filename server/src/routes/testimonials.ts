import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { testimonials } from "@paperclipai/db";
import { createTestimonialSchema, updateTestimonialSchema } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity } from "../services/index.js";

export function testimonialRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/testimonials", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const items = await db
      .select()
      .from(testimonials)
      .where(eq(testimonials.companyId, companyId))
      .orderBy(desc(testimonials.sortOrder), desc(testimonials.createdAt));
    res.json(items);
  });

  router.get("/companies/:companyId/testimonials/:id", async (req, res) => {
    const { companyId, id } = req.params as { companyId: string; id: string };
    assertCompanyAccess(req, companyId);
    const item = await db
      .select()
      .from(testimonials)
      .where(and(eq(testimonials.id, id), eq(testimonials.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!item) throw notFound("Testimonial not found");
    res.json(item);
  });

  router.post("/companies/:companyId/testimonials", validate(createTestimonialSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const item = await db
      .insert(testimonials)
      .values({ ...req.body, companyId })
      .returning()
      .then((rows) => rows[0]);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "testimonial.created",
      entityType: "testimonial",
      entityId: item.id,
      details: { authorName: item.authorName },
    });
    res.status(201).json(item);
  });

  router.put("/companies/:companyId/testimonials/:id", validate(updateTestimonialSchema), async (req, res) => {
    const { companyId, id } = req.params as { companyId: string; id: string };
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const item = await db
      .update(testimonials)
      .set({ ...req.body, updatedAt: new Date() })
      .where(and(eq(testimonials.id, id), eq(testimonials.companyId, companyId)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!item) throw notFound("Testimonial not found");
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "testimonial.updated",
      entityType: "testimonial",
      entityId: item.id,
      details: { authorName: item.authorName },
    });
    res.json(item);
  });

  router.delete("/companies/:companyId/testimonials/:id", async (req, res) => {
    const { companyId, id } = req.params as { companyId: string; id: string };
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const item = await db
      .delete(testimonials)
      .where(and(eq(testimonials.id, id), eq(testimonials.companyId, companyId)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!item) throw notFound("Testimonial not found");
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "testimonial.deleted",
      entityType: "testimonial",
      entityId: item.id,
      details: { authorName: item.authorName },
    });
    res.json({ ok: true });
  });

  return router;
}
