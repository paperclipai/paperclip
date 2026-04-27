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
  agentSkillSyncSchema,
  testAdapterEnvironmentSchema,
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
  updateProjectWorkspaceSchema,
  // Company
  createCompanySchema,
  updateCompanySchema,
  updateCompanyBrandingSchema,
  // Routine
  createRoutineSchema,
  updateRoutineSchema,
  createRoutineTriggerSchema,
  updateRoutineTriggerSchema,
  rotateRoutineTriggerSecretSchema,
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
  upsertBudgetPolicySchema,
  resolveBudgetIncidentSchema,
  // Sidebar
  upsertSidebarOrderPreferenceSchema,
  // Execution workspaces
  updateExecutionWorkspaceSchema,
  workspaceRuntimeControlTargetSchema,
  // Environments
  createEnvironmentSchema,
  updateEnvironmentSchema,
  probeEnvironmentConfigSchema,
  // Company skills
  companySkillCreateSchema,
  companySkillFileUpdateSchema,
  companySkillImportSchema,
  companySkillProjectScanRequestSchema,
  // Issue tree
  createIssueTreeHoldSchema,
  previewIssueTreeControlSchema,
  releaseIssueTreeHoldSchema,
  // Issue interactions
  createIssueThreadInteractionSchema,
  createChildIssueSchema,
  acceptIssueThreadInteractionSchema,
  rejectIssueThreadInteractionSchema,
  respondIssueThreadInteractionSchema,
  // Auth / profile
  updateCurrentUserProfileSchema,
  // Company portability (legacy routes)
  companyPortabilityExportSchema,
  companyPortabilityPreviewSchema,
  companyPortabilityImportSchema,
  // Access / membership
  acceptInviteSchema,
  createCompanyInviteSchema,
  createOpenClawInvitePromptSchema,
  claimJoinRequestApiKeySchema,
  createCliAuthChallengeSchema,
  resolveCliAuthChallengeSchema,
  updateCompanyMemberSchema,
  updateCompanyMemberWithPermissionsSchema,
  archiveCompanyMemberSchema,
  updateMemberPermissionsSchema,
  updateUserCompanyAccessSchema,
  // Instance settings
  patchInstanceGeneralSettingsSchema,
  patchInstanceExperimentalSettingsSchema,
} from "@paperclipai/shared";

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

// ─── Common schemas ──────────────────────────────────────────────────────────

