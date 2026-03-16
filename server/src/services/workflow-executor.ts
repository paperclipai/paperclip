import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  workflows,
  workflowRuns,
  workflowRunSteps,
  agents,
  agentWakeupRequests,
  issues,
  issueComments,
  projects,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  interpolateObject,
  buildExecutionContext,
  validateVariablesAvailable,
} from "./variable-interpolation.js";

interface WorkflowNode {
  id: string;
  type: "trigger" | "agent" | "action" | "condition" | "delay";
  data: Record<string, unknown>;
  position?: { x: number; y: number };
}

interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  data?: Record<string, unknown>;
}

interface WorkflowDefinition {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

interface ExecutionContext {
  runId: string;
  variables: Record<string, unknown>;
  stepResults: Map<string, unknown>;
  status: "running" | "success" | "failed" | "cancelled";
  error?: string;
}

export class WorkflowExecutor {
  constructor(private db: Db) {}

  /**
   * Execute a workflow run
   */
  async executeWorkflow(runId: string, companyId: string): Promise<void> {
    try {
      // Get workflow run details
      const run = await this.db
        .select()
        .from(workflowRuns)
        .where(
          and(eq(workflowRuns.id, runId), eq(workflowRuns.companyId, companyId))
        )
        .limit(1);

      if (run.length === 0) {
        logger.error(`Workflow run not found: ${runId}`);
        return;
      }

      const workflowRun = run[0];

      // Get workflow definition
      const workflow = await this.db
        .select()
        .from(workflows)
        .where(eq(workflows.id, workflowRun.workflowId))
        .limit(1);

      if (workflow.length === 0) {
        await this.updateRunStatus(runId, "failed", "Workflow not found");
        return;
      }

      const definition = workflow[0].definition as unknown as WorkflowDefinition;
      const context: ExecutionContext = {
        runId,
        variables: (workflowRun.variables as Record<string, unknown>) || {},
        stepResults: new Map(),
        status: "running",
      };

      // Execute workflow
      await this.executeDefinition(definition, context, companyId);

      // Update run status
      await this.updateRunStatus(
        runId,
        context.status,
        context.error,
        context.stepResults
      );
    } catch (error: any) {
      logger.error(`Error executing workflow ${runId}: ${error?.message}`);
      await this.updateRunStatus(
        runId,
        "failed",
        error?.message || "Unknown error"
      );
    }
  }

  /**
   * Execute workflow definition (nodes and edges)
   */
  private async executeDefinition(
    definition: WorkflowDefinition,
    context: ExecutionContext,
    companyId: string
  ): Promise<void> {
    // Find trigger node (entry point)
    const triggerNode = definition.nodes.find((n) => n.type === "trigger");
    if (!triggerNode) {
      context.status = "failed";
      context.error = "No trigger node found in workflow";
      return;
    }

    // Start execution from trigger
    const nextNodeIds = this.getConnectedNodes(
      definition.edges,
      triggerNode.id,
      "target"
    );

    // Execute connected nodes sequentially
    for (const nodeId of nextNodeIds) {
      const success = await this.executeNode(
        definition,
        nodeId,
        context,
        companyId
      );
      if (!success && context.status === "failed") {
        break; // Stop on error (configurable in future)
      }
    }

    if (context.status === "running") {
      context.status = "success";
    }
  }

