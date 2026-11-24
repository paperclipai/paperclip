import { dashboardOwner } from "./responsibility-owner.js";
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  acceptResponsibilityBarProposalSchema,
  createResponsibilityBarProposalSchema,
  declineResponsibilityBarProposalSchema,
  startResponsibilityBarConversationSchema,
  type ProposeResponsibilityBarInteraction,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { authorizationDeniedDetails, issueReadSqlCondition, projectReadSqlCondition } from "../services/authorization.js";
import { accessService, heartbeatService, issueReferenceService, issueService, logActivity } from "../services/index.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import { responsibilityBarService } from "../services/responsibility-bars.js";
import { responsibilityService } from "../services/responsibilities.js";
import { assertBoard, getAccessibleResource, getActorInfo } from "./authz.js";
import { getReadableIssue } from "./readable-issue.js";
import { boardCanManageResponsibilityOwner } from "./responsibilities.js";

const NOT_FOUND = "Responsibility not found";
const ISSUE_NOT_FOUND = "Issue not found";
const BAR_FIELDS = ["standard", "metricKind", "metricName", "metricUnit", "metricDirection", "metricTarget", "metricLow", "metricHigh"] as const;

/**
 * Setting a responsibility's bar by talking to an agent (experimental
 * `enableResponsibilities`). A person opens the bar conversation from the
 * responsibility; the agent in it proposes bars; a person allowed to edit the
 * responsibility accepts one, which applies it, or says it is not right.
 */
