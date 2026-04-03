import { Router } from "express";
import type { Db } from "@ironworksai/db";
import { agentRoleTemplates } from "@ironworksai/db";
import { and, desc, eq, or } from "drizzle-orm";
import { DEPARTMENTS, EMPLOYMENT_TYPES } from "@ironworksai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";
import { assertCanWrite, assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity } from "../services/index.js";

export function roleTemplateRoutes(db: Db) {
  const router = Router();

  // ── GET /companies/:companyId/role-templates ────────────────────────────────
  // Returns both system templates and custom templates for this company.
  router.get("/companies/:companyId/role-templates", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const rows = await db
      .select()
      .from(agentRoleTemplates)
      .where(
        or(
          eq(agentRoleTemplates.companyId, companyId),
          eq(agentRoleTemplates.isSystem, true),
        ),
      )
      .orderBy(desc(agentRoleTemplates.isSystem), agentRoleTemplates.name)
      .limit(200);

    res.json(rows);
  });

  // ── POST /companies/:companyId/role-templates ───────────────────────────────
  router.post("/companies/:companyId/role-templates", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanWrite(req, companyId, db);

    const {
      name,
      role,
      department,
      employmentType,
      title,
      capabilities,
      defaultKbPageIds,
      defaultPermissions,
      systemPromptTemplate,
    } = req.body as Record<string, unknown>;

    if (!name || typeof name !== "string") {
      throw badRequest("name is required");
    }
    if (!role || typeof role !== "string") {
      throw badRequest("role is required");
    }
    if (!title || typeof title !== "string") {
      throw badRequest("title is required");
    }

    const row = await db
      .insert(agentRoleTemplates)
      .values({
        companyId,
        name: name as string,
        role: role as string,
        title: title as string,
        department: typeof department === "string" && (DEPARTMENTS as readonly string[]).includes(department) ? department : null,
        employmentType: typeof employmentType === "string" && ([...EMPLOYMENT_TYPES, "any"] as string[]).includes(employmentType) ? employmentType : "any",
        capabilities: typeof capabilities === "string" ? capabilities : null,
        defaultKbPageIds: Array.isArray(defaultKbPageIds) ? defaultKbPageIds : [],
        defaultPermissions: (defaultPermissions && typeof defaultPermissions === "object" && !Array.isArray(defaultPermissions))
          ? defaultPermissions as Record<string, unknown>
          : {},
        systemPromptTemplate: typeof systemPromptTemplate === "string" ? systemPromptTemplate : null,
        isSystem: false,
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
      action: "role_template.created",
      entityType: "role_template",
      entityId: row.id,
      details: { name: row.name, role: row.role },
    });

    res.status(201).json(row);
  });

  // ── PATCH /companies/:companyId/role-templates/:id ──────────────────────────
  router.patch("/companies/:companyId/role-templates/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCanWrite(req, companyId, db);

    const existing = await db
      .select()
      .from(agentRoleTemplates)
      .where(and(eq(agentRoleTemplates.id, id), eq(agentRoleTemplates.companyId, companyId)))
      .then((rows) => rows[0] ?? null);

    if (!existing) {
      throw notFound("Role template not found");
    }
    if (existing.isSystem) {
      throw forbidden("System templates cannot be modified");
    }

    const {
      name,
      role,
      department,
      employmentType,
      title,
      capabilities,
      defaultKbPageIds,
      defaultPermissions,
      systemPromptTemplate,
    } = req.body as Record<string, unknown>;

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof name === "string") updates.name = name;
    if (typeof role === "string") updates.role = role;
    if (typeof title === "string") updates.title = title;
    if (typeof department === "string") updates.department = department;
    if (typeof employmentType === "string") updates.employmentType = employmentType;
    if (typeof capabilities === "string") updates.capabilities = capabilities;
    if (Array.isArray(defaultKbPageIds)) updates.defaultKbPageIds = defaultKbPageIds;
    if (defaultPermissions && typeof defaultPermissions === "object" && !Array.isArray(defaultPermissions)) {
      updates.defaultPermissions = defaultPermissions;
    }
    if (typeof systemPromptTemplate === "string") updates.systemPromptTemplate = systemPromptTemplate;

    const updated = await db
      .update(agentRoleTemplates)
      .set(updates)
      .where(and(eq(agentRoleTemplates.id, id), eq(agentRoleTemplates.companyId, companyId)))
      .returning()
      .then((rows) => rows[0]!);

    res.json(updated);
  });

  // ── DELETE /companies/:companyId/role-templates/:id ─────────────────────────
  router.delete("/companies/:companyId/role-templates/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCanWrite(req, companyId, db);

    const existing = await db
      .select({ id: agentRoleTemplates.id, isSystem: agentRoleTemplates.isSystem })
      .from(agentRoleTemplates)
      .where(and(eq(agentRoleTemplates.id, id), eq(agentRoleTemplates.companyId, companyId)))
      .then((rows) => rows[0] ?? null);

    if (!existing) {
      throw notFound("Role template not found");
    }
    if (existing.isSystem) {
      throw forbidden("System templates cannot be deleted");
    }

    await db
      .delete(agentRoleTemplates)
      .where(eq(agentRoleTemplates.id, id));

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "role_template.deleted",
      entityType: "role_template",
      entityId: id,
    });

    res.json({ ok: true });
  });

  return router;
}
