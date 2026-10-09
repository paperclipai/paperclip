import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { routines, routineTriggers, type Db } from "@paperclipai/db";
import { createRoutineSchema, updateRoutineSchema, createRoutineTriggerSchema, updateRoutineTriggerSchema } from "@paperclipai/shared";
import { routineService } from "../routines.js";
import { documentAnnotationService } from "../document-annotations.js";
import { persistActivity } from "../activity-log.js";
import { conflict, forbidden, notFound } from "../../errors.js";

export const manageRoutineInputSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(240),
  action: z.enum(["create", "update", "pause", "resume"]),
  routineId: z.string().uuid().optional(),
  baseRevisionId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(200_000).optional(),
  projectId: z.string().uuid().optional(),
  schedule: z.object({
    triggerId: z.string().uuid().optional(),
    cronExpression: z.string().trim().min(1).max(240),
    timezone: z.string().trim().min(1).max(120),
  }).strict().optional(),
}).strict().superRefine((input, ctx) => {
  const error = (message: string) => ctx.addIssue({ code: "custom", message });
  if (input.action === "create") {
    if (!input.title || !input.schedule || input.routineId || input.baseRevisionId || input.schedule.triggerId) error("Create requires a title and schedule, without existing routine or trigger identity");
  } else {
    if (!input.routineId || !input.baseRevisionId) error("Read the routine first; routineId and baseRevisionId are required");
    if (["pause", "resume"].includes(input.action) && [input.title, input.description, input.projectId, input.schedule].some(value => value !== undefined)) error("Pause and resume accept only the routine identity and revision");
    if (input.schedule && !input.schedule.triggerId) error("Read the existing schedule first; triggerId is required when updating it");
  }
});
type Binding = { companyId: string; agentId: string; issueId: string; runId: string };

export async function lockOwnedRoutine(db: Db, binding: Binding, id: string) {
  // Execution authorization already holds the agent and issue locks. A firing
  // holds the routine while assigning its issue and waking the agent, so waiting
  // here would form a cycle. Reject contention and roll back the receipt before
  // the agent retries; this also covers saved create receipts.
  let routine: typeof routines.$inferSelect | undefined;
  try {
    [routine] = await db.select().from(routines).where(and(eq(routines.id, id), eq(routines.companyId, binding.companyId))).for("update", { noWait: true });
  } catch (error) {
    const failure = error as { code?: string; cause?: { code?: string } } | null;
    if (failure?.code === "55P03" || failure?.cause?.code === "55P03") {
      throw conflict("Routine is busy. Retry the same request after the current firing or edit finishes.", { code: "routine_busy", retryable: true });
    }
    throw error;
  }
  if (!routine) throw notFound("Routine not found");
  if (routine.assigneeAgentId !== binding.agentId) throw forbidden("Agents can only manage routines assigned to themselves");
  return routine;
}

