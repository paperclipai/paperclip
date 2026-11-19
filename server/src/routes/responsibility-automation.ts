import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  acceptAutomationProposalSchema,
  createAutomationProposalSchema,
  declineAutomationProposalSchema,
  listResponsibilitiesQuerySchema,
  reportStandingCheckSchema,
  startAutomationConversationSchema,
  type AcceptedAutomationProposal,
  type ProposeAutomationInteraction,
} from "@paperclipai/shared";
import { forbidden, unprocessable } from "../errors.js";
import { responsibilitiesDisabledError } from "../services/responsibilities-disabled.js";
import { validate } from "../middleware/validate.js";
import {
  authorizationDeniedDetails,
  issueReadSqlCondition,
  projectReadSqlCondition,
} from "../services/authorization.js";
import {
  accessService,
  heartbeatService,
  instanceSettingsService,
  issueReferenceService,
  issueService,
  logActivity,
  routineService,
} from "../services/index.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { ResponsibilityReadScope } from "../services/responsibilities.js";
import { responsibilityAutomationService } from "../services/responsibility-automation.js";
import { automationConversationService } from "../services/responsibility-automation-conversations.js";
import { standingCheckService } from "../services/routine-standing-checks.js";
import { routineSuggestionService, type RoutineSuggestionResponsibilityFiling } from "../services/routine-suggestions.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";
import { defaultResponsibilityOwnerUserId } from "./responsibilities.js";
import { getReadableIssue } from "./readable-issue.js";

const automationQuerySchema = listResponsibilitiesQuerySchema.pick({ ownerUserId: true });
const ISSUE_NOT_FOUND = "Issue not found";

/**
 * How automated a person's responsibilities are, and turning manual tasks
 * into automations (experimental, `enableResponsibilities`):
 * - the read (access rules repeat the overview route in `responsibilities.ts`
 *   exactly; reads log no activity);
 * - the automation conversation about one task, the agent's proposal in it,
 *   and a person accepting it or saying it is not right;
 * - an agent reporting what a standing check found on a wake-up.
 */
