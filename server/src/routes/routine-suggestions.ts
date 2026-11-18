import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  acceptRoutineSuggestionSchema,
  createRoutineFromTaskSchema,
  createRoutineSuggestionSchema,
  declineRoutineSuggestionSchema,
  type RoutineFromTaskResult,
  type SuggestRoutineInteraction,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, issueService, logActivity, routineService } from "../services/index.js";
import {
  routineSuggestionService,
  type RoutineSuggestionResponsibilityFiling,
} from "../services/routine-suggestions.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { assertBoard, getActorInfo } from "./authz.js";
import { getReadableIssue } from "./readable-issue.js";

const ISSUE_NOT_FOUND = "Issue not found";

/**
 * Routine offers on finished tasks (experimental `enableResponsibilities`).
 * The agent that finished a task offers once; a person accepts or declines in
 * the task's conversation. A person can also turn a task into a routine
 * without an offer (`repeat-as-routine`), through the same creation path.
 */
export function routineSuggestionRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager; filing?: RoutineSuggestionResponsibilityFiling } = {},
) {
  const router = Router();
  const issues = issueService(db);
  const access = accessService(db);
  const svc = routineSuggestionService(db, {
    routines: routineService(db, { pluginWorkerManager: options.pluginWorkerManager }),
    filing: options.filing,
  });

  function interactionDetails(interaction: SuggestRoutineInteraction) {
    return {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      interactionStatus: interaction.status,
      continuationPolicy: interaction.continuationPolicy,
      requestedResolverPolicy: interaction.requestedResolverPolicy,
      effectiveResolverPolicy: interaction.effectiveResolverPolicy,
    };
  }

  async function log(req: Request, input: {
    companyId: string;
    action: string;
    entityType: string;
    entityId: string;
    details?: Record<string, unknown>;
  }) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      details: input.details,
    });
  }

  /** Same permission routine creation needs: a routine assigns recurring work to an agent. */
  async function assertBoardCanAssignTasks(req: Request, companyId: string) {
    if (req.actor.type !== "board") return;
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const allowed = await access.canUser(companyId, req.actor.userId, "tasks:assign");
    if (!allowed) throw forbidden("Missing permission: tasks:assign");
  }

  function boardUserId(req: Request) {
    return req.actor.type === "board" ? req.actor.userId ?? "board" : "board";
  }

  router.post("/issues/:id/routine-suggestions", validate(createRoutineSuggestionSchema), async (req, res) => {
    const issue = await getReadableIssue(access, req, res, issues.getById(req.params.id as string), ISSUE_NOT_FOUND);
    if (!issue) return;
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden("Only the agent that finished the task can offer a routine");
    }
    const interaction = await svc.offer(issue, req.body, {
      agentId: req.actor.agentId,
      runId: req.actor.runId ?? null,
    });
    await log(req, {
      companyId: issue.companyId,
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: issue.id,
      details: interactionDetails(interaction),
    });
    res.status(201).json(interaction);
  });

  router.post(
    "/issues/:id/routine-suggestions/:interactionId/accept",
    validate(acceptRoutineSuggestionSchema),
    async (req, res) => {
      const issue = await getReadableIssue(access, req, res, issues.getById(req.params.id as string), ISSUE_NOT_FOUND);
      if (!issue) return;
      assertBoard(req);
      await assertBoardCanAssignTasks(req, issue.companyId);
      const accepted = await svc.accept(issue, req.params.interactionId as string, req.body, {
        userId: boardUserId(req),
        runId: req.actor.runId ?? null,
      });
      await log(req, {
        companyId: issue.companyId,
        action: "routine.created",
        entityType: "routine",
        entityId: accepted.routine.id,
        details: {
          title: accepted.routine.title,
          assigneeAgentId: accepted.routine.assigneeAgentId,
          sourceIssueId: issue.id,
          routineSuggestionInteractionId: accepted.interaction.id,
        },
      });
      await log(req, {
        companyId: issue.companyId,
        action: "routine.trigger_created",
        entityType: "routine_trigger",
        entityId: accepted.trigger.id,
        details: { routineId: accepted.routine.id, kind: accepted.trigger.kind },
      });
      for (const entry of accepted.filed) {
        if (!entry.created) continue;
        await log(req, {
          companyId: issue.companyId,
          action: "responsibility.linked",
          entityType: "responsibility",
          entityId: entry.responsibilityId,
          details: { linkId: entry.linkId, targetType: "routine", targetId: accepted.routine.id },
        });
      }
      await log(req, {
        companyId: issue.companyId,
        action: "issue.thread_interaction_accepted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          ...interactionDetails(accepted.interaction),
          routineId: accepted.routine.id,
          responsibilityIds: accepted.filed.map((entry) => entry.responsibilityId),
        },
      });
      res.json({ interaction: accepted.interaction, routine: accepted.routine });
    },
  );

  router.post("/issues/:id/repeat-as-routine", validate(createRoutineFromTaskSchema), async (req, res) => {
    const issue = await getReadableIssue(access, req, res, issues.getById(req.params.id as string), ISSUE_NOT_FOUND);
    if (!issue) return;
    assertBoard(req);
    await assertBoardCanAssignTasks(req, issue.companyId);
    const created = await svc.createFromTask(issue, req.body, {
      userId: boardUserId(req),
      runId: req.actor.runId ?? null,
    });
    await log(req, {
      companyId: issue.companyId,
      action: "routine.created",
      entityType: "routine",
      entityId: created.routine.id,
      details: {
        title: created.routine.title,
        assigneeAgentId: created.routine.assigneeAgentId,
        sourceIssueId: issue.id,
        ...(created.acceptedOffer ? { routineSuggestionInteractionId: created.acceptedOffer.id } : {}),
      },
    });
    await log(req, {
      companyId: issue.companyId,
      action: "routine.trigger_created",
      entityType: "routine_trigger",
      entityId: created.trigger.id,
      details: { routineId: created.routine.id, kind: created.trigger.kind },
    });
    for (const entry of created.filed) {
      if (!entry.created) continue;
      await log(req, {
        companyId: issue.companyId,
        action: "responsibility.linked",
        entityType: "responsibility",
        entityId: entry.responsibilityId,
        details: { linkId: entry.linkId, targetType: "routine", targetId: created.routine.id },
      });
    }
    if (created.acceptedOffer) {
      await log(req, {
        companyId: issue.companyId,
        action: "issue.thread_interaction_accepted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          ...interactionDetails(created.acceptedOffer),
          routineId: created.routine.id,
          responsibilityIds: created.filed.map((entry) => entry.responsibilityId),
        },
      });
    }
    const body: RoutineFromTaskResult = {
      routine: {
        id: created.routine.id,
        title: created.routine.title,
        assigneeAgentId: created.routine.assigneeAgentId,
        projectId: created.routine.projectId,
        status: created.routine.status,
      },
      cadenceLabel: created.cadenceLabel,
      timezone: created.timezone,
      responsibilityIds: created.filed.map((entry) => entry.responsibilityId),
      acceptedOfferId: created.acceptedOffer?.id ?? null,
    };
    res.status(201).json(body);
  });

  router.post(
    "/issues/:id/routine-suggestions/:interactionId/decline",
    validate(declineRoutineSuggestionSchema),
    async (req, res) => {
      const issue = await getReadableIssue(access, req, res, issues.getById(req.params.id as string), ISSUE_NOT_FOUND);
      if (!issue) return;
      assertBoard(req);
      const interaction = await svc.decline(issue, req.params.interactionId as string, { userId: boardUserId(req) });
      await log(req, {
        companyId: issue.companyId,
        action: "issue.thread_interaction_rejected",
        entityType: "issue",
        entityId: issue.id,
        details: interactionDetails(interaction),
      });
      res.json(interaction);
    },
  );

  return router;
}