const ErrorSchema = registry.register(
  "Error",
  z.object({ error: z.string() }).openapi({ title: "Error" }),
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

type OpenApiAuthLevel =
  | "public"
  | "authenticated"
  | "board"
  | "instance_admin";

type OpenApiDocument = {
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
  paths?: Record<string, Record<string, Record<string, unknown>>>;
  security?: Array<Record<string, string[]>>;
};

const BOARD_SESSION_AUTH_SCHEME = "BoardSessionAuth";
const BOARD_API_KEY_AUTH_SCHEME = "BoardApiKeyAuth";
const AGENT_BEARER_AUTH_SCHEME = "AgentBearerAuth";

const BOARD_SECURITY = [
  { [BOARD_SESSION_AUTH_SCHEME]: [] },
  { [BOARD_API_KEY_AUTH_SCHEME]: [] },
] satisfies Array<Record<string, string[]>>;

const AUTHENTICATED_SECURITY = [
  ...BOARD_SECURITY,
  { [AGENT_BEARER_AUTH_SCHEME]: [] },
] satisfies Array<Record<string, string[]>>;

const PUBLIC_OPERATIONS = new Set([
  "GET /api/health",
  "GET /api/openapi.json",
  "GET /api/board-claim/{token}",
  "POST /api/cli-auth/challenges",
  "GET /api/cli-auth/challenges/{id}",
  "POST /api/cli-auth/challenges/{id}/cancel",
  "GET /api/invites/{token}",
  "GET /api/invites/{token}/logo",
  "GET /api/invites/{token}/onboarding",
  "GET /api/invites/{token}/onboarding.txt",
  "GET /api/invites/{token}/skills/index",
  "GET /api/invites/{token}/skills/{skillName}",
  "GET /api/invites/{token}/test-resolution",
  "POST /api/invites/{token}/accept",
  "POST /api/join-requests/{requestId}/claim-api-key",
]);

const BOARD_ONLY_PREFIXES = [
  "/api/auth/",
  "/api/admin/",
  "/api/plugins",
  "/api/instance/",
];

const BOARD_ONLY_OPERATIONS = new Set([
  "GET /api/companies",
  "POST /api/companies",
  "GET /api/companies/stats",
  "GET /api/companies/issues",
  "POST /api/board-claim/{token}/claim",
  "GET /api/cli-auth/me",
  "POST /api/companies/{companyId}/invites",
  "GET /api/companies/{companyId}/invites",
  "POST /api/companies/{companyId}/openclaw/invite-prompt",
  "GET /api/companies/{companyId}/join-requests",
  "POST /api/companies/{companyId}/join-requests/{requestId}/approve",
  "POST /api/companies/{companyId}/join-requests/{requestId}/reject",
  "GET /api/companies/{companyId}/members",
  "PATCH /api/companies/{companyId}/members/{memberId}",
  "PATCH /api/companies/{companyId}/members/{memberId}/role-and-grants",
  "POST /api/companies/{companyId}/members/{memberId}/archive",
  "PATCH /api/companies/{companyId}/members/{memberId}/permissions",
  "GET /api/companies/{companyId}/user-directory",
  "POST /api/issues/{id}/interactions/{interactionId}/accept",
  "POST /api/issues/{id}/interactions/{interactionId}/reject",
  "POST /api/issues/{id}/interactions/{interactionId}/respond",
]);

const INSTANCE_ADMIN_OPERATIONS = new Set([
  "POST /api/companies",
  "POST /api/plugins/install",
  "POST /api/instance/database-backups",
  "POST /api/admin/users/{userId}/promote-instance-admin",
  "POST /api/admin/users/{userId}/demote-instance-admin",
  "PUT /api/admin/users/{userId}/company-access",
]);

const CREATED_OPERATIONS = new Set([
  "POST /api/adapters/install",
  "POST /api/companies/{companyId}/agent-hires",
  "POST /api/companies/{companyId}/agents",
  "POST /api/agents/{id}/keys",
  "POST /api/companies/{companyId}/approvals",
  "POST /api/approvals/{id}/comments",
  "POST /api/companies/{companyId}/assets/images",
  "POST /api/companies/{companyId}/logo",
  "POST /api/cli-auth/challenges",
  "POST /api/companies",
  "POST /api/companies/{companyId}/invites",
  "POST /api/companies/{companyId}/openclaw/invite-prompt",
  "POST /api/companies/{companyId}/cost-events",
  "POST /api/companies/{companyId}/finance-events",
  "POST /api/companies/{companyId}/environments",
  "POST /api/companies/{companyId}/goals",
  "POST /api/companies/{companyId}/labels",
  "POST /api/issues/{id}/work-products",
  "POST /api/issues/{id}/approvals",
  "POST /api/companies/{companyId}/issues",
  "POST /api/issues/{id}/children",
  "POST /api/issues/{id}/interactions",
  "POST /api/issues/{id}/comments",
  "POST /api/companies/{companyId}/issues/{issueId}/attachments",
  "POST /api/companies/{companyId}/projects",
  "POST /api/projects/{id}/workspaces",
  "POST /api/companies/{companyId}/routines",
  "POST /api/routines/{id}/triggers",
  "POST /api/companies/{companyId}/secrets",
  "POST /api/companies/{companyId}/skills",
  "POST /api/companies/{companyId}/skills/import",
  "POST /api/join-requests/{requestId}/claim-api-key",
  "POST /api/admin/users/{userId}/promote-instance-admin",
  "POST /api/plugins/install",
  "POST /api/instance/database-backups",
]);

const ACCEPTED_OPERATIONS = new Set([
  "POST /api/invites/{token}/accept",
]);

const FORBIDDEN_RESPONSE = {
  description: "Forbidden",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
};

function operationKey(method: string, path: string) {
  return `${method.toUpperCase()} ${path}`;
}

function isBoardOnlyOperation(method: string, path: string) {
  const key = operationKey(method, path);
  if (BOARD_ONLY_OPERATIONS.has(key)) return true;
  return BOARD_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function resolveOperationAuthLevel(method: string, path: string): OpenApiAuthLevel {
  const key = operationKey(method, path);
  if (PUBLIC_OPERATIONS.has(key)) return "public";
  if (INSTANCE_ADMIN_OPERATIONS.has(key)) return "instance_admin";
  if (isBoardOnlyOperation(method, path)) return "board";
  return "authenticated";
}

function applyOperationStatusOverride(
  operation: Record<string, unknown>,
  fromStatus: string,
  toStatus: string,
) {
  const responses = operation.responses as Record<string, unknown> | undefined;
  if (!responses || !responses[fromStatus] || responses[toStatus]) return;
  responses[toStatus] = responses[fromStatus];
  delete responses[fromStatus];
}

function applyDocumentFixups(document: OpenApiDocument): OpenApiDocument {
  document.components ??= {};
  document.components.securitySchemes = {
    [BOARD_SESSION_AUTH_SCHEME]: {
      type: "apiKey",
      in: "cookie",
      name: "paperclip_session",
      description:
        "Board session cookie in authenticated mode. Paperclip uses Better Auth; cookie transport may vary by deployment.",
    },
    [BOARD_API_KEY_AUTH_SCHEME]: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "Board API Key",
      description: "Board API key presented in the Authorization bearer header.",
    },
    [AGENT_BEARER_AUTH_SCHEME]: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "Agent API Key or Agent JWT",
      description:
        "Agent API key or Paperclip-issued local agent JWT presented in the Authorization bearer header.",
    },
  };
  document.security = AUTHENTICATED_SECURITY;

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      const authLevel = resolveOperationAuthLevel(method, path);
      if (authLevel === "public") {
        operation.security = [];
      } else if (authLevel === "authenticated") {
        operation.security = AUTHENTICATED_SECURITY;
      } else {
        operation.security = BOARD_SECURITY;
      }

      operation["x-paperclip-authorization"] =
        authLevel === "instance_admin"
          ? { actor: "board", instanceAdmin: true }
          : authLevel === "board"
            ? { actor: "board" }
            : authLevel === "authenticated"
              ? { actor: "board_or_agent" }
              : { actor: "public" };

      const key = operationKey(method, path);
      if (authLevel !== "public") {
        const responses = (operation.responses ??= {}) as Record<string, unknown>;
        if (!responses["403"]) {
          responses["403"] = FORBIDDEN_RESPONSE;
        }
      }
      if (CREATED_OPERATIONS.has(key)) {
        applyOperationStatusOverride(operation, "200", "201");
      }
      if (ACCEPTED_OPERATIONS.has(key)) {
        applyOperationStatusOverride(operation, "200", "202");
      }
    }
  }

  return document;
}

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

