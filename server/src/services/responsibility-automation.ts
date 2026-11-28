import type { Db } from "@paperclipai/db";
import {
  DEFAULT_ROUTINE_CADENCE,
  RESPONSIBILITY_AUTOMATION_CANDIDATE_LIMIT,
  RESPONSIBILITY_AUTOMATION_LEVELS,
  RESPONSIBILITY_AUTOMATION_RECENT_DAYS,
  RESPONSIBILITY_AUTOMATION_ROUTINE_LIMIT,
  ROUTINE_FROM_TASK_ORIGIN_KIND,
  automationCandidateReason,
  automationHintForTask,
  rankAutomationCandidates,
  responsibilityAutomationLevel,
  responsibilityAutomationShare,
  responsibleAutomationAgentId,
  type AutomationCandidate,
  type AutomationStart,
  type ResponsibilityAutomation,
  type ResponsibilityAutomationAreaTotals,
  type ResponsibilityAutomationItem,
  type ResponsibilityAutomationLevel,
  type ResponsibilityAutomationOverview,
  type ResponsibilityAutomationStalled,
  type ResponsibilityRoutineOffer,
  type RoutineStatus,
} from "@paperclipai/shared";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { responsibilityService, type ResponsibilityReadScope } from "./responsibilities.js";
import { automationConversationService } from "./responsibility-automation-conversations.js";
import { agentWakesOnItsOwn, standingCheckService, STANDING_CHECK_TRIGGER_KIND } from "./routine-standing-checks.js";
import { routineSuggestionService } from "./routine-suggestions.js";
import { routineService } from "./routines.js";

const DAY_MS = 86_400_000;

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function emptyByLevel(): Record<ResponsibilityAutomationLevel, number> {
  return Object.fromEntries(RESPONSIBILITY_AUTOMATION_LEVELS.map((level) => [level, 0])) as Record<ResponsibilityAutomationLevel, number>;
}

type RoutineFacts = NonNullable<Awaited<ReturnType<ReturnType<typeof routineService>["automationFacts"]>> extends Map<string, infer F> ? F : never>;

/** A routine's triggers in the order the view prefers to describe it: a standing check, then a schedule, then a webhook. */
const START_ORDER = [STANDING_CHECK_TRIGGER_KIND, "schedule", "webhook"];

/**
 * How automated an owner's responsibilities are (experimental,
 * `enableResponsibilities`): per active responsibility, its running
 * automations against its manual tasks (the rule is in `@paperclipai/shared`'s
 * responsibility-automation), the automations that do not run, and the manual
 * tasks ranked by how worth automating they are, each with an instant hint,
 * the agent a conversation would be with and any open conversation. Each
 * module answers for its own data: responsibilities for membership, routines
 * for triggers and origins, standing checks for last results and which agents
 * wake, routine suggestions for which tasks can be automated, interactions
 * for agents' offers, and conversations for the open ones. A fixed number of
 * queries, whatever the count.
 */
