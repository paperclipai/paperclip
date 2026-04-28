import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { rt2PersonalPnLService } from "../services/rt2-personal-pnl.js";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";
import { logActivity } from "../services/activity-log.js";

function routeActor(req: Request) {
  if (req.actor?.type === "agent") return { actorType: "agent" as const, actorId: req.actor.agentId ?? "agent" };
  return { actorType: "user" as const, actorId: req.actor?.userId ?? "rt2-operator" };
}

export function rt2PersonalPnLRoutes(db: Db) {
  const router = Router();
  const svc = rt2PersonalPnLService(db);

  // M2.7: Get company P&L report
  router.get("/companies/:companyId/rt2/pnl", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const period = req.query.period as string | undefined;
    const report = await svc.getCompanyPnLReport(companyId, period);
    res.json(report);
  });

  // M2.7: Get P&L summary
  router.get("/companies/:companyId/rt2/pnl/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const period = req.query.period as string | undefined;
    const summary = await svc.getCompanyPnLSummary(companyId, period);
    res.json(summary);
  });

  router.get("/companies/:companyId/rt2/pnl/drilldown/:actorId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { actorId } = req.params;
    const actorType = (req.query.actorType as string) || "user";
    const period = req.query.period as string | undefined;

    if (!["user", "agent"].includes(actorType)) {
      throw badRequest("actorType must be 'user' or 'agent'");
    }

    const drilldown = await svc.getActorPnLDrilldown(companyId, actorId, actorType as "user" | "agent", period);
    res.json(drilldown);
  });

  router.get("/companies/:companyId/rt2/pnl/settlements", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const period = req.query.period as string | undefined;
    res.json(await svc.getSettlementOverview(companyId, period));
  });

  router.get("/companies/:companyId/rt2/pnl/settlements/thresholds", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    res.json(await svc.getSettlementThresholds(companyId));
  });

  router.put("/companies/:companyId/rt2/pnl/settlements/thresholds", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const allowedKeys = [
      "highValueGold",
      "selfReviewCriticalCount",
      "goldFarmingEarnedCount",
      "goldFarmingWarningGold",
      "goldFarmingWarningMultiplier",
      "goldFarmingCriticalGold",
      "goldFarmingCriticalMultiplier",
      "qualityBiasAutoScore",
      "evaluationWindowDays",
    ] as const;
    const input: Record<string, number> = {};
    for (const key of allowedKeys) {
      if (req.body?.[key] === undefined) continue;
      const value = Number(req.body[key]);
      if (!Number.isFinite(value) || value <= 0) throw badRequest(`${key} must be a positive number`);
      input[key] = value;
    }

    res.json(await svc.updateSettlementThresholds(companyId, input));
  });

  router.post("/companies/:companyId/rt2/pnl/settlements/:settlementId/comment", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const comment = String(req.body?.comment ?? "").trim();
    if (!comment) throw badRequest("comment is required");
    const actor = routeActor(req);
    const result = await svc.addSettlementComment(companyId, req.params.settlementId as string, {
      ...actor,
      comment,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "rt2.settlement.comment_added",
      entityType: "settlement",
      entityId: result.id,
      details: { status: result.status, workProductId: result.workProductId },
    });
    res.json(result);
  });

  router.post("/companies/:companyId/rt2/pnl/settlements/:settlementId/approve", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const finalPriceGold = req.body?.finalPriceGold === undefined ? undefined : Number(req.body.finalPriceGold);
    if (finalPriceGold !== undefined && (!Number.isFinite(finalPriceGold) || finalPriceGold <= 0)) {
      throw badRequest("finalPriceGold must be a positive number");
    }
    const actor = routeActor(req);
    const result = await svc.approveSettlement(companyId, req.params.settlementId as string, {
      approverId: actor.actorId,
      finalPriceGold,
      decisionReason: req.body?.decisionReason ? String(req.body.decisionReason) : undefined,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "rt2.settlement.approved",
      entityType: "settlement",
      entityId: result.id,
      details: {
        workProductId: result.workProductId,
        finalPriceGold: result.finalPriceGold,
        ledgerEntryId: result.ledgerEntryId,
        antiGamingSignals: result.antiGamingSignals.map((signal) => signal.key),
      },
    });
    res.json(result);
  });

  router.post("/companies/:companyId/rt2/pnl/settlements/:settlementId/reject", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const decisionReason = String(req.body?.decisionReason ?? "").trim();
    if (!decisionReason) throw badRequest("decisionReason is required");
    const actor = routeActor(req);
    const result = await svc.rejectSettlement(companyId, req.params.settlementId as string, {
      approverId: actor.actorId,
      decisionReason,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "rt2.settlement.rejected",
      entityType: "settlement",
      entityId: result.id,
      details: {
        workProductId: result.workProductId,
        decisionReason,
        antiGamingSignals: result.antiGamingSignals.map((signal) => signal.key),
      },
    });
    res.json(result);
  });

  // M2.7: Get actor P&L history
  router.get("/companies/:companyId/rt2/pnl/actor/:actorId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { actorId } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 12;
    const history = await svc.getActorPnLHistory(companyId, actorId, limit);
    res.json(history);
  });

  // M2.7: Get actor coin balance
  router.get("/companies/:companyId/rt2/coins/balance/:actorId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { actorId } = req.params;
    const actorType = (req.query.actorType as string) || "agent";

    if (!["user", "agent"].includes(actorType)) {
      throw badRequest("actorType must be 'user' or 'agent'");
    }

    const balance = await svc.getActorBalance(companyId, actorId, actorType);
    res.json({ actorId, actorType, balance });
  });

  // M2.7: Get actor coin history
  router.get("/companies/:companyId/rt2/coins/history/:actorId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { actorId } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const history = await svc.getActorCoinHistory(companyId, actorId, limit);
    res.json(history);
  });

  // M2.7: Record income
  router.post("/companies/:companyId/rt2/pnl/income", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { actorId, actorType, amount, description, referenceId, referenceType } = req.body;

    if (!actorId || !actorType || !amount) {
      throw badRequest("actorId, actorType, and amount are required");
    }

    if (!["user", "agent"].includes(actorType)) {
      throw badRequest("actorType must be 'user' or 'agent'");
    }

    if (amount <= 0) {
      throw badRequest("amount must be positive");
    }

    const pnl = await svc.recordIncome(
      companyId,
      actorId,
      actorType,
      amount,
      description || "",
      referenceId,
      referenceType,
    );

    res.json(pnl);
  });

  // M2.7: Record expense
  router.post("/companies/:companyId/rt2/pnl/expense", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { actorId, actorType, amount, description, referenceId, referenceType } = req.body;

    if (!actorId || !actorType || !amount) {
      throw badRequest("actorId, actorType, and amount are required");
    }

    if (!["user", "agent"].includes(actorType)) {
      throw badRequest("actorType must be 'user' or 'agent'");
    }

    if (amount <= 0) {
      throw badRequest("amount must be positive");
    }

    const pnl = await svc.recordExpense(
      companyId,
      actorId,
      actorType,
      amount,
      description || "",
      referenceId,
      referenceType,
    );

    res.json(pnl);
  });

  // M2.7: Transfer coins
  router.post("/companies/:companyId/rt2/coins/transfer", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { fromActorId, fromActorType, toActorId, toActorType, amount, description } = req.body;

    if (!fromActorId || !fromActorType || !toActorId || !toActorType || !amount) {
      throw badRequest("All actor fields and amount are required");
    }

    if (!["user", "agent"].includes(fromActorType) || !["user", "agent"].includes(toActorType)) {
      throw badRequest("actorType must be 'user' or 'agent'");
    }

    if (amount <= 0) {
      throw badRequest("amount must be positive");
    }

    const result = await svc.transferCoins(
      companyId,
      fromActorId,
      fromActorType,
      toActorId,
      toActorType,
      amount,
      description || "",
    );

    res.json(result);
  });

  // M2.7: Allocate budget
  router.post("/companies/:companyId/rt2/pnl/budget", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { actorId, actorType, amount } = req.body;

    if (!actorId || !actorType || amount === undefined) {
      throw badRequest("actorId, actorType, and amount are required");
    }

    if (!["user", "agent"].includes(actorType)) {
      throw badRequest("actorType must be 'user' or 'agent'");
    }

    if (amount < 0) {
      throw badRequest("amount must be non-negative");
    }

    const pnl = await svc.allocateBudget(companyId, actorId, actorType, amount);
    res.json(pnl);
  });

  return router;
}
