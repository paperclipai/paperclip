import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createIssueTreeHoldSchema,
  previewIssueTreeControlSchema,
  releaseIssueTreeHoldSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { heartbeatService, issueService, issueTreeControlService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const TREE_RUN_CANCELLATION_RESPONSE_WAIT_MS = 1_000;

function errorToMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function waitForRunCancellationTasks(tasks: Promise<void>[]) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.all(tasks),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, TREE_RUN_CANCELLATION_RESPONSE_WAIT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function issueTreeControlRoutes(db: Db) {
  const router = Router();
  const issuesSvc = issueService(db);
  const treeControlSvc = issueTreeControlService(db);
  const heartbeat = heartbeatService(db);

  async function resolveRootIssue(req: Request) {
    const rootIssueId = req.params.id as string;
    const root = await issuesSvc.getById(rootIssueId);
    return root;
  }

  router.post("/issues/:id/tree-control/preview", validate(previewIssueTreeControlSchema), async (req, res) => {
    assertBoard(req);
    const root = await resolveRootIssue(req);
    if (!root) {
      res.status(404).json({ error: "Root issue not found" });
      return;
    }
    assertCompanyAccess(req, root.companyId);

    const preview = await treeControlSvc.preview(root.companyId, root.id, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: root.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.tree_control_previewed",
      entityType: "issue",
      entityId: root.id,
      details: {
        mode: preview.mode,
        totals: preview.totals,
        warningCodes: preview.warnings.map((warning) => warning.code),
      },
    });

    res.json(preview);
  });

  router.post("/issues/:id/tree-holds", validate(createIssueTreeHoldSchema), async (req, res) => {
    assertBoard(req);
    const root = await resolveRootIssue(req);
    if (!root) {
      res.status(404).json({ error: "Root issue not found" });
      return;
    }
    assertCompanyAccess(req, root.companyId);

    const actor = getActorInfo(req);
    const actorInput = {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
      runId: actor.runId,
    };
    let result = await treeControlSvc.createHold(root.companyId, root.id, {
      ...req.body,
      actor: actorInput,
    });
    await logActivity(db, {
      companyId: root.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.tree_hold_created",
      entityType: "issue",
      entityId: root.id,
      details: {
        holdId: result.hold.id,
        mode: result.hold.mode,
        reason: result.hold.reason,
        totals: result.preview.totals,
        warningCodes: result.preview.warnings.map((warning) => warning.code),
      },
    });

    const runCancellationTasks: Promise<void>[] = [];
    if (result.hold.mode === "pause" || result.hold.mode === "cancel") {
      const interruptedRunIds = [...new Set(result.preview.activeRuns.map((run) => run.id))];
      for (const heartbeatRunId of interruptedRunIds) {
        const cancellationTask = (async () => {
          try {
            await heartbeat.cancelRun(heartbeatRunId);
            await logActivity(db, {
              companyId: root.companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              action: "issue.tree_hold_run_interrupted",
              entityType: "heartbeat_run",
              entityId: heartbeatRunId,
              details: {
                holdId: result.hold.id,
                rootIssueId: root.id,
                reason: result.hold.mode === "pause" ? "active_subtree_pause_hold" : "subtree_cancel_operation",
              },
            });
          } catch (error) {
            await Promise.resolve(logActivity(db, {
              companyId: root.companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              action: "issue.tree_hold_run_interrupt_failed",
              entityType: "heartbeat_run",
              entityId: heartbeatRunId,
              details: {
                holdId: result.hold.id,
                rootIssueId: root.id,
                reason: result.hold.mode === "pause" ? "active_subtree_pause_hold" : "subtree_cancel_operation",
                error: errorToMessage(error),
              },
            })).catch(() => null);
          }
        })();
        runCancellationTasks.push(cancellationTask);
      }

      const cancelledWakeups = await treeControlSvc.cancelUnclaimedWakeupsForTree(
        root.companyId,
        root.id,
        result.hold.mode === "pause"
          ? "Cancelled because an active subtree pause hold was created"
          : "Cancelled because a subtree cancel operation was applied",
      );
      for (const wakeup of cancelledWakeups) {
        await logActivity(db, {
          companyId: root.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.tree_hold_wakeup_deferred",
          entityType: "agent_wakeup_request",
          entityId: wakeup.id,
          details: {
            holdId: result.hold.id,
            rootIssueId: root.id,
            agentId: wakeup.agentId,
            previousReason: wakeup.reason,
          },
        });
      }
    }

    if (result.hold.mode === "cancel") {
      const statusUpdate = await treeControlSvc.cancelIssueStatusesForHold(root.companyId, root.id, result.hold.id);
      await logActivity(db, {
        companyId: root.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.tree_cancel_status_updated",
        entityType: "issue",
        entityId: root.id,
        details: {
          holdId: result.hold.id,
          cancelledIssueIds: statusUpdate.updatedIssueIds,
          cancelledIssueCount: statusUpdate.updatedIssueIds.length,
        },
      });
    }

    if (runCancellationTasks.length > 0) {
      await waitForRunCancellationTasks(runCancellationTasks);
    }

    if (result.hold.mode === "restore") {
      let statusUpdate;
      try {
        statusUpdate = await treeControlSvc.restoreIssueStatusesForHold(root.companyId, root.id, result.hold.id, {
          reason: result.hold.reason,
          actor: actorInput,
        });
      } catch (error) {
        await treeControlSvc.releaseHold(root.companyId, root.id, result.hold.id, {
          reason: "Restore operation failed before subtree status updates completed",
          metadata: {
            cleanup: "restore_failed_before_apply",
          },
          actor: actorInput,
        }).catch(() => null);
        throw error;
      }
      if (statusUpdate.restoreHold) {
        result = { ...result, hold: statusUpdate.restoreHold };
      }
      await logActivity(db, {
        companyId: root.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.tree_restore_status_updated",
        entityType: "issue",
        entityId: root.id,
        details: {
          holdId: result.hold.id,
          restoredIssueIds: statusUpdate.updatedIssueIds,
          restoredIssueCount: statusUpdate.updatedIssueIds.length,
          releasedCancelHoldIds: statusUpdate.releasedCancelHoldIds,
        },
      });

      const wakeAgents = typeof req.body.metadata === "object"
        && req.body.metadata !== null
        && (req.body.metadata as Record<string, unknown>).wakeAgents === true;
      if (wakeAgents) {
        for (const restoredIssue of statusUpdate.updatedIssues) {
          if (!restoredIssue.assigneeAgentId) continue;
          const wakeRun = await heartbeat
            .wakeup(restoredIssue.assigneeAgentId, {
              source: "assignment",
              triggerDetail: "system",
              reason: "issue_tree_restored",
              payload: {
                issueId: restoredIssue.id,
                rootIssueId: root.id,
                restoreHoldId: result.hold.id,
              },
              requestedByActorType: actor.actorType,
              requestedByActorId: actor.actorId,
              contextSnapshot: {
                issueId: restoredIssue.id,
                taskId: restoredIssue.id,
                wakeReason: "issue_tree_restored",
                source: "issue.tree_restore",
                rootIssueId: root.id,
                restoreHoldId: result.hold.id,
              },
            })
            .catch(() => null);
          if (!wakeRun) continue;
          await logActivity(db, {
            companyId: root.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "issue.tree_restore_wakeup_requested",
            entityType: "heartbeat_run",
            entityId: wakeRun.id,
            details: {
              holdId: result.hold.id,
              rootIssueId: root.id,
              issueId: restoredIssue.id,
              agentId: restoredIssue.assigneeAgentId,
            },
          });
        }
      }
    }

    res
      .status(result.hold.mode === "restore" || result.hold.mode === "resume" ? 200 : 201)
      .json(result);
  });

  router.get("/issues/:id/tree-control/state", async (req, res) => {
    assertBoard(req);
    const issueId = req.params.id as string;
    const issue = await issuesSvc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const activePauseHold = await treeControlSvc.getActivePauseHoldGate(issue.companyId, issue.id);
    res.json({ activePauseHold });
  });

  router.get("/issues/:id/tree-holds", async (req, res) => {
    assertBoard(req);
    const root = await resolveRootIssue(req);
    if (!root) {
      res.status(404).json({ error: "Root issue not found" });
      return;
    }
    assertCompanyAccess(req, root.companyId);
    const statusParam = typeof req.query.status === "string" ? req.query.status : null;
    const modeParam = typeof req.query.mode === "string" ? req.query.mode : null;
    const includeMembers = req.query.includeMembers === "true";
    const holds = await treeControlSvc.listHolds(root.companyId, root.id, {
      status: statusParam === "active" || statusParam === "released" ? statusParam : undefined,
      mode:
        modeParam === "pause" || modeParam === "resume" || modeParam === "cancel" || modeParam === "restore"
          ? modeParam
          : undefined,
      includeMembers,
    });
    res.json(holds);
  });

  router.get("/issues/:id/tree-holds/:holdId", async (req, res) => {
    assertBoard(req);
    const root = await resolveRootIssue(req);
    if (!root) {
      res.status(404).json({ error: "Root issue not found" });
      return;
    }
    assertCompanyAccess(req, root.companyId);

    const hold = await treeControlSvc.getHold(root.companyId, req.params.holdId as string);
    if (!hold || hold.rootIssueId !== root.id) {
      res.status(404).json({ error: "Issue tree hold not found" });
      return;
    }
    res.json(hold);
  });

  router.post(
    "/issues/:id/tree-holds/:holdId/release",
    validate(releaseIssueTreeHoldSchema),
    async (req, res) => {
      assertBoard(req);
      const root = await resolveRootIssue(req);
      if (!root) {
        res.status(404).json({ error: "Root issue not found" });
        return;
      }
      assertCompanyAccess(req, root.companyId);

      const actor = getActorInfo(req);
      const hold = await treeControlSvc.releaseHold(root.companyId, root.id, req.params.holdId as string, {
        ...req.body,
        actor: {
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
          runId: actor.runId,
        },
      });
      await logActivity(db, {
        companyId: root.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.tree_hold_released",
        entityType: "issue",
        entityId: root.id,
        details: {
          holdId: hold.id,
          mode: hold.mode,
          reason: hold.releaseReason,
          memberCount: hold.members?.length ?? 0,
        },
      });

      res.json(hold);
    },
  );

  return router;
}
