import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns } from "@paperclipai/db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

/**
 * Run lifecycle alert service
 *
 * Monitors run lifecycle events and triggers alerts for:
 * - Failed cleanup attempts
 * - Process termination failures or hangs
 * - Zombie run detection (runs that should have terminated but are still active)
 */

export interface RunLifecycleAlert {
  alertType: "cleanup_failed" | "termination_failed" | "termination_hung" | "zombie_detected";
  severity: "warning" | "error" | "critical";
  companyId: string;
  runId: string;
  agentId: string;
  message: string;
  details: Record<string, unknown>;
  timestamp: Date;
}

export interface AlertThresholds {
  /**
   * Max time in ms for process termination before considering it hung
   * Default: 30 seconds
   */
  terminationHangThresholdMs: number;

  /**
   * Age in hours before a stuck run is considered a zombie
   * Default: 1 hour
   */
  zombieRunAgeHours: number;

  /**
   * How often to check for zombie runs (in minutes)
   * Default: 15 minutes
   */
  zombieCheckIntervalMinutes: number;
}

const DEFAULT_THRESHOLDS: AlertThresholds = {
  terminationHangThresholdMs: 30_000, // 30 seconds
  zombieRunAgeHours: 1,
  zombieCheckIntervalMinutes: 15,
};

export class RunLifecycleAlertService {
  constructor(
    private db: Db,
    private thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
    private onAlert?: (alert: RunLifecycleAlert) => void | Promise<void>,
  ) {}

  /**
   * Check activity log for failed cleanup or termination events in the last N minutes
   */
  async checkRecentFailures(lookbackMinutes = 5, companyId?: string): Promise<RunLifecycleAlert[]> {
    const since = new Date(Date.now() - lookbackMinutes * 60 * 1000);
    const alerts: RunLifecycleAlert[] = [];

    const conditions = [
      inArray(activityLog.action, [
        "run.cleanup.failed",
        "run.process.termination_failed",
      ]),
      gte(activityLog.createdAt, since),
    ];

    if (companyId) {
      conditions.push(eq(activityLog.companyId, companyId));
    }

    const failureEvents = await this.db
      .select()
      .from(activityLog)
      .where(and(...conditions))
      .orderBy(desc(activityLog.createdAt))
      .limit(100);

    for (const event of failureEvents) {
      const alertType =
        event.action === "run.cleanup.failed" ? "cleanup_failed" : "termination_failed";

      alerts.push({
        alertType,
        severity: "error",
        companyId: event.companyId,
        runId: event.entityId,
        agentId: event.agentId ?? "unknown",
        message: `Run ${alertType.replace("_", " ")}: ${event.entityId}`,
        details: (event.details as Record<string, unknown>) ?? {},
        timestamp: new Date(event.createdAt),
      });
    }

    return alerts;
  }