export function responsibilityBarRoutes(db: Db, opts: { heartbeat?: IssueAssignmentWakeupDeps } = {}) {
  const router = Router();
  const access = accessService(db);
  const svc = responsibilityBarService(db);
  const responsibilitiesSvc = responsibilityService(db);
  const issues = issueService(db);
  const references = issueReferenceService(db);
  const heartbeat = opts.heartbeat ?? heartbeatService(db);

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

  function interactionDetails(interaction: ProposeResponsibilityBarInteraction) {
    return {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      interactionStatus: interaction.status,
      continuationPolicy: interaction.continuationPolicy,
      requestedResolverPolicy: interaction.requestedResolverPolicy,
      effectiveResolverPolicy: interaction.effectiveResolverPolicy,
      responsibilityId: interaction.payload.responsibilityId,
    };
  }

  /** The writer rule of the responsibilities routes: the owner. */
  function assertWriter(req: Request, row: { companyId: string; ownerUserId: string }) {
    if (!boardCanManageResponsibilityOwner(req, row.companyId, row.ownerUserId)) {
      throw forbidden("Only the person who owns this responsibility can change its bar");
    }
  }

  function boardUserId(req: Request) {
    return req.actor.type === "board" ? req.actor.userId ?? "board" : "board";
  }

  async function readScope(req: Request) {
    const [issueReadCondition, projectReadCondition] = await Promise.all([
      issueReadSqlCondition(db, req.actor),
      projectReadSqlCondition(db, req.actor),
    ]);
    return { issueReadCondition, projectReadCondition };
  }

  router.get("/responsibilities/:id/bar-conversation", async (req, res) => {
    await svc.assertEnabled();
    const row = await getAccessibleResource(req, res, responsibilitiesSvc.getById(req.params.id as string), NOT_FOUND);
    if (!row) return;
    assertBoard(req);
    await dashboardOwner(db, req, row.companyId, row.ownerUserId);
    res.json(await svc.conversation(row));
  });

  router.post(
    "/responsibilities/:id/bar-conversation",
    validate(startResponsibilityBarConversationSchema),
    async (req, res) => {
      await svc.assertEnabled();
      const row = await getAccessibleResource(req, res, responsibilitiesSvc.getById(req.params.id as string), NOT_FOUND);
      if (!row) return;
      assertBoard(req);
      assertWriter(req, row);
      const actor = getActorInfo(req);
      const agentId = req.body.agentId ?? await svc.defaultAgentId(row);
      if (agentId) {
        // The same assignment permission the delegate route checks.
        const decision = await access.decide({
          actor: req.actor,
          action: "tasks:assign",
          resource: {
            type: "issue",
            companyId: row.companyId,
            issueId: null,
            projectId: null,
            parentIssueId: null,
            assigneeAgentId: agentId,
            assigneeUserId: null,
          },
        });
        if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
      }
      const { issue, created } = await svc.startConversation(row, { agentId: agentId ?? undefined }, {
        userId: actor.actorId,
        runId: actor.runId,
        identityContextId: req.actor.identityContextId ?? null,
        authorizationActor: req.actor,
      });
      if (created) {
        await references.syncIssue(issue.id);
        await log(req, {
          companyId: row.companyId,
          action: "issue.created",
          entityType: "issue",
          entityId: issue.id,
          details: { title: issue.title, identifier: issue.identifier, responsibilityId: row.id },
        });
        await log(req, {
          companyId: row.companyId,
          action: "responsibility.bar_conversation_started",
          entityType: "responsibility",
          entityId: row.id,
          details: { issueId: issue.id, identifier: issue.identifier, agentId: issue.assigneeAgentId },
        });
        void queueIssueAssignmentWakeup({
          heartbeat,
          issue,
          reason: "issue_assigned",
          mutation: "create",
          contextSource: "responsibility.bar_conversation",
          requestedByActorType: "user",
          requestedByActorId: actor.actorId,
        });
      }
      const body = await svc.conversation(row);
      if (created) {
        res.status(201).json(body);
        return;
      }
      res.json(body);
    },
  );

  router.post("/issues/:id/bar-proposals", validate(createResponsibilityBarProposalSchema), async (req, res) => {
    await svc.assertEnabled();
    const issue = await getReadableIssue(access, req, res, issues.getById(req.params.id as string), ISSUE_NOT_FOUND);
    if (!issue) return;
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden("Only the agent in this bar conversation can propose a bar");
    }
    const { interaction, replacedIds } = await svc.propose(issue, req.body, {
      agentId: req.actor.agentId,
      runId: req.actor.runId ?? null,
    });
    await log(req, {
      companyId: issue.companyId,
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: issue.id,
      details: { ...interactionDetails(interaction), replacedInteractionIds: replacedIds },
    });
    res.status(201).json(interaction);
  });

  router.post(
    "/issues/:id/bar-proposals/:interactionId/accept",
    validate(acceptResponsibilityBarProposalSchema),
    async (req, res) => {
      await svc.assertEnabled();
      const issue = await getReadableIssue(access, req, res, issues.getById(req.params.id as string), ISSUE_NOT_FOUND);
      if (!issue) return;
      assertBoard(req);
      const { responsibility } = await svc.responsibilityForConversation(issue);
      assertWriter(req, responsibility);
      const accepted = await svc.accept(issue, req.params.interactionId as string, { userId: boardUserId(req) }, {
        keepMetrics: req.body.keepMetrics,
      });
      const { before, after } = accepted;
      const changed = BAR_FIELDS.filter((field) => String(before[field] ?? "") !== String(after[field] ?? ""));
      await log(req, {
        companyId: issue.companyId,
        action: "responsibility.bar_updated",
        entityType: "responsibility",
        entityId: after.id,
        details: {
          fields: changed,
          fromMetricKind: before.metricKind,
          toMetricKind: after.metricKind,
          standard: after.standard,
          source: "bar_conversation",
          issueId: issue.id,
          interactionId: accepted.interaction.id,
        },
      });
      if (String(before.metricCurrent ?? "") !== String(after.metricCurrent ?? "")) {
        await log(req, {
          companyId: issue.companyId,
          action: "responsibility.metric_updated",
          entityType: "responsibility",
          entityId: after.id,
          details: {
            metricName: after.metricName,
            from: before.metricCurrent === null ? null : Number(before.metricCurrent),
            to: after.metricCurrent === null ? null : Number(after.metricCurrent),
          },
        });
      }
      if (accepted.metrics.applied) {
        await log(req, {
          companyId: issue.companyId,
          action: "responsibility.metrics_set",
          entityType: "responsibility",
          entityId: after.id,
          details: {
            source: "bar_conversation",
            issueId: issue.id,
            interactionId: accepted.interaction.id,
            primaryDisplay: accepted.interaction.payload.primaryDisplay ?? null,
            metrics: (accepted.metrics.kept ?? []).map((metric) => ({ title: metric.title, display: metric.display })),
            droppedMetrics: accepted.interaction.result?.droppedMetrics ?? [],
          },
        });
      }
      await log(req, {
        companyId: issue.companyId,
        action: "issue.thread_interaction_accepted",
        entityType: "issue",
        entityId: issue.id,
        details: interactionDetails(accepted.interaction),
      });
      res.json({
        interaction: accepted.interaction,
        responsibility: await responsibilitiesSvc.withRollup(after, await readScope(req)),
      });
    },
  );

  router.post(
    "/issues/:id/bar-proposals/:interactionId/decline",
    validate(declineResponsibilityBarProposalSchema),
    async (req, res) => {
      await svc.assertEnabled();
      const issue = await getReadableIssue(access, req, res, issues.getById(req.params.id as string), ISSUE_NOT_FOUND);
      if (!issue) return;
      assertBoard(req);
      const { responsibility } = await svc.responsibilityForConversation(issue);
      assertWriter(req, responsibility);
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
