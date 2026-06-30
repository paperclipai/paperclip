import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { routineRuns, routines, workflowInvocations } from "@paperclipai/db";
import type {
  WorkflowInvocationEnvelope,
  WorkflowInvocationResult,
  WorkflowRunInvocationSummary,
} from "@paperclipai/shared";
import { WORKFLOW_INVOCATION_CONTRACT_VERSION } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { workflowService, resolveWorkflowByInvocationTarget } from "./workflows.js";

function toInvocationMarkdown(envelope: WorkflowInvocationEnvelope) {
  if (envelope.payload.kind === "markdown") {
    return envelope.payload.inputMarkdown;
  }
  const targetBits = [
    envelope.target.workflowId ? `workflowId: ${envelope.target.workflowId}` : null,
    envelope.target.workflowKey ? `workflowKey: ${envelope.target.workflowKey}` : null,
    envelope.target.capability ? `capability: ${envelope.target.capability}` : null,
  ].filter((value): value is string => Boolean(value));
  return [
    "# Routine workflow invocation",
    "",
    `Contract: ${envelope.contractVersion}`,
    targetBits.length > 0 ? `Target: ${targetBits.join(", ")}` : null,
    "",
    "Structured JSON payload:",
    "```json",
    JSON.stringify(envelope.payload.inputJson, null, 2),
    "```",
    "",
  ].filter((line): line is string => line !== null).join("\n");
}

function toInvocationSummary(
  row: {
    id: string;
    contractVersion: string;
    inputKind: string;
    sourceRoutineId: string;
    sourceRoutineRunId: string;
    sourceRoutineTitle: string | null;
    sourceRoutineRunSource: string | null;
    targetWorkflowId: string;
    targetWorkflowKey: string | null;
    targetCapability: string | null;
  },
): WorkflowRunInvocationSummary {
  return {
    id: row.id,
    contractVersion: row.contractVersion as WorkflowRunInvocationSummary["contractVersion"],
    inputKind: row.inputKind as WorkflowRunInvocationSummary["inputKind"],
    sourceRoutineId: row.sourceRoutineId,
    sourceRoutineTitle: row.sourceRoutineTitle,
    sourceRoutineRunId: row.sourceRoutineRunId,
    sourceRoutineRunSource: row.sourceRoutineRunSource,
    targetWorkflowId: row.targetWorkflowId,
    targetWorkflowKey: row.targetWorkflowKey,
    targetCapability: row.targetCapability,
  };
}

export function workflowInvocationService(db: Db) {
  const workflowSvc = workflowService(db);

  return {
    invokeFromRoutine: async (input: {
      routineId: string;
      sourceRoutineRunId: string;
      envelope: WorkflowInvocationEnvelope;
    }): Promise<WorkflowInvocationResult> => {
      if (input.envelope.contractVersion !== WORKFLOW_INVOCATION_CONTRACT_VERSION) {
        throw unprocessable(`Unsupported workflow invocation contract: ${input.envelope.contractVersion}`);
      }

      const routineRow = await db
        .select()
        .from(routines)
        .where(eq(routines.id, input.routineId))
        .then((rows) => rows[0] ?? null);
      if (!routineRow) throw notFound("Routine not found");

      const sourceRunRow = await db
        .select()
        .from(routineRuns)
        .where(and(
          eq(routineRuns.id, input.sourceRoutineRunId),
          eq(routineRuns.routineId, routineRow.id),
          eq(routineRuns.companyId, routineRow.companyId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!sourceRunRow) {
        throw unprocessable("Source routine run does not belong to this routine");
      }

      const workflowRow = await resolveWorkflowByInvocationTarget(db, routineRow.companyId, input.envelope.target);
      const inputMarkdown = toInvocationMarkdown(input.envelope);
      const inputJson = input.envelope.payload.kind === "json" ? input.envelope.payload.inputJson : null;

      const invocationRow = await db.insert(workflowInvocations).values({
        companyId: routineRow.companyId,
        sourceRoutineId: routineRow.id,
        sourceRoutineRunId: sourceRunRow.id,
        targetWorkflowId: workflowRow.id,
        targetWorkflowKey: workflowRow.workflowKey ?? null,
        targetCapability: input.envelope.target.capability ?? null,
        contractVersion: input.envelope.contractVersion,
        inputKind: input.envelope.payload.kind,
        inputMarkdown,
        inputJson,
        status: "queued",
      }).returning().then((rows) => rows[0] ?? null);
      if (!invocationRow) {
        throw unprocessable("Failed to create workflow invocation");
      }

      try {
        const run = await workflowSvc.runInvocation(workflowRow.id, {
          inputMarkdown,
          invocation: toInvocationSummary({
            id: invocationRow.id,
            contractVersion: input.envelope.contractVersion,
            inputKind: input.envelope.payload.kind,
            sourceRoutineId: routineRow.id,
            sourceRoutineRunId: sourceRunRow.id,
            sourceRoutineTitle: routineRow.title,
            sourceRoutineRunSource: sourceRunRow.source,
            targetWorkflowId: workflowRow.id,
            targetWorkflowKey: workflowRow.workflowKey ?? null,
            targetCapability: input.envelope.target.capability ?? null,
          }),
          invocationInputJson: inputJson,
        });
        await db.update(workflowInvocations).set({
          workflowRunId: run.id,
          status: "linked",
          updatedAt: new Date(),
        }).where(eq(workflowInvocations.id, invocationRow.id));
        return {
          id: invocationRow.id,
          companyId: routineRow.companyId,
          sourceRoutineId: routineRow.id,
          sourceRoutineRunId: sourceRunRow.id,
          targetWorkflowId: workflowRow.id,
          targetWorkflowKey: workflowRow.workflowKey ?? null,
          targetCapability: input.envelope.target.capability ?? null,
          contractVersion: input.envelope.contractVersion,
          inputKind: input.envelope.payload.kind,
          inputMarkdown,
          inputJson,
          workflowRunId: run.id,
          status: "linked",
          failureReason: null,
          createdAt: invocationRow.createdAt,
          updatedAt: new Date(),
        };
      } catch (error) {
        await db.update(workflowInvocations).set({
          status: "failed",
          failureReason: error instanceof Error ? error.message : String(error),
          updatedAt: new Date(),
        }).where(eq(workflowInvocations.id, invocationRow.id));
        throw error;
      }
    },
  };
}
