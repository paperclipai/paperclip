import { Router, type Request, type Response } from "express";
import { eq, and } from "drizzle-orm";
import { workflows, workflowRuns } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { getWorkflowExecutor } from "../services/workflow-executor.js";
import { getWorkflowScheduler } from "../services/workflow-scheduler.js";
import { assertCompanyAccess } from "./authz.js";

interface WorkflowCreateRequest {
  name: string;
  description?: string;
  definition: Record<string, unknown>;
  enabled?: boolean;
}

interface WorkflowUpdateRequest {
  name?: string;
  description?: string;
  definition?: Record<string, unknown>;
  enabled?: boolean;
}

interface WorkflowRunTriggerRequest {
  variables?: Record<string, unknown>;
  triggerType?: string;
}

export function createWorkflowRoutes(db: Db): Router {
  const router = Router({ mergeParams: true });

  /**
   * POST /companies/:companyId/workflows
   * Create a new workflow
   */
  router.post("/", async (req: Request, res: Response) => {
    try {
      const companyId = String(req.params.companyId);
      assertCompanyAccess(req, companyId);

      const { name, description, definition, enabled = true }: WorkflowCreateRequest = req.body;

      if (!name || !definition) {
        return res.status(400).json({ error: "name and definition are required" });
      }

      const newWorkflow = await db
        .insert(workflows)
        .values({
          companyId,
          name,
          description: description || null,
          definition,
          enabled,
        })
        .returning();

      // If enabled and has schedule trigger, register with scheduler
      if (enabled) {
        const def = definition as any;
        const triggerNode = def.nodes?.find((n: any) => n.type === "trigger");
        if (triggerNode?.data?.triggerType === "schedule") {
          const scheduler = getWorkflowScheduler(db);
          await scheduler.scheduleWorkflow(newWorkflow[0].id, companyId);
        }
      }

      logger.info(`Created workflow ${newWorkflow[0].id}`);
      return res.status(201).json(newWorkflow[0]);
    } catch (error: any) {
      logger.error(`Error creating workflow: ${error?.message}`);
      return res.status(500).json({ error: error?.message || "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/workflows
   * List all workflows for the company
   */
  router.get("/", async (req: Request, res: Response) => {
    try {
      const companyId = String(req.params.companyId);
      assertCompanyAccess(req, companyId);

      const workflowList = await db
        .select()
        .from(workflows)
        .where(eq(workflows.companyId, companyId));

      return res.json(workflowList);
    } catch (error: any) {
      logger.error(`Error listing workflows: ${error?.message}`);
      return res.status(500).json({ error: error?.message || "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/workflows/:id
   * Get workflow details
   */
  router.get("/:id", async (req: Request, res: Response) => {
    try {
      const companyId = String(req.params.companyId);
      const id = String(req.params.id);
      assertCompanyAccess(req, companyId);

      const workflowList = await db
        .select()
        .from(workflows)
        .where(and(eq(workflows.id, id), eq(workflows.companyId, companyId)))
        .limit(1);

      if (workflowList.length === 0) {
        return res.status(404).json({ error: "Workflow not found" });
      }

      return res.json(workflowList[0]);
    } catch (error: any) {
      logger.error(`Error fetching workflow: ${error?.message}`);
      return res.status(500).json({ error: error?.message || "Internal server error" });
    }
  });

  /**
   * PUT /companies/:companyId/workflows/:id
   * Update workflow
   */
  router.put("/:id", async (req: Request, res: Response) => {
    try {
      const companyId = String(req.params.companyId);
      const id = String(req.params.id);
      assertCompanyAccess(req, companyId);

      const { name, description, definition, enabled }: WorkflowUpdateRequest = req.body;

      // Verify workflow exists
      const existing = await db
        .select()
        .from(workflows)
        .where(and(eq(workflows.id, id), eq(workflows.companyId, companyId)))
        .limit(1);

      if (existing.length === 0) {
        return res.status(404).json({ error: "Workflow not found" });
      }

      // Update workflow
      const updated = await db
        .update(workflows)
        .set({
          name: name || existing[0].name,
          description: description !== undefined ? description : existing[0].description,
          definition: definition || existing[0].definition,
          enabled: enabled !== undefined ? enabled : existing[0].enabled,
          updatedAt: new Date(),
        })
        .where(eq(workflows.id, id))
        .returning();

      // Handle scheduler updates
      const scheduler = getWorkflowScheduler(db);
      if (enabled === true) {
        const def = definition || existing[0].definition;
        const defObj = def as any;
        const triggerNode = defObj.nodes?.find((n: any) => n.type === "trigger");
        if (triggerNode?.data?.triggerType === "schedule") {
          await scheduler.scheduleWorkflow(id, companyId);
        }
      } else if (enabled === false) {
        scheduler.unscheduleWorkflow(id);
      }

      logger.info(`Updated workflow ${id}`);
      return res.json(updated[0]);
    } catch (error: any) {
      logger.error(`Error updating workflow: ${error?.message}`);
      return res.status(500).json({ error: error?.message || "Internal server error" });
    }
  });

  /**
   * DELETE /companies/:companyId/workflows/:id
   * Delete workflow
   */
  router.delete("/:id", async (req: Request, res: Response) => {
    try {
      const companyId = String(req.params.companyId);
      const id = String(req.params.id);
      assertCompanyAccess(req, companyId);

      // Verify workflow exists
      const existing = await db
        .select()
        .from(workflows)
        .where(and(eq(workflows.id, id), eq(workflows.companyId, companyId)))
        .limit(1);

      if (existing.length === 0) {
        return res.status(404).json({ error: "Workflow not found" });
      }

      // Unschedule if scheduled
      const scheduler = getWorkflowScheduler(db);
      scheduler.unscheduleWorkflow(id);

      // Delete workflow (cascades to workflowRuns and workflowRunSteps)
      await db.delete(workflows).where(eq(workflows.id, id));

      logger.info(`Deleted workflow ${id}`);
      return res.status(204).send();
    } catch (error: any) {
      logger.error(`Error deleting workflow: ${error?.message}`);
      return res.status(500).json({ error: error?.message || "Internal server error" });
    }
  });

  /**
   * POST /companies/:companyId/workflows/:id/run
   * Trigger a workflow execution
   */
  router.post("/:id/run", async (req: Request, res: Response) => {
    try {
      const companyId = String(req.params.companyId);
      const id = String(req.params.id);
      assertCompanyAccess(req, companyId);

      const { variables = {}, triggerType = "manual" }: WorkflowRunTriggerRequest = req.body;

      // Verify workflow exists
      const workflowList = await db
        .select()
        .from(workflows)
        .where(and(eq(workflows.id, id), eq(workflows.companyId, companyId)))
        .limit(1);

      if (workflowList.length === 0) {
        return res.status(404).json({ error: "Workflow not found" });
      }

      // Create workflow run
      const newRun = await db
        .insert(workflowRuns)
        .values({
          workflowId: id,
          companyId,
          status: "running",
          variables,
          triggerData: { trigger: triggerType, timestamp: new Date() },
        })
        .returning();

      const runId = newRun[0].id;

      // Execute workflow asynchronously
      const executor = getWorkflowExecutor(db);
      executor.executeWorkflow(runId, companyId).catch((error: any) => {
        logger.error(`Error executing workflow ${id}: ${error?.message}`);
      });

      logger.info(`Started workflow run ${runId}`);
      return res.status(202).json({
        runId,
        status: "running",
        message: "Workflow execution started",
      });
    } catch (error: any) {
      logger.error(`Error triggering workflow: ${error?.message}`);
      return res.status(500).json({ error: error?.message || "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/workflows/:id/runs
   * List all runs for a workflow
   */
  router.get("/:id/runs", async (req: Request, res: Response) => {
    try {
      const companyId = String(req.params.companyId);
      const id = String(req.params.id);
      assertCompanyAccess(req, companyId);

      // Verify workflow exists
      const existing = await db
        .select()
        .from(workflows)
        .where(and(eq(workflows.id, id), eq(workflows.companyId, companyId)))
        .limit(1);

      if (existing.length === 0) {
        return res.status(404).json({ error: "Workflow not found" });
      }

      // Get runs
      const runs = await db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.workflowId, id));

      return res.json(runs);
    } catch (error: any) {
      logger.error(`Error fetching workflow runs: ${error?.message}`);
      return res.status(500).json({ error: error?.message || "Internal server error" });
    }
  });

  /**
   * GET /companies/:companyId/workflows/runs/:runId
   * Get details of a specific run
   */
  router.get("/runs/:runId", async (req: Request, res: Response) => {
    try {
      const companyId = String(req.params.companyId);
      const runId = String(req.params.runId);
      assertCompanyAccess(req, companyId);

      const runs = await db
        .select()
        .from(workflowRuns)
        .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.companyId, companyId)))
        .limit(1);

      if (runs.length === 0) {
        return res.status(404).json({ error: "Workflow run not found" });
      }

      return res.json(runs[0]);
    } catch (error: any) {
      logger.error(`Error fetching workflow run: ${error?.message}`);
      return res.status(500).json({ error: error?.message || "Internal server error" });
    }
  });

  return router;
}