export function responsibilityAutomationService(
  db: Db,
  deps: {
    responsibilities?: ReturnType<typeof responsibilityService>;
    routines?: ReturnType<typeof routineService>;
    suggestions?: ReturnType<typeof routineSuggestionService>;
    interactions?: ReturnType<typeof issueThreadInteractionService>;
  } = {},
) {
  const responsibilitiesSvc = deps.responsibilities ?? responsibilityService(db);
  const routinesSvc = deps.routines ?? routineService(db);
  const suggestions = deps.suggestions ?? routineSuggestionService(db, { routines: routinesSvc });
  const interactions = deps.interactions ?? issueThreadInteractionService(db);
  const conversations = automationConversationService(db, { routines: routinesSvc, suggestions });
  const standingChecks = standingCheckService(db);

  return {
    async overview(
      companyId: string,
      ownerUserId: string,
      opts: { scope: ResponsibilityReadScope; now?: Date },
    ): Promise<ResponsibilityAutomationOverview> {
      const now = opts.now ?? new Date();
      const since = new Date(now.getTime() - RESPONSIBILITY_AUTOMATION_RECENT_DAYS * DAY_MS);
      const work = await responsibilitiesSvc.automationWork(companyId, ownerUserId, opts.scope, since);

      const taskIds = [...new Set(work.tasks.map((task) => task.id))];
      const routineIds = [...new Set(work.routines.map((pair) => pair.routineId))];
      const [facts, unrepeatable, converted, offers, open, agents, lastChecks] = await Promise.all([
        routinesSvc.automationFacts(companyId, routineIds),
        suggestions.unrepeatableIssueIds(companyId, taskIds),
        routinesSvc.liveOriginIds(companyId, ROUTINE_FROM_TASK_ORIGIN_KIND, taskIds),
        interactions.routineSuggestionsForIssues(companyId, taskIds),
        conversations.conversationsForTasks(companyId, taskIds, ownerUserId),
        conversations.companyAgents(companyId),
        standingChecks.lastResults(companyId, routineIds, opts.scope.issueReadCondition),
      ]);
      const waking = new Set(agents.rows.filter(agentWakesOnItsOwn).map((agent) => agent.id));
      const firstAssignable = agents.rows.find((agent) => agents.usable.has(agent.id))?.id ?? null;

      // A task an accepted offer turned into a routine is covered too (offers accepted before origins were recorded).
      const acceptedOffer = new Set(offers.filter((offer) => offer.status === "accepted").map((offer) => offer.issueId));
      const pendingOffer = new Map<string, (typeof offers)[number]>();
      for (const offer of offers) {
        if (offer.status === "pending" && !pendingOffer.has(offer.issueId)) pendingOffer.set(offer.issueId, offer);
      }

      const tasksByResponsibility = new Map<string, typeof work.tasks>();
      const agentsByResponsibility = new Map<string, string[]>();
      const noteAgent = (responsibilityId: string, agentId: string | null) => {
        if (!agentId) return;
        const list = agentsByResponsibility.get(responsibilityId) ?? [];
        if (!list.includes(agentId)) list.push(agentId);
        agentsByResponsibility.set(responsibilityId, list);
      };
      for (const responsibility of work.responsibilities) noteAgent(responsibility.id, responsibility.runByAgentId);
      for (const pair of work.routines) noteAgent(pair.responsibilityId, facts.get(pair.routineId)?.assigneeAgentId ?? null);
      for (const task of work.tasks) {
        noteAgent(task.responsibilityId, task.assigneeAgentId);
        if (unrepeatable.has(task.id) || converted.has(task.id) || acceptedOffer.has(task.id)) continue;
        const list = tasksByResponsibility.get(task.responsibilityId) ?? [];
        list.push(task);
        tasksByResponsibility.set(task.responsibilityId, list);
      }
      const routinesByResponsibility = new Map<string, string[]>();
      for (const pair of work.routines) {
        const list = routinesByResponsibility.get(pair.responsibilityId) ?? [];
        list.push(pair.routineId);
        routinesByResponsibility.set(pair.responsibilityId, list);
      }

      const primaryTrigger = (fact: RoutineFacts) => {
        for (const kind of START_ORDER) {
          const found = fact.triggers.find((trigger) => trigger.kind === kind);
          if (found) return found;
        }
        return null;
      };
      /** A routine with only a standing check runs only while its agent wakes up on its own. */
      const isStandingCheckOnly = (fact: RoutineFacts) =>
        fact.triggers.length > 0 && fact.triggers.every((trigger) => trigger.kind === STANDING_CHECK_TRIGGER_KIND);
      const stallReason = (fact: RoutineFacts): ResponsibilityAutomationStalled["reason"] | null => {
        if (fact.status === "paused") return "paused";
        if (fact.status !== "active" || !fact.assigneeAgentId) return "no_agent";
        if (isStandingCheckOnly(fact) && !waking.has(fact.assigneeAgentId)) return "no_wakeups";
        return null;
      };
      const startOf = (fact: RoutineFacts): AutomationStart => {
        const trigger = primaryTrigger(fact);
        if (!trigger) return { kind: "on_request" };
        if (trigger.kind === STANDING_CHECK_TRIGGER_KIND) return { kind: "standing_check", lastResult: lastChecks.get(fact.id) ?? null };
        if (trigger.kind === "webhook") {
          return { kind: "webhook", webhookUrl: trigger.webhookUrl, signingMode: trigger.signingMode, lastDeliveryAt: trigger.lastDeliveryAt };
        }
        return { kind: "schedule", cadenceLabel: trigger.label?.trim() || null, timezone: trigger.timezone, nextRunAt: iso(trigger.nextRunAt) };
      };

      const items: ResponsibilityAutomation[] = [];
      const runningIds = new Map<string, Set<string>>();
      const manualIds = new Map<string, Set<string>>();
      for (const responsibility of work.responsibilities) {
        const routineFacts = (routinesByResponsibility.get(responsibility.id) ?? [])
          .map((id) => facts.get(id))
          .filter((fact): fact is RoutineFacts => !!fact && fact.status !== "archived")
          .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
        const running = routineFacts.filter((fact) => stallReason(fact) === null);
        const stalled: ResponsibilityAutomationStalled[] = routineFacts.flatMap((fact) => {
          const reason = stallReason(fact);
          return reason ? [{
            id: fact.id,
            title: fact.title,
            status: fact.status as RoutineStatus,
            assigneeAgentId: fact.assigneeAgentId,
            startKind: startOf(fact).kind,
            reason,
          }] : [];
        });
        const manual = tasksByResponsibility.get(responsibility.id) ?? [];
        const ranked = rankAutomationCandidates(manual.map((task) => ({ ...task, hasPendingOffer: task.status === "done" && pendingOffer.has(task.id) })));
        const working = agentsByResponsibility.get(responsibility.id) ?? [];
        const candidates: AutomationCandidate[] = ranked.slice(0, RESPONSIBILITY_AUTOMATION_CANDIDATE_LIMIT).map((task) => {
          const offer = task.hasPendingOffer ? pendingOffer.get(task.id)! : null;
          const pending: ResponsibilityRoutineOffer | null = offer
            ? {
              interactionId: offer.id,
              agentId: offer.createdByAgentId ?? offer.payload.assigneeAgentId,
              title: offer.payload.title,
              cadence: offer.payload.cadence,
              cadenceLabel: offer.payload.cadenceLabel,
            }
            : null;
          const hint = automationHintForTask(task);
          const fromTitle = hint?.cadence ?? null;
          const conversation = open.get(task.id) ?? null;
          return {
            issueId: task.id,
            identifier: task.identifier,
            title: task.title,
            status: task.status,
            assigneeAgentId: task.assigneeAgentId,
            assigneeUserId: task.assigneeUserId,
            completedAt: iso(task.completedAt),
            updatedAt: iso(task.updatedAt) ?? now.toISOString(),
            reason: automationCandidateReason(task),
            hint,
            pendingOffer: pending,
            suggestedCadence: pending?.cadence ?? fromTitle ?? DEFAULT_ROUTINE_CADENCE,
            cadenceSource: pending ? "offer" : fromTitle ? "title" : "default",
            responsibleAgentId: conversation?.agentId && agents.usable.has(conversation.agentId)
              ? conversation.agentId
              : responsibleAutomationAgentId({
                taskAgentId: task.assigneeAgentId,
                agentsUnderResponsibility: working,
                firstAssignableAgentId: firstAssignable,
                canTakeWork: (id) => agents.usable.has(id),
              }),
            conversation,
          };
        });
        const automations: ResponsibilityAutomationItem[] = running
          .slice(0, RESPONSIBILITY_AUTOMATION_ROUTINE_LIMIT)
          .map((fact) => {
            const start = startOf(fact);
            return {
              id: fact.id,
              title: fact.title,
              assigneeAgentId: fact.assigneeAgentId!,
              start,
              otherStarts: Math.max(0, fact.triggers.length - (start.kind === "on_request" ? 0 : 1)),
              lastRunAt: iso(fact.lastTriggeredAt),
            };
          });
        runningIds.set(responsibility.id, new Set(running.map((fact) => fact.id)));
        manualIds.set(responsibility.id, new Set(manual.map((task) => task.id)));
        items.push({
          responsibilityId: responsibility.id,
          areaId: responsibility.areaId,
          level: responsibilityAutomationLevel(running.length, manual.length),
          share: responsibilityAutomationShare(running.length, manual.length),
          automationCount: running.length,
          manualTaskCount: manual.length,
          openManualTaskCount: manual.filter((task) => task.status !== "done").length,
          nothingFiled: !work.linked.has(responsibility.id),
          automations,
          stalledAutomations: stalled,
          candidates,
          candidateTotal: manual.length,
          manualTaskIds: ranked.map((task) => task.id),
        });
      }

      // Distinct counts: an automation or task under two responsibilities counts once.
      const distinct = (members: readonly ResponsibilityAutomation[]) => {
        const automationsHere = new Set<string>();
        const tasksHere = new Set<string>();
        for (const item of members) {
          for (const id of runningIds.get(item.responsibilityId) ?? []) automationsHere.add(id);
          for (const id of manualIds.get(item.responsibilityId) ?? []) tasksHere.add(id);
        }
        return {
          automations: automationsHere.size,
          manualTasks: tasksHere.size,
          share: responsibilityAutomationShare(automationsHere.size, tasksHere.size),
        };
      };
      const byArea = new Map<string | null, ResponsibilityAutomation[]>();
      for (const item of items) {
        const list = byArea.get(item.areaId) ?? [];
        list.push(item);
        byArea.set(item.areaId, list);
      }
      const areas: ResponsibilityAutomationAreaTotals[] = [...byArea.entries()].map(([areaId, members]) => ({ areaId, ...distinct(members) }));
      const byLevel = emptyByLevel();
      for (const item of items) byLevel[item.level] += 1;

      return {
        ownerUserId,
        recentDays: RESPONSIBILITY_AUTOMATION_RECENT_DAYS,
        responsibilities: items,
        areas,
        totals: { responsibilities: items.length, byLevel, ...distinct(items) },
      };
    },
  };
}
