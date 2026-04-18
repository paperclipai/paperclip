import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createWorkflowTemplateSchema,
  updateWorkflowTemplateSchema,
  workflowInvokeInputSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, workflowTemplateService } from "../services/index.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { heartbeatService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function workflowTemplateRoutes(db: Db) {
  const router = Router();
  const svc = workflowTemplateService(db);
  const heartbeat = heartbeatService(db);

  // List templates for a company
  router.get("/companies/:companyId/workflow-templates", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const templates = await svc.list(companyId);
    res.json(templates);
  });

  // Create a workflow template
  router.post(
    "/companies/:companyId/workflow-templates",
    validate(createWorkflowTemplateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const actor = getActorInfo(req);
      const template = await svc.create(companyId, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "workflow_template.created",
        entityType: "workflow_template",
        entityId: template.id,
        details: { name: template.name, nodeCount: template.nodes.length },
      });

      res.status(201).json(template);
    },
  );

  // Get a workflow template
  router.get("/workflow-templates/:id", async (req, res) => {
    const id = req.params.id as string;
    const template = await svc.get(id);
    if (!template) {
      res.status(404).json({ error: "Workflow template not found" });
      return;
    }
    assertCompanyAccess(req, template.companyId);
    res.json(template);
  });

  // Update a workflow template
  router.patch(
    "/workflow-templates/:id",
    validate(updateWorkflowTemplateSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await svc.get(id);
      if (!existing) {
        res.status(404).json({ error: "Workflow template not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);

      const updated = await svc.update(id, req.body);
      if (!updated) {
        res.status(404).json({ error: "Workflow template not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "workflow_template.updated",
        entityType: "workflow_template",
        entityId: id,
        details: { name: updated.name },
      });

      res.json(updated);
    },
  );

  // Delete a workflow template
  router.delete("/workflow-templates/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.get(id);
    if (!existing) {
      res.status(404).json({ error: "Workflow template not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    await svc.remove(id);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "workflow_template.deleted",
      entityType: "workflow_template",
      entityId: id,
      details: { name: existing.name },
    });

    res.status(204).end();
  });

  // Invoke a workflow template
  router.post(
    "/workflow-templates/:id/invoke",
    validate(workflowInvokeInputSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await svc.get(id);
      if (!existing) {
        res.status(404).json({ error: "Workflow template not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);

      const actor = getActorInfo(req);
      const result = await svc.invoke(existing.companyId, existing, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "workflow_template.invoked",
        entityType: "workflow_template",
        entityId: id,
        details: {
          name: existing.name,
          rootIssueId: result.rootIssueId,
          issueCount: result.createdIssues.length,
        },
      });

      // Fire wakeups for unblocked todo nodes with assignees
      for (const created of result.createdIssues) {
        if (created.status === "todo" && created.assigneeAgentId) {
          void queueIssueAssignmentWakeup({
            heartbeat,
            issue: {
              id: created.issueId,
              assigneeAgentId: created.assigneeAgentId,
              status: "todo",
            },
            reason: "issue_assigned",
            mutation: "workflow_invoke",
            contextSource: "workflow_template.invoke",
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
          });
        }
      }

      res.status(201).json(result);
    },
  );

  return router;
}
