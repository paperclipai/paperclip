import { z } from "zod";
import { issueDocumentKeySchema, upsertIssueDocumentSchema } from "./validators/issue.js";

/** Preserve the author's workflow text; blank text cannot define a workflow. */
export const caseWorkflowDocumentTextSchema = z.string().min(1).max(200_000).regex(/\S/, "Workflow document text must not be blank")
  .describe("Workflow Markdown. Recommend both a fenced Mermaid stateDiagram-v2 map and prose explaining every transition: its trigger or condition, required evidence or outputs, destination agent, human wait/resume rules, and bounded correction or escalation behavior. Match diagram state IDs to phase names and define named transition outcomes in prose. Stored verbatim as the task's workflow document; diagram labels are advisory, not executable guards.");

/** Kickoff inputs become ordinary documents on the newly created primary task. */
export const caseInitialDocumentSchema = z.object({
  key: z.preprocess((value) => typeof value === "string" ? value.trim().toLowerCase() : value, issueDocumentKeySchema
    .refine(key => key !== "workflow", "The workflow document key is reserved; use workflow_document_text")),
  title: z.string().trim().min(1).max(200),
  body: upsertIssueDocumentSchema.shape.body,
}).strict();
export const caseInitialDocumentsSchema = z.array(caseInitialDocumentSchema).max(20).superRefine((documents, ctx) => {
  const keys = new Set<string>();
  let bodyCharacters = 0;
  for (const [index, document] of documents.entries()) {
    if (keys.has(document.key)) ctx.addIssue({ code: "custom", path: [index, "key"], message: "Document keys must be unique after normalization" });
    keys.add(document.key);
    bodyCharacters += document.body.length;
  }
  if (bodyCharacters > 200_000) ctx.addIssue({ code: "custom", message: "Initial document bodies must total at most 200000 characters" });
});
export type CaseInitialDocument = z.infer<typeof caseInitialDocumentSchema>;

export const CASE_HANDOFF_STATES = ["awaiting_release", "pending_dispatch", "delivered", "awaiting_completion", "completed", "cancelled"] as const;
export type CaseHandoffState = typeof CASE_HANDOFF_STATES[number];
export type CaseHandoffDestinationKind = "agent" | "done";

export const agentCaseHandoffSchema = z.object({
  to: z.never().optional(),
  idempotencyKey: z.string().trim().min(1).max(240),
  case: z.union([
    z.object({ id: z.string().guid() }).strict(),
    z.object({ create: z.object({
      caseType: z.string().trim().min(1).max(120),
      title: z.string().trim().min(1).max(500),
      summary: z.string().max(8_000).optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
      projectId: z.string().guid().nullable().optional(),
    }).strict() }).strict(),
  ]),
  toAgentId: z.string().guid(),
  phase: z.string().trim().min(1).max(120),
  instructions: z.string().min(1).max(20_000),
  expectedHandoffVersion: z.number().int().nonnegative().optional(),
  expectedIssueStatusVersion: z.number().int().nonnegative().optional(),
  bindIssueId: z.string().guid().optional(),
  initialDocuments: caseInitialDocumentsSchema.optional(),
  workflow_document_text: caseWorkflowDocumentTextSchema.optional(),
  workflowId: z.string().guid().nullable().optional(),
}).strict().superRefine((input, ctx) => {
  if ("id" in input.case && input.expectedHandoffVersion === undefined) {
    ctx.addIssue({ code: "custom", path: ["expectedHandoffVersion"], message: "Required for an existing case" });
  }
  if (input.bindIssueId && input.expectedIssueStatusVersion === undefined) {
    ctx.addIssue({ code: "custom", path: ["expectedIssueStatusVersion"], message: "Required when binding an existing task" });
  }
  if (input.bindIssueId && input.initialDocuments?.length) {
    ctx.addIssue({ code: "custom", path: ["initialDocuments"], message: "Initial documents require a newly created primary task" });
  }
  if (input.workflowId !== undefined && input.workflow_document_text !== undefined) {
    ctx.addIssue({ code: "custom", path: ["workflowId"], message: "Provide workflowId or workflow_document_text, not both" });
  }
  if ("create" in input.case && input.workflow_document_text === undefined && !input.workflowId) {
    ctx.addIssue({ code: "custom", path: ["workflow_document_text"], message: "Required when creating a case" });
  }
  if ("id" in input.case && input.bindIssueId && input.workflow_document_text !== undefined) {
    ctx.addIssue({ code: "custom", path: ["workflow_document_text"], message: "Workflow text cannot be supplied when binding an existing case to a task" });
  }
  const totalBodyCharacters = (input.workflow_document_text?.length ?? 0)
    + (input.initialDocuments ?? []).reduce((total, document) => total + document.body.length, 0);
  if (totalBodyCharacters > 200_000) {
    ctx.addIssue({ code: "custom", path: ["initialDocuments"], message: "Workflow and initial document bodies must total at most 200000 characters" });
  }
});
export const doneCaseHandoffSchema = z.object({
  to: z.literal("done"),
  idempotencyKey: z.string().trim().min(1).max(240),
  case: z.object({ id: z.string().guid() }).strict(),
  phase: z.literal("done").default("done"),
  instructions: z.string().min(1).max(20_000),
  expectedHandoffVersion: z.number().int().nonnegative(),
  expectedIssueStatusVersion: z.number().int().nonnegative(),
}).strict();
export const handoffCaseSchema = z.union([agentCaseHandoffSchema, doneCaseHandoffSchema]);
export type AgentCaseHandoffInput = z.infer<typeof agentCaseHandoffSchema>;
export type DoneCaseHandoffInput = z.infer<typeof doneCaseHandoffSchema>;
export type HandoffCaseInput = z.input<typeof handoffCaseSchema>;
export type HandoffCaseResult = {
  handoffId: string;
  caseId: string;
  taskId: string;
  taskIdentifier: string;
  handoffVersion: number;
  destinationKind: CaseHandoffDestinationKind;
  state: CaseHandoffState;
  completedAt: Date | string | null;
  callerMustYield: boolean;
  replayed: boolean;
};
export interface CaseHandoff {
  workflowTransition: CaseWorkflowTransition | null;
  id: string;
  companyId: string;
  caseId: string;
  issueId: string;
  version: number;
  fromAgentId: string | null;
  destinationKind: CaseHandoffDestinationKind;
  toAgentId: string | null;
  phase: string;
  instructions: string;
  commentId: string | null;
  actorType: "agent" | "user" | "system";
  actorId: string;
  sourceRunId: string | null;
  responsibleUserId: string | null;
  expectedIssueStatusVersion: number | null;
  appliedIssueStatusVersion: number | null;
  wakeupRequestId: string;
  idempotencyKey: string;
  inputFingerprint: string;
  state: CaseHandoffState;
  attemptCount: number;
  nextAttemptAt: Date | string;
  leaseExpiresAt: Date | string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  createdAt: Date | string;
  assignmentAppliedAt: Date | string | null;
  deliveredAt: Date | string | null;
  completedAt: Date | string | null;
  cancelledAt: Date | string | null;
  updatedAt: Date | string;
}

export interface CaseWorkflowTransition {
  from: { workflowId: string | null; name: string | null; phase: string | null };
  to: { workflowId: string | null; name: string | null; phase: string };
  documentRevisionId: string | null;
}
