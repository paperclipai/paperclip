import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  // Agent
  createAgentSchema,
  createAgentHireSchema,
  updateAgentSchema,
  updateAgentPermissionsSchema,
  updateAgentInstructionsPathSchema,
  updateAgentInstructionsBundleSchema,
  upsertAgentInstructionsFileSchema,
  createAgentKeySchema,
  wakeAgentSchema,
  resetAgentSessionSchema,
  // Issue
  createIssueSchema,
  updateIssueSchema,
  createIssueLabelSchema,
  addIssueCommentSchema,
  checkoutIssueSchema,
  linkIssueApprovalSchema,
  createIssueWorkProductSchema,
  updateIssueWorkProductSchema,
  upsertIssueDocumentSchema,
  restoreIssueDocumentRevisionSchema,
  upsertIssueFeedbackVoteSchema,
  // Project
  createProjectSchema,
  updateProjectSchema,
  createProjectWorkspaceSchema,
  // Company
  createCompanySchema,
  updateCompanyBrandingSchema,
  // Routine
  createRoutineSchema,
  updateRoutineSchema,
  createRoutineTriggerSchema,
  updateRoutineTriggerSchema,
  runRoutineSchema,
  // Goal
  createGoalSchema,
  updateGoalSchema,
  // Secret
  createSecretSchema,
  updateSecretSchema,
  rotateSecretSchema,
  // Approval
  createApprovalSchema,
  resolveApprovalSchema,
  requestApprovalRevisionSchema,
  resubmitApprovalSchema,
  addApprovalCommentSchema,
  // Cost / budget
  createCostEventSchema,
  createFinanceEventSchema,
  updateBudgetSchema,
  // Sidebar
  upsertSidebarOrderPreferenceSchema,
} from "@paperclipai/shared";

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

// ─── Common schemas ──────────────────────────────────────────────────────────

const ErrorSchema = registry.register(
  "Error",
  z.object({ error: z.string() }).openapi("Error"),
);

const responses = {
  ok: (schema: z.ZodTypeAny = z.record(z.unknown())) => ({
    description: "Success",
    content: { "application/json": { schema } },
  }),
  noContent: { description: "No content" },
  badRequest: {
    description: "Bad request",
    content: { "application/json": { schema: ErrorSchema } },
  },
  unauthorized: {
    description: "Unauthorized",
    content: { "application/json": { schema: ErrorSchema } },
  },
  forbidden: {
    description: "Forbidden",
    content: { "application/json": { schema: ErrorSchema } },
  },
  notFound: {
    description: "Not found",
    content: { "application/json": { schema: ErrorSchema } },
  },
  serverError: {
    description: "Internal server error",
    content: { "application/json": { schema: ErrorSchema } },
  },
};

const jsonBody = (schema: z.ZodTypeAny) => ({
  content: { "application/json": { schema } },
  required: true as const,
});

const r = responses;