  /**
   * Execute a single workflow node
   */
  private async executeNode(
    definition: WorkflowDefinition,
    nodeId: string,
    context: ExecutionContext,
    companyId: string
  ): Promise<boolean> {
    const node = definition.nodes.find((n) => n.id === nodeId);
    if (!node) {
      logger.warn(`Node not found: ${nodeId}`);
      return false;
    }

    try {
      // Build execution context with step results
      const executionContext = buildExecutionContext(
        context.variables,
        context.stepResults
      );

      // Interpolate node configuration with variables
      const interpolatedData = interpolateObject(node.data, executionContext) as Record<string, unknown>;

      // Create step record
      const step = await this.db
        .insert(workflowRunSteps)
        .values({
          runId: context.runId,
          nodeId: node.id,
          stepType: node.type,
          status: "running",
          input: (node.data as Record<string, unknown>) || undefined,
          startedAt: new Date(),
        })
        .returning();

      const stepId = step[0].id;

      // Execute based on node type
      let result: unknown;
      let success = true;

      switch (node.type) {
        case "trigger":
          result = context.variables;
          break;

        case "agent":
          result = await this.executeAgentStep(
            { ...node, data: interpolatedData },
            context,
            companyId
          );
          break;

        case "action":
          result = await this.executeActionStep(
            { ...node, data: interpolatedData },
            context,
            companyId
          );
          break;

        case "condition":
          result = this.evaluateCondition(
            { ...node, data: interpolatedData },
            context
          );
          break;

        case "delay":
          result = await this.executeDelay({
            ...node,
            data: interpolatedData,
          });
          break;

        default:
          throw new Error(`Unknown node type: ${node.type}`);
      }

      // Store result
      context.stepResults.set(nodeId, result);

      // Update step with success
      await this.db
        .update(workflowRunSteps)
        .set({
          status: "success",
          output: (result as Record<string, unknown>) || undefined,
          completedAt: new Date(),
        })
        .where(eq(workflowRunSteps.id, stepId));

      // Execute next nodes
      const nextNodeIds = this.getConnectedNodes(
        definition.edges,
        nodeId,
        "target"
      );
      for (const nextId of nextNodeIds) {
        await this.executeNode(definition, nextId, context, companyId);
      }

      return success;
    } catch (error: any) {
      context.status = "failed";
      context.error = error?.message || "Step execution failed";

      logger.error(`Error executing node ${nodeId}: ${error?.message}`);
      return false;
    }
  }

  /**
   * Execute agent step - wake up an agent
   */
  private async executeAgentStep(
    node: WorkflowNode,
    context: ExecutionContext,
    companyId: string
  ): Promise<unknown> {
    const agentId = node.data?.agentId as string;
    const payload = node.data?.payload as Record<string, unknown> | undefined;

    if (!agentId) {
      throw new Error("Agent ID is required for agent step");
    }

    // Verify agent exists
    const agent = await this.db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (agent.length === 0) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Create wakeup request - heartbeat scheduler will pick it up
    try {
      const wakeupRequest = await this.db
        .insert(agentWakeupRequests)
        .values({
          agentId,
          companyId,
          source: "workflow",
          payload: (payload || {}) as Record<string, unknown>,
          reason: "Triggered by workflow execution",
        })
        .returning();

      logger.info(
        `Workflow: Created agent wakeup request ${wakeupRequest[0].id} for agent ${agentId}`
      );

      return {
        agentId,
        status: "wakeup_created",
        wakeupRequestId: wakeupRequest[0].id,
        payload: payload || {},
      };
    } catch (error: any) {
      logger.error(`Error creating agent wakeup request: ${error?.message}`);
      throw new Error(`Failed to queue agent execution: ${error?.message}`);
    }
  }

  /**
   * Execute action step
   */
  private async executeActionStep(
    node: WorkflowNode,
    context: ExecutionContext,
    companyId: string
  ): Promise<unknown> {
    const actionType = node.data?.type as string;

    switch (actionType) {
      case "create-issue":
        return this.executeCreateIssueAction(node, context, companyId);

      case "add-comment":
        return this.executeAddCommentAction(node, context, companyId);

      case "notify":
        return this.executeNotifyAction(node, context);

      default:
        throw new Error(`Unknown action type: ${actionType}`);
    }
  }

  /**
   * Execute create issue action
   */
  private async executeCreateIssueAction(
    node: WorkflowNode,
    context: ExecutionContext,
    companyId: string
  ): Promise<unknown> {
    const projectId = node.data?.projectId as string | undefined;
    const title = node.data?.title as string | undefined;
    const description = node.data?.description as string | undefined;
    const priority = (node.data?.priority as string) || "medium";
    const status = (node.data?.status as string) || "backlog";

    if (!title) {
      throw new Error("Issue title is required");
    }

    // Verify project exists if specified
    if (projectId) {
      const project = await this.db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
        .limit(1);

      if (project.length === 0) {
        throw new Error(`Project not found: ${projectId}`);
      }
    }

    try {
      // Create issue
      const newIssue = await this.db
        .insert(issues)
        .values({
          companyId,
          projectId: projectId || null,
          title,
          description: description || null,
          priority,
          status,
          createdByUserId: "workflow-automation",
        })
        .returning();

      const issueId = newIssue[0].id;

      logger.info(`Workflow: Created issue ${issueId}`);

      return {
        status: "created",
        issueId,
        issueNumber: newIssue[0].issueNumber,
        title,
      };
    } catch (error: any) {
      logger.error(`Error creating issue: ${error?.message}`);
      throw new Error(`Failed to create issue: ${error?.message}`);
    }
  }

