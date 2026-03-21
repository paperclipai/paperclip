import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  companyPortabilityExportSchema,
  companyPortabilityImportSchema,
  companyPortabilityPreviewSchema,
  createCompanySchema,
  updateCompanySchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  budgetService,
  companyPortabilityService,
  companyService,
  logActivity,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function companyRoutes(db: Db) {
  const router = Router();
  const svc = companyService(db);
  const portability = companyPortabilityService(db);
  const access = accessService(db);
  const budgets = budgetService(db);

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
    const filtered = allowed
      ? Object.fromEntries(Object.entries(stats).filter(([companyId]) => allowed.has(companyId)))
      : stats;

    if (req.query.includeChildren !== "true") {
      res.json(filtered);
      return;
    }

    // Build child → parent map to aggregate subsidiary counts into holding totals
    const all = await svc.list();
    const childrenByParent = new Map<string, string[]>();
    for (const c of all) {
      if (c.parentCompanyId) {
        const siblings = childrenByParent.get(c.parentCompanyId) ?? [];
        siblings.push(c.id);
        childrenByParent.set(c.parentCompanyId, siblings);
      }
    }

    const result: Record<string, {
      agentCount: number; issueCount: number;
      subsidiaryCount: number; totalAgentCount: number; totalIssueCount: number;
    }> = {};
    for (const [companyId, s] of Object.entries(filtered)) {
      const children = childrenByParent.get(companyId) ?? [];
      const totalAgentCount = s.agentCount + children.reduce((sum, cid) => sum + (stats[cid]?.agentCount ?? 0), 0);
      const totalIssueCount = s.issueCount + children.reduce((sum, cid) => sum + (stats[cid]?.issueCount ?? 0), 0);
      result[companyId] = { ...s, subsidiaryCount: children.length, totalAgentCount, totalIssueCount };
    }
    res.json(result);
  });

  router.get("/tree", async (req, res) => {
    assertBoard(req);
    const all = await svc.list();
    const visible = (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)
      ? all
      : (() => {
          const actorIds = new Set(req.actor.companyIds ?? []);
          // Include subsidiaries of any company the actor has access to
          const parentIds = new Set(all.filter(c => c.parentCompanyId && actorIds.has(c.parentCompanyId)).map(c => c.id));
          return all.filter(c => actorIds.has(c.id) || parentIds.has(c.id));
        })();

    type TreeNode = (typeof visible[0]) & { children: TreeNode[] };
    const byId = new Map<string, TreeNode>(visible.map(c => [c.id, { ...c, children: [] }]));
    const roots: TreeNode[] = [];
    for (const node of byId.values()) {
      if (node.parentCompanyId && byId.has(node.parentCompanyId)) {
        byId.get(node.parentCompanyId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    res.json(roots);
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.get("/:companyId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
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
    if (req.body.target.mode === "existing_company") {
      assertCompanyAccess(req, req.body.target.companyId);
    } else {
      assertBoard(req);
    }
    const preview = await portability.previewImport(req.body);
    res.json(preview);
  });

  router.post("/import", validate(companyPortabilityImportSchema), async (req, res) => {
    if (req.body.target.mode === "existing_company") {
      assertCompanyAccess(req, req.body.target.companyId);
    } else {
      assertBoard(req);
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
    res.status(201).json(company);
  });

  router.patch("/:companyId", validate(updateCompanySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await svc.update(companyId, req.body);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.updated",
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

  return router;
}
