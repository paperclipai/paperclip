import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { companyMemberships } from "@ironworksai/db";
import {
  companyPortabilityExportSchema,
  companyPortabilityImportSchema,
  companyPortabilityPreviewSchema,
  createCompanySchema,
  updateCompanyBrandingSchema,
  updateCompanySchema,
} from "@ironworksai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  budgetService,
  companyPortabilityService,
  companyService,
  logActivity,
  playbookService,
  routineService,
  seedSystemRoleTemplates,
} from "../services/index.js";
import { knowledgeService } from "../services/knowledge.js";
import { seedDefaultChannels } from "../services/channels.js";
import type { StorageService } from "../storage/types.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";
import { ROLE_DEFAULT_CAPABILITIES } from "../services/role-defaults.js";

export function companyRoutes(db: Db, storage?: StorageService) {
  const router = Router();
  const svc = companyService(db);
  const agents = agentService(db);
  const portability = companyPortabilityService(db, storage);
  const access = accessService(db);
  const budgets = budgetService(db);
  const playbooksvc = playbookService(db);
  const routinesvc = routineService(db);
  const knowledgesvc = knowledgeService(db);

  async function assertCanUpdateBranding(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden("Only CEO agents can update company branding");
    }
  }

  async function assertCanManagePortability(req: Request, companyId: string, capability: "imports" | "exports") {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden(`Only CEO agents can manage company ${capability}`);
    }
  }

  router.get("/", async (req, res) => {
    assertBoard(req);
    const result = await svc.list();
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
      res.json(result);
      return;
    }
    const allowed = new Set(req.actor.companyIds ?? []);
    res.json(result.filter((company) => allowed.has(company.id)));
  });

  router.get("/stats", async (req, res) => {
    assertBoard(req);
    const allowed = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin
      ? null
      : new Set(req.actor.companyIds ?? []);
    const stats = await svc.stats();
    if (!allowed) {
      res.json(stats);
      return;
    }
    const filtered = Object.fromEntries(Object.entries(stats).filter(([companyId]) => allowed.has(companyId)));
    res.json(filtered);
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.get("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    // Allow agents (CEO) to read their own company; board always allowed
    if (req.actor.type !== "agent") {
      assertBoard(req);
    }
    const company = await svc.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(company);
  });

  router.post("/:companyId/export", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await portability.exportBundle(companyId, req.body);
    res.json(result);
  });

  router.post("/import/preview", validate(companyPortabilityPreviewSchema), async (req, res) => {
    assertBoard(req);
    if (req.body.target.mode === "new_company") {
      assertInstanceAdmin(req);
    } else {
      assertCompanyAccess(req, req.body.target.companyId);
    }
    const preview = await portability.previewImport(req.body);
    res.json(preview);
  });

  router.post("/import", validate(companyPortabilityImportSchema), async (req, res) => {
    assertBoard(req);
    if (req.body.target.mode === "new_company") {
      assertInstanceAdmin(req);
    } else {
      assertCompanyAccess(req, req.body.target.companyId);
    }
    const actor = getActorInfo(req);
    const result = await portability.importBundle(req.body, req.actor.type === "board" ? req.actor.userId : null);
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "company.imported",
      entityType: "company",
      entityId: result.company.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        include: req.body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
      },
    });
    res.json(result);
  });

  router.post("/:companyId/exports/preview", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "exports");
    const preview = await portability.previewExport(companyId, req.body);
    res.json(preview);
  });

  router.post("/:companyId/exports", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "exports");
    const result = await portability.exportBundle(companyId, req.body);
    res.json(result);
  });

  router.post("/:companyId/imports/preview", validate(companyPortabilityPreviewSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "imports");
    if (req.body.target.mode === "existing_company" && req.body.target.companyId !== companyId) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (req.body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const preview = await portability.previewImport(req.body, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    res.json(preview);
  });

  router.post("/:companyId/imports/apply", validate(companyPortabilityImportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanManagePortability(req, companyId, "imports");
    if (req.body.target.mode === "existing_company" && req.body.target.companyId !== companyId) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (req.body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const actor = getActorInfo(req);
    const result = await portability.importBundle(req.body, req.actor.type === "board" ? req.actor.userId : null, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      entityType: "company",
      entityId: result.company.id,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.imported",
      details: {
        include: req.body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
        importMode: "agent_safe",
      },
    });
    res.json(result);
  });

  router.post("/", validate(createCompanySchema), async (req, res) => {
    assertBoard(req);
    if (!(req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)) {
      throw forbidden("Instance admin required");
    }
    const company = await svc.create(req.body);
    await access.ensureMembership(company.id, "user", req.actor.userId ?? "local-board", "owner", "active");
    await logActivity(db, {
      companyId: company.id,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.created",
      entityType: "company",
      entityId: company.id,
      details: { name: company.name },
    });
    if (company.budgetMonthlyCents > 0) {
      await budgets.upsertPolicy(
        company.id,
        {
          scopeType: "company",
          scopeId: company.id,
          amount: company.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        req.actor.userId ?? "board",
      );
    }
    // Auto-seed default playbooks, routines, knowledge base, and role templates for every new company
    try {
      await playbooksvc.seedDefaults(company.id);
      await routinesvc.seedDefaults(company.id);
      await knowledgesvc.seedDefaults(company.id);
      await seedSystemRoleTemplates(db, company.id);
    } catch {
      // Non-fatal -- company is created even if seeding fails
    }

    // Auto-create default channels (#company, #engineering, #marketing, #operations, #leadership)
    try {
      await seedDefaultChannels(db, company.id);
    } catch {
      // Non-fatal
    }

    res.status(201).json(company);
  });

  router.patch("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const actor = getActorInfo(req);
    let body: Record<string, unknown>;

    if (req.actor.type === "agent") {
      // Only CEO agents may update company branding fields
      const agentSvc = agentService(db);
      const actorAgent = req.actor.agentId ? await agentSvc.getById(req.actor.agentId) : null;
      if (!actorAgent || actorAgent.role !== "ceo") {
        throw forbidden("Only CEO agents or board users may update company settings");
      }
      if (actorAgent.companyId !== companyId) {
        throw forbidden("Agent key cannot access another company");
      }
      body = updateCompanyBrandingSchema.parse(req.body);
    } else {
      assertBoard(req);
      body = updateCompanySchema.parse(req.body);
    }

    const company = await svc.update(companyId, body);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.updated",
      entityType: "company",
      entityId: companyId,
      details: body,
    });
    res.json(company);
  });

  router.patch("/:companyId/branding", validate(updateCompanyBrandingSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanUpdateBranding(req, companyId);
    const company = await svc.update(companyId, req.body);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.branding_updated",
      entityType: "company",
      entityId: companyId,
      details: req.body,
    });
    res.json(company);
  });

  router.post("/:companyId/archive", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await svc.archive(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.archived",
      entityType: "company",
      entityId: companyId,
    });
    res.json(company);
  });

  router.delete("/:companyId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await svc.remove(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json({ ok: true });
  });

  /**
   * POST /api/companies/:companyId/agents/:agentId/grant-capability
   *
   * Allows an authorized actor to grant or revoke a capability on another
   * agent within the same company.
   *
   * Authorization rules (checked against req.actor, NOT the URL param):
   *   - Board actor (session / board_key / local_implicit): must be an
   *     instance admin OR a company owner/admin membership.
   *   - Agent actor: the authenticated agent (req.actor.agentId) must have
   *     canManagePermissions on its own permissions record.
   *
   * The :agentId URL param is retained for API compatibility and recorded in
   * the activity log, but it is NOT used to make authorization decisions.
   *
   * Body: { targetAgentId: string, capability: string, value: boolean, temporary?: boolean }
   */
  router.post("/:companyId/agents/:agentId/grant-capability", async (req, res) => {
    const companyId = req.params.companyId as string;
    // `:agentId` is kept for API compatibility / activity-log context only.
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);

    const { targetAgentId, capability, value, temporary } = req.body as {
      targetAgentId?: unknown;
      capability?: unknown;
      value?: unknown;
      temporary?: unknown;
    };

    // Validate body
    if (typeof targetAgentId !== "string" || targetAgentId.length === 0) {
      res.status(422).json({ error: "targetAgentId is required" });
      return;
    }
    if (typeof capability !== "string" || capability.length === 0) {
      res.status(422).json({ error: "capability is required" });
      return;
    }
    if (typeof value !== "boolean") {
      res.status(422).json({ error: "value must be a boolean" });
      return;
    }

    // Only known capability names are accepted
    const knownCapabilities = new Set(Object.keys(ROLE_DEFAULT_CAPABILITIES["default"]!));
    knownCapabilities.add("canCreateAgents"); // legacy
    if (!knownCapabilities.has(capability)) {
      res.status(422).json({ error: `Unknown capability: ${capability}` });
      return;
    }

    // SEC-AUTH-001 fix: authorize from req.actor, not the URL-param agent.
    const actorAgentSvc = agentService(db);

    if (req.actor.type === "board") {
      // Board actors: instance admins and local_implicit are always permitted.
      // Regular board users must be an owner or admin of this company.
      const isPrivilegedBoardActor =
        req.actor.source === "local_implicit" || req.actor.isInstanceAdmin;

      if (!isPrivilegedBoardActor) {
        if (!req.actor.userId) {
          res.status(403).json({ error: "Insufficient permissions to manage agent capabilities" });
          return;
        }
        const membership = await db
          .select({ membershipRole: companyMemberships.membershipRole })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, req.actor.userId),
              eq(companyMemberships.status, "active"),
            ),
          )
          .then((rows) => rows[0] ?? null);

        const role = membership?.membershipRole;
        if (role !== "owner" && role !== "admin") {
          res.status(403).json({ error: "Insufficient permissions to manage agent capabilities" });
          return;
        }
      }
    } else if (req.actor.type === "agent") {
      // Agent actors: the AUTHENTICATED agent (from the bearer token) must have
      // canManagePermissions. The URL-param :agentId is irrelevant for authz.
      const callerAgentId = req.actor.agentId;
      if (!callerAgentId) {
        res.status(403).json({ error: "Agent authentication required" });
        return;
      }
      const callerAgent = await actorAgentSvc.getById(callerAgentId);
      if (!callerAgent || callerAgent.companyId !== companyId) {
        res.status(403).json({ error: "Authenticated agent does not belong to this company" });
        return;
      }
      const canManagePermissions = Boolean(callerAgent.permissions?.canManagePermissions);
      if (!canManagePermissions) {
        res.status(403).json({ error: "Agent does not have canManagePermissions" });
        return;
      }
    } else {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    // Resolve target agent
    const targetAgent = await actorAgentSvc.getById(targetAgentId);
    if (!targetAgent || targetAgent.companyId !== companyId) {
      res.status(404).json({ error: "Target agent not found" });
      return;
    }

    // Apply the capability patch
    const existingPerms: Record<string, unknown> = { ...(targetAgent.permissions ?? {}) };
    const updatedPerms = { ...existingPerms, [capability]: value };
    const updatedAgent = await actorAgentSvc.update(targetAgentId, { permissions: updatedPerms });
    if (!updatedAgent) {
      res.status(404).json({ error: "Target agent not found after update" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.capability_granted",
      entityType: "agent",
      entityId: targetAgentId,
      details: {
        grantedByAgentId: agentId,
        capability,
        value,
        temporary: temporary === true,
      },
    });

    res.json({
      agentId: targetAgentId,
      capability,
      value,
      temporary: temporary === true,
      permissions: updatedAgent.permissions,
    });
  });

  return router;
}
