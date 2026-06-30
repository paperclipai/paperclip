import { z } from "zod";
import { WORKFLOW_INVOCATION_CONTRACT_VERSION } from "../constants.js";

export const workflowInvocationContractVersionSchema = z.literal(WORKFLOW_INVOCATION_CONTRACT_VERSION);

export const workflowInvocationMarkdownPayloadSchema = z.object({
  kind: z.literal("markdown"),
  inputMarkdown: z.string().trim().min(1).max(200_000),
});

export const workflowInvocationJsonPayloadSchema = z.object({
  kind: z.literal("json"),
  inputJson: z.record(z.unknown()),
});

export const workflowInvocationPayloadSchema = z.discriminatedUnion("kind", [
  workflowInvocationMarkdownPayloadSchema,
  workflowInvocationJsonPayloadSchema,
]);

export const workflowInvocationTargetSelectorSchema = z.object({
  workflowId: z.string().uuid().optional().nullable(),
  workflowKey: z.string().trim().min(1).max(200).optional().nullable(),
  capability: z.string().trim().min(1).max(200).optional().nullable(),
}).refine((value) => Boolean(value.workflowId || value.workflowKey || value.capability), {
  message: "Select a workflow id, workflow key, or capability.",
});

export const workflowInvocationEnvelopeSchema = z.object({
  contractVersion: workflowInvocationContractVersionSchema,
  target: workflowInvocationTargetSelectorSchema,
  payload: workflowInvocationPayloadSchema,
});

export type WorkflowInvocationContractVersion = z.infer<typeof workflowInvocationContractVersionSchema>;
export type WorkflowInvocationMarkdownPayload = z.infer<typeof workflowInvocationMarkdownPayloadSchema>;
export type WorkflowInvocationJsonPayload = z.infer<typeof workflowInvocationJsonPayloadSchema>;
export type WorkflowInvocationPayload = z.infer<typeof workflowInvocationPayloadSchema>;
export type WorkflowInvocationTargetSelector = z.infer<typeof workflowInvocationTargetSelectorSchema>;
export type WorkflowInvocationEnvelope = z.infer<typeof workflowInvocationEnvelopeSchema>;

export const routineWorkflowInvocationRequestSchema = z.object({
  sourceRoutineRunId: z.string().uuid(),
  invocation: workflowInvocationEnvelopeSchema,
});

export type RoutineWorkflowInvocationRequest = z.infer<typeof routineWorkflowInvocationRequestSchema>;