  /**
   * Check for termination hangs by looking for termination_triggered events
   * that don't have a corresponding terminated/termination_failed event
   */
  async checkTerminationHangs(companyId?: string): Promise<RunLifecycleAlert[]> {
    const hangThreshold = new Date(Date.now() - this.thresholds.terminationHangThresholdMs);
    const lowerBound = new Date(Date.now() - 24 * 60 * 60 * 1000); // Last 24 hours
    const alerts: RunLifecycleAlert[] = [];

    const conditions = [
      eq(activityLog.action, "run.process.termination_triggered"),
      sql`${activityLog.createdAt} < ${hangThreshold}`,
      sql`${activityLog.createdAt} >= ${lowerBound}`,
    ];

    if (companyId) {
      conditions.push(eq(activityLog.companyId, companyId));
    }

    // Find termination_triggered events older than threshold within last 24h
    const triggeredEvents = await this.db
      .select()
      .from(activityLog)
      .where(and(...conditions))
      .orderBy(desc(activityLog.createdAt))
      .limit(100);

    for (const triggered of triggeredEvents) {
      // Check if there's a corresponding terminated or termination_failed event
      const completed = await this.db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, triggered.entityId),
            inArray(activityLog.action, ["run.process.terminated", "run.process.termination_failed"]),
            gte(activityLog.createdAt, new Date(triggered.createdAt)),
          ),
        )
        .limit(1);

      if (completed.length === 0) {
        alerts.push({
          alertType: "termination_hung",
          severity: "warning",
          companyId: triggered.companyId,
          runId: triggered.entityId,
          agentId: triggered.agentId ?? "unknown",
          message: `Process termination hung for run ${triggered.entityId}`,
          details: {
            triggeredAt: triggered.createdAt,
            hangDurationMs: Date.now() - new Date(triggered.createdAt).getTime(),
            ...(triggered.details as Record<string, unknown> ?? {}),
          },
          timestamp: new Date(),
        });
      }
    }

    return alerts;
  }

  /**
   * Detect zombie runs: runs marked as "running" or "queued" that haven't had
   * output or activity in more than the zombie threshold
   */
  async detectZombieRuns(companyId?: string): Promise<RunLifecycleAlert[]> {
    const zombieThreshold = new Date(
      Date.now() - this.thresholds.zombieRunAgeHours * 60 * 60 * 1000,
    );
    const alerts: RunLifecycleAlert[] = [];

    const conditions = [
      inArray(heartbeatRuns.status, ["running", "queued"]),
      sql`${heartbeatRuns.lastOutputAt} < ${zombieThreshold}`,
    ];

    if (companyId) {
      conditions.push(eq(heartbeatRuns.companyId, companyId));
    }

    const suspectedZombies = await this.db
      .select()
      .from(heartbeatRuns)
      .where(and(...conditions))
      .orderBy(desc(heartbeatRuns.lastOutputAt))
      .limit(100);

    for (const run of suspectedZombies) {
      const ageMs = Date.now() - (run.lastOutputAt?.getTime() ?? run.createdAt.getTime());
      const ageHours = ageMs / (60 * 60 * 1000);

      alerts.push({
        alertType: "zombie_detected",
        severity: ageHours > 4 ? "critical" : "warning",
        companyId: run.companyId,
        runId: run.id,
        agentId: run.agentId,
        message: `Zombie run detected: ${run.id} (${ageHours.toFixed(1)}h since last output)`,
        details: {
          status: run.status,
          processPid: run.processPid,
          processGroupId: run.processGroupId,
          lastOutputAt: run.lastOutputAt,
          ageHours,
          livenessState: run.livenessState,
          livenessReason: run.livenessReason,
        },
        timestamp: new Date(),
      });
    }

    return alerts;
  }

  /**
   * Run all checks and emit alerts
   */
  async checkAll(companyId?: string): Promise<RunLifecycleAlert[]> {
    const [failures, hangs, zombies] = await Promise.all([
      this.checkRecentFailures(5, companyId),
      this.checkTerminationHangs(companyId),
      this.detectZombieRuns(companyId),
    ]);

    const allAlerts = [...failures, ...hangs, ...zombies];

    // Emit alerts via callback
    if (this.onAlert) {
      for (const alert of allAlerts) {
        try {
          await this.onAlert(alert);
        } catch (error) {
          logger.error({ err: error, alert }, "Failed to emit run lifecycle alert");
        }
      }
    }

    return allAlerts;
  }

  /**
   * Log alert to structured logging
   */
  logAlert(alert: RunLifecycleAlert): void {
    const logLevel = alert.severity === "critical" ? "error" : alert.severity === "error" ? "error" : "warn";
    logger[logLevel](
      {
        alertType: alert.alertType,
        severity: alert.severity,
        companyId: alert.companyId,
        runId: alert.runId,
        agentId: alert.agentId,
        details: alert.details,
      },
      alert.message,
    );
  }
}

/**
 * Create alert service instance
 */
export function createRunLifecycleAlertService(
  db: Db,
  thresholds?: Partial<AlertThresholds>,
  onAlert?: (alert: RunLifecycleAlert) => void | Promise<void>,
): RunLifecycleAlertService {
  return new RunLifecycleAlertService(
    db,
    { ...DEFAULT_THRESHOLDS, ...thresholds },
    onAlert,
  );
}
