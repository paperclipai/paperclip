import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  acceptDashboardChangeSetSchema,
  createDashboardChangeSetSchema,
  declineDashboardChangeSetSchema,
  responsibilityDashboardQuerySchema,
  restoreDashboardVersionSchema,
  startDashboardConversationSchema,
  type AcceptedDashboardChangeSet,
  type ProposeDashboardChangesInteraction,
  type RestoredDashboardVersion,
} from "@paperclipai/shared";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { accessService, heartbeatService, issueReferenceService, issueService, logActivity } from "../services/index.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import { responsibilityDashboardService } from "../services/responsibility-dashboard.js";
import {
  responsibilityDashboardVersionService,
  toDashboardVersionSummary,
  type DashboardActivityEvent,
} from "../services/responsibility-dashboard-versions.js";
import { responsibilityService } from "../services/responsibilities.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";
import { getReadableIssue } from "./readable-issue.js";
import { boardCanManageResponsibilityOwner } from "./responsibilities.js";

const ISSUE_NOT_FOUND = "Issue not found";
const VERSION_NOT_FOUND = "Version not found";

/**
 * A person's Dashboard, made and changed by talking to an agent, with every
 * applied change saved as a version (experimental `enableResponsibilities`).
 * Reads follow the responsibilities overview: board users read their own by
 * default, agents name the person. A person who may edit that person's
 * responsibilities (themselves, or a company admin) starts the conversation,
 * applies the agent's proposed changes and restores versions; only the agent
 * in the conversation proposes.
 */
