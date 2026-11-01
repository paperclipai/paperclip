import { createHash } from "node:crypto";
import { z } from "zod";
import { createWorkflowSchema, updateWorkflowSchema, listWorkflowsSchema, readWorkflowQuerySchema } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { forbidden, badRequest } from "../../errors.js";
import { requireCasesEnabled } from "../workflows.js";
import { runnerApiCallSchema, type RunnerApiCall } from "./runner-api-client.js";

const retryKey = z.string().min(1).max(240);
const workflowId = z.string().guid();
const schemas = {
  list_workflows: listWorkflowsSchema,
  read_workflow: readWorkflowQuerySchema.extend({ workflowId, responseText: runnerApiCallSchema.shape.responseText })
    .refine(input => !input.responseText?.offsetBytes || Boolean(input.snapshot), "Continuation pages require the snapshot returned by the first read"),
  create_workflow: createWorkflowSchema.extend({ idempotencyKey: retryKey }),
  update_workflow: updateWorkflowSchema.safeExtend({ workflowId, idempotencyKey: retryKey }),
};

export async function executeNativeWorkflowTool(input: {
  db: Db; binding: { companyId: string; casesEnabled?: boolean }; tool: string; arguments: unknown;
  callApi: (receiptKey: string, request: RunnerApiCall) => Promise<unknown>;
}) {
  if (input.binding.casesEnabled !== true) throw forbidden("Cases are disabled");
  await requireCasesEnabled(input.db);
  const schema = schemas[input.tool as keyof typeof schemas];
  if (!schema) throw badRequest("Unknown workflow operation");
  const parsed = schema.safeParse(input.arguments);
  if (!parsed.success) throw badRequest("Invalid workflow arguments", { issues: parsed.error.issues });
  const { workflowId: id, idempotencyKey, responseText, ...body } = parsed.data as {
    workflowId?: string; idempotencyKey?: string; responseText?: RunnerApiCall["responseText"];
  } & Record<string, unknown>;
  const method = input.tool === "create_workflow" ? "POST" : input.tool === "update_workflow" ? "PATCH" : "GET";
  const request: RunnerApiCall = {
    operationId: `${method} /api/${id ? "workflows/{id}" : "companies/{companyId}/workflows"}`,
    pathParams: id ? { id } : { companyId: input.binding.companyId },
    ...(method === "GET" ? { query: body } : { body }),
    ...(input.tool === "read_workflow" ? { responseText: responseText ?? { offsetBytes: 0 } } : {}),
  };
  const key = idempotencyKey ?? createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const result = await input.callApi(`workflow-tool:${input.tool}:${key}`, request);
  if (input.tool !== "read_workflow" || !result || typeof result !== "object") return result;
  const etag = "etag" in result && typeof result.etag === "string" ? result.etag : "";
  const snapshot = /^(?:W\/)?"([a-f0-9]{64})"$/.exec(etag)?.[1];
  return { ...result, ...(snapshot ? { snapshot } : {}), guidance: "Concatenate data JSON text pages using read_workflow with the same workflowId, returned snapshot, and responseText.offsetBytes=responseText.nextOffsetBytes until null. A 409 conflict requires restarting at offset zero without snapshot. Adoption captures the latest prompt at handoff acceptance." };
}