registry.registerPath({
  method: "get",
  path: "/api/openapi.json",
  tags: ["health"],
  summary: "Get the generated OpenAPI document",
  responses: { 200: r.ok() },
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
    body: jsonBody(updateCompanySchema.partial()),
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
    body: jsonBody(updateAgentSchema.omit({ permissions: true })),
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
  method: "post",
  path: "/api/agents/{id}/skills/sync",
  tags: ["agents"],
  summary: "Sync desired skills onto an agent configuration",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(agentSkillSyncSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
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

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/adapters/{type}/test-environment",
  tags: ["adapters"],
  summary: "Validate adapter environment access for a company",
  request: {
    params: z.object({ companyId: z.string(), type: z.string() }),
    body: jsonBody(testAdapterEnvironmentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
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
  method: "patch",
  path: "/api/projects/{id}/workspaces/{workspaceId}",
  tags: ["projects"],
  summary: "Update a project workspace",
  request: {
    params: z.object({ id: z.string(), workspaceId: z.string() }),
    body: jsonBody(updateProjectWorkspaceSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
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
  path: "/api/routine-triggers/{id}/rotate-secret",
  tags: ["routines"],
  summary: "Rotate a routine trigger secret",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(rotateRoutineTriggerSecretSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
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
  method: "post",
  path: "/api/companies/{companyId}/budgets/policies",
  tags: ["costs"],
  summary: "Create or update a budget policy",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(upsertBudgetPolicySchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/budget-incidents/{incidentId}/resolve",
  tags: ["costs"],
  summary: "Resolve a budget incident",
  request: {
    params: z.object({ companyId: z.string(), incidentId: z.string() }),
    body: jsonBody(resolveBudgetIncidentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
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
    body: jsonBody(z.object({
      actorType: z.enum(["agent", "user", "system", "plugin"]).optional(),
      actorId: z.string().min(1),
      action: z.string().min(1),
      entityType: z.string().min(1),
      entityId: z.string().min(1),
      agentId: z.string().uuid().optional().nullable(),
      details: z.record(z.unknown()).optional().nullable(),
    })),
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
    body: jsonBody(z.object({
      itemKey: z.string().trim().min(1).regex(/^(approval|join|run):.+$/, "Unsupported inbox item key"),
    })),
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
  request: { body: jsonBody(patchInstanceGeneralSettingsSchema) },
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
  request: { body: jsonBody(patchInstanceExperimentalSettingsSchema) },
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
  method: "post",
  path: "/api/companies/{companyId}/invites",
  tags: ["access"],
  summary: "Create a company invite",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createCompanyInviteSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
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
  path: "/api/companies/{companyId}/join-requests/{requestId}/approve",
  tags: ["access"],
  summary: "Approve a company join request",
  request: { params: z.object({ companyId: z.string(), requestId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/join-requests/{requestId}/reject",
  tags: ["access"],
  summary: "Reject a company join request",
  request: { params: z.object({ companyId: z.string(), requestId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
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
  method: "post",
  path: "/api/invites/{token}/accept",
  tags: ["access"],
  summary: "Accept an invite and create or replay a join request",
  request: {
    params: z.object({ token: z.string() }),
    body: jsonBody(acceptInviteSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
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
  method: "patch",
  path: "/api/companies/{companyId}/members/{memberId}",
  tags: ["access"],
  summary: "Update a company member status or role",
  request: {
    params: z.object({ companyId: z.string(), memberId: z.string() }),
    body: jsonBody(updateCompanyMemberSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/members/{memberId}/role-and-grants",
  tags: ["access"],
  summary: "Update a company member role and explicit grants",
  request: {
    params: z.object({ companyId: z.string(), memberId: z.string() }),
    body: jsonBody(updateCompanyMemberWithPermissionsSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/members/{memberId}/archive",
  tags: ["access"],
  summary: "Archive a company member",
  request: {
    params: z.object({ companyId: z.string(), memberId: z.string() }),
    body: jsonBody(archiveCompanyMemberSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/members/{memberId}/permissions",
  tags: ["access"],
  summary: "Update explicit company member permissions",
  request: {
    params: z.object({ companyId: z.string(), memberId: z.string() }),
    body: jsonBody(updateMemberPermissionsSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
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
  path: "/api/companies/{companyId}/openclaw/invite-prompt",
  tags: ["access"],
  summary: "Create an OpenClaw invite prompt bundle",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createOpenClawInvitePromptSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/cli-auth/challenges",
  tags: ["access"],
  summary: "Create a CLI auth challenge",
  request: { body: jsonBody(createCliAuthChallengeSchema) },
  responses: { 200: r.ok(), 400: r.badRequest },
});

registry.registerPath({
  method: "post",
  path: "/api/cli-auth/challenges/{id}/approve",
  tags: ["access"],
  summary: "Approve a CLI auth challenge",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(resolveCliAuthChallengeSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/cli-auth/challenges/{id}/cancel",
  tags: ["access"],
  summary: "Cancel a CLI auth challenge",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(resolveCliAuthChallengeSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 404: r.notFound },
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
  method: "post",
  path: "/api/join-requests/{requestId}/claim-api-key",
  tags: ["access"],
  summary: "Claim the initial API key for an approved agent join request",
  request: {
    params: z.object({ requestId: z.string() }),
    body: jsonBody(claimJoinRequestApiKeySchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/admin/users",
  tags: ["admin"],
  summary: "List all users (admin)",
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

// ─── Auth / profile ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/auth/get-session",
  tags: ["auth"],
  summary: "Get current session",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/auth/profile",
  tags: ["auth"],
  summary: "Get current user profile",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/auth/profile",
  tags: ["auth"],
  summary: "Update current user profile",
  request: { body: jsonBody(updateCurrentUserProfileSchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/users/{userSlug}/profile",
  tags: ["auth"],
  summary: "Get a user profile within a company",
  request: { params: z.object({ companyId: z.string(), userSlug: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

// ─── Heartbeat runs ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/heartbeat-runs",
  tags: ["runs"],
  summary: "List heartbeat runs for a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/live-runs",
  tags: ["runs"],
  summary: "List live runs for a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{issueId}/live-runs",
  tags: ["runs"],
  summary: "List live runs for an issue",
  request: { params: z.object({ issueId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{issueId}/active-run",
  tags: ["runs"],
  summary: "Get active run for an issue",
  request: { params: z.object({ issueId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/heartbeat-runs/{runId}",
  tags: ["runs"],
  summary: "Get a heartbeat run",
  request: { params: z.object({ runId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/heartbeat-runs/{runId}/cancel",
  tags: ["runs"],
  summary: "Cancel a heartbeat run",
  request: { params: z.object({ runId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/heartbeat-runs/{runId}/watchdog-decisions",
  tags: ["runs"],
  summary: "Submit watchdog decisions for a run",
  request: {
    params: z.object({ runId: z.string() }),
    body: jsonBody(z.object({
      decision: z.enum(["snooze", "continue", "dismissed_false_positive"]),
      evaluationIssueId: z.string().optional().nullable(),
      reason: z.string().optional().nullable(),
      snoozedUntil: z.string().datetime().optional().nullable(),
    })),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/heartbeat-runs/{runId}/events",
  tags: ["runs"],
  summary: "Get events for a heartbeat run",
  request: { params: z.object({ runId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/heartbeat-runs/{runId}/log",
  tags: ["runs"],
  summary: "Get log for a heartbeat run",
  request: { params: z.object({ runId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/heartbeat-runs/{runId}/workspace-operations",
  tags: ["runs"],
  summary: "List workspace operations for a run",
  request: { params: z.object({ runId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/workspace-operations/{operationId}/log",
  tags: ["runs"],
  summary: "Get log for a workspace operation",
  request: { params: z.object({ operationId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Agent runs & heartbeat ───────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/approve",
  tags: ["agents"],
  summary: "Approve a pending agent action",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/heartbeat/invoke",
  tags: ["agents"],
  summary: "Invoke agent heartbeat",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/claude-login",
  tags: ["agents"],
  summary: "Trigger Claude login for agent",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Issue interactions & tree ───────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/interactions",
  tags: ["issues"],
  summary: "List issue thread interactions",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/interactions",
  tags: ["issues"],
  summary: "Create an issue thread interaction",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(createIssueThreadInteractionSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/interactions/{interactionId}/accept",
  tags: ["issues"],
  summary: "Accept an issue thread interaction",
  request: {
    params: z.object({ id: z.string(), interactionId: z.string() }),
    body: jsonBody(acceptIssueThreadInteractionSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/interactions/{interactionId}/reject",
  tags: ["issues"],
  summary: "Reject an issue thread interaction",
  request: {
    params: z.object({ id: z.string(), interactionId: z.string() }),
    body: jsonBody(rejectIssueThreadInteractionSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/interactions/{interactionId}/respond",
  tags: ["issues"],
  summary: "Answer questions on an issue thread interaction",
  request: {
    params: z.object({ id: z.string(), interactionId: z.string() }),
    body: jsonBody(respondIssueThreadInteractionSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/children",
  tags: ["issues"],
  summary: "Create child issues",
  request: { params: z.object({ id: z.string() }), body: jsonBody(createChildIssueSchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/admin/force-release",
  tags: ["issues"],
  summary: "Force-release an issue (admin)",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/tree-control/state",
  tags: ["issues"],
  summary: "Get issue tree control state",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/tree-control/preview",
  tags: ["issues"],
  summary: "Preview issue tree control changes",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(previewIssueTreeControlSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/tree-holds",
  tags: ["issues"],
  summary: "List issue tree holds",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/tree-holds",
  tags: ["issues"],
  summary: "Create an issue tree hold",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(createIssueTreeHoldSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/tree-holds/{holdId}",
  tags: ["issues"],
  summary: "Get an issue tree hold",
  request: { params: z.object({ id: z.string(), holdId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/tree-holds/{holdId}/release",
  tags: ["issues"],
  summary: "Release an issue tree hold",
  request: {
    params: z.object({ id: z.string(), holdId: z.string() }),
    body: jsonBody(releaseIssueTreeHoldSchema),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Attachments ──────────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/issues/{issueId}/attachments",
  tags: ["assets"],
  summary: "Upload an attachment to an issue",
  request: { params: z.object({ companyId: z.string(), issueId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/attachments/{attachmentId}/content",
  tags: ["assets"],
  summary: "Download attachment content",
  request: { params: z.object({ attachmentId: z.string() }) },
  responses: { 200: { description: "File content" }, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/attachments/{attachmentId}",
  tags: ["assets"],
  summary: "Delete an attachment",
  request: { params: z.object({ attachmentId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Assets ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/assets/images",
  tags: ["assets"],
  summary: "Upload an image asset",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/logo",
  tags: ["assets"],
  summary: "Upload company logo",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/assets/{assetId}/content",
  tags: ["assets"],
  summary: "Download asset content",
  request: { params: z.object({ assetId: z.string() }) },
  responses: { 200: { description: "File content" }, 401: r.unauthorized, 404: r.notFound },
});

// ─── Company skills ───────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skills",
  tags: ["skills"],
  summary: "List skills for a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skills/{skillId}",
  tags: ["skills"],
  summary: "Get a company skill",
  request: { params: z.object({ companyId: z.string(), skillId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skills/{skillId}/update-status",
  tags: ["skills"],
  summary: "Get skill update status",
  request: { params: z.object({ companyId: z.string(), skillId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skills/{skillId}/files",
  tags: ["skills"],
  summary: "List skill files",
  request: { params: z.object({ companyId: z.string(), skillId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skills",
  tags: ["skills"],
  summary: "Create a company skill",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(companySkillCreateSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/skills/{skillId}/files",
  tags: ["skills"],
  summary: "Update a skill file",
  request: {
    params: z.object({ companyId: z.string(), skillId: z.string() }),
    body: jsonBody(companySkillFileUpdateSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skills/import",
  tags: ["skills"],
  summary: "Import a skill",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(companySkillImportSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skills/scan-projects",
  tags: ["skills"],
  summary: "Scan project for skills",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(companySkillProjectScanRequestSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skills/{skillId}/install-update",
  tags: ["skills"],
  summary: "Install a skill update",
  request: { params: z.object({ companyId: z.string(), skillId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}/skills/{skillId}",
  tags: ["skills"],
  summary: "Delete a company skill",
  request: { params: z.object({ companyId: z.string(), skillId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Execution workspaces ─────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/execution-workspaces",
  tags: ["execution-workspaces"],
  summary: "List execution workspaces for a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/execution-workspaces/{id}",
  tags: ["execution-workspaces"],
  summary: "Get an execution workspace",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/execution-workspaces/{id}/close-readiness",
  tags: ["execution-workspaces"],
  summary: "Check close-readiness of a workspace",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/execution-workspaces/{id}/workspace-operations",
  tags: ["execution-workspaces"],
  summary: "List workspace operations",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/execution-workspaces/{id}",
  tags: ["execution-workspaces"],
  summary: "Update an execution workspace",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateExecutionWorkspaceSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/execution-workspaces/{id}/runtime-services/{action}",
  tags: ["execution-workspaces"],
  summary: "Control a runtime service in a workspace",
  request: {
    params: z.object({ id: z.string(), action: z.string() }),
    body: jsonBody(workspaceRuntimeControlTargetSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/execution-workspaces/{id}/runtime-commands/{action}",
  tags: ["execution-workspaces"],
  summary: "Run a runtime command in a workspace",
  request: {
    params: z.object({ id: z.string(), action: z.string() }),
    body: jsonBody(workspaceRuntimeControlTargetSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Environments ─────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/environments",
  tags: ["environments"],
  summary: "List environments for a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/environments/capabilities",
  tags: ["environments"],
  summary: "Get environment capabilities",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/environments",
  tags: ["environments"],
  summary: "Create an environment",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createEnvironmentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/environments/{id}",
  tags: ["environments"],
  summary: "Get an environment",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/environments/{id}/leases",
  tags: ["environments"],
  summary: "List leases for an environment",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/environment-leases/{leaseId}",
  tags: ["environments"],
  summary: "Get an environment lease",
  request: { params: z.object({ leaseId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/environments/{id}",
  tags: ["environments"],
  summary: "Update an environment",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateEnvironmentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/environments/{id}",
  tags: ["environments"],
  summary: "Delete an environment",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/environments/{id}/probe",
  tags: ["environments"],
  summary: "Probe an environment",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/environments/probe-config",
  tags: ["environments"],
  summary: "Probe environment config",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(probeEnvironmentConfigSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Adapters (full) ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/adapters",
  tags: ["adapters"],
  summary: "List all adapters",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/adapters/install",
  tags: ["adapters"],
  summary: "Install an adapter",
  request: {
    body: jsonBody(z.object({
      packageName: z.string(),
      isLocalPath: z.boolean().optional(),
      version: z.string().optional(),
    })),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/adapters/{type}",
  tags: ["adapters"],
  summary: "Enable or disable an adapter",
  request: {
    params: z.object({ type: z.string() }),
    body: jsonBody(z.object({ disabled: z.boolean() })),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/adapters/{type}/override",
  tags: ["adapters"],
  summary: "Pause or resume an adapter's override of a builtin",
  request: {
    params: z.object({ type: z.string() }),
    body: jsonBody(z.object({ paused: z.boolean() })),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/adapters/{type}",
  tags: ["adapters"],
  summary: "Delete an adapter",
  request: { params: z.object({ type: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/adapters/{type}/reload",
  tags: ["adapters"],
  summary: "Reload an adapter",
  request: { params: z.object({ type: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/adapters/{type}/reinstall",
  tags: ["adapters"],
  summary: "Reinstall an adapter",
  request: { params: z.object({ type: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/adapters/{type}/config-schema",
  tags: ["adapters"],
  summary: "Get adapter config schema",
  request: { params: z.object({ type: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Plugins ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/plugins",
  tags: ["plugins"],
  summary: "List installed plugins",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/examples",
  tags: ["plugins"],
  summary: "List example plugins",
  responses: { 200: r.ok() },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/ui-contributions",
  tags: ["plugins"],
  summary: "List plugin UI contributions",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/tools",
  tags: ["plugins"],
  summary: "List plugin tools",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/tools/execute",
  tags: ["plugins"],
  summary: "Execute a plugin tool",
  request: {
    body: jsonBody(z.object({
      tool: z.string(),
      parameters: z.record(z.unknown()).optional(),
      runContext: z.object({
        agentId: z.string(),
        runId: z.string(),
        companyId: z.string(),
        projectId: z.string(),
      }),
    })),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/install",
  tags: ["plugins"],
  summary: "Install a plugin",
  request: {
    body: jsonBody(z.object({
      packageName: z.string(),
      version: z.string().optional(),
      isLocalPath: z.boolean().optional(),
    })),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/{pluginId}",
  tags: ["plugins"],
  summary: "Get a plugin",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/plugins/{pluginId}",
  tags: ["plugins"],
  summary: "Delete a plugin",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/enable",
  tags: ["plugins"],
  summary: "Enable a plugin",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/disable",
  tags: ["plugins"],
  summary: "Disable a plugin",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/{pluginId}/health",
  tags: ["plugins"],
  summary: "Get plugin health",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/{pluginId}/logs",
  tags: ["plugins"],
  summary: "Get plugin logs",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/upgrade",
  tags: ["plugins"],
  summary: "Upgrade a plugin",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/{pluginId}/config",
  tags: ["plugins"],
  summary: "Get plugin config",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/config",
  tags: ["plugins"],
  summary: "Set plugin config",
  request: {
    params: z.object({ pluginId: z.string() }),
    body: jsonBody(z.object({ configJson: z.record(z.unknown()) })),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/config/test",
  tags: ["plugins"],
  summary: "Test plugin config",
  request: {
    params: z.object({ pluginId: z.string() }),
    body: jsonBody(z.object({ configJson: z.record(z.unknown()) })),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/{pluginId}/jobs",
  tags: ["plugins"],
  summary: "List plugin jobs",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/{pluginId}/jobs/{jobId}/runs",
  tags: ["plugins"],
  summary: "List runs for a plugin job",
  request: { params: z.object({ pluginId: z.string(), jobId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/jobs/{jobId}/trigger",
  tags: ["plugins"],
  summary: "Trigger a plugin job",
  request: { params: z.object({ pluginId: z.string(), jobId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/webhooks/{endpointKey}",
  tags: ["plugins"],
  summary: "Deliver an external webhook payload to a plugin",
  request: {
    params: z.object({ pluginId: z.string(), endpointKey: z.string() }),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/{pluginId}/dashboard",
  tags: ["plugins"],
  summary: "Get plugin dashboard data",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/bridge/data",
  tags: ["plugins"],
  summary: "Send data via plugin bridge",
  request: {
    params: z.object({ pluginId: z.string() }),
    body: jsonBody(z.object({
      key: z.string(),
      companyId: z.string().optional(),
      params: z.record(z.unknown()).optional(),
    })),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/bridge/action",
  tags: ["plugins"],
  summary: "Send action via plugin bridge",
  request: {
    params: z.object({ pluginId: z.string() }),
    body: jsonBody(z.object({
      key: z.string(),
      companyId: z.string().optional(),
      params: z.record(z.unknown()).optional(),
    })),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/data/{key}",
  tags: ["plugins"],
  summary: "Get plugin data by key (URL-keyed bridge)",
  request: {
    params: z.object({ pluginId: z.string(), key: z.string() }),
    body: jsonBody(z.object({
      companyId: z.string().optional(),
      params: z.record(z.unknown()).optional(),
    })),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/actions/{key}",
  tags: ["plugins"],
  summary: "Invoke a plugin action (URL-keyed bridge)",
  request: {
    params: z.object({ pluginId: z.string(), key: z.string() }),
    body: jsonBody(z.object({
      companyId: z.string().optional(),
      params: z.record(z.unknown()).optional(),
    })),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Instance database backups ────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/instance/database-backups",
  tags: ["instance"],
  summary: "Trigger a database backup",
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

// ─── LLM text endpoints ───────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/llms/agent-configuration.txt",
  tags: ["llms"],
  summary: "Get agent configuration as plain text (for LLM context)",
  responses: { 200: { description: "Plain text agent configuration" }, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/llms/agent-configuration/{adapterType}.txt",
  tags: ["llms"],
  summary: "Get agent configuration for a specific adapter type",
  request: { params: z.object({ adapterType: z.string() }) },
  responses: { 200: { description: "Plain text agent configuration" }, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/llms/agent-icons.txt",
  tags: ["llms"],
  summary: "Get agent icon names as plain text",
  responses: { 200: { description: "Plain text icon list" }, 401: r.unauthorized },
});

// ─── Issues (legacy / misc) ───────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/issues",
  tags: ["issues"],
  summary: "Legacy — returns error directing to /api/companies/{companyId}/issues",
  responses: { 400: r.badRequest },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/comments/{commentId}",
  tags: ["issues"],
  summary: "Get a single issue comment",
  request: { params: z.object({ id: z.string(), commentId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

// ─── Org chart images ─────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/org.svg",
  tags: ["companies"],
  summary: "Get org chart as SVG",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: { description: "SVG image" }, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/org.png",
  tags: ["companies"],
  summary: "Get org chart as PNG",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: { description: "PNG image" }, 401: r.unauthorized },
});

// ─── Company portability (legacy routes) ─────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/issues",
  tags: ["companies"],
  summary: "Legacy — returns error directing to correct issues path",
  responses: { 400: r.badRequest },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/export",
  tags: ["companies"],
  summary: "Export a company (legacy singular form)",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(companyPortabilityExportSchema),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/import/preview",
  tags: ["companies"],
  summary: "Preview a company import (legacy route)",
  request: { body: jsonBody(companyPortabilityPreviewSchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/import",
  tags: ["companies"],
  summary: "Apply a company import (legacy route)",
  request: { body: jsonBody(companyPortabilityImportSchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Board claim & CLI auth ───────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/board-claim/{token}",
  tags: ["access"],
  summary: "Get board claim details by token",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: r.ok(), 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/board-claim/{token}/claim",
  tags: ["access"],
  summary: "Claim a board token",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/cli-auth/challenges/{id}",
  tags: ["access"],
  summary: "Get a CLI auth challenge",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 404: r.notFound },
});

// ─── Invite onboarding ────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/invites/{token}/logo",
  tags: ["access"],
  summary: "Get company logo for an invite",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: { description: "Image file" }, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/invites/{token}/onboarding",
  tags: ["access"],
  summary: "Get onboarding data for an invite",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: r.ok(), 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/invites/{token}/onboarding.txt",
  tags: ["access"],
  summary: "Get onboarding instructions as plain text",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: { description: "Plain text onboarding instructions" }, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/invites/{token}/skills/index",
  tags: ["access"],
  summary: "Get skills index for an invite",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: r.ok(), 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/invites/{token}/skills/{skillName}",
  tags: ["access"],
  summary: "Get a skill by name for an invite",
  request: { params: z.object({ token: z.string(), skillName: z.string() }) },
  responses: { 200: r.ok(), 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/invites/{token}/test-resolution",
  tags: ["access"],
  summary: "Test invite token resolution",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: r.ok(), 404: r.notFound },
});

// ─── Admin ────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/admin/users/{userId}/company-access",
  tags: ["admin"],
  summary: "Get company access for a user (admin)",
  request: { params: z.object({ userId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "put",
  path: "/api/admin/users/{userId}/company-access",
  tags: ["admin"],
  summary: "Set company access for a user (admin)",
  request: {
    params: z.object({ userId: z.string() }),
    body: jsonBody(updateUserCompanyAccessSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "post",
  path: "/api/admin/users/{userId}/promote-instance-admin",
  tags: ["admin"],
  summary: "Promote a user to instance admin",
  request: { params: z.object({ userId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/admin/users/{userId}/demote-instance-admin",
  tags: ["admin"],
  summary: "Demote a user from instance admin",
  request: { params: z.object({ userId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

// ─── Project workspace runtime ────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/projects/{id}/workspaces/{workspaceId}/runtime-services/{action}",
  tags: ["projects"],
  summary: "Control a runtime service in a project workspace",
  request: {
    params: z.object({ id: z.string(), workspaceId: z.string(), action: z.string() }),
    body: jsonBody(workspaceRuntimeControlTargetSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/projects/{id}/workspaces/{workspaceId}/runtime-commands/{action}",
  tags: ["projects"],
  summary: "Run a runtime command in a project workspace",
  request: {
    params: z.object({ id: z.string(), workspaceId: z.string(), action: z.string() }),
    body: jsonBody(workspaceRuntimeControlTargetSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Plugin bridge stream ─────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/plugins/{pluginId}/bridge/stream/{channel}",
  tags: ["plugins"],
  summary: "Subscribe to a plugin bridge SSE stream",
  request: { params: z.object({ pluginId: z.string(), channel: z.string() }) },
  responses: {
    200: { description: "Server-sent event stream (text/event-stream)" },
    401: r.unauthorized,
  },
});

// ─── Plugin UI static ─────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/_plugins/{pluginId}/ui/{filePath}",
  tags: ["plugins"],
  summary: "Serve plugin UI static file",
  request: { params: z.object({ pluginId: z.string(), filePath: z.string() }) },
  responses: { 200: { description: "Static file content" }, 404: r.notFound },
});

// ─── Adapter UI parser ────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/adapters/{type}/ui-parser.js",
  tags: ["adapters"],
  summary: "Get adapter UI parser script",
  request: { params: z.object({ type: z.string() }) },
  responses: { 200: { description: "JavaScript file" }, 404: r.notFound },
});

// ─── Spec builder ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildOpenApiSpec(): any {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return applyDocumentFixups(generator.generateDocument({
    openapi: "3.0.0",
    info: {
      title: "Paperclip API",
      version: "1.0.0",
      description: "REST API for the Paperclip AI agent management platform",
    },
    servers: [{ url: "/" }],
  }));
}