  /**
   * Execute add comment action
   */
  private async executeAddCommentAction(
    node: WorkflowNode,
    context: ExecutionContext,
    companyId: string
  ): Promise<unknown> {
    const issueId = node.data?.issueId as string | undefined;
    const comment = node.data?.comment as string | undefined;

    if (!issueId) {
      throw new Error("Issue ID is required for comment action");
    }

    if (!comment) {
      throw new Error("Comment text is required");
    }

    try {
      // Verify issue exists
      const issue = await this.db
        .select()
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .limit(1);

      if (issue.length === 0) {
        throw new Error(`Issue not found: ${issueId}`);
      }

      // Create comment
      const newComment = await this.db
        .insert(issueComments)
        .values({
          issueId,
          companyId,
          body: comment,
          authorUserId: "workflow-automation",
        })
        .returning();

      const commentId = newComment[0].id;

      logger.info(
        `Workflow: Added comment ${commentId} to issue ${issueId}`
      );

      return {
        status: "added",
        commentId,
        issueId,
      };
    } catch (error: any) {
      logger.error(`Error adding comment: ${error?.message}`);
      throw new Error(`Failed to add comment: ${error?.message}`);
    }
  }

  /**
   * Execute notify action
   */
  private async executeNotifyAction(
    node: WorkflowNode,
    context: ExecutionContext
  ): Promise<unknown> {
    const { channel, message } = node.data;

    // TODO: Implement actual notification
    logger.info(`Workflow: Sending notification`);

    return {
      status: "sent",
      channel,
    };
  }

  /**
   * Evaluate condition node
   */
  private evaluateCondition(
    node: WorkflowNode,
    context: ExecutionContext
  ): boolean {
    const { variable, operator, value } = node.data;
    const varValue = context.variables[variable as string];

    switch (operator) {
      case "equals":
        return varValue === value;
      case "contains":
        return String(varValue).includes(String(value));
      case "greater_than":
        return Number(varValue) > Number(value);
      case "less_than":
        return Number(varValue) < Number(value);
      case "regex":
        return new RegExp(value as string).test(String(varValue));
      default:
        return false;
    }
  }

  /**
   * Execute delay step
   */
  private async executeDelay(node: WorkflowNode): Promise<unknown> {
    const delayMs = ((node.data?.duration as number) || 1) * 1000;
    logger.info(`Workflow: Delaying for ${delayMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { status: "completed" };
  }

  /**
   * Get connected nodes in a specific direction
   */
  private getConnectedNodes(
    edges: WorkflowEdge[],
    nodeId: string,
    direction: "source" | "target"
  ): string[] {
    if (direction === "target") {
      // Get nodes that this node points to
      return edges
        .filter((e) => e.source === nodeId)
        .map((e) => e.target);
    } else {
      // Get nodes that point to this node
      return edges
        .filter((e) => e.target === nodeId)
        .map((e) => e.source);
    }
  }

  /**
   * Update workflow run status
   */
  private async updateRunStatus(
    runId: string,
    status: "running" | "success" | "failed" | "cancelled",
    error?: string,
    stepResults?: Map<string, unknown>
  ): Promise<void> {
    await this.db
      .update(workflowRuns)
      .set({
        status,
        error: error || null,
        completedAt: ["success", "failed", "cancelled"].includes(status)
          ? new Date()
          : null,
        updatedAt: new Date(),
      })
      .where(eq(workflowRuns.id, runId));
  }
}

/**
 * Global workflow executor instance
 */
let workflowExecutor: WorkflowExecutor | null = null;

export function getWorkflowExecutor(db: Db): WorkflowExecutor {
  if (!workflowExecutor) {
    workflowExecutor = new WorkflowExecutor(db);
  }
  return workflowExecutor;
}
