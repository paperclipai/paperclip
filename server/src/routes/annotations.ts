import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { annotations } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

const ANNOTATION_TYPES = ["perimeter", "hazard", "resource", "note"] as const;
const SEVERITIES = ["critical", "warning", "info"] as const;
const VISIBILITIES = ["org_wide", "admin_only"] as const;

function isAdminActor(req: Parameters<typeof assertBoard>[0]): boolean {
  return req.actor.isInstanceAdmin === true;
}

export function annotationRoutes(db: Db) {
  const router = Router();

  /** GET /annotations?companyId&bbox=minLng,minLat,maxLng,maxLat&from&to */
  router.get("/annotations", async (req, res) => {
    assertBoard(req);

    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const userId = req.actor?.userId ?? null;
    const isAdmin = isAdminActor(req);

    const rows = await db
      .select()
      .from(annotations)
      .where(
        and(
          eq(annotations.companyId, companyId),
          eq(annotations.isDeleted, false),
        ),
      )
      .orderBy(desc(annotations.createdAt))
      .limit(500);

    const visible = rows.filter((r) => {
      if (r.visibility === "admin_only" && !isAdmin && r.authorId !== userId) return false;
      return true;
    });

    res.json({ annotations: visible });
  });

  /** POST /annotations */
  router.post("/annotations", async (req, res) => {
    assertBoard(req);

    const body = req.body as Record<string, unknown>;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const label = typeof body["label"] === "string" ? body["label"].trim() : null;
    if (!label) throw badRequest("label is required");

    const annotationType = ANNOTATION_TYPES.includes(body["annotationType"] as typeof ANNOTATION_TYPES[number])
      ? (body["annotationType"] as typeof ANNOTATION_TYPES[number])
      : "note";

    const severity = SEVERITIES.includes(body["severity"] as typeof SEVERITIES[number])
      ? (body["severity"] as typeof SEVERITIES[number])
      : "info";

    const visibility = VISIBILITIES.includes(body["visibility"] as typeof VISIBILITIES[number])
      ? (body["visibility"] as typeof VISIBILITIES[number])
      : "org_wide";

    if (!body["geometry"] || typeof body["geometry"] !== "object") {
      throw badRequest("geometry is required (GeoJSON)");
    }

    const userId = req.actor?.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [row] = await db
      .insert(annotations)
      .values({
        companyId,
        authorId: userId,
        authorName: typeof body["authorName"] === "string" ? body["authorName"] : null,
        label,
        annotationType,
        severity,
        visibility,
        geometry: body["geometry"] as object,
        irwinIncidentId: typeof body["irwinIncidentId"] === "string" ? body["irwinIncidentId"] : null,
      })
      .returning();

    res.status(201).json(row);
  });

  /** PATCH /annotations/:id */
  router.patch("/annotations/:id", async (req, res) => {
    assertBoard(req);

    const { id } = req.params;
    const userId = req.actor?.userId ?? null;
    const isAdmin = isAdminActor(req);

    const [existing] = await db.select().from(annotations).where(eq(annotations.id, id));
    if (!existing || existing.isDeleted) throw notFound("Annotation not found");

    const body = req.body as Record<string, unknown>;
    const companyId = existing.companyId;
    assertCompanyAccess(req, companyId);

    if (!isAdmin && existing.authorId !== userId) {
      throw badRequest("Only the author or an admin may edit this annotation");
    }

    const updates: Partial<typeof annotations.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (typeof body["label"] === "string" && body["label"].trim()) updates.label = body["label"].trim();
    if (ANNOTATION_TYPES.includes(body["annotationType"] as typeof ANNOTATION_TYPES[number])) {
      updates.annotationType = body["annotationType"] as typeof ANNOTATION_TYPES[number];
    }
    if (SEVERITIES.includes(body["severity"] as typeof SEVERITIES[number])) {
      updates.severity = body["severity"] as typeof SEVERITIES[number];
    }
    if (VISIBILITIES.includes(body["visibility"] as typeof VISIBILITIES[number])) {
      updates.visibility = body["visibility"] as typeof VISIBILITIES[number];
    }
    if (body["geometry"] && typeof body["geometry"] === "object") {
      updates.geometry = body["geometry"] as object;
    }

    const [updated] = await db
      .update(annotations)
      .set(updates)
      .where(eq(annotations.id, id))
      .returning();

    res.json(updated);
  });

  /** DELETE /annotations/:id */
  router.delete("/annotations/:id", async (req, res) => {
    assertBoard(req);

    const { id } = req.params;
    const userId = req.actor?.userId ?? null;
    const isAdmin = isAdminActor(req);

    const [existing] = await db.select().from(annotations).where(eq(annotations.id, id));
    if (!existing || existing.isDeleted) throw notFound("Annotation not found");

    assertCompanyAccess(req, existing.companyId);

    if (!isAdmin && existing.authorId !== userId) {
      throw badRequest("Only the author or an admin may delete this annotation");
    }

    await db
      .update(annotations)
      .set({ isDeleted: true, updatedAt: new Date() })
      .where(eq(annotations.id, id));

    res.status(204).end();
  });

  return router;
}
