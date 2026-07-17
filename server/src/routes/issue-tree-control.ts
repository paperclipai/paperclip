import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createIssueTreeHoldSchema,
  previewIssueTreeControlSchema,
  releaseIssueTreeHoldSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  heartbeatService,
  issueService,
  issueTreeControlService,
  issueVisibilityService,
  logActivity,
  type VisibilityPrincipal,
} from "../services/index.js";
import { notFound } from "../errors.js";
import {
  assertBoard,
  assertCompanyAccess,
  getActorInfo,
  requirePermissionOrProjectPermission,
  requireProjectAccess,
} from "./authz.js";

const TREE_RUN_CANCELLATION_RESPONSE_WAIT_MS = 1_000;
type TreeAuthorizationIssue = {
  id: string;
  companyId: string;
  projectId: string | null;
  visibility: string;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  assigneeUserId: string | null;
  assigneeAgentId: string | null;
};

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
  const access = accessService(db);
  const visibility = issueVisibilityService(db);

  function visibilityPrincipal(req: Request): VisibilityPrincipal {
    if (req.actor.type === "agent") return { kind: "agent", agentId: req.actor.agentId ?? "" };
    if (req.actor.type === "board" && req.actor.source === "local_implicit") return { kind: "system" };
    return {
      kind: "user",
      userId: req.actor.type === "board" ? req.actor.userId ?? "" : "",
      isInstanceAdmin: req.actor.type === "board" && Boolean(req.actor.isInstanceAdmin),
    };
  }

  async function authorizeIssueBoundary(
    req: Request,
    companyId: string,
    tree: TreeAuthorizationIssue[],
    options: { mutation: boolean },
  ) {
    assertCompanyAccess(req, companyId);
    const projectIds = [...new Set(tree
      .map((issue) => issue.projectId)
      .filter((projectId): projectId is string => typeof projectId === "string"))];
    for (const projectId of projectIds) {
      await requireProjectAccess(req, access, companyId, projectId);
    }
    const visible = await visibility.filterVisibleIssues(visibilityPrincipal(req), tree);
    if (visible.length !== tree.length) {
      throw notFound("Issue subtree not found");
    }
    if (options.mutation) {
      const mutationScopes = new Set<string | null>(tree.map((issue) => issue.projectId ?? null));
      for (const projectId of mutationScopes) {
        await requirePermissionOrProjectPermission(
          req,
          access,
          companyId,
          "issues:manage",
          projectId,
          "project:issues:edit",
        );
      }
    }
    return tree;
  }

  async function authorizeTreeBoundary(
    req: Request,
    root: NonNullable<Awaited<ReturnType<typeof issuesSvc.getById>>>,
    options: { mutation: boolean },
  ) {
    const tree = await treeControlSvc.listTreeIssues(root.companyId, root.id);
    return authorizeIssueBoundary(req, root.companyId, tree, options);
  }

  async function authorizeHoldMemberBoundary(
    req: Request,
    companyId: string,
    holds: Array<{ members?: Array<{ issueId: string }> }>,
    options: { mutation: boolean },
  ) {
    const issueIds = [...new Set(holds.flatMap((hold) => hold.members?.map((member) => member.issueId) ?? []))];
    if (issueIds.length === 0) return;
    const memberIssues = await Promise.all(issueIds.map((issueId) => issuesSvc.getById(issueId)));
    if (memberIssues.some((issue) => !issue || issue.companyId !== companyId)) {
      throw notFound("Issue tree hold not found");
    }
    await authorizeIssueBoundary(
      req,
      companyId,
      memberIssues as TreeAuthorizationIssue[],
      options,
    );
  }

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
    const authorizedTree = await authorizeTreeBoundary(req, root, { mutation: false });

    const preview = await treeControlSvc.preview(root.companyId, root.id, {
      ...req.body,
      expectedIssueIds: authorizedTree.map((issue) => issue.id),
    });
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
    const authorizedTree = await authorizeTreeBoundary(req, root, { mutation: true });

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
      expectedIssueIds: authorizedTree.map((issue) => issue.id),
      authorizeLockedBoundary: async () => {
        await authorizeTreeBoundary(req, root, { mutation: true });
      },
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
      const statusUpdate = result.statusUpdate ?? { updatedIssueIds: [], updatedIssues: [] };
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
      const statusUpdate = result.statusUpdate && "releasedCancelHoldIds" in result.statusUpdate
        ? result.statusUpdate
        : {
            updatedIssueIds: [],
            updatedIssues: [],
            releasedCancelHoldIds: [],
            restoreHold: result.hold,
          };
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
    await authorizeTreeBoundary(req, issue, { mutation: false });
    const activePauseHold = await treeControlSvc.getActivePauseHoldGate(issue.companyId, issue.id);
    if (activePauseHold && activePauseHold.rootIssueId !== issue.id) {
      const holdRoot = await issuesSvc.getById(activePauseHold.rootIssueId);
      if (!holdRoot || holdRoot.companyId !== issue.companyId) throw notFound("Issue not found");
      await authorizeTreeBoundary(req, holdRoot, { mutation: false });
    }
    res.json({ activePauseHold });
  });

  router.get("/issues/:id/tree-holds", async (req, res) => {
    assertBoard(req);
    const root = await resolveRootIssue(req);
    if (!root) {
      res.status(404).json({ error: "Root issue not found" });
      return;
    }
    await authorizeTreeBoundary(req, root, { mutation: false });
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
    if (includeMembers) await authorizeHoldMemberBoundary(req, root.companyId, holds, { mutation: false });
    res.json(holds);
  });

  router.get("/issues/:id/tree-holds/:holdId", async (req, res) => {
    assertBoard(req);
    const root = await resolveRootIssue(req);
    if (!root) {
      res.status(404).json({ error: "Root issue not found" });
      return;
    }
    await authorizeTreeBoundary(req, root, { mutation: false });

    const hold = await treeControlSvc.getHold(root.companyId, req.params.holdId as string);
    if (!hold || hold.rootIssueId !== root.id) {
      res.status(404).json({ error: "Issue tree hold not found" });
      return;
    }
    await authorizeHoldMemberBoundary(req, root.companyId, [hold], { mutation: false });
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
      const authorizedTree = await authorizeTreeBoundary(req, root, { mutation: true });
      const existingHold = await treeControlSvc.getHold(root.companyId, req.params.holdId as string);
      if (!existingHold || existingHold.rootIssueId !== root.id) {
        res.status(404).json({ error: "Issue tree hold not found" });
        return;
      }
      await authorizeHoldMemberBoundary(req, root.companyId, [existingHold], { mutation: true });

      const actor = getActorInfo(req);
      const hold = await treeControlSvc.releaseHold(root.companyId, root.id, req.params.holdId as string, {
        ...req.body,
        expectedIssueIds: authorizedTree.map((issue) => issue.id),
        authorizeLockedBoundary: async () => {
          await authorizeTreeBoundary(req, root, { mutation: true });
          const lockedBoundaryHold = await treeControlSvc.getHold(
            root.companyId,
            req.params.holdId as string,
          );
          if (!lockedBoundaryHold || lockedBoundaryHold.rootIssueId !== root.id) {
            throw notFound("Issue tree hold not found");
          }
          await authorizeHoldMemberBoundary(
            req,
            root.companyId,
            [lockedBoundaryHold],
            { mutation: true },
          );
        },
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
