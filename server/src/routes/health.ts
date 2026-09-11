import { randomUUID, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, instanceUserRoles, invites } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import {
  readPersistedDevServerStatus,
  removeDevServerRestartRequest,
  toDevServerHealthStatus,
  writeDevServerRestartRequest,
} from "../dev-server-status.js";
import { logger } from "../middleware/logger.js";
import { getServerInfoSnapshot, type ServerInfoSnapshot } from "../server-info.js";
import {
  getCloudStackContext,
  isCloudManagedInstance,
  type CloudInstanceEnv,
} from "../services/cloud-instance.js";
import { getCloudRuntimeIdentity } from "../services/cloud-runtime-identity.js";
import { getHiddenSettings } from "../services/settings-visibility.js";
import {
  inspectDatabaseBackupHealth,
  type DatabaseBackupHealthStatus,
  type DatabaseBackupHealthWarning,
  type InspectDatabaseBackupHealthOptions,
} from "../services/database-backup-health.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { isManagedWorkspaceInstance, resolveWorkspaceReadiness } from "../services/workspace-readiness.js";
import {
  resolveWorkspaceReadinessLocalToken,
  WORKSPACE_READINESS_TOKEN_HEADER,
  WORKSPACE_READINESS_USER_EMAIL_HEADER,
  WORKSPACE_READINESS_USER_ID_HEADER,
} from "../auth/workspace-login-handoff.js";
import { serverVersion } from "../version.js";
import { getStartupRecoveryState } from "../startup-recovery-state.js";
import { nativeRestartRecoverySummary } from "../services/native-runtime/native-restart-recovery.js";
import {
  removeHotRestartIntent,
  writeHotRestartIntent,
} from "../services/hot-restart.js";

function shouldExposeFullHealthDetails(
  actorType: "none" | "board" | "agent" | null | undefined,
  deploymentMode: DeploymentMode,
) {
  if (deploymentMode !== "authenticated") return true;
  return actorType === "board" || actorType === "agent";
}

