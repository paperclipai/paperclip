import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { budgetIncidents, costEvents, type Db } from "@paperclipai/db";
import {
  createCostEventSchema,
  createFinanceEventSchema,
  resolveBudgetIncidentSchema,
  updateBudgetSchema,
  upsertBudgetPolicySchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  budgetService,
  costService,
  financeService,
  companyService,
  agentService,
  heartbeatService,
  issueService,
  logActivity,
  projectService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { fetchAllQuotaWindows } from "../services/quota-windows.js";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { scopedCompanyAuthz } from "./scoped-company-authz.js";

export function costRoutes(db: Db) {
  const router = Router();
  const heartbeat = heartbeatService(db);
  const budgetHooks = {
    cancelWorkForScope: heartbeat.cancelBudgetScopeWork,
  };
  const costs = costService(db, budgetHooks);
  const finance = financeService(db);
  const budgets = budgetService(db, budgetHooks);
  const companies = companyService(db);
  const agents = agentService(db);
  const issues = issueService(db);
  const projects = projectService(db);
  const scopedAuthz = scopedCompanyAuthz(db);

  const costReadPermissionKeys = [
    "issues:view",
    "projects:view",
    "agents:view",
    "departments:view",
    "teams:view",
  ] as const;

  const companyManagePermissionKeys = [
    "issues:manage",
    "projects:manage",
    "agents:manage",
  ] as const;

  async function resolveIssueDepartmentId(companyId: string, issueId: string) {
    const issue = await issues.getById(issueId);
    if (!issue) throw notFound("Issue not found");
    if (issue.companyId !== companyId) throw unprocessable("Issue does not belong to company");
    if (issue.departmentId !== undefined && issue.departmentId !== null) {
      return issue.departmentId ?? null;
    }
    if (!issue.projectId) return null;
    const project = await projects.getById(issue.projectId);
    if (!project || project.companyId !== companyId) return null;
    return project.departmentId ?? null;
  }

  async function resolveIssueProjectId(companyId: string, issueId: string) {
    const issue = await issues.getById(issueId);
    if (!issue) throw notFound("Issue not found");
    if (issue.companyId !== companyId) throw unprocessable("Issue does not belong to company");
    return issue.projectId ?? null;
  }

  async function resolveProjectDepartmentId(companyId: string, projectId: string) {
    const project = await projects.getById(projectId);
    if (!project) throw notFound("Project not found");
    if (project.companyId !== companyId) throw unprocessable("Project does not belong to company");
    return project.departmentId ?? null;
  }

  async function resolveAgentDepartmentId(companyId: string, agentId: string) {
    const agent = await agents.getById(agentId);
    if (!agent) throw notFound("Agent not found");
    if (agent.companyId !== companyId) throw unprocessable("Agent does not belong to company");
    return agent.departmentId ?? null;
  }

  async function resolveCostEventDepartmentId(companyId: string, costEventId: string): Promise<string | null> {
    const event = await db
      .select({
        companyId: costEvents.companyId,
        issueId: costEvents.issueId,
        projectId: costEvents.projectId,
        agentId: costEvents.agentId,
      })
      .from(costEvents)
      .where(eq(costEvents.id, costEventId))
      .then((rows) => rows[0] ?? null);
    if (!event) throw notFound("Cost event not found");
    if (event.companyId !== companyId) throw unprocessable("Cost event does not belong to company");
    return resolveScopeDepartmentForEvent(companyId, {
      issueId: event.issueId,
      projectId: event.projectId,
      agentId: event.agentId,
    });
  }

  async function resolveScopeDepartmentForEvent(
    companyId: string,
    input: {
      issueId?: string | null;
      projectId?: string | null;
      agentId?: string | null;
      costEventId?: string | null;
    },
  ): Promise<string | null> {
    if (input.issueId) {
      if (input.projectId) {
        const issueProjectId = await resolveIssueProjectId(companyId, input.issueId);
        if (issueProjectId !== input.projectId) {
          throw unprocessable("Issue does not belong to project");
        }
      }
      return resolveIssueDepartmentId(companyId, input.issueId);
    }
    if (input.projectId) {
      return resolveProjectDepartmentId(companyId, input.projectId);
    }
    if (input.costEventId) {
      return resolveCostEventDepartmentId(companyId, input.costEventId);
    }
    if (input.agentId) {
      return resolveAgentDepartmentId(companyId, input.agentId);
    }
    return null;
  }

  async function assertBudgetScopeManagePermission(
    req: Request,
    companyId: string,
    scopeType: string,
    scopeId: string,
  ) {
    if (scopeType === "company") {
      await scopedAuthz.assertAnyScopedPermission(req, companyId, companyManagePermissionKeys, null);
      return;
    }
    if (scopeType === "project") {
      const departmentId = await resolveProjectDepartmentId(companyId, scopeId);
      await scopedAuthz.assertAnyScopedPermission(req, companyId, ["projects:manage"], departmentId);
      return;
    }
    if (scopeType === "agent") {
      const departmentId = await resolveAgentDepartmentId(companyId, scopeId);
      await scopedAuthz.assertAnyScopedPermission(req, companyId, ["agents:manage"], departmentId);
      return;
    }
    throw badRequest("Unsupported budget scope type");
  }

  async function filterBudgetOverviewByScope(
    overview: Awaited<ReturnType<typeof budgets.overview>>,
    scopeDepartmentIds: string[],
  ) {
    const projectDepartments = new Map<string, string | null>();
    const agentDepartments = new Map<string, string | null>();

    async function resolveScopeDepartment(scopeType: string, scopeId: string) {
      if (scopeType === "project") {
        if (!projectDepartments.has(scopeId)) {
          projectDepartments.set(scopeId, await resolveProjectDepartmentId(overview.companyId, scopeId));
        }
        return projectDepartments.get(scopeId) ?? null;
      }

      if (scopeType === "agent") {
        if (!agentDepartments.has(scopeId)) {
          agentDepartments.set(scopeId, await resolveAgentDepartmentId(overview.companyId, scopeId));
        }
        return agentDepartments.get(scopeId) ?? null;
      }

      return null;
    }

    const policies = [];
    for (const policy of overview.policies) {
      const departmentId = await resolveScopeDepartment(policy.scopeType, policy.scopeId);
      if (departmentId && scopeDepartmentIds.includes(departmentId)) {
        policies.push(policy);
      }
    }

    const activeIncidents = [];
    for (const incident of overview.activeIncidents) {
      const departmentId = await resolveScopeDepartment(incident.scopeType, incident.scopeId);
      if (departmentId && scopeDepartmentIds.includes(departmentId)) {
        activeIncidents.push(incident);
      }
    }

    return {
      ...overview,
      policies,
      activeIncidents,
      pausedAgentCount: policies.filter((policy) => policy.scopeType === "agent" && policy.paused).length,
      pausedProjectCount: policies.filter((policy) => policy.scopeType === "project" && policy.paused).length,
      pendingApprovalCount: activeIncidents.filter((incident) => incident.approvalStatus === "pending").length,
    };
  }

  router.post("/companies/:companyId/cost-events", validate(createCostEventSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only report its own costs" });
      return;
    }
    if (req.actor.type !== "agent") {
      const departmentId = await resolveScopeDepartmentForEvent(companyId, req.body);
      await scopedAuthz.assertAnyScopedPermission(req, companyId, companyManagePermissionKeys, departmentId);
    }

    const event = await costs.createEvent(companyId, {
      ...req.body,
      occurredAt: new Date(req.body.occurredAt),
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "cost.reported",
      entityType: "cost_event",
      entityId: event.id,
      details: { costCents: event.costCents, model: event.model },
    });

    res.status(201).json(event);
  });

  router.post("/companies/:companyId/finance-events", validate(createFinanceEventSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const departmentId = await resolveScopeDepartmentForEvent(companyId, req.body);
    await scopedAuthz.assertAnyScopedPermission(req, companyId, companyManagePermissionKeys, departmentId);

    const event = await finance.createEvent(companyId, {
      ...req.body,
      occurredAt: new Date(req.body.occurredAt),
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "finance_event.reported",
      entityType: "finance_event",
      entityId: event.id,
      details: {
        amountCents: event.amountCents,
        biller: event.biller,
        eventKind: event.eventKind,
        direction: event.direction,
      },
    });

    res.status(201).json(event);
  });

  function parseDateRange(query: Record<string, unknown>) {
    const fromRaw = query.from as string | undefined;
    const toRaw = query.to as string | undefined;
    const from = fromRaw ? new Date(fromRaw) : undefined;
    const to = toRaw ? new Date(toRaw) : undefined;
    if (from && isNaN(from.getTime())) throw badRequest("invalid 'from' date");
    if (to && isNaN(to.getTime())) throw badRequest("invalid 'to' date");
    return (from || to) ? { from, to } : undefined;
  }

  function parseLimit(query: Record<string, unknown>) {
    const raw = Array.isArray(query.limit) ? query.limit[0] : query.limit;
    if (raw == null || raw === "") return 100;
    const limit = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
    if (!Number.isFinite(limit) || limit <= 0 || limit > 500) {
      throw badRequest("invalid 'limit' value");
    }
    return limit;
  }

  router.get("/companies/:companyId/costs/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scope = await scopedAuthz.resolveAnyScopedPermission(req, companyId, costReadPermissionKeys);
    const range = parseDateRange(req.query);
    const summary = await costs.summary(
      companyId,
      range,
      scope.companyWide ? undefined : { scopeDepartmentIds: scope.departmentIds },
    );
    res.json(scope.companyWide ? summary : { ...summary, budgetCents: 0, utilizationPercent: 0 });
  });

  router.get("/companies/:companyId/costs/by-agent", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scope = await scopedAuthz.resolveAnyScopedPermission(req, companyId, costReadPermissionKeys);
    const range = parseDateRange(req.query);
    const rows = await costs.byAgent(
      companyId,
      range,
      scope.companyWide ? undefined : { scopeDepartmentIds: scope.departmentIds },
    );
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-agent-model", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scope = await scopedAuthz.resolveAnyScopedPermission(req, companyId, costReadPermissionKeys);
    const range = parseDateRange(req.query);
    const rows = await costs.byAgentModel(
      companyId,
      range,
      scope.companyWide ? undefined : { scopeDepartmentIds: scope.departmentIds },
    );
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-provider", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scope = await scopedAuthz.resolveAnyScopedPermission(req, companyId, costReadPermissionKeys);
    const range = parseDateRange(req.query);
    const rows = await costs.byProvider(
      companyId,
      range,
      scope.companyWide ? undefined : { scopeDepartmentIds: scope.departmentIds },
    );
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-biller", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scope = await scopedAuthz.resolveAnyScopedPermission(req, companyId, costReadPermissionKeys);
    const range = parseDateRange(req.query);
    const rows = await costs.byBiller(
      companyId,
      range,
      scope.companyWide ? undefined : { scopeDepartmentIds: scope.departmentIds },
    );
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scope = await scopedAuthz.resolveAnyScopedPermission(req, companyId, costReadPermissionKeys);
    const range = parseDateRange(req.query);
    const summary = await finance.summary(
      companyId,
      range,
      scope.companyWide ? undefined : { scopeDepartmentIds: scope.departmentIds },
    );
    res.json(summary);
  });

  router.get("/companies/:companyId/costs/finance-by-biller", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scope = await scopedAuthz.resolveAnyScopedPermission(req, companyId, costReadPermissionKeys);
    const range = parseDateRange(req.query);
    const rows = await finance.byBiller(
      companyId,
      range,
      scope.companyWide ? undefined : { scopeDepartmentIds: scope.departmentIds },
    );
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-by-kind", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scope = await scopedAuthz.resolveAnyScopedPermission(req, companyId, costReadPermissionKeys);
    const range = parseDateRange(req.query);
    const rows = await finance.byKind(
      companyId,
      range,
      scope.companyWide ? undefined : { scopeDepartmentIds: scope.departmentIds },
    );
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-events", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scope = await scopedAuthz.resolveAnyScopedPermission(req, companyId, costReadPermissionKeys);
    const range = parseDateRange(req.query);
    const limit = parseLimit(req.query);
    const rows = await finance.list(
      companyId,
      range,
      limit,
      scope.companyWide ? undefined : { scopeDepartmentIds: scope.departmentIds },
    );
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/window-spend", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scope = await scopedAuthz.resolveAnyScopedPermission(req, companyId, costReadPermissionKeys);
    const rows = await costs.windowSpend(
      companyId,
      scope.companyWide ? undefined : { scopeDepartmentIds: scope.departmentIds },
    );
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/quota-windows", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    await scopedAuthz.assertAnyScopedPermission(req, companyId, costReadPermissionKeys, null);
    // validate companyId resolves to a real company so the "__none__" sentinel
    // and any forged ids are rejected before we touch provider credentials
    const company = await companies.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const results = await fetchAllQuotaWindows();
    res.json(results);
  });

  router.get("/companies/:companyId/budgets/overview", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scope = await scopedAuthz.resolveAnyScopedPermission(req, companyId, costReadPermissionKeys);
    const overview = await budgets.overview(companyId);
    res.json(
      scope.companyWide
        ? overview
        : await filterBudgetOverviewByScope(overview, scope.departmentIds),
    );
  });

  router.post(
    "/companies/:companyId/budgets/policies",
    validate(upsertBudgetPolicySchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      await assertBudgetScopeManagePermission(req, companyId, req.body.scopeType, req.body.scopeId);
      const summary = await budgets.upsertPolicy(companyId, req.body, req.actor.userId ?? "board");
      res.json(summary);
    },
  );

  router.post(
    "/companies/:companyId/budget-incidents/:incidentId/resolve",
    validate(resolveBudgetIncidentSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const incidentId = req.params.incidentId as string;
      assertCompanyAccess(req, companyId);
      const incidentRecord = await db
        .select({
          companyId: budgetIncidents.companyId,
          scopeType: budgetIncidents.scopeType,
          scopeId: budgetIncidents.scopeId,
        })
        .from(budgetIncidents)
        .where(eq(budgetIncidents.id, incidentId))
        .then((rows) => rows[0] ?? null);
      if (!incidentRecord || incidentRecord.companyId !== companyId) {
        throw notFound("Budget incident not found");
      }
      await assertBudgetScopeManagePermission(req, companyId, incidentRecord.scopeType, incidentRecord.scopeId);
      const incident = await budgets.resolveIncident(companyId, incidentId, req.body, req.actor.userId ?? "board");
      res.json(incident);
    },
  );

  router.get("/companies/:companyId/costs/by-project", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scope = await scopedAuthz.resolveAnyScopedPermission(req, companyId, costReadPermissionKeys);
    const range = parseDateRange(req.query);
    const rows = await costs.byProject(
      companyId,
      range,
      scope.companyWide ? undefined : { scopeDepartmentIds: scope.departmentIds },
    );
    res.json(rows);
  });

  router.patch("/companies/:companyId/budgets", validate(updateBudgetSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await scopedAuthz.assertAnyScopedPermission(req, companyId, companyManagePermissionKeys, null);
    const company = await companies.update(companyId, { budgetMonthlyCents: req.body.budgetMonthlyCents });
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.budget_updated",
      entityType: "company",
      entityId: companyId,
      details: { budgetMonthlyCents: req.body.budgetMonthlyCents },
    });

    await budgets.upsertPolicy(
      companyId,
      {
        scopeType: "company",
        scopeId: companyId,
        amount: req.body.budgetMonthlyCents,
        windowKind: "calendar_month_utc",
      },
      req.actor.userId ?? "board",
    );

    res.json(company);
  });

  router.patch("/agents/:agentId/budgets", validate(updateBudgetSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const agent = await agents.getById(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    if (req.actor.type === "agent") {
      if (req.actor.agentId !== agentId) {
        res.status(403).json({ error: "Agent can only change its own budget" });
        return;
      }
      assertCompanyAccess(req, agent.companyId);
    } else {
      assertBoard(req);
      await scopedAuthz.assertAnyScopedPermission(req, agent.companyId, ["agents:manage"], agent.departmentId ?? null);
    }

    const updated = await agents.update(agentId, { budgetMonthlyCents: req.body.budgetMonthlyCents });
    if (!updated) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "agent.budget_updated",
      entityType: "agent",
      entityId: updated.id,
      details: { budgetMonthlyCents: updated.budgetMonthlyCents },
    });

    await budgets.upsertPolicy(
      updated.companyId,
      {
        scopeType: "agent",
        scopeId: updated.id,
        amount: updated.budgetMonthlyCents,
        windowKind: "calendar_month_utc",
      },
      req.actor.type === "board" ? req.actor.userId ?? "board" : null,
    );

    res.json(updated);
  });

  return router;
}