export function responsibilityAutomationRoutes(
  db: Db,
  opts: { heartbeat?: IssueAssignmentWakeupDeps; pluginWorkerManager?: PluginWorkerManager; filing?: RoutineSuggestionResponsibilityFiling } = {},
) {
  const router = Router();
  const access = accessService(db);
  const settings = instanceSettingsService(db);
  const issues = issueService(db);
  const references = issueReferenceService(db);
  const routines = routineService(db, { pluginWorkerManager: opts.pluginWorkerManager });
  const suggestions = routineSuggestionService(db, { routines, filing: opts.filing });
  const automation = responsibilityAutomationService(db, { routines, suggestions });
  const conversations = automationConversationService(db, { routines, suggestions });
  const standingChecks = standingCheckService(db);
  const heartbeat = opts.heartbeat ?? heartbeatService(db);

  async function assertResponsibilitiesEnabled() {
    const experimental = await settings.getExperimental();
    if (experimental.enableResponsibilities !== true) throw responsibilitiesDisabledError();
  }

  async function assertCompanyRead(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board" && req.actor.type !== "agent") throw forbidden("Board or agent access required");
    if (req.actor.type !== "agent") return;
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) {
      throw forbidden(
        "Responsibilities are outside this agent's authorization boundary",
        authorizationDeniedDetails(decision),
      );
    }
  }

  async function readScope(req: Request): Promise<ResponsibilityReadScope> {
    const [issueReadCondition, projectReadCondition] = await Promise.all([
      issueReadSqlCondition(db, req.actor),
      projectReadSqlCondition(db, req.actor),
    ]);
    return { issueReadCondition, projectReadCondition };
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

  function interactionDetails(interaction: ProposeAutomationInteraction) {
    return {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      interactionStatus: interaction.status,
      continuationPolicy: interaction.continuationPolicy,
      requestedResolverPolicy: interaction.requestedResolverPolicy,
      effectiveResolverPolicy: interaction.effectiveResolverPolicy,
      sourceIssueId: interaction.payload.sourceIssueId,
    };
  }

  /** The permission the routine paths need: an automation assigns recurring work to an agent. */
  async function assertBoardCanAssignTasks(req: Request, companyId: string) {
    if (req.actor.type !== "board") return;
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const allowed = await access.canUser(companyId, req.actor.userId, "tasks:assign");
    if (!allowed) throw forbidden("Missing permission: tasks:assign");
  }

  function boardUserId(req: Request) {
    return req.actor.type === "board" ? req.actor.userId ?? "board" : "board";
  }

  router.get("/companies/:companyId/responsibilities/automation", async (req, res) => {
    await assertResponsibilitiesEnabled();
    const companyId = req.params.companyId as string;
    await assertCompanyRead(req, companyId);
    const query = automationQuerySchema.parse(req.query);
    const ownerUserId = query.ownerUserId ?? defaultResponsibilityOwnerUserId(req);
    if (!ownerUserId) {
      throw unprocessable(req.actor.type === "agent"
        ? "ownerUserId is required: this run works for no person, so name the person whose responsibilities to read"
        : "ownerUserId is required");
    }
    res.json(await automation.overview(companyId, ownerUserId, { scope: await readScope(req) }));
  });

  router.get("/issues/:id/automation-conversation", async (req, res) => {
    await assertResponsibilitiesEnabled();
    const issue = await getReadableIssue(access, req, res, issues.getById(req.params.id as string), ISSUE_NOT_FOUND);
    if (!issue) return;
    assertBoard(req);
    res.json(await conversations.conversationFor(issue));
  });

  router.post("/issues/:id/automation-conversation", validate(startAutomationConversationSchema), async (req, res) => {
    await assertResponsibilitiesEnabled();
    const source = await getReadableIssue(access, req, res, issues.getById(req.params.id as string), ISSUE_NOT_FOUND);
    if (!source) return;
    assertBoard(req);
    await assertBoardCanAssignTasks(req, source.companyId);
    const actor = getActorInfo(req);
    const agentId = req.body.agentId ?? await conversations.defaultAgentId(source, req.body.responsibilityId);
    if (agentId) {
      // The same assignment permission the delegate route checks.
      const decision = await access.decide({
        actor: req.actor,
        action: "tasks:assign",
        resource: {
          type: "issue",
          companyId: source.companyId,
          issueId: null,
          projectId: null,
          parentIssueId: null,
          assigneeAgentId: agentId,
          assigneeUserId: null,
        },
      });
      if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    }
    const { issue, created } = await conversations.startConversation(source, {
      agentId: agentId ?? undefined,
      responsibilityId: req.body.responsibilityId,
    }, {
      userId: actor.actorId,
      runId: actor.runId,
      identityContextId: req.actor.identityContextId ?? null,
      authorizationActor: req.actor,
    });
    if (created) {
      await references.syncIssue(issue.id);
      await log(req, {
        companyId: source.companyId,
        action: "issue.created",
        entityType: "issue",
        entityId: issue.id,
        details: { title: issue.title, identifier: issue.identifier, sourceIssueId: source.id },
      });
      await log(req, {
        companyId: source.companyId,
        action: "issue.automation_conversation_started",
        entityType: "issue",
        entityId: source.id,
        details: { conversationIssueId: issue.id, identifier: issue.identifier, agentId: issue.assigneeAgentId },
      });
      void queueIssueAssignmentWakeup({
        heartbeat,
        issue,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "responsibility.automation_conversation",
        requestedByActorType: "user",
        requestedByActorId: actor.actorId,
      });
    }
    const body = await conversations.conversation(source);
    if (created) {
      res.status(201).json(body);
      return;
    }
    res.json(body);
  });

  router.post("/issues/:id/automation-proposals", validate(createAutomationProposalSchema), async (req, res) => {
    await assertResponsibilitiesEnabled();
    const issue = await getReadableIssue(access, req, res, issues.getById(req.params.id as string), ISSUE_NOT_FOUND);
    if (!issue) return;
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden("Only the agent in this automation conversation can propose an automation");
    }
    const { interaction, replacedIds } = await conversations.propose(issue, req.body, {
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
    "/issues/:id/automation-proposals/:interactionId/accept",
    validate(acceptAutomationProposalSchema),
    async (req, res) => {
      await assertResponsibilitiesEnabled();
      const issue = await getReadableIssue(access, req, res, issues.getById(req.params.id as string), ISSUE_NOT_FOUND);
      if (!issue) return;
      assertBoard(req);
      await assertBoardCanAssignTasks(req, issue.companyId);
      const accepted = await conversations.accept(issue, req.params.interactionId as string, req.body, {
        userId: boardUserId(req),
        runId: req.actor.runId ?? null,
      });
      const sourceIssueId = accepted.interaction.payload.sourceIssueId;
      await log(req, {
        companyId: issue.companyId,
        action: "routine.created",
        entityType: "routine",
        entityId: accepted.routine.id,
        details: {
          title: accepted.routine.title,
          assigneeAgentId: accepted.routine.assigneeAgentId,
          sourceIssueId,
          automationProposalInteractionId: accepted.interaction.id,
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
          triggerKind: accepted.trigger.kind,
          responsibilityIds: accepted.filed.map((entry) => entry.responsibilityId),
        },
      });
      const body: AcceptedAutomationProposal = {
        interaction: accepted.interaction,
        routine: {
          id: accepted.routine.id,
          title: accepted.routine.title,
          assigneeAgentId: accepted.routine.assigneeAgentId,
          projectId: accepted.routine.projectId,
          status: accepted.routine.status,
        },
        webhook: accepted.secretMaterial
          ? { url: accepted.secretMaterial.webhookUrl, secret: accepted.secretMaterial.webhookSecret, signingMode: accepted.trigger.signingMode ?? "bearer" }
          : null,
      };
      // The secret is shown to this person once; nothing may cache it.
      res.setHeader("Cache-Control", "no-store");
      res.json(body);
    },
  );

  router.post(
    "/issues/:id/automation-proposals/:interactionId/decline",
    validate(declineAutomationProposalSchema),
    async (req, res) => {
      await assertResponsibilitiesEnabled();
      const issue = await getReadableIssue(access, req, res, issues.getById(req.params.id as string), ISSUE_NOT_FOUND);
      if (!issue) return;
      assertBoard(req);
      const interaction = await conversations.decline(issue, req.params.interactionId as string, { userId: boardUserId(req) });
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

  router.post("/routines/:id/standing-check-results", validate(reportStandingCheckSchema), async (req, res) => {
    await assertResponsibilitiesEnabled();
    const routine = await getAccessibleResource(req, res, routines.get(req.params.id as string), "Routine not found");
    if (!routine) return;
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden("Only the agent that runs this standing check can report on it");
    }
    const reported = await standingChecks.report(routine, req.body, {
      agentId: req.actor.agentId,
      runId: req.actor.runId ?? null,
    });
    await log(req, {
      companyId: routine.companyId,
      action: "routine.standing_check_reported",
      entityType: "routine",
      entityId: routine.id,
      details: { runId: reported.runId, outcome: reported.outcome, issueId: reported.issueId },
    });
    res.status(201).json(reported);
  });

  return router;
}