function matchesSharedToken(expectedToken: string | undefined | null, providedToken: string | undefined) {
  const expectedValue = expectedToken?.trim();
  const token = providedToken?.trim();
  if (!expectedValue || !token) return false;

  const expected = Buffer.from(expectedValue);
  const provided = Buffer.from(token);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

function hasDevServerStatusToken(providedToken: string | undefined) {
  return matchesSharedToken(process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN, providedToken);
}

/**
 * Whether the caller may read this instance's workspace readiness.
 *
 * A managed workspace runs in `authenticated` mode, so its own control plane has
 * no board session against it. The runtime injects a derived probe token into the
 * guest and presents it here — the same shared-secret shape the dev-server
 * supervisor already uses, and never a browser-supplied identity header.
 */
function hasWorkspaceReadinessToken(providedToken: string | undefined) {
  return matchesSharedToken(resolveWorkspaceReadinessLocalToken(), providedToken);
}

function redactedDatabaseBackupWarning(warning: DatabaseBackupHealthWarning): DatabaseBackupHealthWarning {
  const messages: Record<DatabaseBackupHealthWarning["code"], string> = {
    database_backup_check_failed: "Database backup health check failed.",
    database_backup_last_failure: "Database backup failure marker is present.",
    database_backup_missing: "No recent database backup was found.",
    database_backup_stale: "Latest database backup is stale.",
  };
  return {
    code: warning.code,
    message: messages[warning.code],
  };
}

function redactedDatabaseBackupHealth(databaseBackup: DatabaseBackupHealthStatus) {
  return {
    enabled: databaseBackup.enabled,
    status: databaseBackup.status,
    warnings: databaseBackup.warnings.map(redactedDatabaseBackupWarning),
  };
}

function getCloudHealthStatus(env: CloudInstanceEnv) {
  const context = getCloudStackContext(env);
  if (!context) return undefined;
  const runtimeIdentity = env === process.env ? getCloudRuntimeIdentity() : null;

  return {
    managed: true as const,
    managedBy: "paperclip-cloud" as const,
    stackSlug: context.stackSlug,
    cloudBaseUrl: context.cloudOrigin,
    ...(runtimeIdentity ? {
      runtimeIdentity: {
        canonicalOrigin: runtimeIdentity.canonicalOrigin,
        stackSlug: runtimeIdentity.stackSlug,
      },
    } : {}),
  };
}

export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    serverInfo?: ServerInfoSnapshot;
    databaseBackupHealth?: InspectDatabaseBackupHealthOptions;
    runtimeEnv?: CloudInstanceEnv;
  } = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  },
) {
  const router = Router();

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

    if (!db) {
      res.status(503).json({ error: "database_unavailable" });
      return;
    }

    const requestId = randomUUID();
    const requestedAt = new Date();
    const serverInfo = opts.serverInfo ?? getServerInfoSnapshot();
    const preflightActiveRunIds = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"))
      .then((rows) => rows.map((row) => row.id));
    let intent: Awaited<ReturnType<typeof writeHotRestartIntent>> | null = null;
    try {
      intent = await writeHotRestartIntent({
        previousServerPid: process.pid,
        previousServerIdentity: serverInfo.processStartedAt,
        previousServerVersion: serverVersion,
        preflightActiveRunIds,
        recoveryRequestId: requestId,
        requestedAt,
      });
      const written = writeDevServerRestartRequest({
        requestedAt: requestedAt.toISOString(),
        reason: "manual_restart_now",
        requestId,
        mode: "hot",
        previousServerIdentity: serverInfo.processStartedAt,
      });
      if (!written) {
        throw new Error("dev_server_supervisor_unavailable");
      }
    } catch (error) {
      try {
        removeDevServerRestartRequest({ requestId });
      } catch (rollbackError) {
        logger.error(
          { err: rollbackError, requestId },
          "failed to roll back dev-server restart request",
        );
      }
      if (intent) {
        await removeHotRestartIntent(undefined, intent).catch(
          (rollbackError) => {
            logger.error(
              { err: rollbackError, requestId },
              "failed to roll back hot-restart intent",
            );
          },
        );
      }
      if (
        error instanceof Error &&
        error.message === "dev_server_supervisor_unavailable"
      ) {
        res.status(404).json({ error: "dev_server_supervisor_unavailable" });
        return;
      }
      logger.error({ err: error, requestId }, "failed to coordinate hot restart request");
      res.status(500).json({ error: "hot_restart_intent_failed" });
      return;
    }

    res.status(202).json({
      status: "restart_requested",
      requestId,
      mode: "hot",
    });
  });

  router.get("/", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    const exposeFullDetails = shouldExposeFullHealthDetails(
      actorType,
      opts.deploymentMode,
    );
    const runtimeEnv = opts.runtimeEnv ?? process.env;
    const startupRecovery = getStartupRecoveryState();
    const healthStatus =
      startupRecovery.phase === "ready" ? "ok" : "starting";
    const cloud = getCloudHealthStatus(runtimeEnv);
    // Operator-hidden settings ride every response (like `cloud`): the list
    // holds UI surface names only, and the settings nav needs it before any
    // fuller-detail fetch. Omitted entirely when nothing is hidden, so
    // deployments without the env var keep today's byte-identical responses.
    const hiddenSettings = [...getHiddenSettings(runtimeEnv)];
    // serverInfo (git SHA + process start) rides on the full-details responses
    // only, so it reaches board/agent actors in authenticated mode or any caller
    // in local_trusted dev — never anonymous authenticated callers. The
    // enableServerInfoDebugView experimental flag gates the UI surface, not this
    // already access-controlled field.
    const serverInfo = opts.serverInfo ?? getServerInfoSnapshot();
    // The build commit is a plain git SHA of a public repository — not a
    // secret — so it is surfaced on every response, including the redacted
    // one, unlike the fuller `serverInfo` block. Deploy tooling (and anyone)
    // can read which commit this server is running without authenticating.
    const commit = serverInfo.git.available ? serverInfo.git.fullSha : null;
    const exposeDevServerDetails =
      exposeFullDetails || hasDevServerStatusToken(req.get("x-paperclip-dev-server-status-token"));
    // Workspace readiness names the instance and execution workspace that
    // answered, so it rides the protected responses only. Public health stays
    // redacted: an anonymous caller still learns liveness and nothing else.
    const exposeWorkspaceReadiness =
      isManagedWorkspaceInstance()
      && (exposeFullDetails || hasWorkspaceReadinessToken(req.get(WORKSPACE_READINESS_TOKEN_HEADER)));
    const requestedHandoffUserId = req.get(WORKSPACE_READINESS_USER_ID_HEADER)?.trim();
    const requestedHandoffUserEmail = req.get(WORKSPACE_READINESS_USER_EMAIL_HEADER)?.trim();
    const handoffSubject = requestedHandoffUserId && requestedHandoffUserEmail
      ? { userId: requestedHandoffUserId, email: requestedHandoffUserEmail }
      : null;

    if (!db) {
      res.json(
        exposeFullDetails
          ? {
              status: healthStatus,
              version: serverVersion,
              serverVersion: serverVersion,
              commit,
              serverInfo,
              ...(cloud ? { cloud } : {}),
              ...(hiddenSettings.length ? { hiddenSettings } : {}),
            }
          : {
              status: healthStatus,
              deploymentMode: opts.deploymentMode,
              commit,
              ...(cloud ? { cloud } : {}),
              ...(hiddenSettings.length ? { hiddenSettings } : {}),
            },
      );
      return;
    }

    try {
      await db.execute(sql`SELECT 1`);
    } catch (error) {
      logger.warn({ err: error }, "Health check database probe failed");
      // Carry readiness on the unhealthy response too: the seed phase recorded on
      // disk is exactly what tells an operator whether this is a half-finished
      // restore or a database that died after being verified.
      const workspace = exposeWorkspaceReadiness
        ? await resolveWorkspaceReadiness({ db, handoffSubject }).catch(() => null)
        : null;
      res.status(503).json({
        status: "unhealthy",
        version: serverVersion,
        serverVersion,
        commit,
        error: "database_unreachable",
        ...(exposeFullDetails ? { serverInfo } : {}),
        ...(workspace ? { workspace } : {}),
        ...(cloud ? { cloud } : {}),
      });
      return;
    }

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    let bootstrapInviteActive = false;
    // Cloud-managed instances have no first-admin concept: the control
    // plane owns identity and its trusted-header users are deliberately
    // never instance_admin, so the role-count gate below would report
    // bootstrap_pending forever and lock every managed tenant out at the
    // claim screen. Self-hosted deployments (neither canonical managed signal)
    // are unaffected.
    if (opts.deploymentMode === "authenticated" && !isCloudManagedInstance(runtimeEnv)) {
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
      const activeRunCount = await db
        .select({ count: count() })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]))
        .then((rows) => Number(rows[0]?.count ?? 0));

      devServer = toDevServerHealthStatus(persistedDevServerStatus, {
        autoRestartEnabled: experimentalSettings.autoRestartDevServerWhenIdle ?? false,
        activeRunCount,
      });
    }

    const workspaceReadiness = exposeWorkspaceReadiness
      ? await resolveWorkspaceReadiness({ db, handoffSubject }).catch((error) => {
          logger.warn({ err: error }, "workspace readiness probe failed");
          return null;
        })
      : null;

    const databaseBackup = opts.databaseBackupHealth
      ? inspectDatabaseBackupHealth(opts.databaseBackupHealth)
      : undefined;
    const warnings = databaseBackup?.warnings.length ? databaseBackup.warnings : undefined;
    const nativeRecovery = exposeFullDetails
      ? await nativeRestartRecoverySummary(db).catch((error) => {
          logger.warn({ err: error }, "native recovery health summary failed");
          return {};
        })
      : undefined;

    if (!exposeFullDetails) {
      const redactedDatabaseBackup = databaseBackup ? redactedDatabaseBackupHealth(databaseBackup) : undefined;
      const redactedWarnings = redactedDatabaseBackup?.warnings.length ? redactedDatabaseBackup.warnings : undefined;
      res.json({
        status: healthStatus,
        deploymentMode: opts.deploymentMode,
        deploymentExposure: opts.deploymentExposure,
        commit,
        bootstrapStatus,
        bootstrapInviteActive,
        ...(redactedDatabaseBackup ? { databaseBackup: redactedDatabaseBackup } : {}),
        ...(redactedWarnings ? { warnings: redactedWarnings } : {}),
        ...(devServer ? { devServer } : {}),
        // Token-authorized probe on an otherwise redacted response: the control
        // plane needs readiness without a board session, and nothing else about
        // this instance becomes visible.
        ...(workspaceReadiness ? { workspace: workspaceReadiness } : {}),
        ...(cloud ? { cloud } : {}),
        ...(hiddenSettings.length ? { hiddenSettings } : {}),
      });
      return;
    }

    res.json({
      status: healthStatus,
      version: serverVersion,
      serverVersion,
      commit,
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      bootstrapInviteActive,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
      serverInfo,
      startupRecovery,
      nativeRecovery,
      ...(databaseBackup ? { databaseBackup } : {}),
      ...(warnings ? { warnings } : {}),
      ...(devServer ? { devServer } : {}),
      ...(workspaceReadiness ? { workspace: workspaceReadiness } : {}),
      ...(cloud ? { cloud } : {}),
      ...(hiddenSettings.length ? { hiddenSettings } : {}),
    });
  });

  return router;
}
