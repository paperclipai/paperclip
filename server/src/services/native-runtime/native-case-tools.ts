import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { cases, type Db } from "@paperclipai/db";
import { z } from "zod";
import { caseInitialDocumentsSchema, caseWorkflowDocumentTextSchema, isUuidLike } from "@paperclipai/shared";
import { patchCaseSchema } from "../../routes/cases-schemas.js";
import { badRequest, forbidden, notFound } from "../../errors.js";
import { assertActorCanReadCase } from "../case-access.js";
import type { AuthorizationActor } from "../authorization.js";
import { instanceSettingsService } from "../instance-settings.js";
import { caseReadPageShape, refineCaseReadPage } from "../case-agent-read.js";
import type { RunnerApiCall } from "./runner-api-client.js";

export const NATIVE_CASE_OPERATIONS = new Set([
  "create_case", "read_case", "update_case", "list_workflows", "read_workflow", "create_workflow", "update_workflow",
]);

/** Retain the case boundary on generic HTTP response captures too. Shared
 * pipeline routes deliberately do not establish a standalone-case identity. */
export async function caseIdForApiCapture(db: Db, companyId: string, path: string, pathParams?: Record<string, string>) {
  const parameter = /^\/api\/cases\/\{([^}]+)\}(?:\/|$)/.exec(path)?.[1];
  const identity = parameter ? pathParams?.[parameter] : undefined;
  if (!identity) return undefined;
  const [record] = await db.select({ id: cases.id }).from(cases).where(and(eq(cases.companyId, companyId),
    isUuidLike(identity) ? eq(cases.id, identity) : eq(cases.identifier, identity.trim().toUpperCase()),
  )).limit(1);
  return record?.id;
}

const identity = z.object({ caseId: z.string().guid().optional() }).strict();
const retryKey = z.string().min(1).max(240);
export const createNativeCaseSchema = z.object({
  idempotencyKey: retryKey, caseType: z.string().trim().min(1).max(120), title: z.string().trim().min(1).max(500),
  summary: z.string().max(8000).optional(), fields: z.record(z.string(), z.unknown()).optional(),
  projectId: z.string().guid().nullable().optional(),
  workflow_document_text: caseWorkflowDocumentTextSchema.optional(),
  workflowId: z.string().guid().optional(),
  kickoff: z.object({ toAgentId: z.string().guid(), phase: z.string().trim().min(1).max(120), instructions: z.string().min(1).max(20000) }).strict(),
  initialDocuments: caseInitialDocumentsSchema.optional(),
}).strict().refine(input => Boolean(input.workflowId) !== (input.workflow_document_text !== undefined), "Provide workflowId or workflow_document_text, not both");

const schemas = {
  read_case: identity.extend(caseReadPageShape).superRefine(refineCaseReadPage),
  update_case: patchCaseSchema.pick({ title: true, summary: true, fields: true })
    .extend({ caseId: z.string().guid().optional(), idempotencyKey: retryKey })
    .strict().refine(input => ["title", "summary", "fields"].some(key => Object.hasOwn(input, key)),
      "Provide at least one of title, summary, or fields"),
};

/** A narrow transport over the real case routes, including their privacy, trust,
 * mutation fences, retained sources and audit. Never resolves pipeline cases. */
export async function executeNativeCaseTool(input: {
  db: Db;
  binding: { companyId: string; issueId: string; casesEnabled?: boolean };
  actor: AuthorizationActor;
  tool: string;
  arguments: unknown;
  callApi: (receiptKey: string, request: RunnerApiCall) => Promise<unknown>;
}) {
  if (input.binding.casesEnabled !== true || !(await instanceSettingsService(input.db).getExperimental()).enableCases) {
    throw forbidden("Cases are disabled");
  }
  const schema = schemas[input.tool as keyof typeof schemas];
  if (!schema) throw badRequest("Unknown native case operation");
  const parsed = schema.safeParse(input.arguments);
  if (!parsed.success) throw badRequest("Invalid case tool arguments", { issues: parsed.error.issues });
  const values = parsed.data as { caseId?: string; idempotencyKey?: string } & Record<string, unknown>;
  const [caseRow] = await input.db.select({ id: cases.id, companyId: cases.companyId }).from(cases).where(and(
    eq(cases.companyId, input.binding.companyId), values.caseId ? eq(cases.id, values.caseId) : eq(cases.workIssueId, input.binding.issueId),
  )).limit(1);
  if (!caseRow) throw notFound("Case not found");
  await assertActorCanReadCase(input.db, input.actor, caseRow);
  const { caseId: _caseId, idempotencyKey, ...body } = values;
  const mutation = input.tool === "update_case";
  const method = mutation ? "PATCH" : "GET";
  const requestKey = idempotencyKey ?? createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const result = await input.callApi(`case-tool:${input.tool}:${requestKey}`, {
    operationId: `${method} /api/cases/{id}`, pathParams: { id: caseRow.id },
    query: { includeDocumentBodies: false, ...(!mutation ? { agentRead: true, ...body } : {}) }, ...(mutation ? { body } : {}),
  });
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const { operationId, ...response } = result as Record<string, unknown>;
  return { ...response, apiOperationId: operationId };
}