export function responsibilityDashboardRoutes(db: Db, opts: { heartbeat?: IssueAssignmentWakeupDeps } = {}) {
  const router = Router();
  const access = accessService(db);
  const svc = responsibilityDashboardService(db);
  const versions = responsibilityDashboardVersionService(db);
  const responsibilitiesSvc = responsibilityService(db);
  const issues = issueService(db);
  const references = issueReferenceService(db);
  const heartbeat = opts.heartbeat ?? heartbeatService(db);

  async function log(req: Request, input: { companyId: string; action: string; entityType: string; entityId: string; details?: Record<string, unknown> }) {
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

  async function logEvents(req: Request, companyId: string, events: readonly DashboardActivityEvent[]) {
    for (const event of events) {
      await log(req, { companyId, action: event.action, entityType: event.entityType, entityId: event.entityId, details: event.details });
    }
  }

  /** The overview route's read rule: company access, and agents inside the company-scope boundary. */
  async function assertCompanyRead(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board" && req.actor.type !== "agent") throw forbidden("Board or agent access required");
    if (req.actor.type === "agent") {
      const decision = await access.decide({ actor: req.actor, action: "company_scope:read", resource: { type: "company", companyId } });
      if (!decision.allowed) {
        throw forbidden("Responsibilities are outside this agent's authorization boundary", authorizationDeniedDetails(decision));
      }
    }
  }

  /** The overview route's ownerUserId rule: board users default to themselves; agents must name the person. */
  function ownerFrom(req: Request, ownerUserId: string | undefined) {
    const owner = ownerUserId ?? (req.actor.type === "board" ? req.actor.userId : undefined);
    if (!owner) {
      throw unprocessable(req.actor.type === "agent"
        ? "ownerUserId is required: name the person whose dashboard to read"
        : "ownerUserId is required");
    }
    return owner;
  }

  function assertWriter(req: Request, companyId: string, ownerUserId: string) {
    if (!boardCanManageResponsibilityOwner(req, companyId, ownerUserId)) {
      throw forbidden("Only the person whose dashboard this is, or a company admin, can change it");
    }
  }

  function boardUserId(req: Request) {
    return req.actor.type === "board" ? req.actor.userId ?? "board" : "board";
  }

  function interactionDetails(interaction: ProposeDashboardChangesInteraction) {
    return {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      interactionStatus: interaction.status,
      continuationPolicy: interaction.continuationPolicy,
      requestedResolverPolicy: interaction.requestedResolverPolicy,
      effectiveResolverPolicy: interaction.effectiveResolverPolicy,
      ownerUserId: interaction.payload.ownerUserId,
    };
  }

  router.get("/companies/:companyId/responsibility-dashboard", async (req, res) => {
    await svc.assertEnabled();
    const companyId = req.params.companyId as string;
    await assertCompanyRead(req, companyId);
    const query = responsibilityDashboardQuerySchema.parse(req.query);
    res.json(await svc.state(companyId, ownerFrom(req, query.ownerUserId)));
  });

  router.get("/companies/:companyId/responsibility-dashboard/versions", async (req, res) => {
    await svc.assertEnabled();
    const companyId = req.params.companyId as string;
    await assertCompanyRead(req, companyId);
    const query = responsibilityDashboardQuerySchema.parse(req.query);
    const ownerUserId = ownerFrom(req, query.ownerUserId);
    // Someone who may change this dashboard saves it as it is first, so the list starts with what they see.
    const writer = boardCanManageResponsibilityOwner(req, companyId, ownerUserId);
    const { list, saved } = await versions.list(companyId, ownerUserId, writer ? { checkpointBy: getActorInfo(req).actorId } : {});
    if (saved) {
      await log(req, {
        companyId,
        action: "responsibility_dashboard.version_saved",
        entityType: "responsibility_dashboard_version",
        entityId: saved.id,
        details: { ownerUserId, cause: saved.cause, summary: saved.summary },
      });
    }
    res.json(list);
  });

  router.post("/companies/:companyId/responsibility-dashboard/conversation", validate(startDashboardConversationSchema), async (req, res) => {
    await svc.assertEnabled();
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const ownerUserId = ownerFrom(req, req.body.ownerUserId);
    assertWriter(req, companyId, ownerUserId);
    if (ownerUserId !== req.actor.userId && !(await responsibilitiesSvc.isCompanyMember(companyId, ownerUserId))) {
      throw notFound("Owner is not a member of this company");
    }
    const actor = getActorInfo(req);
    const agentId = req.body.agentId ?? await svc.defaultAgentId(companyId);
    if (agentId) {
      // The same assignment permission the delegate and bar-conversation routes check.
      const decision = await access.decide({
        actor: req.actor,
        action: "tasks:assign",
        resource: {
          type: "issue",
          companyId,
          issueId: null,
          projectId: null,
          parentIssueId: null,
          assigneeAgentId: agentId,
          assigneeUserId: null,
        },
      });
      if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    }
    const { issue, created, interviewPosted } = await svc.startConversation(companyId, ownerUserId, { mode: req.body.mode, agentId: agentId ?? undefined }, {
      userId: actor.actorId,
      runId: actor.runId,
      identityContextId: req.actor.identityContextId ?? null,
      authorizationActor: req.actor,
    });
    if (created) {
      await references.syncIssue(issue.id);
      await log(req, {
        companyId,
        action: "issue.created",
        entityType: "issue",
        entityId: issue.id,
        details: { title: issue.title, identifier: issue.identifier, ownerUserId },
      });
      await log(req, {
        companyId,
        action: "responsibility_dashboard.conversation_started",
        entityType: "issue",
        entityId: issue.id,
        details: { ownerUserId, mode: req.body.mode, identifier: issue.identifier, agentId: issue.assigneeAgentId },
      });
      // A Create conversation waits for the interview answers, which wake the agent; nothing runs until then.
      if (!interviewPosted) {
        void queueIssueAssignmentWakeup({
          heartbeat,
          issue,
          reason: "issue_assigned",
          mutation: "create",
          contextSource: "responsibility.dashboard_conversation",
          requestedByActorType: "user",
          requestedByActorId: actor.actorId,
        });
      }
    }
    const body = await svc.state(companyId, ownerUserId);
    if (created) {
      res.status(201).json(body);
      return;
    }
    res.json(body);
  });

  router.post("/issues/:id/dashboard-changes", validate(createDashboardChangeSetSchema), async (req, res) => {
    await svc.assertEnabled();
    const issue = await getReadableIssue(access, req, res, issues.getById(req.params.id as string), ISSUE_NOT_FOUND);
    if (!issue) return;
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden("Only the agent in this dashboard conversation can propose changes");
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
      details: { ...interactionDetails(interaction), changes: interaction.payload.changes.length, replacedInteractionIds: replacedIds },
    });
    res.status(201).json(interaction);
  });

  router.post(
    "/issues/:id/dashboard-changes/:interactionId/accept",
    validate(acceptDashboardChangeSetSchema),
    async (req, res) => {
      await svc.assertEnabled();
      const issue = await getReadableIssue(access, req, res, issues.getById(req.params.id as string), ISSUE_NOT_FOUND);
      if (!issue) return;
      assertBoard(req);
      const { ownerUserId } = await svc.ownerForConversation(issue);
      assertWriter(req, issue.companyId, ownerUserId);
      const accepted = await svc.accept(issue, req.params.interactionId as string, { userId: boardUserId(req) }, { keep: req.body.keep });
      await logEvents(req, issue.companyId, accepted.events);
      await log(req, {
        companyId: issue.companyId,
        action: "responsibility_dashboard.changes_applied",
        entityType: "responsibility_dashboard_version",
        entityId: accepted.after.id,
        details: {
          ownerUserId,
          issueId: issue.id,
          interactionId: accepted.interaction.id,
          summary: accepted.after.summary,
          previousVersionId: accepted.before.id,
          dropped: accepted.dropped,
        },
      });
      await log(req, {
        companyId: issue.companyId,
        action: "issue.thread_interaction_accepted",
        entityType: "issue",
        entityId: issue.id,
        details: interactionDetails(accepted.interaction),
      });
      const body: AcceptedDashboardChangeSet = {
        interaction: accepted.interaction,
        version: toDashboardVersionSummary(accepted.after),
      };
      res.json(body);
    },
  );

  router.post(
    "/issues/:id/dashboard-changes/:interactionId/decline",
    validate(declineDashboardChangeSetSchema),
    async (req, res) => {
      await svc.assertEnabled();
      const issue = await getReadableIssue(access, req, res, issues.getById(req.params.id as string), ISSUE_NOT_FOUND);
      if (!issue) return;
      assertBoard(req);
      const { ownerUserId } = await svc.ownerForConversation(issue);
      assertWriter(req, issue.companyId, ownerUserId);
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

  router.post("/responsibility-dashboard-versions/:id/restore", validate(restoreDashboardVersionSchema), async (req, res) => {
    await svc.assertEnabled();
    const version = await getAccessibleResource(req, res, versions.getById(req.params.id as string), VERSION_NOT_FOUND);
    if (!version) return;
    assertBoard(req);
    assertWriter(req, version.companyId, version.ownerUserId);
    const restored = await versions.restore(version, { userId: getActorInfo(req).actorId });
    await logEvents(req, version.companyId, restored.events);
    if (restored.changed) {
      await log(req, {
        companyId: version.companyId,
        action: "responsibility_dashboard.restored",
        entityType: "responsibility_dashboard_version",
        entityId: restored.version.id,
        details: { ownerUserId: version.ownerUserId, restoredVersionId: version.id, summary: restored.version.summary },
      });
    }
    const body: RestoredDashboardVersion = { version: toDashboardVersionSummary(restored.version) };
    res.json(body);
  });

  return router;
}
