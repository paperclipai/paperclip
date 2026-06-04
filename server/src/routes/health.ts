import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { instanceUserRoles, invites } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { readPersistedDevServerStatus, toDevServerHealthStatus, writeDevServerRestartRequest } from "../dev-server-status.js";
import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { logActivity } from "../services/activity-log.js";
import {
  beginRestartDrain,
  getRestartDrainStatus,
  listActiveRunCompanyIdsForDrain,
  markRestartDeferred,
  recordEmergencyRestartOverride,
  summarizeActiveRunsForDrain,
  type RestartDrainSource,
  type RestartEmergencyCategory,
} from "../services/restart-drain.js";
import { serverVersion } from "../version.js";

function shouldExposeFullHealthDetails(
  actorType: "none" | "board" | "agent" | null | undefined,
  deploymentMode: DeploymentMode,
) {
  if (deploymentMode !== "authenticated") return true;
  return actorType === "board" || actorType === "agent";
}

function hasDevServerStatusToken(providedToken: string | undefined) {
  const expectedToken = process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN?.trim();
  const token = providedToken?.trim();
  if (!expectedToken || !token) return false;

  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(token);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

const RESTART_EMERGENCY_CATEGORIES = new Set<RestartEmergencyCategory>([
  "operator_override",
  "security_update",
  "service_recovery",
  "other",
]);

function normalizeEmergencyCategory(value: unknown): RestartEmergencyCategory {
  if (typeof value !== "string") return "other";
  const trimmed = value.trim();
  return RESTART_EMERGENCY_CATEGORIES.has(trimmed as RestartEmergencyCategory)
    ? trimmed as RestartEmergencyCategory
    : "other";
}

function parseRestartGuardBody(body: unknown) {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const emergencyReason = typeof record.emergencyReason === "string" ? record.emergencyReason.trim() : "";
  return {
    emergency: record.emergency === true,
    emergencyReasonPresent: record.emergencyReasonProvided === true || emergencyReason.length > 0,
    emergencyReasonCategory: normalizeEmergencyCategory(record.emergencyReasonCategory),
  };
}

export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
  } = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  },
) {
  const router = Router();

  async function logEmergencyRestartOverride(input: {
    activeRunSummary: Awaited<ReturnType<typeof summarizeActiveRunsForDrain>>;
    emergencyReasonPresent: boolean;
    emergencyReasonCategory: RestartEmergencyCategory;
    req: Request;
  }) {
    if (!db || input.activeRunSummary.activeRunCount <= 0) return;
    const actor = "actor" in input.req ? input.req.actor : null;
    const companyIds = await listActiveRunCompanyIdsForDrain(db);
    await Promise.all(companyIds.map((companyId) =>
      logActivity(db, {
        companyId,
        actorType: actor?.type === "agent" ? "agent" : actor?.type === "board" ? "user" : "system",
        actorId: actor?.type === "agent"
          ? (actor.agentId ?? "system")
          : actor?.type === "board"
            ? (actor.userId ?? "system")
            : "system",
        agentId: actor?.type === "agent" ? actor.agentId : null,
        runId: actor?.type === "agent" || actor?.type === "board"
          ? actor.runId ?? null
          : null,
        action: "restart.emergency_override",
        entityType: "instance",
        entityId: "instance",
        details: {
          activeRunCount: input.activeRunSummary.activeRunCount,
          oldestRunStartedAt: input.activeRunSummary.oldestRunStartedAt,
          oldestRunAgeMs: input.activeRunSummary.oldestRunAgeMs,
          emergencyReasonPresent: input.emergencyReasonPresent,
          emergencyReasonCategory: input.emergencyReasonCategory,
        },
      }),
    ));
  }

  async function evaluateRestartGuard(input: {
    req: Request;
    res: Response;
    source: RestartDrainSource;
    reason: "planned_restart" | "manual_restart_now";
    requireDb?: boolean;
  }) {
    const body = parseRestartGuardBody(input.req.body);
    if (body.emergency && !body.emergencyReasonPresent) {
      input.res.status(400).json({ error: "emergency_reason_required" });
      return null;
    }

    const hasDb = Boolean(db && typeof (db as { select?: unknown }).select === "function");
    if (!hasDb && input.requireDb !== false) {
      input.res.status(503).json({ error: "restart_guard_unavailable" });
      return null;
    }

    const activeRunSummary = hasDb
      ? await summarizeActiveRunsForDrain(db as Db)
      : {
        activeRunCount: 0,
        oldestRunStartedAt: null,
        oldestRunAgeMs: null,
        nextCheckAt: null,
      };
    beginRestartDrain({ source: input.source, reason: input.reason });

    if (activeRunSummary.activeRunCount > 0 && !body.emergency) {
      markRestartDeferred();
      input.res.status(202).json({
        status: "restart_deferred",
        activeRunCount: activeRunSummary.activeRunCount,
        oldestRunStartedAt: activeRunSummary.oldestRunStartedAt,
        oldestRunAgeMs: activeRunSummary.oldestRunAgeMs,
        nextCheckAt: activeRunSummary.nextCheckAt,
      });
      return null;
    }

    if (body.emergency) {
      recordEmergencyRestartOverride({
        reasonPresent: body.emergencyReasonPresent,
        reasonCategory: body.emergencyReasonCategory,
      });
      await logEmergencyRestartOverride({
        activeRunSummary,
        emergencyReasonPresent: body.emergencyReasonPresent,
        emergencyReasonCategory: body.emergencyReasonCategory,
        req: input.req,
      });
    }

    return {
      emergency: body.emergency,
      activeRunSummary,
    };
  }

  router.post("/service-restart/check", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    if (opts.deploymentMode === "authenticated" && actorType === "none") {
      res.status(403).json({ error: "authenticated_actor_required" });
      return;
    }

    const guard = await evaluateRestartGuard({
      req,
      res,
      source: "operator",
      reason: "planned_restart",
    });
    if (!guard) return;

    res.status(200).json({
      status: guard.emergency ? "restart_allowed_emergency" : "restart_allowed",
      activeRunCount: guard.activeRunSummary.activeRunCount,
      oldestRunStartedAt: guard.activeRunSummary.oldestRunStartedAt,
      oldestRunAgeMs: guard.activeRunSummary.oldestRunAgeMs,
    });
  });

  router.post("/dev-server/restart", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    if (opts.deploymentMode === "authenticated" && actorType !== "board") {
      res.status(403).json({ error: "board_access_required" });
      return;
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    if (!persistedDevServerStatus) {
      res.status(404).json({ error: "dev_server_supervisor_unavailable" });
      return;
    }

    const restartRequired =
      persistedDevServerStatus.dirty ||
      persistedDevServerStatus.changedPathCount > 0 ||
      persistedDevServerStatus.pendingMigrations.length > 0;
    if (!restartRequired) {
      res.status(409).json({ error: "restart_not_required" });
      return;
    }

    const guard = await evaluateRestartGuard({
      req,
      res,
      source: "dev_server",
      reason: "manual_restart_now",
      requireDb: false,
    });
    if (!guard) return;

    const written = writeDevServerRestartRequest({
      requestedAt: new Date().toISOString(),
      reason: "manual_restart_now",
    });
    if (!written) {
      res.status(404).json({ error: "dev_server_supervisor_unavailable" });
      return;
    }

    res.status(202).json({
      status: guard.emergency ? "restart_requested_emergency" : "restart_requested",
      activeRunCount: guard.activeRunSummary.activeRunCount,
      oldestRunStartedAt: guard.activeRunSummary.oldestRunStartedAt,
      oldestRunAgeMs: guard.activeRunSummary.oldestRunAgeMs,
    });
  });

  router.get("/", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    const exposeFullDetails = shouldExposeFullHealthDetails(
      actorType,
      opts.deploymentMode,
    );
    const exposeDevServerDetails =
      exposeFullDetails || hasDevServerStatusToken(req.get("x-paperclip-dev-server-status-token"));

    if (!db) {
      res.json(
        exposeFullDetails
          ? { status: "ok", version: serverVersion }
          : { status: "ok", deploymentMode: opts.deploymentMode },
      );
      return;
    }

    try {
      await db.execute(sql`SELECT 1`);
    } catch (error) {
      logger.warn({ err: error }, "Health check database probe failed");
      res.status(503).json({
        status: "unhealthy",
        version: serverVersion,
        error: "database_unreachable"
      });
      return;
    }

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    let bootstrapInviteActive = false;
    if (opts.deploymentMode === "authenticated") {
      const roleCount = await db
        .select({ count: count() })
        .from(instanceUserRoles)
        .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";

      if (bootstrapStatus === "bootstrap_pending") {
        const now = new Date();
        const inviteCount = await db
          .select({ count: count() })
          .from(invites)
          .where(
            and(
              eq(invites.inviteType, "bootstrap_ceo"),
              isNull(invites.revokedAt),
              isNull(invites.acceptedAt),
              gt(invites.expiresAt, now),
            ),
          )
          .then((rows) => Number(rows[0]?.count ?? 0));
        bootstrapInviteActive = inviteCount > 0;
      }
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    let devServer: ReturnType<typeof toDevServerHealthStatus> | undefined;
    if (exposeDevServerDetails && persistedDevServerStatus && typeof (db as { select?: unknown }).select === "function") {
      const instanceSettings = instanceSettingsService(db);
      const experimentalSettings = await instanceSettings.getExperimental();
      const activeRunSummary = await summarizeActiveRunsForDrain(db);

      devServer = toDevServerHealthStatus(persistedDevServerStatus, {
        autoRestartEnabled: experimentalSettings.autoRestartDevServerWhenIdle ?? false,
        activeRunCount: activeRunSummary.activeRunCount,
        oldestActiveRunStartedAt: activeRunSummary.oldestRunStartedAt,
        oldestActiveRunAgeMs: activeRunSummary.oldestRunAgeMs,
        nextRestartCheckAt: activeRunSummary.nextCheckAt,
        drain: getRestartDrainStatus(),
      });
    }

    if (!exposeFullDetails) {
      res.json({
        status: "ok",
        deploymentMode: opts.deploymentMode,
        deploymentExposure: opts.deploymentExposure,
        bootstrapStatus,
        bootstrapInviteActive,
        ...(devServer ? { devServer } : {}),
      });
      return;
    }

    res.json({
      status: "ok",
      version: serverVersion,
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      bootstrapInviteActive,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
      ...(devServer ? { devServer } : {}),
    });
  });

  return router;
}