/** Called inside the authority's run-bound idempotency/authorization transaction. */
export async function manageRoutine(db: Db, binding: Binding, input: z.infer<typeof manageRoutineInputSchema>) {
  const service = routineService(db);
  const actor = { agentId: binding.agentId, runId: binding.runId };
  const publications: Awaited<ReturnType<typeof persistActivity>>["publication"][] = [];
  const log = async (action: string, entityType: string, entityId: string, details: Record<string, unknown>) => {
    const { publication } = await persistActivity(db, { companyId: binding.companyId, actorType: "agent", actorId: binding.agentId,
      agentId: binding.agentId, runId: binding.runId, issueId: binding.issueId, action, entityType, entityId,
      details: { ...details, source: "manage_routine" } });
    publications.push(publication);
  };
  const logRevision = async (routineId: string, revision: { id: string; revisionNumber: number; changeSummary: string | null; snapshot: { triggers: unknown[] } }) =>
    log("routine.revision_created", "routine", routineId, { revisionId: revision.id, revisionNumber: revision.revisionNumber,
      changeSummary: revision.changeSummary, triggerCount: revision.snapshot.triggers.length });
  let routine;
  if (input.action === "create") {
    routine = await service.create(binding.companyId, createRoutineSchema.parse({
      title: input.title, description: input.description, projectId: input.projectId,
      assigneeAgentId: binding.agentId, parentIssueId: binding.issueId,
    }), actor);
    await log("routine.revision_created", "routine", routine.id, { revisionId: routine.latestRevisionId,
      revisionNumber: routine.latestRevisionNumber, changeSummary: "Created routine", triggerCount: 0 });
    const created = await service.createTrigger(routine.id, createRoutineTriggerSchema.parse({ kind: "schedule", ...input.schedule }), actor);
    await log("routine.trigger_created", "routine_trigger", created.trigger.id, { routineId: routine.id, kind: "schedule" });
    await logRevision(routine.id, created.revision);
  } else {
    const existing = await lockOwnedRoutine(db, binding, input.routineId!);
    routine = await service.update(existing.id, updateRoutineSchema.parse({
      baseRevisionId: input.baseRevisionId,
      ...(input.action === "pause" ? { status: "paused" } : input.action === "resume" ? { status: "active" } : {
        title: input.title, description: input.description, projectId: input.projectId,
      }),
    }), actor);
    if (routine && routine.latestRevisionId !== existing.latestRevisionId) {
      await log("routine.revision_created", "routine", routine.id, { revisionId: routine.latestRevisionId,
        revisionNumber: routine.latestRevisionNumber, changeSummary: "Updated routine", triggerCount: null });
      if (input.description !== undefined) {
        const doc = await service.getDescriptionDocument(routine.id);
        if (doc) {
          const remapped = await documentAnnotationService(db).remapOpenThreadsForRoutineDocument({
            routineId: routine.id, key: doc.key, documentId: doc.id,
            nextRevisionId: doc.latestRevisionId, nextRevisionNumber: doc.latestRevisionNumber, nextBody: doc.body,
          });
          for (const remap of remapped) {
            await log("routine.document_annotation_remapped", "routine", routine.id, {
              key: doc.key, documentKey: doc.key, documentId: doc.id, threadId: remap.thread.id,
              revisionNumber: doc.latestRevisionNumber, anchorState: remap.thread.anchorState,
              anchorConfidence: remap.thread.anchorConfidence, snapshotId: remap.snapshot.id,
            });
          }
        }
      }
    }
    if (input.schedule) {
      const [trigger] = await db.select().from(routineTriggers).where(and(
        eq(routineTriggers.id, input.schedule.triggerId!), eq(routineTriggers.routineId, existing.id), eq(routineTriggers.companyId, binding.companyId),
      )).for("update");
      if (!trigger || trigger.kind !== "schedule" || trigger.archived) throw notFound("Routine schedule not found");
      const updated = await service.updateTrigger(trigger.id, updateRoutineTriggerSchema.parse({ cronExpression: input.schedule.cronExpression, timezone: input.schedule.timezone }), actor);
      if (!updated) throw notFound("Routine schedule not found");
      await log("routine.trigger_updated", "routine", existing.id, { triggerId: trigger.id, kind: "schedule" });
      await logRevision(existing.id, updated.revision);
    }
  }
  if (!routine) throw notFound("Routine not found");
  const current = await service.getDetail(routine.id);
  if (!current) throw notFound("Routine not found");
  await log(input.action === "create" ? "routine.created" : "routine.updated", "routine", current.id,
    { title: current.title, operation: input.action, revisionId: current.latestRevisionId });
  return { publications, result: {
    routineId: current.id, title: current.title, status: current.status,
    baseRevisionId: current.latestRevisionId, assigneeAgentId: current.assigneeAgentId,
    schedules: current.triggers.filter(trigger => trigger.kind === "schedule").map(trigger => ({
      triggerId: trigger.id, cronExpression: trigger.cronExpression, timezone: trigger.timezone, enabled: trigger.enabled, nextRunAt: trigger.nextRunAt,
    })),
  } };
}
