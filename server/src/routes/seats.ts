import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { PERMISSION_KEYS, SEAT_PAUSE_REASONS } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { accessService, seatService } from "../services/index.js";
import { logActivity } from "../services/activity-log.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const OPERATOR_SEAT_PAUSE_REASONS = SEAT_PAUSE_REASONS.filter(
  (reason) => reason !== "budget_enforcement",
) as ["manual_admin", "maintenance"];

const attachHumanSchema = z.object({
  userId: z.string().min(1),
});

const detachHumanSchema = z.object({
  userId: z.string().min(1).optional().nullable(),
});

const attachShadowAgentSchema = z.object({
  agentId: z.string().uuid(),
});

const detachShadowAgentSchema = z.object({
  agentId: z.string().uuid().optional().nullable(),
});

const updateSeatSchema = z.object({
  delegatedPermissions: z.array(z.enum(PERMISSION_KEYS)).default([]),
});

const pauseSeatSchema = z.object({
  pauseReason: z.enum(OPERATOR_SEAT_PAUSE_REASONS),
});

const resumeSeatSchema = z.object({
  pauseReason: z.enum(OPERATOR_SEAT_PAUSE_REASONS).optional().nullable(),
});

export function seatRoutes(db: Db) {
  const router = Router();
  const seatsSvc = seatService(db);
  const access = accessService(db);

  router.get("/companies/:companyId/seats", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await seatsSvc.listForCompany(companyId);
    res.json(result);
  });

  router.get("/companies/:companyId/seats/attachable-members", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const members = await access.listActiveUserMemberships(companyId);
    res.json(members);
  });

  router.get("/companies/:companyId/seats/:seatId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const seatId = req.params.seatId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await seatsSvc.getDetail(companyId, seatId);
    if (!result) {
      res.status(404).json({ error: "Seat not found" });
      return;
    }
    res.json(result);
  });

  router.patch("/companies/:companyId/seats/:seatId", validate(updateSeatSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const seatId = req.params.seatId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await seatsSvc.updateDelegatedPermissions(companyId, seatId, req.body.delegatedPermissions);
    if (!result) {
      res.status(404).json({ error: "Seat not found" });
      return;
    }
    const actor = getActorInfo(req);
    const previousDelegatedPermissions = result.previousDelegatedPermissions;
    const nextDelegatedPermissions = result.seat.delegatedPermissions;
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "seat.delegated_permissions_updated",
      entityType: "seat",
      entityId: seatId,
      details: {
        previousDelegatedPermissions,
        delegatedPermissions: nextDelegatedPermissions,
        addedPermissions: nextDelegatedPermissions.filter((permission) => !previousDelegatedPermissions.includes(permission)),
        removedPermissions: previousDelegatedPermissions.filter((permission) => !nextDelegatedPermissions.includes(permission)),
      },
    });
    res.json(result.seat);
  });

  router.post("/companies/:companyId/seats/:seatId/pause", validate(pauseSeatSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const seatId = req.params.seatId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await seatsSvc.pauseSeat(companyId, seatId, req.body.pauseReason);
    if (!result) {
      res.status(404).json({ error: "Seat not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "seat.paused",
      entityType: "seat",
      entityId: seatId,
      details: {
        pauseReason: result.pauseReason,
        pauseReasons: result.pauseReasons,
      },
    });
    res.json(result);
  });

  router.post("/companies/:companyId/seats/:seatId/resume", validate(resumeSeatSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const seatId = req.params.seatId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await seatsSvc.resumeSeat(companyId, seatId, req.body.pauseReason ?? null);
    if (!result) {
      res.status(404).json({ error: "Seat not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "seat.resumed",
      entityType: "seat",
      entityId: seatId,
      details: {
        clearedPauseReason: req.body.pauseReason ?? null,
        pauseReason: result.pauseReason,
        pauseReasons: result.pauseReasons,
        status: result.status,
      },
    });
    res.json(result);
  });

  router.post("/companies/:companyId/seats/backfill", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await seatsSvc.backfillCompany(companyId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "seat.backfill_executed",
      entityType: "company",
      entityId: companyId,
      details: {
        seatsCreated: result.seatsCreated,
        seatsUpdated: result.seatsUpdated,
        primaryOccupanciesCreated: result.primaryOccupanciesCreated,
        agentsLinkedToSeats: result.agentsLinkedToSeats,
        ownershipBackfills: result.ownershipBackfills,
        warningCount: result.warnings.length,
        warningCodes: Array.from(new Set(result.warnings.map((warning) => warning.code))).sort(),
      },
    });
    res.json(result);
  });

  router.post("/companies/:companyId/seats/reconcile-modes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await seatsSvc.reconcileModes(companyId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "seat.modes_reconciled",
      entityType: "company",
      entityId: companyId,
      details: {
        scannedSeatCount: result.scannedSeatCount,
        updatedSeatCount: result.updatedSeatCount,
      },
    });
    res.json(result);
  });

  router.post("/companies/:companyId/seats/:seatId/attach-human", validate(attachHumanSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const seatId = req.params.seatId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await seatsSvc.attachHuman(companyId, seatId, req.body.userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "seat.human_attached",
      entityType: "seat",
      entityId: seatId,
      details: {
        userId: req.body.userId,
        previousOperatingMode: result.previousOperatingMode ?? null,
        operatingMode: result.operatingMode,
      },
    });
    res.json(result);
  });

  router.post("/companies/:companyId/seats/:seatId/detach-human", validate(detachHumanSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const seatId = req.params.seatId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await seatsSvc.detachHuman(companyId, seatId, req.body.userId ?? null);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "seat.human_detached",
      entityType: "seat",
      entityId: seatId,
      details: {
        userId: req.body.userId ?? null,
        previousOperatingMode: result.previousOperatingMode ?? null,
        operatingMode: result.operatingMode,
        fallbackReassignedIssueCount: result.fallbackReassignedIssueCount,
      },
    });
    res.json(result);
  });

  router.post("/companies/:companyId/seats/:seatId/attach-shadow-agent", validate(attachShadowAgentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const seatId = req.params.seatId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await seatsSvc.attachShadowAgent(companyId, seatId, req.body.agentId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "seat.shadow_agent_attached",
      entityType: "seat",
      entityId: seatId,
      details: {
        shadowAgentId: req.body.agentId,
        previousOperatingMode: result.previousOperatingMode ?? null,
        operatingMode: result.operatingMode,
      },
    });
    res.json(result);
  });

  router.post("/companies/:companyId/seats/:seatId/detach-shadow-agent", validate(detachShadowAgentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const seatId = req.params.seatId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const result = await seatsSvc.detachShadowAgent(companyId, seatId, req.body.agentId ?? null);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "seat.shadow_agent_detached",
      entityType: "seat",
      entityId: seatId,
      details: {
        shadowAgentId: req.body.agentId ?? null,
        previousOperatingMode: result.previousOperatingMode ?? null,
        operatingMode: result.operatingMode,
      },
    });
    res.json(result);
  });

  return router;
}
