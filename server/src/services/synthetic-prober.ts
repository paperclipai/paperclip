import { and, eq, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { appProbeSpecs, appDeployments } from "@paperclipai/db";
import { getDokployClient, type DokployApp } from "./dokploy-client.js";
import { logger } from "../middleware/logger.js";

const PROBE_INTERVAL_MS = 60_000;
const STABILITY_WINDOW_MS = 30 * 60 * 1_000;
const ROLLBACK_COOLDOWN_MS = 30 * 60 * 1_000;

interface ProbeResult {
  appName: string;
  success: boolean;
  statusCode?: number;
  responseBody?: string;
  error?: string;
  consecutiveFailures: number;
}

interface ConsecutiveFailureTracker {
  count: number;
  lastFailure: number;
}

export class SyntheticProber {
  private db: Db;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private failureTracker: Map<string, ConsecutiveFailureTracker> = new Map();
  private cooldownTracker: Map<string, number> = new Map();
  private isRunning = false;

  constructor(db: Db) {
    this.db = db;
  }

  start(): void {
    if (this.intervalTimer !== null) {
      logger.warn("SyntheticProber already started");
      return;
    }

    logger.info({ intervalMs: PROBE_INTERVAL_MS }, "Starting SyntheticProber");
    this.intervalTimer = setInterval(() => {
      this.runProbeCycle().catch((err) => {
        logger.error({ err }, "SyntheticProber probe cycle failed");
      });
    }, PROBE_INTERVAL_MS);

    this.runProbeCycle().catch((err) => {
      logger.error({ err }, "SyntheticProber initial probe cycle failed");
    });
  }

  stop(): void {
    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
      logger.info("SyntheticProber stopped");
    }
  }

  async runProbeCycle(): Promise<void> {
    if (this.isRunning) {
      logger.debug("SyntheticProber cycle already running, skipping");
      return;
    }

    this.isRunning = true;
    const cycleStart = Date.now();

    try {
      const specs = await this.db
        .select()
        .from(appProbeSpecs)
        .where(eq(appProbeSpecs.isActive, true));

      logger.debug({ count: specs.length }, "SyntheticProber probing apps");

      for (const spec of specs) {
        await this.probeApp(spec.appName, spec.probeUrl, spec.expectedStatus);
      }

      await this.markStableDeployments();
    } finally {
      this.isRunning = false;
      const cycleDuration = Date.now() - cycleStart;
      logger.debug({ durationMs: cycleDuration }, "SyntheticProber cycle complete");
    }
  }

  private async probeApp(
    appName: string,
    probeUrl: string,
    expectedStatus: number,
  ): Promise<ProbeResult> {
    const tracker = this.failureTracker.get(appName) ?? { count: 0, lastFailure: 0 };
    const cooldownUntil = this.cooldownTracker.get(appName) ?? 0;
    const now = Date.now();

    if (now < cooldownUntil) {
      logger.debug({ appName, cooldownRemainingMs: cooldownUntil - now }, "App in rollback cooldown, skipping probe");
      return { appName, success: true, consecutiveFailures: tracker.count };
    }

    let result: ProbeResult;
    try {
      const response = await fetch(probeUrl, {
        method: "GET",
        headers: { "User-Agent": "KitVentures-SyntheticProber/1.0" },
        signal: AbortSignal.timeout(10_000),
      });

      const body = await response.text().catch(() => "");
      const success = response.status === expectedStatus;

      result = {
        appName,
        success,
        statusCode: response.status,
        responseBody: body.substring(0, 1000),
        consecutiveFailures: success ? 0 : tracker.count + 1,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      result = {
        appName,
        success: false,
        error,
        consecutiveFailures: tracker.count + 1,
      };
    }

    if (result.success) {
      tracker.count = 0;
      this.failureTracker.set(appName, tracker);
    } else {
      tracker.count = result.consecutiveFailures;
      tracker.lastFailure = now;
      this.failureTracker.set(appName, tracker);

      logger.warn(
        { appName, consecutiveFailures: tracker.count, statusCode: result.statusCode, error: result.error },
        "App probe failed",
      );

      if (tracker.count >= 2) {
        await this.handleConsecutiveFailures(appName);
      }
    }

    await this.updateProbeResult(appName, result);

    return result;
  }

  private async handleConsecutiveFailures(appName: string): Promise<void> {
    const latestDeployment = await this.getLatestDeployment(appName);

    if (!latestDeployment) {
      logger.warn({ appName }, "No deployment found for rollback");
      return;
    }

    if (latestDeployment.includesMigration) {
      logger.warn(
        { appName, deploymentId: latestDeployment.dokployDeployId },
        "Latest deployment includes migration, creating BOARD issue instead of auto-rollback",
      );
      await this.createNoRollbackBoardIssue(appName, latestDeployment);
      this.cooldownTracker.set(appName, Date.now() + ROLLBACK_COOLDOWN_MS);
      return;
    }

    const rollbackTarget = await this.findVerifiedStableDeployment(appName);
    if (!rollbackTarget) {
      logger.warn({ appName }, "No verified-stable deployment found for rollback");
      return;
    }

    const rollbackCooldown = latestDeployment.lastRollbackAt
      ? new Date(latestDeployment.lastRollbackAt).getTime() + ROLLBACK_COOLDOWN_MS
      : 0;

    if (Date.now() < rollbackCooldown) {
      logger.debug({ appName, cooldownEndsAt: new Date(rollbackCooldown) }, "Rollback cooldown active");
      return;
    }

    await this.executeRollback(appName, rollbackTarget, latestDeployment);
  }

  private async getLatestDeployment(appName: string) {
    const results = await this.db
      .select()
      .from(appDeployments)
      .where(eq(appDeployments.appName, appName))
      .orderBy(appDeployments.deployedAt)
      .limit(1);

    return results[0] ?? null;
  }

  private async findVerifiedStableDeployment(appName: string) {
    const cutoff = new Date(Date.now() - STABILITY_WINDOW_MS);

    const results = await this.db
      .select()
      .from(appDeployments)
      .where(
        and(
          eq(appDeployments.appName, appName),
          eq(appDeployments.verifiedStable, true),
          lte(appDeployments.deployedAt, cutoff),
        ),
      )
      .orderBy(appDeployments.deployedAt)
      .limit(1);

    return results[0] ?? null;
  }

  private async executeRollback(
    appName: string,
    targetDeployment: typeof appDeployments.$inferSelect,
    currentDeployment: typeof appDeployments.$inferSelect,
  ): Promise<void> {
    logger.info(
      { appName, targetDeploymentId: targetDeployment.id, currentDeploymentId: currentDeployment.id },
      "Executing auto-rollback",
    );

    try {
      const client = getDokployClient();
      await client.rollback({
        appId: appName,
        deploymentId: targetDeployment.dokployDeployId!,
        reason: `Auto-rollback: 2 consecutive probe failures on ${appName}`,
      });

      await this.db
        .update(appDeployments)
        .set({ lastRollbackAt: new Date() })
        .where(eq(appDeployments.id, currentDeployment.id));

      this.cooldownTracker.set(appName, Date.now() + ROLLBACK_COOLDOWN_MS);
      this.failureTracker.set(appName, { count: 0, lastFailure: 0 });

      logger.info({ appName }, "Auto-rollback completed successfully");
    } catch (err) {
      logger.error({ err, appName }, "Auto-rollback failed");
    }
  }

  private async createNoRollbackBoardIssue(
    appName: string,
    deployment: typeof appDeployments.$inferSelect,
  ): Promise<void> {
    logger.info(
      { appName, deploymentId: deployment.dokployDeployId },
      "Would create [BOARD] APP-DOWN-NO-AUTOROLLBACK issue for migration deployment",
    );
  }

  private async updateProbeResult(appName: string, result: ProbeResult): Promise<void> {
    try {
      await this.db
        .update(appProbeSpecs)
        .set({
          lastProbedAt: new Date(),
          lastProbeResult: result.success ? "ok" : `fail:${result.statusCode ?? "err"}:${result.error ?? ""}`,
        })
        .where(eq(appProbeSpecs.appName, appName));
    } catch (err) {
      logger.debug({ err, appName }, "Failed to update probe result");
    }
  }

  private async markStableDeployments(): Promise<void> {
    const cutoff = new Date(Date.now() - STABILITY_WINDOW_MS);

    await this.db
      .update(appDeployments)
      .set({
        verifiedStable: true,
        verifiedStableAt: new Date(),
      })
      .where(
        and(
          eq(appDeployments.verifiedStable, false),
          lte(appDeployments.deployedAt, cutoff),
        ),
      );
  }

  getStats(): { trackedApps: number; inCooldown: number } {
    return {
      trackedApps: this.failureTracker.size,
      inCooldown: this.cooldownTracker.size,
    };
  }
}

let proberInstance: SyntheticProber | null = null;

export function getSyntheticProber(db: Db): SyntheticProber {
  if (!proberInstance) {
    proberInstance = new SyntheticProber(db);
  }
  return proberInstance;
}

export function startSyntheticProber(db: Db): SyntheticProber {
  const prober = getSyntheticProber(db);
  prober.start();
  return prober;
}

export function stopSyntheticProber(): void {
  if (proberInstance) {
    proberInstance.stop();
    proberInstance = null;
  }
}