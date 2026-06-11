import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { resolveRecoveryActionByIdSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  agentService,
  heartbeatService,
  issueRecoveryActionService,
  issueService,
  logActivity,
} from "../services/index.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const listQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  ownerAgentId: z.string().uuid().optional(),
  sourceIssueId: z.string().uuid().optional(),
});

export function recoveryActionRoutes(
  db: Db,
  opts: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const svc = issueRecoveryActionService(db);
  const issuesSvc = issueService(db);
  const agentsSvc = agentService(db);
  const heartbeat = heartbeatService(db, { pluginWorkerManager: opts.pluginWorkerManager });

  router.get("/recovery-actions", async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }
    let companyId = parsed.data.companyId ?? null;
    if (!companyId && req.actor.type === "agent") {
      companyId = req.actor.companyId ?? null;
    }
    if (!companyId) {
      res.status(400).json({ error: "companyId is required" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const actions = await svc.listActiveByCompany(companyId, {
      ownerAgentId: parsed.data.ownerAgentId ?? null,
      sourceIssueId: parsed.data.sourceIssueId ?? null,
    });
    res.json({ actions });
  });

  router.get("/recovery-actions/:id", async (req, res) => {
    const id = String(req.params.id ?? "").trim();
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: "Recovery action not found" });
      return;
    }
    const action = await svc.getById(id);
    if (!action) {
      res.status(404).json({ error: "Recovery action not found" });
      return;
    }
    assertCompanyAccess(req, action.companyId);
    res.json({ action });
  });

  router.post(
    "/recovery-actions/:id/resolve",
    validate(resolveRecoveryActionByIdSchema),
    async (req, res) => {
      const id = String(req.params.id ?? "").trim();
      if (!UUID_RE.test(id)) {
        res.status(404).json({ error: "Recovery action not found" });
        return;
      }
      const action = await svc.getById(id);
      if (!action) {
        res.status(404).json({ error: "Recovery action not found" });
        return;
      }
      assertCompanyAccess(req, action.companyId);

      if (action.status !== "active" && action.status !== "escalated") {
        res.status(422).json({
          error: "Recovery action is already resolved",
          details: { id: action.id, status: action.status, outcome: action.outcome },
        });
        return;
      }

      const sourceIssue = await issuesSvc.getById(action.sourceIssueId);

      const actor = getActorInfo(req);
      if (req.actor.type === "agent") {
        const actorAgentId = actor.agentId;
        const allowed =
          !!actorAgentId &&
          (action.ownerAgentId === actorAgentId ||
            (sourceIssue?.assigneeAgentId ?? null) === actorAgentId);
        if (!allowed) {
          res.status(403).json({
            error: "Agent cannot resolve this recovery action",
            details: {
              recoveryActionId: action.id,
              ownerAgentId: action.ownerAgentId,
              sourceAssigneeAgentId: sourceIssue?.assigneeAgentId ?? null,
              actorAgentId: actorAgentId ?? null,
            },
          });
          return;
        }
      } else {
        assertBoard(req);
      }

      const { outcome, resolutionNote } = req.body as z.infer<typeof resolveRecoveryActionByIdSchema>;
      const nextStatus = outcome === "cancelled" ? "cancelled" : "resolved";

      const resolved = await svc.resolveActiveForIssue({
        companyId: action.companyId,
        sourceIssueId: action.sourceIssueId,
        actionId: action.id,
        status: nextStatus,
        outcome,
        resolutionNote: resolutionNote ?? null,
      });
      if (!resolved) {
        res.status(409).json({ error: "Recovery action could not be resolved" });
        return;
      }

      await logActivity(db, {
        companyId: resolved.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.recovery_action_resolved",
        entityType: "issue",
        entityId: resolved.sourceIssueId,
        details: {
          recoveryActionId: resolved.id,
          recoveryActionStatus: resolved.status,
          outcome: resolved.outcome,
          resolutionNote: resolved.resolutionNote,
          source: "recovery_action_by_id_resolve",
        },
      });

      if (outcome === "escalated" && resolved.previousOwnerAgentId) {
        const previousOwnerAgentId = resolved.previousOwnerAgentId;
        const previousOwner = await agentsSvc.getById(previousOwnerAgentId).catch(() => null);
        const ownerName = previousOwner?.name ?? previousOwnerAgentId;

        if (sourceIssue) {
          const body = [
            `Recovery action \`${resolved.id}\` escalated by ${
              actor.actorType === "agent" ? "agent" : "board user"
            }.`,
            "",
            `- Previous owner: [@${ownerName}](agent://${previousOwnerAgentId})`,
            resolutionNote ? `- Note: ${resolutionNote}` : null,
          ]
            .filter((line): line is string => line !== null)
            .join("\n");
          try {
            await issuesSvc.addComment(
              sourceIssue.id,
              body,
              {},
              { authorType: "system" },
            );
          } catch (err) {
            logger.warn(
              { err, recoveryActionId: resolved.id, sourceIssueId: sourceIssue.id },
              "failed to post escalation comment on source issue",
            );
          }
        }

        try {
          await heartbeat.wakeup(previousOwnerAgentId, {
            source: "assignment",
            triggerDetail: "system",
            reason: "recovery_action_escalated",
            idempotencyKey: `recovery_action_escalated:${resolved.id}`,
            payload: {
              issueId: resolved.sourceIssueId,
              sourceIssueId: resolved.sourceIssueId,
              recoveryActionId: resolved.id,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: resolved.sourceIssueId,
              taskId: resolved.sourceIssueId,
              wakeReason: "recovery_action_escalated",
              source: "recovery_action_by_id_resolve",
              recoveryActionId: resolved.id,
            },
          });
        } catch (err) {
          logger.warn(
            { err, recoveryActionId: resolved.id, previousOwnerAgentId },
            "failed to wake previous owner agent after recovery escalation",
          );
        }
      }

      res.json({ action: resolved });
    },
  );

  return router;
}
