import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, issueThreadInteractions, issues, projects, responsibilities } from "@paperclipai/db";
import {
  AUTOMATION_CONVERSATION_ORIGIN_KIND,
  ROUTINE_FROM_TASK_ORIGIN_KIND,
  automationHintForTask,
  automationStartLabel,
  createAutomationProposalSchema,
  getAgentWorkEligibility,
  responsibleAutomationAgentId,
  routineSuggestionCadenceLabel,
  routineSuggestionCronExpression,
  type AcceptAutomationProposal,
  type AutomationConversation,
  type AutomationConversationRef,
  type CreateAutomationProposal,
  type ProposeAutomationInteraction,
  type ProposeAutomationPayload,
  type RoutineTriggerSecretMaterial,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { AuthorizationActor } from "./authorization.js";
import { issueThreadInteractionService, isAcceptClaimLost } from "./issue-thread-interactions.js";
import { issueService } from "./issues.js";
import { responsibilityService } from "./responsibilities.js";
import { agentWakesOnItsOwn } from "./routine-standing-checks.js";
import { routineSuggestionService, type AutomationFromTask } from "./routine-suggestions.js";
import { routineService } from "./routines.js";

type IssueRow = typeof issues.$inferSelect;

/** Agents that can hold a conversation: assignable, and not paused. */
const SILENT_AGENT_STATUSES = new Set(["paused", "terminated", "pending_approval"]);
const unrestricted = { issueReadCondition: sql<boolean>`true`, projectReadCondition: sql<boolean>`true` };

function isClosed(status: string) {
  return status === "done" || status === "cancelled";
}

function clip(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export interface AcceptedAutomation extends AutomationFromTask {
  interaction: ProposeAutomationInteraction;
  timezone: string | null;
}

/**
 * Automation conversations (experimental `enableResponsibilities`): from a
 * manual task a person talks with an agent about automating it, and the
 * conversation ends in one proposed automation the person accepts with one
 * tap. The conversation is an ordinary task (origin `automation_conversation`,
 * origin id = the task being automated) assigned to the agent. This module
 * owns the guardrails, the proposal's derived words and the accept path; the
 * card row belongs to the interactions service, the routine and its trigger
 * to the routines module (through the routine-suggestions creation path,
 * which also files it under the task's responsibilities).
 */
export function automationConversationService(
  db: Db,
  deps: {
    routines?: ReturnType<typeof routineService>;
    suggestions?: ReturnType<typeof routineSuggestionService>;
  } = {},
) {
  const interactions = issueThreadInteractionService(db);
  const routines = deps.routines ?? routineService(db);
  const suggestions = deps.suggestions ?? routineSuggestionService(db, { routines });
  const responsibilitiesSvc = responsibilityService(db);
  const issuesSvc = issueService(db);

  const assertEnabled = () => suggestions.assertEnabled();

  async function companyAgents(companyId: string) {
    const rows = await db.select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      role: agents.role,
      status: agents.status,
      reportsTo: agents.reportsTo,
      adapterType: agents.adapterType,
      runtimeConfig: agents.runtimeConfig,
      createdAt: agents.createdAt,
    }).from(agents).where(eq(agents.companyId, companyId)).orderBy(asc(agents.createdAt), asc(agents.id));
    const usable = new Set(rows.filter((agent) => !SILENT_AGENT_STATUSES.has(agent.status)
      && getAgentWorkEligibility({ agent, agents: rows }).assignable).map((agent) => agent.id));
    return { rows, usable };
  }

  /**
   * The responsible agent: the task's agent; otherwise the agent that runs a
   * responsibility the task is under (the one the person started from first);
   * otherwise the organization's first-created agent that can be assigned.
   */
  async function defaultAgentId(source: Pick<IssueRow, "id" | "companyId" | "assigneeAgentId">, responsibilityId?: string): Promise<string | null> {
    const [{ rows, usable }, under] = await Promise.all([
      companyAgents(source.companyId),
      responsibilitiesSvc.lookup(source.companyId, { kind: "issue", id: source.id }, unrestricted).catch(() => []),
    ]);
    const ids = [...new Set([responsibilityId, ...under.map((entry) => entry.id)].filter((id): id is string => !!id))];
    const runners = ids.length === 0 ? [] : await db.select({ id: responsibilities.id, runByAgentId: responsibilities.runByAgentId })
      .from(responsibilities)
      .where(and(eq(responsibilities.companyId, source.companyId), inArray(responsibilities.id, ids)));
    const runnerIds = ids.map((id) => runners.find((row) => row.id === id)?.runByAgentId).filter((id): id is string => !!id);
    return responsibleAutomationAgentId({
      taskAgentId: source.assigneeAgentId,
      agentsUnderResponsibility: runnerIds,
      firstAssignableAgentId: rows.find((agent) => usable.has(agent.id))?.id ?? null,
      canTakeWork: (id) => usable.has(id),
    });
  }

  async function latestConversation(source: Pick<IssueRow, "id" | "companyId">): Promise<IssueRow | null> {
    const [issue] = await db.select().from(issues).where(and(
      eq(issues.companyId, source.companyId),
      eq(issues.originKind, AUTOMATION_CONVERSATION_ORIGIN_KIND),
      eq(issues.originId, source.id),
      ne(issues.status, "cancelled"),
    )).orderBy(desc(issues.createdAt), desc(issues.id)).limit(1);
    return issue ?? null;
  }

  async function pendingProposal(issue: Pick<IssueRow, "id" | "companyId">) {
    const [row] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, issue.companyId),
      eq(issueThreadInteractions.issueId, issue.id),
      eq(issueThreadInteractions.kind, "propose_automation"),
      eq(issueThreadInteractions.status, "pending"),
    )).orderBy(desc(issueThreadInteractions.createdAt)).limit(1);
    if (!row) return null;
    return (await interactions.getById(row.id)) as ProposeAutomationInteraction | null;
  }

  async function latestProposalAccepted(issue: Pick<IssueRow, "id" | "companyId">) {
    const [row] = await db.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, issue.companyId),
      eq(issueThreadInteractions.issueId, issue.id),
      eq(issueThreadInteractions.kind, "propose_automation"),
    )).orderBy(desc(issueThreadInteractions.createdAt)).limit(1);
    return row?.status === "accepted";
  }

  async function loadSource(companyId: string, issueId: string) {
    const [row] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
    if (!row) throw notFound("Issue not found");
    return row;
  }

  async function loadConversationIssue(issueRef: { id: string; companyId: string }) {
    const issue = await loadSource(issueRef.companyId, issueRef.id);
    if (issue.originKind !== AUTOMATION_CONVERSATION_ORIGIN_KIND || !issue.originId) {
      throw unprocessable("An automation can only be proposed in a task's automation conversation", {
        code: "automation_not_automation_conversation",
      });
    }
    return issue;
  }

  async function assertNotAutomatedYet(source: Pick<IssueRow, "id" | "companyId">) {
    const live = await routines.liveOriginIds(source.companyId, ROUTINE_FROM_TASK_ORIGIN_KIND, [source.id]);
    if (live.has(source.id)) {
      throw conflict("This task is already automated", { code: "automation_exists" });
    }
  }

  /** Where the automation conversation for a task stands. */
  async function conversation(source: IssueRow): Promise<AutomationConversation> {
    const [issue, agentId] = await Promise.all([latestConversation(source), defaultAgentId(source)]);
    const proposal = issue ? await pendingProposal(issue) : null;
    const state: AutomationConversation["state"] = !issue ? "none"
      : proposal ? "proposal_waiting"
        : !isClosed(issue.status) && !(await latestProposalAccepted(issue)) ? "discussing"
          : "settled";
    return {
      sourceIssueId: source.id,
      state,
      defaultAgentId: agentId,
      conversation: issue ? {
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
        agentId: issue.assigneeAgentId,
        createdAt: issue.createdAt,
      } : null,
      proposal,
    };
  }

  return {
    assertEnabled,
    defaultAgentId,
    companyAgents,

    /**
     * The open automation conversation for each of these tasks (the latest
     * not cancelled, while it is open or has a proposal waiting). Two queries
     * whatever the count.
     */
    async conversationsForTasks(companyId: string, taskIds: readonly string[]): Promise<Map<string, AutomationConversationRef>> {
      const found = new Map<string, AutomationConversationRef>();
      if (taskIds.length === 0) return found;
      const rows = await db.selectDistinctOn([issues.originId], {
        id: issues.id,
        originId: issues.originId,
        identifier: issues.identifier,
        status: issues.status,
        agentId: issues.assigneeAgentId,
      }).from(issues).where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, AUTOMATION_CONVERSATION_ORIGIN_KIND),
        inArray(issues.originId, [...new Set(taskIds)]),
        ne(issues.status, "cancelled"),
      )).orderBy(issues.originId, desc(issues.createdAt), desc(issues.id));
      if (rows.length === 0) return found;
      const pending = new Set((await db.selectDistinct({ issueId: issueThreadInteractions.issueId }).from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          inArray(issueThreadInteractions.issueId, rows.map((row) => row.id)),
          eq(issueThreadInteractions.kind, "propose_automation"),
          eq(issueThreadInteractions.status, "pending"),
        ))).map((row) => row.issueId));
      for (const row of rows) {
        if (!row.originId) continue;
        const waiting = pending.has(row.id);
        if (!waiting && isClosed(row.status)) continue;
        found.set(row.originId, {
          issueId: row.id,
          identifier: row.identifier,
          agentId: row.agentId,
          state: waiting ? "proposal_waiting" : "discussing",
        });
      }
      return found;
    },

    async conversationFor(issueRef: { id: string; companyId: string }) {
      await assertEnabled();
      return conversation(await loadSource(issueRef.companyId, issueRef.id));
    },

    /**
     * Open the conversation about automating a task: the open one (or the
     * latest one with a proposal waiting) when there is one, otherwise a new
     * task assigned to the agent, carrying the person's opening message (the
     * task and the instant hint) and a link back. The route wakes the agent
     * and writes activity after commit.
     */
    async startConversation(
      issueRef: { id: string; companyId: string },
      input: { agentId?: string; responsibilityId?: string },
      actor: { userId: string; runId: string | null; identityContextId: string | null; authorizationActor: AuthorizationActor },
    ): Promise<{ source: IssueRow; issue: IssueRow; created: boolean }> {
      await assertEnabled();
      await suggestions.assertCanBeAutomated(issueRef);
      const source = await loadSource(issueRef.companyId, issueRef.id);
      await assertNotAutomatedYet(source);
      const existing = await latestConversation(source);
      if (existing && (!isClosed(existing.status) || (await pendingProposal(existing)))) {
        return { source, issue: existing, created: false };
      }
      const agentId = input.agentId ?? await defaultAgentId(source, input.responsibilityId);
      if (!agentId) {
        throw unprocessable("No agent in this organization can talk this through; set the automation up by hand", {
          code: "automation_conversation_no_agent",
        });
      }
      const { usable } = await companyAgents(source.companyId);
      const [agent] = await db.select({ id: agents.id }).from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, source.companyId)));
      if (!agent) throw notFound("Agent not found");
      if (!usable.has(agent.id)) {
        throw unprocessable("That agent is not taking work right now; choose another or set the automation up by hand", {
          code: "automation_conversation_agent_unavailable",
        });
      }
      const [company] = await db.select({ issuePrefix: companies.issuePrefix }).from(companies)
        .where(eq(companies.id, source.companyId));
      const hint = automationHintForTask(source);
      const name = source.identifier ? `${source.identifier}, “${source.title}”` : `“${source.title}”`;
      const backLink = company ? `[Back to ${source.identifier ?? "the task"}](/${company.issuePrefix}/issues/${source.identifier ?? source.id})` : null;
      const description = [
        `I do ${name} by hand at the moment. Help me turn it into an automation that runs without me: say what you understand the task to be, ask me what you need, then propose one automation I can accept with one tap.`,
        ...(hint ? ["", `Quick suggestion from its title (only a guess): ${hint.why}`] : []),
        ...(backLink ? ["", backLink] : []),
      ].join("\n");
      // The conversation copies the task's title and identifier, so a private
      // task's conversation is private too: only the person and the agent see it.
      const sourceIsPrivate = source.visibility === "private" || source.privacyRootIssueId !== null
        || (source.projectId !== null && await db.select({ id: projects.id }).from(projects)
          .where(and(eq(projects.id, source.projectId), eq(projects.companyId, source.companyId), eq(projects.visibility, "private")))
          .limit(1).then((rows) => rows.length > 0));
      const issue = await issuesSvc.create(source.companyId, {
        ...(sourceIsPrivate ? { visibility: "private" as const } : {}),
        title: clip(`Automate “${source.title}”`, 200),
        description,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        originKind: AUTOMATION_CONVERSATION_ORIGIN_KIND,
        originId: source.id,
        createdByUserId: actor.userId,
        createdByAgentId: null,
        trustExplicitResponsibleUserId: true,
        workspaceSelectionActor: actor.authorizationActor,
        originRunId: actor.runId,
        originIdentityContextId: actor.identityContextId,
        actorRunId: actor.runId,
      });
      return { source, issue: issue as unknown as IssueRow, created: true };
    },

    conversation,

    /** The agent in an automation conversation proposes one automation. Nothing is created. */
    async propose(
      issueRef: { id: string; companyId: string },
      input: CreateAutomationProposal,
      actor: { agentId: string; runId: string | null },
    ) {
      await assertEnabled();
      const data = createAutomationProposalSchema.parse(input);
      const issue = await loadConversationIssue(issueRef);
      if (issue.status === "cancelled") {
        throw conflict("This automation conversation was cancelled", { code: "automation_conversation_cancelled" });
      }
      if (issue.assigneeAgentId !== actor.agentId) {
        throw forbidden("Only the agent in this automation conversation can propose an automation");
      }
      const source = await loadSource(issue.companyId, issue.originId!);
      if (source.status === "cancelled") {
        throw conflict("The task this conversation is about was cancelled", { code: "routine_from_task_cancelled" });
      }
      await assertNotAutomatedYet(source);
      const [agent] = await db.select({ name: agents.name, adapterType: agents.adapterType, status: agents.status, runtimeConfig: agents.runtimeConfig })
        .from(agents).where(and(eq(agents.id, actor.agentId), eq(agents.companyId, issue.companyId)));
      if (!agent) throw notFound("Agent not found");
      if (data.trigger.kind === "standing_check" && !agentWakesOnItsOwn(agent)) {
        throw unprocessable("A standing check needs an agent that wakes up on its own, and you have no heartbeat; propose a schedule or a webhook instead", {
          code: "automation_standing_check_no_heartbeat",
        });
      }
      const filedUnder = (await responsibilitiesSvc.lookup(issue.companyId, { kind: "issue", id: source.id }, unrestricted))
        .map((entry) => ({ id: entry.id, title: entry.title }));
      const trigger: ProposeAutomationPayload["trigger"] = data.trigger.kind === "schedule"
        ? (() => {
          const cadence = {
            frequency: data.trigger.cadence.frequency,
            dayOfWeek: data.trigger.cadence.frequency === "weekly" ? data.trigger.cadence.dayOfWeek ?? null : null,
            dayOfMonth: data.trigger.cadence.frequency === "monthly" ? data.trigger.cadence.dayOfMonth ?? null : null,
            time: data.trigger.cadence.time,
          };
          return { kind: "schedule", cadence, cadenceLabel: routineSuggestionCadenceLabel(cadence), cronExpression: routineSuggestionCronExpression(cadence) };
        })()
        : data.trigger.kind === "webhook"
          ? { kind: "webhook", caller: data.trigger.caller }
          : { kind: "standing_check", lookFor: data.trigger.lookFor, whenFound: data.trigger.whenFound };
      const payload: ProposeAutomationPayload = {
        version: 1,
        sourceIssueId: source.id,
        sourceIdentifier: source.identifier,
        sourceTitle: source.title,
        title: data.title,
        instructions: data.instructions,
        message: data.message ?? null,
        trigger,
        startLabel: automationStartLabel(data.trigger, agent.name),
        assigneeAgentId: actor.agentId,
        agentName: agent.name,
        projectId: source.projectId ?? null,
        filedUnder,
      };
      return interactions.createAutomationProposal(issue, {
        payload,
        title: "Proposed automation",
        summary: `${payload.title} · ${payload.startLabel}`,
        createdByAgentId: actor.agentId,
        sourceRunId: actor.runId,
      });
    },

    /**
     * Create the proposed automation and settle the card. The card is claimed
     * first (so concurrent accepts create one automation), then the routine
     * and its trigger are made through the one creation path for automations
     * made from a task, then the result is recorded. If creating fails, the
     * card is released and stays pending.
     */
    async accept(
      issueRef: { id: string; companyId: string },
      interactionId: string,
      input: AcceptAutomationProposal,
      actor: { userId: string; runId: string | null },
    ): Promise<AcceptedAutomation> {
      await assertEnabled();
      const issue = await loadConversationIssue(issueRef);
      const source = await suggestions.assertCanBeAutomated({ id: issue.originId!, companyId: issue.companyId });
      const claimed = await interactions.claimAutomationProposal(issue, interactionId, "accepted", { userId: actor.userId });
      const claim = claimed.claim!;
      const { payload } = claimed;
      let timezone: string | null = null;
      let created: AutomationFromTask;
      try {
        if (payload.sourceIssueId !== source.id) throw notFound("Interaction not found");
      } catch (error) {
        await interactions.releaseAutomationProposalClaim(issue, interactionId, claim.claimId);
        throw error;
      }
      await suggestions.prepareTakenOverAccept(
        { id: source.id, companyId: source.companyId },
        interactionId,
        claim,
        actor,
        issue,
      );
      try {
        const trigger = payload.trigger;
        if (trigger.kind === "schedule") timezone = await suggestions.resolveTimeZone(input.timezone, actor.userId);
        const description = trigger.kind === "webhook"
          ? `${payload.instructions}\n\nStarted by a webhook: ${trigger.caller}`
          : trigger.kind === "standing_check"
            ? `${payload.instructions}\n\nWhat to look for: ${trigger.lookFor}\nWhen you find it: ${trigger.whenFound}`
            : payload.instructions;
        created = await suggestions.createAutomation({ id: source.id, companyId: source.companyId }, {
          title: payload.title,
          description,
          assigneeAgentId: payload.assigneeAgentId,
          projectId: payload.projectId,
          trigger: trigger.kind === "schedule"
            ? { kind: "schedule", cadenceLabel: trigger.cadenceLabel, cronExpression: trigger.cronExpression, timezone: timezone! }
            : trigger.kind === "webhook"
              ? { kind: "webhook", label: clip(`Webhook: ${trigger.caller}`, 120) }
              : { kind: "heartbeat", label: "Standing check on each wake-up" },
        }, { userId: actor.userId, runId: actor.runId }, suggestions.noteRoutineFor(issue, interactionId, claim.claimId));
      } catch (error) {
        await interactions.releaseAutomationProposalClaim(issue, interactionId, claim.claimId).catch((releaseError) => {
          logger.warn({ err: releaseError, interactionId }, "Could not reopen an automation proposal whose automation failed");
        });
        throw error;
      }
      const secret: RoutineTriggerSecretMaterial | null = created.secretMaterial;
      let interaction: ProposeAutomationInteraction;
      try {
        interaction = await interactions.recordAcceptedAutomationProposal(issue, interactionId, claim.claimId, {
          routineId: created.routine.id,
          routineTitle: created.routine.title,
          triggerId: created.trigger.id,
          cadenceLabel: payload.trigger.kind === "schedule" ? payload.trigger.cadenceLabel : null,
          timezone,
          webhookUrl: secret?.webhookUrl ?? null,
          signingMode: payload.trigger.kind === "webhook" ? created.trigger.signingMode ?? "bearer" : null,
          responsibilityIds: created.filed.map((entry) => entry.responsibilityId),
        });
      } catch (error) {
        // Only when another accept took the card over is its routine the one that stays.
        if (isAcceptClaimLost(error)) await suggestions.archiveRoutine(created.routine.id, actor);
        throw error;
      }
      return { ...created, interaction, timezone };
    },

    /** "Not right": the card closes and the conversation continues. */
    async decline(issueRef: { id: string; companyId: string }, interactionId: string, actor: { userId: string }) {
      await assertEnabled();
      const issue = await loadConversationIssue(issueRef);
      return interactions.claimAutomationProposal(issue, interactionId, "declined", { userId: actor.userId });
    },
  };
}