// ─── Health ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/health",
  tags: ["health"],
  summary: "Health check",
  responses: {
    200: r.ok(z.object({
      status: z.enum(["ok", "unhealthy"]),
      version: z.string().optional(),
      deploymentMode: z.string().optional(),
      bootstrapStatus: z.enum(["ready", "bootstrap_pending"]).optional(),
      bootstrapInviteActive: z.boolean().optional(),
    })),
    503: { description: "Service unavailable", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ─── Companies ───────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies",
  tags: ["companies"],
  summary: "List companies",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies",
  tags: ["companies"],
  summary: "Create a company",
  request: { body: jsonBody(createCompanySchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/stats",
  tags: ["companies"],
  summary: "Company stats",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}",
  tags: ["companies"],
  summary: "Get a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}",
  tags: ["companies"],
  summary: "Update a company",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(z.record(z.unknown())),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/branding",
  tags: ["companies"],
  summary: "Update company branding",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(updateCompanyBrandingSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/archive",
  tags: ["companies"],
  summary: "Archive a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}",
  tags: ["companies"],
  summary: "Delete a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/feedback-traces",
  tags: ["companies"],
  summary: "List company feedback traces",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/exports",
  tags: ["companies"],
  summary: "Export company data",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/exports/preview",
  tags: ["companies"],
  summary: "Preview company export",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/imports/preview",
  tags: ["companies"],
  summary: "Preview company import",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/imports/apply",
  tags: ["companies"],
  summary: "Apply company import",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Agents ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/agents",
  tags: ["agents"],
  summary: "List agents in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/agents",
  tags: ["agents"],
  summary: "Create an agent",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createAgentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/agent-hires",
  tags: ["agents"],
  summary: "Hire an agent",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createAgentHireSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/agent-configurations",
  tags: ["agents"],
  summary: "List agent configurations for a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/org",
  tags: ["agents"],
  summary: "Get org chart data",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/me",
  tags: ["agents"],
  summary: "Get the current agent",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/me/inbox-lite",
  tags: ["agents"],
  summary: "Get current agent inbox (lite)",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/me/inbox/mine",
  tags: ["agents"],
  summary: "Get current agent assigned inbox items",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}",
  tags: ["agents"],
  summary: "Get an agent",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/agents/{id}",
  tags: ["agents"],
  summary: "Update an agent",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateAgentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/agents/{id}",
  tags: ["agents"],
  summary: "Delete an agent",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/agents/{id}/permissions",
  tags: ["agents"],
  summary: "Update agent permissions",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateAgentPermissionsSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/agents/{id}/instructions-path",
  tags: ["agents"],
  summary: "Update agent instructions path",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateAgentInstructionsPathSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/instructions-bundle",
  tags: ["agents"],
  summary: "Get agent instructions bundle",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/agents/{id}/instructions-bundle",
  tags: ["agents"],
  summary: "Update agent instructions bundle",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateAgentInstructionsBundleSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/instructions-bundle/file",
  tags: ["agents"],
  summary: "Get agent instructions file",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "put",
  path: "/api/agents/{id}/instructions-bundle/file",
  tags: ["agents"],
  summary: "Upsert agent instructions file",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(upsertAgentInstructionsFileSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/agents/{id}/instructions-bundle/file",
  tags: ["agents"],
  summary: "Delete agent instructions file",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/configuration",
  tags: ["agents"],
  summary: "Get agent configuration",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/config-revisions",
  tags: ["agents"],
  summary: "List agent config revisions",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/config-revisions/{revisionId}",
  tags: ["agents"],
  summary: "Get an agent config revision",
  request: { params: z.object({ id: z.string(), revisionId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/config-revisions/{revisionId}/rollback",
  tags: ["agents"],
  summary: "Roll back to a config revision",
  request: { params: z.object({ id: z.string(), revisionId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/runtime-state",
  tags: ["agents"],
  summary: "Get agent runtime state",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/runtime-state/reset-session",
  tags: ["agents"],
  summary: "Reset agent session",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(resetAgentSessionSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/task-sessions",
  tags: ["agents"],
  summary: "List agent task sessions",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/skills",
  tags: ["agents"],
  summary: "List agent skills",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/keys",
  tags: ["agents"],
  summary: "List agent API keys",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/keys",
  tags: ["agents"],
  summary: "Create an agent API key",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(createAgentKeySchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/agents/{id}/keys/{keyId}",
  tags: ["agents"],
  summary: "Delete an agent API key",
  request: { params: z.object({ id: z.string(), keyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/wakeup",
  tags: ["agents"],
  summary: "Wake up an agent",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(wakeAgentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/pause",
  tags: ["agents"],
  summary: "Pause an agent",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/resume",
  tags: ["agents"],
  summary: "Resume an agent",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/terminate",
  tags: ["agents"],
  summary: "Terminate an agent",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/instance/scheduler-heartbeats",
  tags: ["agents"],
  summary: "List scheduler heartbeats",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Adapters ────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/adapters/{type}/models",
  tags: ["adapters"],
  summary: "List models for an adapter type",
  request: { params: z.object({ companyId: z.string(), type: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/adapters/{type}/detect-model",
  tags: ["adapters"],
  summary: "Detect active model for an adapter",
  request: { params: z.object({ companyId: z.string(), type: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Issues ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/issues",
  tags: ["issues"],
  summary: "List issues in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/issues",
  tags: ["issues"],
  summary: "Create an issue",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createIssueSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}",
  tags: ["issues"],
  summary: "Get an issue",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/issues/{id}",
  tags: ["issues"],
  summary: "Update an issue",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateIssueSchema.partial()),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/issues/{id}",
  tags: ["issues"],
  summary: "Delete an issue",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/heartbeat-context",
  tags: ["issues"],
  summary: "Get issue heartbeat context",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/work-products",
  tags: ["issues"],
  summary: "List issue work products",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/work-products",
  tags: ["issues"],
  summary: "Create an issue work product",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(createIssueWorkProductSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/work-products/{id}",
  tags: ["issues"],
  summary: "Update a work product",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateIssueWorkProductSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/work-products/{id}",
  tags: ["issues"],
  summary: "Delete a work product",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/documents",
  tags: ["issues"],
  summary: "List issue documents",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/documents/{key}",
  tags: ["issues"],
  summary: "Get an issue document",
  request: { params: z.object({ id: z.string(), key: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "put",
  path: "/api/issues/{id}/documents/{key}",
  tags: ["issues"],
  summary: "Upsert an issue document",
  request: {
    params: z.object({ id: z.string(), key: z.string() }),
    body: jsonBody(upsertIssueDocumentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/issues/{id}/documents/{key}",
  tags: ["issues"],
  summary: "Delete an issue document",
  request: { params: z.object({ id: z.string(), key: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/documents/{key}/revisions",
  tags: ["issues"],
  summary: "List issue document revisions",
  request: { params: z.object({ id: z.string(), key: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/documents/{key}/revisions/{revisionId}/restore",
  tags: ["issues"],
  summary: "Restore a document revision",
  request: {
    params: z.object({ id: z.string(), key: z.string(), revisionId: z.string() }),
    body: jsonBody(restoreIssueDocumentRevisionSchema),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/comments",
  tags: ["issues"],
  summary: "List issue comments",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/comments",
  tags: ["issues"],
  summary: "Add a comment to an issue",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(addIssueCommentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/issues/{id}/comments/{commentId}",
  tags: ["issues"],
  summary: "Delete an issue comment",
  request: { params: z.object({ id: z.string(), commentId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/approvals",
  tags: ["issues"],
  summary: "List issue approvals",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/approvals",
  tags: ["issues"],
  summary: "Link an approval to an issue",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(linkIssueApprovalSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/issues/{id}/approvals/{approvalId}",
  tags: ["issues"],
  summary: "Unlink an approval from an issue",
  request: { params: z.object({ id: z.string(), approvalId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/checkout",
  tags: ["issues"],
  summary: "Check out an issue",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(checkoutIssueSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/release",
  tags: ["issues"],
  summary: "Release an issue",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/read",
  tags: ["issues"],
  summary: "Mark an issue as read",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/issues/{id}/read",
  tags: ["issues"],
  summary: "Mark an issue as unread",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/inbox-archive",
  tags: ["issues"],
  summary: "Archive issue from inbox",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/issues/{id}/inbox-archive",
  tags: ["issues"],
  summary: "Un-archive issue from inbox",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/feedback-votes",
  tags: ["issues"],
  summary: "List issue feedback votes",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/feedback-votes",
  tags: ["issues"],
  summary: "Upsert a feedback vote",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(upsertIssueFeedbackVoteSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/feedback-traces",
  tags: ["issues"],
  summary: "List issue feedback traces",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/feedback-traces/{traceId}",
  tags: ["issues"],
  summary: "Get a feedback trace",
  request: { params: z.object({ traceId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/feedback-traces/{traceId}/bundle",
  tags: ["issues"],
  summary: "Get a feedback trace bundle",
  request: { params: z.object({ traceId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/attachments",
  tags: ["issues"],
  summary: "List issue attachments",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/labels",
  tags: ["issues"],
  summary: "List labels in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/labels",
  tags: ["issues"],
  summary: "Create a label",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createIssueLabelSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/labels/{labelId}",
  tags: ["issues"],
  summary: "Delete a label",
  request: { params: z.object({ labelId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Projects ────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/projects",
  tags: ["projects"],
  summary: "List projects in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/projects",
  tags: ["projects"],
  summary: "Create a project",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createProjectSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/projects/{id}",
  tags: ["projects"],
  summary: "Get a project",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/projects/{id}",
  tags: ["projects"],
  summary: "Update a project",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateProjectSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/projects/{id}",
  tags: ["projects"],
  summary: "Delete a project",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/projects/{id}/workspaces",
  tags: ["projects"],
  summary: "List project workspaces",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/projects/{id}/workspaces",
  tags: ["projects"],
  summary: "Create a project workspace",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(createProjectWorkspaceSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/projects/{id}/workspaces/{workspaceId}",
  tags: ["projects"],
  summary: "Delete a project workspace",
  request: { params: z.object({ id: z.string(), workspaceId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Routines ────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/routines",
  tags: ["routines"],
  summary: "List routines in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/routines",
  tags: ["routines"],
  summary: "Create a routine",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createRoutineSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/routines/{id}",
  tags: ["routines"],
  summary: "Get a routine",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/routines/{id}",
  tags: ["routines"],
  summary: "Update a routine",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateRoutineSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/routines/{id}/runs",
  tags: ["routines"],
  summary: "List runs for a routine",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/routines/{id}/run",
  tags: ["routines"],
  summary: "Manually run a routine",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(runRoutineSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/routines/{id}/triggers",
  tags: ["routines"],
  summary: "Create a routine trigger",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(createRoutineTriggerSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/routine-triggers/{id}",
  tags: ["routines"],
  summary: "Update a routine trigger",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateRoutineTriggerSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/routine-triggers/{id}",
  tags: ["routines"],
  summary: "Delete a routine trigger",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/routine-triggers/public/{publicId}/fire",
  tags: ["routines"],
  summary: "Fire a public routine trigger",
  request: { params: z.object({ publicId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

// ─── Goals ───────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/goals",
  tags: ["goals"],
  summary: "List goals in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/goals",
  tags: ["goals"],
  summary: "Create a goal",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createGoalSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/goals/{id}",
  tags: ["goals"],
  summary: "Get a goal",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/goals/{id}",
  tags: ["goals"],
  summary: "Update a goal",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateGoalSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/goals/{id}",
  tags: ["goals"],
  summary: "Delete a goal",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Secrets ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/secret-providers",
  tags: ["secrets"],
  summary: "List secret providers",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/secrets",
  tags: ["secrets"],
  summary: "List secrets in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/secrets",
  tags: ["secrets"],
  summary: "Create a secret",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createSecretSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/secrets/{id}",
  tags: ["secrets"],
  summary: "Update a secret",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateSecretSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/secrets/{id}/rotate",
  tags: ["secrets"],
  summary: "Rotate a secret",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(rotateSecretSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/secrets/{id}",
  tags: ["secrets"],
  summary: "Delete a secret",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Approvals ───────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/approvals",
  tags: ["approvals"],
  summary: "List approvals in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/approvals",
  tags: ["approvals"],
  summary: "Create an approval",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createApprovalSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/approvals/{id}",
  tags: ["approvals"],
  summary: "Get an approval",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/approvals/{id}/issues",
  tags: ["approvals"],
  summary: "List issues linked to an approval",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/approvals/{id}/approve",
  tags: ["approvals"],
  summary: "Approve an approval",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(resolveApprovalSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/approvals/{id}/reject",
  tags: ["approvals"],
  summary: "Reject an approval",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(resolveApprovalSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/approvals/{id}/request-revision",
  tags: ["approvals"],
  summary: "Request revision on an approval",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(requestApprovalRevisionSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/approvals/{id}/resubmit",
  tags: ["approvals"],
  summary: "Resubmit an approval",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(resubmitApprovalSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/approvals/{id}/comments",
  tags: ["approvals"],
  summary: "List approval comments",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/approvals/{id}/comments",
  tags: ["approvals"],
  summary: "Add a comment to an approval",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(addApprovalCommentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Costs ───────────────────────────────────────────────────────────────────

const costSummaryPaths = [
  "summary", "by-agent", "by-agent-model", "by-provider",
  "by-biller", "by-project", "finance-summary", "finance-by-biller",
  "finance-by-kind", "finance-events", "window-spend", "quota-windows",
] as const;

for (const segment of costSummaryPaths) {
  registry.registerPath({
    method: "get",
    path: `/api/companies/{companyId}/costs/${segment}`,
    tags: ["costs"],
    summary: `Cost report: ${segment}`,
    request: { params: z.object({ companyId: z.string() }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });
}

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/cost-events",
  tags: ["costs"],
  summary: "Record a cost event",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createCostEventSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/finance-events",
  tags: ["costs"],
  summary: "Record a finance event",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createFinanceEventSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/budgets/overview",
  tags: ["costs"],
  summary: "Get budget overview",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/budgets",
  tags: ["costs"],
  summary: "Update company budget",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(updateBudgetSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/agents/{agentId}/budgets",
  tags: ["costs"],
  summary: "Update agent budget",
  request: {
    params: z.object({ agentId: z.string() }),
    body: jsonBody(updateBudgetSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Activity ────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/activity",
  tags: ["activity"],
  summary: "List company activity",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/activity",
  tags: ["activity"],
  summary: "Create an activity entry",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(z.record(z.unknown())),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/activity",
  tags: ["activity"],
  summary: "List activity for an issue",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/runs",
  tags: ["activity"],
  summary: "List runs for an issue",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/heartbeat-runs/{runId}/issues",
  tags: ["activity"],
  summary: "List issues for a heartbeat run",
  request: { params: z.object({ runId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Dashboard ───────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/dashboard",
  tags: ["dashboard"],
  summary: "Get dashboard data",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Sidebar ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/sidebar-badges",
  tags: ["sidebar"],
  summary: "Get sidebar badge counts",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/sidebar-preferences/me",
  tags: ["sidebar"],
  summary: "Get current user sidebar preferences",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "put",
  path: "/api/sidebar-preferences/me",
  tags: ["sidebar"],
  summary: "Update current user sidebar preferences",
  request: { body: jsonBody(upsertSidebarOrderPreferenceSchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/sidebar-preferences/me",
  tags: ["sidebar"],
  summary: "Get sidebar preferences for company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "put",
  path: "/api/companies/{companyId}/sidebar-preferences/me",
  tags: ["sidebar"],
  summary: "Update sidebar preferences for company",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(upsertSidebarOrderPreferenceSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Inbox dismissals ────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/inbox-dismissals",
  tags: ["inbox"],
  summary: "List inbox dismissals",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/inbox-dismissals",
  tags: ["inbox"],
  summary: "Create an inbox dismissal",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(z.record(z.unknown())),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Instance settings ────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/instance/settings/general",
  tags: ["instance"],
  summary: "Get general instance settings",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/instance/settings/general",
  tags: ["instance"],
  summary: "Update general instance settings",
  request: { body: jsonBody(z.record(z.unknown())) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/instance/settings/experimental",
  tags: ["instance"],
  summary: "Get experimental instance settings",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/instance/settings/experimental",
  tags: ["instance"],
  summary: "Update experimental instance settings",
  request: { body: jsonBody(z.record(z.unknown())) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Access / invites / members ───────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/invites",
  tags: ["access"],
  summary: "List company invites",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/join-requests",
  tags: ["access"],
  summary: "List company join requests",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/invites/{inviteId}/revoke",
  tags: ["access"],
  summary: "Revoke an invite",
  request: { params: z.object({ inviteId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/invites/{token}",
  tags: ["access"],
  summary: "Get an invite by token",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: r.ok(), 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/members",
  tags: ["access"],
  summary: "List company members",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/user-directory",
  tags: ["access"],
  summary: "Get company user directory",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/cli-auth/me",
  tags: ["access"],
  summary: "Get current CLI auth session",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/cli-auth/revoke-current",
  tags: ["access"],
  summary: "Revoke current CLI auth session",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/skills/available",
  tags: ["access"],
  summary: "List available skills",
  responses: { 200: r.ok() },
});

registry.registerPath({
  method: "get",
  path: "/api/skills/index",
  tags: ["access"],
  summary: "Get skills index",
  responses: { 200: r.ok() },
});

registry.registerPath({
  method: "get",
  path: "/api/skills/{skillName}",
  tags: ["access"],
  summary: "Get a skill by name",
  request: { params: z.object({ skillName: z.string() }) },
  responses: { 200: r.ok(), 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/admin/users",
  tags: ["admin"],
  summary: "List all users (admin)",
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

// ─── Spec builder ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildOpenApiSpec(): any {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.0",
    info: {
      title: "Paperclip API",
      version: "1.0.0",
      description: "REST API for the Paperclip AI agent management platform",
    },
    servers: [{ url: "/" }],
  });
}
