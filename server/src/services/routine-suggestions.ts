import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, projects } from "@paperclipai/db";
import {
  AUTOMATION_CONVERSATION_ORIGIN_KIND,
  ONBOARDING_FIRST_TASK_ORIGIN_KIND,
  RESPONSIBILITY_AUTOMATION_EXCLUDED_ORIGIN_KINDS,
  RESPONSIBILITY_BAR_ORIGIN_KIND,
  RESPONSIBILITY_DASHBOARD_ORIGIN_KIND,
  RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND,
  ROUTINE_FROM_TASK_ORIGIN_KIND,
  createRoutineFromTaskSchema,
  createRoutineSchema,
  createRoutineSuggestionSchema,
  createRoutineTriggerSchema,
  routineSuggestionCadenceLabel,
  routineSuggestionCronExpression,
  type AcceptRoutineSuggestion,
  type CreateRoutineFromTask,
  type CreateRoutineSuggestion,
  type RoutineSuggestionCadence,
  type Routine,
  type RoutineTrigger,
  type RoutineTriggerSecretMaterial,
  type SuggestRoutineInteraction,
  type SuggestRoutinePayload,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "./instance-settings.js";
import { isAcceptClaimLost, issueThreadInteractionService, type AcceptClaim } from "./issue-thread-interactions.js";
import { responsibilityService } from "./responsibilities.js";
import { routineService } from "./routines.js";
import { workspacePreferenceService } from "./workspace-preferences.js";

/** Parent chains are short; the bound only protects against a corrupt cycle. */
const MAX_ANCESTOR_DEPTH = 64;
const ROUTINE_EXECUTION_ORIGIN_KIND = "routine_execution";

/**
 * Where a new routine is filed when the task it repeats sits under
 * responsibilities. The responsibilities module owns these links; this is the
 * narrow contract the accept path needs from it.
 */
export interface RoutineSuggestionResponsibilityFiling {
  /** Every responsibility the task is under (directly or through its project); empty when loose. */
  responsibilitiesForIssue(companyId: string, issueId: string, ownerUserId: string): Promise<Array<{ id: string }>>;
  /** File the routine under one responsibility. Linking is additive and idempotent. */
  fileRoutine(responsibilityId: string, routineId: string): Promise<{ linkId: string; created: boolean } | null>;
}

/**
 * Default filing through the responsibilities module: its lookup (the same one
 * behind `GET /companies/:companyId/responsibility-links/lookup`) and its
 * additive, idempotent link.
 */
export function responsibilityFilingForRoutineSuggestions(db: Db): RoutineSuggestionResponsibilityFiling {
  const svc = responsibilityService(db);
  // The accept route has already authorized the person to read the task, and
  // linking a routine reads no task or project rows, so no further read scope applies.
  const unrestricted = { issueReadCondition: sql<boolean>`true`, projectReadCondition: sql<boolean>`true` };
  return {
    async responsibilitiesForIssue(companyId, issueId, ownerUserId) {
      return svc.lookup(companyId, ownerUserId, { kind: "issue", id: issueId }, unrestricted);
    },
    async fileRoutine(responsibilityId, routineId) {
      const row = await svc.getById(responsibilityId);
      if (!row) return null;
      const result = await svc.link(row, { kind: "routine", id: routineId }, unrestricted);
      return { linkId: result.link.id, created: result.created };
    },
  };
}

type FiledUnder = Array<{ responsibilityId: string; linkId: string; created: boolean }>;

export interface AcceptedRoutineSuggestion {
  interaction: SuggestRoutineInteraction;
  routine: Routine;
  trigger: RoutineTrigger;
  /** Responsibilities the routine is now filed under. */
  filed: FiledUnder;
}

/** A routine a person made from a task, and the agent's offer it settled, if any. */
export interface RoutineFromTask {
  routine: Routine;
  trigger: RoutineTrigger;
  filed: FiledUnder;
  cadenceLabel: string;
  timezone: string;
  /** The task's pending offer, now accepted with this routine. */
  acceptedOffer: SuggestRoutineInteraction | null;
}

/** How a new automation made from a task starts. */
export type AutomationFromTaskTrigger =
  | { kind: "schedule"; cadenceLabel: string; cronExpression: string; timezone: string }
  | { kind: "webhook"; label: string }
  | { kind: "heartbeat"; label: string };

/** An automation made from a task, whichever way it starts. */
export interface AutomationFromTask {
  routine: Routine;
  trigger: RoutineTrigger;
  /** For a webhook, the address and the secret, returned once by the routines module. */
  secretMaterial: RoutineTriggerSecretMaterial | null;
  filed: FiledUnder;
}

/** Bounded so a corrupt parent cycle cannot recurse forever. */
const MAX_LINEAGE_DEPTH = 64;

/** What each run of a routine made from a task does: the task's own words. */
function routineDescriptionFromTask(task: { identifier: string | null; title: string; description: string | null }) {
  // A scheduled routine cannot ask for run inputs, so never carry {{placeholders}} over.
  const lead = `Repeats ${task.identifier ? `${task.identifier}: ` : ""}${task.title.replaceAll("{{", "{ {")}.`;
  const body = task.description?.trim();
  return body && !body.includes("{{") ? `${lead}\n\n${body}` : lead;
}

function isValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Routine suggestions: after an agent finishes a task that plausibly recurs it
 * may offer, once, to repeat the task on a schedule. This module owns the
 * product guardrails and the accept path (routine, schedule, responsibility
 * filing). The conversation card itself belongs to the interactions service.
 */
export function routineSuggestionService(
  db: Db,
  deps: {
    routines?: ReturnType<typeof routineService>;
    filing?: RoutineSuggestionResponsibilityFiling;
    interactions?: ReturnType<typeof issueThreadInteractionService>;
  } = {},
) {
  const settings = instanceSettingsService(db);
  const interactions = deps.interactions ?? issueThreadInteractionService(db);
  const routines = deps.routines ?? routineService(db);
  const filing = deps.filing ?? responsibilityFilingForRoutineSuggestions(db);

  async function assertEnabled() {
    const experimental = await settings.getExperimental();
    if (experimental.enableResponsibilities !== true) throw notFound("Routine suggestions are not enabled");
  }

  /** True when the task or any ancestor matches `predicate`. */
  async function lineageMatches(
    companyId: string,
    issueId: string,
    predicate: (row: { originKind: string }) => boolean,
  ) {
    let currentId: string | null = issueId;
    const seen = new Set<string>();
    for (let depth = 0; currentId && depth < MAX_ANCESTOR_DEPTH && !seen.has(currentId); depth += 1) {
      seen.add(currentId);
      const [row] = await db
        .select({ originKind: issues.originKind, parentId: issues.parentId })
        .from(issues)
        .where(and(eq(issues.id, currentId), eq(issues.companyId, companyId)));
      if (!row) return false;
      if (predicate(row)) return true;
      currentId = row.parentId;
    }
    return false;
  }

  /**
   * Product guardrails, enforced whatever the agent does: the experimental
   * flag is on, the task is not cancelled, and the task is neither work a
   * routine created nor part of the onboarding first task. An offer on a task
   * that is not done yet (a native agent's completion settles after its turn)
   * is held: it stays out of the conversation and cannot be accepted until
   * the task is done, and cancelling the task withdraws it.
   */
  async function assertTaskEligible(issue: {
    id: string;
    companyId: string;
    status: string;
    assigneeAgentId: string | null;
  }) {
    await assertEnabled();
    if (issue.status === "cancelled") {
      throw conflict("A routine cannot be offered for a cancelled task", {
        code: "routine_suggestion_task_not_done",
      });
    }
    if (!issue.assigneeAgentId) {
      throw unprocessable("A routine needs an agent; this task has none", {
        code: "routine_suggestion_no_agent",
      });
    }
    if (await lineageMatches(issue.companyId, issue.id, (row) => row.originKind === ROUTINE_EXECUTION_ORIGIN_KIND)) {
      throw unprocessable("This task already comes from a routine", {
        code: "routine_suggestion_routine_task",
      });
    }
    if (await lineageMatches(issue.companyId, issue.id, (row) => row.originKind === ONBOARDING_FIRST_TASK_ORIGIN_KIND)) {
      throw unprocessable("Routines are not offered for the onboarding task", {
        code: "routine_suggestion_onboarding_task",
      });
    }
    if (await lineageMatches(issue.companyId, issue.id, (row) => row.originKind === RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND)) {
      throw unprocessable("Routines are not offered for a status update request", {
        code: "routine_suggestion_status_update",
      });
    }
    if (await lineageMatches(issue.companyId, issue.id, (row) => row.originKind === RESPONSIBILITY_DASHBOARD_ORIGIN_KIND)) {
      throw unprocessable("Routines are not offered for a dashboard conversation", {
        code: "routine_suggestion_dashboard_conversation",
      });
    }
  }

  /**
   * A person may turn any task into a routine except work a routine created,
   * the onboarding task, a bar or automation conversation and a status update
   * request (or their subtasks).
   */
  /**
   * Routines are readable company-wide and copy the task's title and
   * description, so a private task (or one in a private project) never
   * becomes a routine.
   */
  async function assertNotPrivate(issue: { id: string; companyId: string }) {
    const [row] = await db.select({
      visibility: issues.visibility,
      privacyRootIssueId: issues.privacyRootIssueId,
      projectVisibility: projects.visibility,
    }).from(issues)
      .leftJoin(projects, and(eq(projects.id, issues.projectId), eq(projects.companyId, issues.companyId)))
      .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)));
    if (row && (row.visibility === "private" || row.privacyRootIssueId !== null || row.projectVisibility === "private")) {
      throw unprocessable("A private task cannot become a routine, because routines are visible to the whole company", {
        code: "routine_from_task_private",
      });
    }
  }

  async function assertRepeatable(issue: { id: string; companyId: string }) {
    await assertNotPrivate(issue);
    if (await lineageMatches(issue.companyId, issue.id, (row) => row.originKind === ROUTINE_EXECUTION_ORIGIN_KIND)) {
      throw unprocessable("This task already comes from a routine", { code: "routine_suggestion_routine_task" });
    }
    if (await lineageMatches(issue.companyId, issue.id, (row) => row.originKind === ONBOARDING_FIRST_TASK_ORIGIN_KIND)) {
      throw unprocessable("The onboarding task cannot become a routine", { code: "routine_suggestion_onboarding_task" });
    }
    if (await lineageMatches(issue.companyId, issue.id, (row) => row.originKind === RESPONSIBILITY_BAR_ORIGIN_KIND)) {
      throw unprocessable("A bar conversation cannot become a routine", { code: "routine_from_task_bar_conversation" });
    }
    if (await lineageMatches(issue.companyId, issue.id, (row) => row.originKind === AUTOMATION_CONVERSATION_ORIGIN_KIND)) {
      throw unprocessable("An automation conversation cannot itself be automated", { code: "routine_from_task_automation_conversation" });
    }
    if (await lineageMatches(issue.companyId, issue.id, (row) => row.originKind === RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND)) {
      throw unprocessable("A request for a status update cannot become a routine", { code: "routine_from_task_status_update" });
    }
    if (await lineageMatches(issue.companyId, issue.id, (row) => row.originKind === RESPONSIBILITY_DASHBOARD_ORIGIN_KIND)) {
      throw unprocessable("A dashboard conversation cannot become a routine", { code: "routine_from_task_dashboard_conversation" });
    }
  }

  async function loadIssue(issueId: string, companyId: string) {
    const [row] = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        projectId: issues.projectId,
        identifier: issues.identifier,
        title: issues.title,
        description: issues.description,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
    if (!row) throw notFound("Issue not found");
    return row;
  }

  async function resolveTimeZone(requested: string | undefined, userId: string) {
    const zone = requested ?? (await workspacePreferenceService(db).get(userId)).timeZone ?? "UTC";
    if (!isValidTimeZone(zone)) throw unprocessable(`Unknown time zone: ${zone}`);
    return zone;
  }

  /**
   * The one creation path for an automation made from a task, whether an
   * agent offered it, an agent proposed it in a conversation or a person
   * asked: an active routine recording the task as its origin (so the task is
   * not offered again), its trigger (a schedule in the person's time zone, a
   * webhook through the routines module's own webhook path, or a standing
   * check), and a link under every responsibility the task is under. A
   * routine left without its trigger is archived before the error is rethrown.
   */
  async function createAutomation(
    issue: { id: string; companyId: string },
    spec: {
      title: string;
      description: string;
      assigneeAgentId: string;
      projectId: string | null;
      trigger: AutomationFromTaskTrigger;
    },
    actor: { userId: string; runId: string | null },
    /** Called once the routine exists, before its trigger; a throw archives it. */
    onRoutineCreated?: (routineId: string) => Promise<void>,
  ): Promise<AutomationFromTask> {
    let routine: Routine | null = null;
    let created: Awaited<ReturnType<typeof routines.createTrigger>>;
    try {
      routine = await routines.create(issue.companyId, createRoutineSchema.parse({
        title: spec.title,
        description: spec.description,
        assigneeAgentId: spec.assigneeAgentId,
        projectId: spec.projectId,
      }), actor, { origin: { kind: ROUTINE_FROM_TASK_ORIGIN_KIND, id: issue.id } });
      if (onRoutineCreated) await onRoutineCreated(routine.id);
      const wanted = spec.trigger;
      created = await routines.createTrigger(routine.id, createRoutineTriggerSchema.parse(
        wanted.kind === "schedule"
          ? { kind: "schedule", label: wanted.cadenceLabel, cronExpression: wanted.cronExpression, timezone: wanted.timezone }
          : wanted.kind === "webhook"
            ? { kind: "webhook", label: wanted.label, signingMode: "bearer" }
            : { kind: "heartbeat", label: wanted.label },
      ), actor);
    } catch (error) {
      if (routine) {
        // The routine exists without its trigger: archive it so the
        // person is not left with a half-made automation.
        const half = routine;
        await routines.update(half.id, { status: "archived" }, actor).catch((archiveError) => {
          logger.warn({ err: archiveError, routineId: half.id }, "Could not archive a routine whose trigger failed");
        });
      }
      throw error;
    }
    const trigger = created.trigger;

    const filed: FiledUnder = [];
    try {
      for (const responsibility of await filing.responsibilitiesForIssue(issue.companyId, issue.id, actor.userId)) {
        try {
          const link = await filing.fileRoutine(responsibility.id, routine.id);
          if (link) filed.push({ responsibilityId: responsibility.id, ...link });
        } catch (error) {
          // The routine is the outcome the person asked for; a filing
          // conflict must not undo it. The routine can be filed later.
          logger.warn({ err: error, responsibilityId: responsibility.id, routineId: routine.id },
            "Could not file a new routine under the task's responsibility");
        }
      }
    } catch (error) {
      logger.warn({ err: error, issueId: issue.id, routineId: routine.id },
        "Could not look up the task's responsibilities for a new routine");
    }
    return { routine, trigger, secretMaterial: created.secretMaterial, filed };
  }

  /** A routine that repeats a task on a schedule (an accepted offer, or a person's form). */
  async function createScheduledRoutine(
    issue: { id: string; companyId: string },
    spec: {
      title: string;
      description: string;
      assigneeAgentId: string;
      projectId: string | null;
      cadenceLabel: string;
      cronExpression: string;
      timezone: string;
    },
    actor: { userId: string; runId: string | null },
    onRoutineCreated?: (routineId: string) => Promise<void>,
  ): Promise<{ routine: Routine; trigger: RoutineTrigger; filed: FiledUnder }> {
    const { routine, trigger, filed } = await createAutomation(issue, {
      title: spec.title,
      description: spec.description,
      assigneeAgentId: spec.assigneeAgentId,
      projectId: spec.projectId,
      trigger: { kind: "schedule", cadenceLabel: spec.cadenceLabel, cronExpression: spec.cronExpression, timezone: spec.timezone },
    }, actor, onRoutineCreated);
    return { routine, trigger, filed };
  }

  async function archiveRoutine(routineId: string, actor: { userId: string; runId: string | null }) {
    await routines.update(routineId, { status: "archived" }, actor).catch((error) => {
      logger.warn({ err: error, routineId }, "Could not archive a routine an interrupted accept made");
    });
  }

  /**
   * Before an accept that took over an interrupted one makes its routine:
   * archive only the routine the interrupted accept had made (noted on the
   * card), and stop if the task already repeats through another routine (a
   * person made one by hand meanwhile). Then the card is closed, not replaced.
   */
  async function prepareTakenOverAccept(
    issue: { id: string; companyId: string },
    interactionId: string,
    claim: AcceptClaim,
    actor: { userId: string; runId: string | null },
    /** The task the card is on, when it is not the task being automated (an automation conversation). */
    cardIssue: { id: string; companyId: string } = issue,
  ) {
    if (!claim.tookOver) return;
    if (claim.strandedRoutineId) await archiveRoutine(claim.strandedRoutineId, actor);
    const live = await routines.liveOriginIds(issue.companyId, ROUTINE_FROM_TASK_ORIGIN_KIND, [issue.id]);
    if (live.has(issue.id)) {
      await interactions.expireAcceptClaim(cardIssue, interactionId, claim.claimId);
      throw conflict("This task already repeats through another routine", { code: "routine_from_task_exists" });
    }
  }

  /** Note the routine an accept just made on its card; fails when the claim was taken over. */
  function noteRoutineFor(issue: { id: string; companyId: string }, interactionId: string, claimId: string) {
    return async (routineId: string) => {
      if (!(await interactions.noteAcceptClaimRoutine(issue, interactionId, claimId, routineId))) {
        throw conflict("Another accept took this over", { code: "accept_claim_taken_over" });
      }
    };
  }

  return {
    assertEnabled,
    resolveTimeZone,
    createAutomation,
    archiveRoutine,
    prepareTakenOverAccept,
    noteRoutineFor,

    /**
     * Whether a person may automate this task: it exists, is not cancelled,
     * and is not work a routine created, the onboarding task, or a bar or
     * automation conversation (or under one).
     */
    async assertCanBeAutomated(issueRef: { id: string; companyId: string }) {
      const issue = await loadIssue(issueRef.id, issueRef.companyId);
      if (issue.status === "cancelled") {
        throw conflict("A cancelled task cannot be automated", { code: "routine_from_task_cancelled" });
      }
      await assertRepeatable(issue);
      return issue;
    },

    /** The agent assigned to a finished task offers, once, to repeat it. */
    async offer(
      issueRef: { id: string; companyId: string },
      input: CreateRoutineSuggestion,
      actor: { agentId: string; runId: string | null },
    ): Promise<SuggestRoutineInteraction> {
      const data = createRoutineSuggestionSchema.parse(input);
      const issue = await loadIssue(issueRef.id, issueRef.companyId);
      await assertTaskEligible(issue);
      await assertNotPrivate(issue);
      if (issue.assigneeAgentId !== actor.agentId) {
        throw forbidden("Only the agent assigned to the task can offer a routine for it");
      }
      const cadenceLabel = routineSuggestionCadenceLabel(data.cadence);
      const payload: SuggestRoutinePayload = {
        version: 1,
        title: data.title,
        instructions: data.instructions,
        message: data.message ?? null,
        cadence: {
          frequency: data.cadence.frequency,
          dayOfWeek: data.cadence.frequency === "weekly" ? data.cadence.dayOfWeek ?? null : null,
          dayOfMonth: data.cadence.frequency === "monthly" ? data.cadence.dayOfMonth ?? null : null,
          time: data.cadence.time,
        },
        cadenceLabel,
        cronExpression: "",
        assigneeAgentId: issue.assigneeAgentId!,
        projectId: issue.projectId ?? null,
      };
      payload.cronExpression = routineSuggestionCronExpression(payload.cadence);
      return interactions.createRoutineSuggestion(issue, {
        payload,
        title: `Repeat "${data.title}"?`,
        summary: cadenceLabel,
        createdByAgentId: actor.agentId,
        sourceRunId: actor.runId,
      });
    },

    /**
     * Create the routine with the task's agent and project, schedule it in the
     * person's time zone, file it under every responsibility the task is
     * under, and record the result on the card.
     */
    async accept(
      issueRef: { id: string; companyId: string },
      interactionId: string,
      input: AcceptRoutineSuggestion,
      actor: { userId: string; runId?: string | null },
    ): Promise<AcceptedRoutineSuggestion> {
      await assertEnabled();
      const issue = await loadIssue(issueRef.id, issueRef.companyId);
      await assertNotPrivate(issue);
      const timezone = await resolveTimeZone(input.timezone, actor.userId);
      const claimed = await interactions.claimRoutineSuggestion(issue, interactionId, "accepted", { userId: actor.userId });
      const claim = claimed.claim!;
      const { payload } = claimed;
      const routineActor = { userId: actor.userId, runId: actor.runId ?? null };
      await prepareTakenOverAccept(issue, interactionId, claim, routineActor);
      let created: Awaited<ReturnType<typeof createScheduledRoutine>>;
      try {
        created = await createScheduledRoutine(issue, {
          title: payload.title,
          description: payload.instructions,
          assigneeAgentId: payload.assigneeAgentId,
          projectId: payload.projectId,
          cadenceLabel: payload.cadenceLabel,
          cronExpression: payload.cronExpression,
          timezone,
        }, routineActor, noteRoutineFor(issue, interactionId, claim.claimId));
      } catch (error) {
        await interactions.releaseRoutineSuggestionClaim(issue, interactionId, claim.claimId);
        throw error;
      }
      let interaction: SuggestRoutineInteraction;
      try {
        interaction = await interactions.recordAcceptedRoutineSuggestion(issue, interactionId, claim.claimId, {
          routineId: created.routine.id,
          routineTitle: created.routine.title,
          cadenceLabel: payload.cadenceLabel,
          timezone,
          responsibilityIds: created.filed.map((entry) => entry.responsibilityId),
        });
      } catch (error) {
        // Only when another accept took the card over is its routine the one that stays.
        if (isAcceptClaimLost(error)) await archiveRoutine(created.routine.id, routineActor);
        throw error;
      }
      return { interaction, ...created };
    },

    /**
     * A person turns a task into a routine (not prompted by an agent): their
     * title, cadence and agent, created exactly as an accepted offer is. The
     * task is left as it is. When the task carries an agent's pending offer,
     * that offer is settled as accepted with this routine, so the
     * conversation shows the routine instead of a stale offer.
     */
    async createFromTask(
      issueRef: { id: string; companyId: string },
      input: CreateRoutineFromTask,
      actor: { userId: string; runId?: string | null },
    ): Promise<RoutineFromTask> {
      await assertEnabled();
      const data = createRoutineFromTaskSchema.parse(input);
      const issue = await loadIssue(issueRef.id, issueRef.companyId);
      if (issue.status === "cancelled") {
        throw conflict("A cancelled task cannot become a routine", { code: "routine_from_task_cancelled" });
      }
      await assertRepeatable(issue);
      const timezone = await resolveTimeZone(data.timezone, actor.userId);
      const cadence: RoutineSuggestionCadence = {
        frequency: data.cadence.frequency,
        dayOfWeek: data.cadence.frequency === "weekly" ? data.cadence.dayOfWeek ?? null : null,
        dayOfMonth: data.cadence.frequency === "monthly" ? data.cadence.dayOfMonth ?? null : null,
        time: data.cadence.time,
      };
      const cadenceLabel = routineSuggestionCadenceLabel(cadence);

      // Settle an open offer on the task with this routine; a held one (task not done) stays as it is.
      let claimedOffer: (SuggestRoutineInteraction & { claim: AcceptClaim | null }) | null = null;
      if (issue.status === "done") {
        const pending = (await interactions.routineSuggestionsForIssues(issue.companyId, [issue.id]))
          .find((offer) => offer.status === "pending");
        if (pending) {
          claimedOffer = await interactions.claimRoutineSuggestion(issue, pending.id, "accepted", { userId: actor.userId })
            .catch((error) => {
              logger.info({ err: error, issueId: issue.id, interactionId: pending.id }, "Left a task's routine offer as it was");
              return null;
            });
        }
      }

      let created: Awaited<ReturnType<typeof createScheduledRoutine>>;
      try {
        created = await createScheduledRoutine(issue, {
          title: data.title,
          description: claimedOffer?.payload.instructions ?? routineDescriptionFromTask(issue),
          assigneeAgentId: data.assigneeAgentId,
          projectId: issue.projectId ?? null,
          cadenceLabel,
          cronExpression: routineSuggestionCronExpression(cadence),
          timezone,
        }, { userId: actor.userId, runId: actor.runId ?? null });
      } catch (error) {
        if (claimedOffer?.claim) await interactions.releaseRoutineSuggestionClaim(issue, claimedOffer.id, claimedOffer.claim.claimId);
        throw error;
      }

      const acceptedOffer = claimedOffer?.claim
        ? await interactions.recordAcceptedRoutineSuggestion(issue, claimedOffer.id, claimedOffer.claim.claimId, {
          routineId: created.routine.id,
          routineTitle: created.routine.title,
          cadenceLabel,
          timezone,
          responsibilityIds: created.filed.map((entry) => entry.responsibilityId),
        })
        : null;
      return { ...created, cadenceLabel, timezone, acceptedOffer };
    },

    /**
     * Which of these tasks can never be one-off work to repeat: a routine
     * created it, or it is the onboarding task or a bar conversation (or
     * under one of those). One query, whatever the count.
     */
    async unrepeatableIssueIds(companyId: string, issueIds: readonly string[]): Promise<Set<string>> {
      if (issueIds.length === 0) return new Set();
      const kinds = [...RESPONSIBILITY_AUTOMATION_EXCLUDED_ORIGIN_KINDS];
      const rows = await db.execute<{ start_id: string }>(sql`
        with recursive lineage(start_id, parent_id, origin_kind, depth) as (
          select i.id, i.parent_id, i.origin_kind, 0
          from ${issues} i
          where i.company_id = ${companyId}
            and i.id::text in (select value from jsonb_array_elements_text(${JSON.stringify([...new Set(issueIds)])}::jsonb))
          union all
          select l.start_id, p.parent_id, p.origin_kind, l.depth + 1
          from lineage l
          join ${issues} p on p.id = l.parent_id and p.company_id = ${companyId}
          where l.depth < ${MAX_LINEAGE_DEPTH}
        )
        select distinct start_id from lineage
        where origin_kind in (select value from jsonb_array_elements_text(${JSON.stringify(kinds)}::jsonb))
      `);
      return new Set([...rows].map((row) => String(row.start_id)));
    },

    /** Declining is quiet and final: the task never shows another offer. */
    async decline(
      issueRef: { id: string; companyId: string },
      interactionId: string,
      actor: { userId: string },
    ): Promise<SuggestRoutineInteraction> {
      await assertEnabled();
      const issue = await loadIssue(issueRef.id, issueRef.companyId);
      return interactions.claimRoutineSuggestion(issue, interactionId, "declined", { userId: actor.userId });
    },
  };
}
