import { Router } from "express";
import type { Db } from "@ironworksai/db";
import {
  createCostEventSchema,
  createFinanceEventSchema,
  resolveBudgetIncidentSchema,
  updateBudgetSchema,
  upsertBudgetPolicySchema,
} from "@ironworksai/shared";
import { validate } from "../middleware/validate.js";
import {
  budgetService,
  costService,
  financeService,
  companyService,
  agentService,
  heartbeatService,
  logActivity,
} from "../services/index.js";
import { costPerIssue } from "../services/costs.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { fetchAllQuotaWindows } from "../services/quota-windows.js";
import { badRequest } from "../errors.js";
import { calculateTotalEquivalentSpend, getRateCard } from "../services/equivalent-spend.js";

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

  router.post("/companies/:companyId/cost-events", validate(createCostEventSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only report its own costs" });
      return;
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
    assertCompanyAccess(req, companyId);
    const range = parseDateRange(req.query);
    const summary = await costs.summary(companyId, range);
    res.json(summary);
  });

  router.get("/companies/:companyId/costs/by-agent", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseDateRange(req.query);
    const rows = await costs.byAgent(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-agent-model", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseDateRange(req.query);
    const rows = await costs.byAgentModel(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-provider", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseDateRange(req.query);
    const rows = await costs.byProvider(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-biller", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseDateRange(req.query);
    const rows = await costs.byBiller(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseDateRange(req.query);
    const summary = await finance.summary(companyId, range);
    res.json(summary);
  });

  router.get("/companies/:companyId/costs/finance-by-biller", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseDateRange(req.query);
    const rows = await finance.byBiller(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-by-kind", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseDateRange(req.query);
    const rows = await finance.byKind(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-events", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseDateRange(req.query);
    const limit = parseLimit(req.query);
    const rows = await finance.list(companyId, range, limit);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/window-spend", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await costs.windowSpend(companyId);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/quota-windows", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
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
    assertCompanyAccess(req, companyId);
    const overview = await budgets.overview(companyId);
    res.json(overview);
  });

  router.post(
    "/companies/:companyId/budgets/policies",
    validate(upsertBudgetPolicySchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
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
      const incident = await budgets.resolveIncident(companyId, incidentId, req.body, req.actor.userId ?? "board");
      res.json(incident);
    },
  );

  router.get("/companies/:companyId/costs/by-project", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseDateRange(req.query);
    const rows = await costs.byProject(companyId, range);
    res.json(rows);
  });

  /**
   * GET /companies/:companyId/costs/equivalent-spend
   * Calculate what subscription usage would cost if billed per API call.
   */
  router.get("/companies/:companyId/costs/equivalent-spend", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseDateRange(req.query);

    // Get all cost events with token data
    const byAgentModel = await costs.byAgentModel(companyId, range);

    // Separate subscription vs API usage
    const subscriptionEntries = byAgentModel.filter(
      (e: Record<string, unknown>) =>
        (e.billingType as string) === "subscription_included" ||
        (e.billingType as string) === "subscription_overage",
    );
    const apiEntries = byAgentModel.filter(
      (e: Record<string, unknown>) => (e.billingType as string) === "metered_api",
    );

    const subscriptionEquivalentCents = calculateTotalEquivalentSpend(
      subscriptionEntries.map((e: Record<string, unknown>) => ({
        model: (e.model as string) ?? "unknown",
        inputTokens: Number(e.inputTokens ?? 0),
        cachedInputTokens: Number(e.cachedInputTokens ?? 0),
        outputTokens: Number(e.outputTokens ?? 0),
      })),
    );

    const apiActualCents = apiEntries.reduce(
      (sum: number, e: Record<string, unknown>) => sum + Number(e.costCents ?? 0),
      0,
    );

    const totalEquivalentCents = subscriptionEquivalentCents + apiActualCents;

    // Determine billing mode
    const hasSubscription = subscriptionEntries.length > 0;
    const hasApi = apiEntries.length > 0;
    const billingMode = hasSubscription && hasApi
      ? "mixed"
      : hasSubscription
        ? "subscription"
        : hasApi
          ? "api"
          : "none";

    res.json({
      billingMode,
      actualSpendCents: apiActualCents,
      subscriptionEquivalentCents,
      totalEquivalentCents,
      subscriptionTokens: {
        input: subscriptionEntries.reduce((s: number, e: Record<string, unknown>) => s + Number(e.inputTokens ?? 0), 0),
        cachedInput: subscriptionEntries.reduce((s: number, e: Record<string, unknown>) => s + Number(e.cachedInputTokens ?? 0), 0),
        output: subscriptionEntries.reduce((s: number, e: Record<string, unknown>) => s + Number(e.outputTokens ?? 0), 0),
      },
      apiTokens: {
        input: apiEntries.reduce((s: number, e: Record<string, unknown>) => s + Number(e.inputTokens ?? 0), 0),
        cachedInput: apiEntries.reduce((s: number, e: Record<string, unknown>) => s + Number(e.cachedInputTokens ?? 0), 0),
        output: apiEntries.reduce((s: number, e: Record<string, unknown>) => s + Number(e.outputTokens ?? 0), 0),
      },
      note: billingMode === "subscription"
        ? "All usage is covered by your subscription. Equivalent spend shows what this would cost per API call."
        : billingMode === "mixed"
          ? "Some usage is subscription-covered, some is API-metered."
          : billingMode === "api"
            ? "All usage is billed per API call."
            : "No usage recorded for this period.",
    });
  });

  /** Rate card for reference. */
  router.get("/costs/rate-card", (_req, res) => {
    res.json(getRateCard());
  });

  /**
   * GET /companies/:companyId/costs/by-project-detail
   * Per-project costs with agent-level breakdown within each project.
   */
  router.get("/companies/:companyId/costs/by-project-detail", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const range = parseDateRange(req.query);

    const projectCosts = await costs.byProject(companyId, range);
    const agentModelCosts = await costs.byAgentModel(companyId, range);

    // Enrich project costs with equivalent spend and agent breakdown
    const enriched = (projectCosts as Array<Record<string, unknown>>).map((project) => {
      const projectId = project.projectId as string;

      // Calculate equivalent spend for this project's tokens
      const equivalentCents = calculateTotalEquivalentSpend([
        {
          model: "unknown", // aggregate — use default rate
          inputTokens: Number(project.inputTokens ?? 0),
          cachedInputTokens: Number(project.cachedInputTokens ?? 0),
          outputTokens: Number(project.outputTokens ?? 0),
        },
      ]);

      return {
        ...project,
        equivalentSpendCents: equivalentCents,
      };
    });

    res.json(enriched);
  });

  /**
   * GET /companies/:companyId/costs/project-export
   * Export project costs as CSV for client billing.
   */
  router.get("/companies/:companyId/costs/project-export", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const range = parseDateRange(req.query);
    const projectId = req.query.projectId as string | undefined;

    if (!projectId) {
      res.status(400).json({ error: "projectId query parameter is required" });
      return;
    }

    const projectCosts = await costs.byProject(companyId, range);
    const byAgent = await costs.byAgent(companyId, range);
    const byAgentModel = await costs.byAgentModel(companyId, range);

    // Build CSV
    const lines: string[] = [
      "Period,Agent,Model,Provider,Billing Type,Input Tokens,Cached Input Tokens,Output Tokens,Actual Cost (USD),Equivalent Cost (USD)",
    ];

    const fromStr = range?.from?.toISOString().split("T")[0] ?? "start";
    const toStr = range?.to?.toISOString().split("T")[0] ?? "now";
    const period = `${fromStr} to ${toStr}`;

    for (const entry of byAgentModel as Array<Record<string, unknown>>) {
      const inputTokens = Number(entry.inputTokens ?? 0);
      const cachedInputTokens = Number(entry.cachedInputTokens ?? 0);
      const outputTokens = Number(entry.outputTokens ?? 0);
      const actualCost = Number(entry.costCents ?? 0) / 100;
      const equivCost = calculateTotalEquivalentSpend([{
        model: (entry.model as string) ?? "unknown",
        inputTokens,
        cachedInputTokens,
        outputTokens,
      }]) / 100;

      lines.push(
        `"${period}","${entry.agentName ?? "Unknown"}","${entry.model ?? ""}","${entry.provider ?? ""}","${entry.billingType ?? ""}",${inputTokens},${cachedInputTokens},${outputTokens},${actualCost.toFixed(2)},${equivCost.toFixed(2)}`,
      );
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="ironworks-costs-${projectId.slice(0, 8)}-${fromStr}-${toStr}.csv"`,
    );
    res.send(lines.join("\n"));
  });

  /**
   * GET /companies/:companyId/cost-per-issue?days=30
   * Aggregate LLM cost per issue for a company.
   */
  router.get("/companies/:companyId/cost-per-issue", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const daysRaw = req.query.days as string | undefined;
    const days = daysRaw ? parseInt(daysRaw, 10) : 30;
    if (daysRaw && (!Number.isFinite(days) || days <= 0)) {
      res.status(400).json({ error: "invalid 'days' query parameter" });
      return;
    }
    const rows = await costPerIssue(db, companyId, days);
    res.json(rows);
  });

  router.patch("/companies/:companyId/budgets", validate(updateBudgetSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
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

    assertCompanyAccess(req, agent.companyId);

    if (req.actor.type === "agent") {
      if (req.actor.agentId !== agentId) {
        res.status(403).json({ error: "Agent can only change its own budget" });
        return;
      }
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
