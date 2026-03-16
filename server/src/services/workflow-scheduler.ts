import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflows, workflowRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { getWorkflowExecutor } from "./workflow-executor.js";

/**
 * WorkflowScheduler integrates workflows with the heartbeat scheduler
 * Enables cron-based, event-based, and webhook triggers
 */
export class WorkflowScheduler {
  private scheduledWorkflows: Map<string, NodeJS.Timeout> = new Map();

  constructor(private db: Db) {}

  /**
   * Initialize scheduler - load all enabled workflows with schedule triggers
   */
  async initialize(): Promise<void> {
    try {
      const enabledWorkflows = await this.db
        .select()
        .from(workflows)
        .where(eq(workflows.enabled, true));

      for (const workflow of enabledWorkflows) {
        const definition = workflow.definition as any;
        const triggerNode = definition.nodes?.find(
          (n: any) => n.type === "trigger"
        );

        if (triggerNode?.data?.triggerType === "schedule" && workflow.id) {
          await this.scheduleWorkflow(workflow.id, workflow.companyId);
        }
      }

      logger.info(
        `Workflow scheduler initialized with ${this.scheduledWorkflows.size} scheduled workflows`
      );
    } catch (error: any) {
      logger.error(`Error initializing workflow scheduler: ${error?.message}`);
    }
  }

  /**
   * Register or update a workflow schedule
   */
  async scheduleWorkflow(workflowId: string, companyId: string): Promise<void> {
    try {
      // Clear existing schedule if present
      this.unscheduleWorkflow(workflowId);

      // Get workflow details
      const workflowList = await this.db
        .select()
        .from(workflows)
        .where(eq(workflows.id, workflowId))
        .limit(1);

      if (workflowList.length === 0) {
        logger.warn(`Workflow not found for scheduling: ${workflowId}`);
        return;
      }

      const workflow = workflowList[0];
      const definition = workflow.definition as any;
      const triggerNode = definition.nodes?.find(
        (n: any) => n.type === "trigger"
      );

      if (!triggerNode?.data?.cronExpression) {
        logger.warn(`No cron expression found for workflow: ${workflowId}`);
        return;
      }

      const cronExpression = triggerNode.data.cronExpression;

      // Parse cron expression and create timer
      const nextRunTime = this.parseAndSchedule(
        cronExpression,
        workflowId,
        companyId
      );

      logger.info(
        `Scheduled workflow ${workflowId} with cron: ${cronExpression}, next run at ${nextRunTime.toISOString()}`
      );
    } catch (error: any) {
      logger.error(`Error scheduling workflow ${workflowId}: ${error?.message}`);
    }
  }

  /**
   * Remove workflow from scheduler
   */
  unscheduleWorkflow(workflowId: string): void {
    const timer = this.scheduledWorkflows.get(workflowId);
    if (timer) {
      clearTimeout(timer);
      this.scheduledWorkflows.delete(workflowId);
      logger.info(`Workflow scheduler: Unscheduled workflow ${workflowId}`);
    }
  }

  /**
   * Parse cron expression and set up timer
   * Simple implementation: supports basic patterns like "0 9 * * *" (9am daily)
   */
  private parseAndSchedule(
    cronExpression: string,
    workflowId: string,
    companyId: string
  ): Date {
    try {
      const nextRun = this.calculateNextRun(cronExpression);

      // Schedule execution
      const delay = nextRun.getTime() - Date.now();
      if (delay > 0) {
        const timer = setTimeout(() => {
          this.executeScheduledWorkflow(workflowId, companyId).then(() => {
            // Reschedule after execution
            this.scheduleWorkflow(workflowId, companyId);
          });
        }, delay);

        this.scheduledWorkflows.set(workflowId, timer);
      }

      return nextRun;
    } catch (error: any) {
      throw new Error(`Invalid cron expression: ${cronExpression}`);
    }
  }

  /**
   * Execute a scheduled workflow
   */
  private async executeScheduledWorkflow(
    workflowId: string,
    companyId: string
  ): Promise<void> {
    try {
      logger.info(`Executing scheduled workflow: ${workflowId}`);

      // Create a new workflow run
      const newRun = await this.db
        .insert(workflowRuns)
        .values({
          workflowId,
          companyId,
          status: "running",
          triggerData: { trigger: "schedule", timestamp: new Date() },
          variables: {},
        })
        .returning();

      const runId = newRun[0].id;

      // Execute workflow asynchronously
      const executor = getWorkflowExecutor(this.db);
      executor.executeWorkflow(runId, companyId).catch((error: any) => {
        logger.error(
          `Error executing scheduled workflow ${workflowId}: ${error?.message}`
        );
      });
    } catch (error: any) {
      logger.error(
        `Error creating workflow run for ${workflowId}: ${error?.message}`
      );
    }
  }

  /**
   * Calculate next run time from cron expression
   * Simple implementation supporting:
   * - "0 9 * * *" = 9am every day
   * - "0 *\/6 * * *" = Every 6 hours
   * - "0 0 * * 0" = Every Sunday at midnight
   * - etc.
   */
  private calculateNextRun(cronExpression: string): Date {
    const now = new Date();
    const [minute, hour, dayOfMonth, month, dayOfWeek] =
      cronExpression.split(" ");

    // Helper to check if value matches cron pattern
    const matches = (cronVal: string, actualVal: number): boolean => {
      if (cronVal === "*") return true;
      if (cronVal.startsWith("*/")) {
        const step = parseInt(cronVal.substring(2), 10);
        return actualVal % step === 0;
      }
      return parseInt(cronVal, 10) === actualVal;
    };

    // Start from next minute
    let nextRun = new Date(now);
    nextRun.setSeconds(0);
    nextRun.setMilliseconds(0);
    nextRun.setMinutes(nextRun.getMinutes() + 1);

    // Try next 366 days to find a match (avoid infinite loop)
    for (let i = 0; i < 366 * 24 * 60; i++) {
      const m = nextRun.getMinutes();
      const h = nextRun.getHours();
      const d = nextRun.getDate();
      const mon = nextRun.getMonth() + 1; // 1-12
      const dw = nextRun.getDay(); // 0-6 (Sunday-Saturday)

      if (
        matches(minute, m) &&
        matches(hour, h) &&
        matches(dayOfMonth, d) &&
        matches(month, mon) &&
        matches(dayOfWeek, dw)
      ) {
        return nextRun;
      }

      nextRun.setMinutes(nextRun.getMinutes() + 1);
    }

    throw new Error(`Could not find valid next run for cron: ${cronExpression}`);
  }

  /**
   * Shutdown scheduler - clear all timers
   */
  shutdown(): void {
    for (const [workflowId, timer] of this.scheduledWorkflows.entries()) {
      clearTimeout(timer);
    }
    this.scheduledWorkflows.clear();
    logger.info("Workflow scheduler shutdown");
  }
}

/**
 * Global workflow scheduler instance
 */
let workflowScheduler: WorkflowScheduler | null = null;

export function getWorkflowScheduler(db: Db): WorkflowScheduler {
  if (!workflowScheduler) {
    workflowScheduler = new WorkflowScheduler(db);
  }
  return workflowScheduler;
}

export function initializeWorkflowScheduler(db: Db): Promise<void> {
  const scheduler = getWorkflowScheduler(db);
  return scheduler.initialize();
}
