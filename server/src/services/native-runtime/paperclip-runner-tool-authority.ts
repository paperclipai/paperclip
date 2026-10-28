import { priorRecoveryApiReceipt } from "../recovery-effect-receipts.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { caseHandoffService } from "../case-handoffs.js";
import { caseIdForApiCapture, createNativeCaseSchema, executeNativeCaseTool, NATIVE_CASE_OPERATIONS } from "./native-case-tools.js";
import { executeNativeWorkflowTool } from "./native-workflow-tools.js";
import { assertNoCaseHandoffMutation } from "../heartbeat/case-handoff-lifecycle.js";
import { handoffCaseSchema } from "@paperclipai/shared";
import { skillAccessService } from "../skill-access.js";
import { withExternalExecutionAdmission, type ExternalAdmissionTransaction } from "../../modules/external-agents/index.js";
import { callTaskWorkspaceTool, pendingTaskRepositoryContinuation } from "../task-workspace-tools.js";
import { TaskAttachmentReadCache, TASK_ATTACHMENT_DEFINITIONS, TASK_ATTACHMENT_SCHEMAS, listTaskAttachments, readTaskAttachment } from "./runner-task-attachments.js";
import { RUNNER_BRIDGE_READ_OPERATIONS, RUNNER_BRIDGE_SCHEMAS, runnerBridgeDefinitions, readAssignedSkill, executeWorkspaceTool, readWorkspaceUploadFile, settleRunnerBridgeRead, assertRunnerWorkspacePathAllowed } from "./runner-bridge-tools.js";
import type { NativeRuntimeContextSnapshot } from "../../vendor/paperclip-runner/index.js";
import { assertCanManageIssueMonitor, eligibleIssueMonitorWait, prepareIssueMonitorUpdate, setTaskMonitorSchema, summarizeIssueMonitor } from "../issue-monitors.js";
import { readTaskQuestionContext } from "../issue-question-context.js";
import { isConversation } from "../agent-conversations.js";
import { setIssueTitle } from "../issue-title.js";
import { externalObjectService } from "../external-objects.js";
import { instanceSettingsService } from "../instance-settings.js";
import { fastResponseHistoryBody, setIssueTitleSchema } from "@paperclipai/shared";
import { authorizeInstructionCommit } from "../agent-instruction-authorization.js";
import { executeAgentInstructionTool } from "./agent-instruction-tools.js";
import { createReadStream } from "node:fs";
import { publicChatTaskUrl } from "../chat-task-url.js";
import { agentCommentaryToolInputSchema } from "@paperclipai/shared";
import { submitAgentCommentary } from "../agent-commentary.js";
import type { createAssignedMcpTools } from "./assigned-mcp-tools.js";
import { captureRunnerToolResult, fitRunnerToolResultPage, READ_TOOL_RESULT, READ_TOOL_RESULT_DEFINITION, readToolResultSchema, RUNNER_TOOL_RESULT_MAX_BYTES } from "./runner-tool-results.js";
import { assertAssignableAgent } from "../agent-assignability.js";
import { approvalReadSqlCondition, canActorReadApproval, authorizationService, issueReadSqlCondition, type AuthorizationActor } from "../authorization.js";
import { resolveCoreTrustPreset } from "../trust-preset-resolver.js";
import { normalizeIssueExecutionPolicy, redactIssueMonitorExternalRef } from "../issue-execution-policy.js";
import { buildLowTrustSourceTrust, isLowTrustQuarantined, LOW_TRUST_QUARANTINED_BODY, resolveActorSourceTrustForIssue, sanitizeQuarantinedCommentForHigherTrust } from "../source-trust.js";
import { handoffPlanContext } from "./handoff-plan-context.js";
import { callCreateSkillTool, callUpdateSkillTool } from "../skill-tools.js";
import { callProjectTool } from "../project-tools.js";
import { isConnectorTool, executeConnectorTool, type ConnectorAssignment } from "../connector-runtime.js";
import { resolveNativeRuntimeMcpSnapshot } from "./runtime-context.js";
import { connectionIntentService } from "../connection-intents.js";
import { RUNTIME_CONNECTION_TOOL_DEFINITIONS } from "../connection-tool-definitions.js";
import { connectionsSearchInputSchema, connectionRequestInputSchema, CONNECTION_INTENT_AGENT_GUIDANCE } from "@paperclipai/shared";
import { createHash, randomUUID } from "node:crypto";
import { paperclipChatFilePreparationDelivery } from "@paperclipai/adapter-utils/chat-file-delivery";
import {
  isPaperclipExternalChatContractTurn,
  normalizePaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import { runnerApiToolsEnabled } from "./runner-api-rollout.js";
import { openRunnerApiWorkspaceFile } from "./runner-api-files.js";
import { basename } from "node:path";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";
import { getStorageService } from "../../storage/index.js";
import type { StorageService } from "../../storage/types.js";
import { assetService } from "../assets.js";
import { canActorReadAssetContent } from "../asset-content-access.js";
import { getSecretProvider } from "../../secrets/provider-registry.js";
import { runnerApiSensitiveResponse } from "./runner-api-sensitive-response.js";
import { workspaceFileResourceService } from "../workspace-file-resources.js";
import { badRequest, forbidden, notFound, HttpError } from "../../errors.js";
import { runnerApiCatalog, searchRunnerApi } from "./runner-api-catalog.js";
import { executeRunnerApi, validateRunnerApiCall, RUNNER_API_MAX_BYTES, type RunnerApiCall, type RunnerApiFile, type RunnerApiIo } from "./runner-api-client.js";
import { acquireRunnerApiResponseSlot, runnerApiCompanyCaptureMaxBytes, RUNNER_API_RESPONSE_MAX_BYTES, RUNNER_API_RESPONSE_RUN_MAX_BYTES, RunnerApiResponseLimitError } from "./runner-api-response-limits.js";
import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  authUsers,
  companyMemberships,
  companySkills,
  activityLog,
  assets,
  runnerApiResponseReservations,
  agents,
  agentWakeupRequests,
  chatEndpoints,
  chatConversations,
  companies,
  documentRevisions,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueAttachments,
  issueDocuments,
  issues,
  projects,
  issueThreadInteractions,
} from "@paperclipai/db";
import { CAPABILITY_CANONICAL_OPERATIONS, CAPABILITY_SEMANTIC_TOOL_CATALOG, runnerCodexDynamicToolsFit, SemanticToolOutcomeUnknownError } from "../../vendor/paperclip-runner/index.js";
import { agentService } from "../agents.js";
import { approvalService } from "../approvals.js";
import { documentService } from "../documents.js";
import { issueService } from "../issues.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { getNativeReviewAssignment, readNativeReviewAssignmentContext, type NativeReviewAssignmentContext } from "./native-review-participant.js";
import { childReviewOutcomes } from "./child-review-outcomes.js";
import { logActivity, persistActivity, publishActivity } from "../activity-log.js";
import { captureRunIdentity } from "../run-identity.js";
import { prepareNativeRunnerFileHandoff, readVerifiedWorkspaceFile, type RemoteWorkspaceFileReader } from "./native-runner-file-handoff.js";
import { MAX_ATTACHMENT_BYTES } from "../../attachment-types.js";
import {
  READ_CURRENT_WAKE_COMMENTS_TOOL_DEFINITION,
  READ_CURRENT_WAKE_COMMENTS_TOOL_NAME,
  readCurrentWakeComments,
  type CurrentWakeCommentsBinding,
} from "./current-wake-comments.js";
import {
  readPublishedGitHubReviewCompletionContinuation,
  authorizeChatAttachmentReuse,
  authorizeChatConversationForBoundRun,
  LIST_CHAT_ATTACHMENTS_TOOL_DEFINITION,
  LIST_CHAT_ATTACHMENTS_TOOL_NAME,
  listAuthorizedChatAttachments,
  prepareReusedChatAttachment,
  REUSE_CHAT_ATTACHMENT_TOOL_DEFINITION,
  REUSE_CHAT_ATTACHMENT_TOOL_NAME,
  type ChatAttachmentReuseSource,
} from "./chat-attachment-reuse.js";
import {
  READ_CHAT_ATTACHMENT_TOOL_DEFINITION,
  READ_CHAT_ATTACHMENT_TOOL_NAME,
  type NativeChatAttachmentReadScope,
} from "./chat-attachment-read.js";

const EXTERNAL_WORKSPACE_OPERATIONS = new Set(["get_workspace", "list_workspaces", "select_workspace", "prepare_repository", "register_deliverable"]);
const IMPLEMENTED_OPERATIONS = new Set([
  "submit_complaint", "submit_suggestion",
  "read_agent_instructions", "update_agent_instructions", "get_agent_instruction_history", "restore_agent_instructions",
  "search_api", "call_api", "hire_agent",
  "get_task_context", "get_task_history", "search_tasks", "report_progress", "set_task_title", "set_task_monitor",
  "request_human_input", "handoff_case", ...NATIVE_CASE_OPERATIONS,
  "get_workspace", "list_workspaces", "select_workspace", "prepare_repository", "create_skill", "update_skill", "create_task", "reassign_task", "set_dependencies", "create_project", "list_project_repositories", "list_projects", "register_deliverable",
  "list_documents", "read_document", "list_document_revisions", "write_document",
  "list_agents", "get_agent", "list_approvals", "get_approval", "get_approval_context",
]);

/** Closed first-party native Muse profile. No connector, generic API, credential or workspace grants. */
export const MUSE_NATIVE_OPERATIONS = new Set([
  "get_identity", "list_people",
  "submit_complaint", "submit_suggestion", "get_task_context", "get_task_history", "search_tasks", "report_progress", "set_task_title", "set_task_monitor",
  "create_task", "handoff_case", ...NATIVE_CASE_OPERATIONS, "reassign_task", "set_dependencies", "create_project", "list_projects", "list_documents", "read_document", "list_document_revisions", "write_document",
  "list_agents", "get_agent", "list_approvals", "get_approval", "get_approval_context", "read_current_wake_comments", "resolve_review",
]);

const NATIVE_REVIEW_READ_TOOLS = new Set([
  "get_task_context", "get_task_history", "list_documents", "read_document", "list_document_revisions",
]);

// The owning catalogs classify first-party reads. Recovery still calls execute(),
// which rechecks the current tool advertisement, run, permissions and file scope.
// External connector annotations never authorize replay of an uncertain effect.
const RECOVERABLE_READ_OPERATIONS = new Set([
  ...CAPABILITY_CANONICAL_OPERATIONS.filter(tool => IMPLEMENTED_OPERATIONS.has(tool.operationId) && tool.sideEffectClass === "read")
    .map(tool => tool.operationId),
  ...RUNNER_BRIDGE_READ_OPERATIONS,
  ...Object.keys(TASK_ATTACHMENT_SCHEMAS),
  READ_CURRENT_WAKE_COMMENTS_TOOL_NAME, LIST_CHAT_ATTACHMENTS_TOOL_NAME, READ_CHAT_ATTACHMENT_TOOL_NAME,
  READ_TOOL_RESULT, "connections_search",
]);
const RECOVERABLE_READ_ERRORS = new Set([
  "paperclip_runner_document_not_found", "paperclip_runner_agent_not_found",
  "paperclip_runner_approval_not_found", "paperclip_runner_tool_input_invalid",
]);
const readOnlyApiMethod = (method: string) => ["GET", "HEAD", "OPTIONS"].includes(method);
const toolCallKey = (callId: string) => createHash("sha256").update(callId).digest("hex");
const toolInputDigest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

type NativeIssueDocument = NonNullable<Awaited<ReturnType<ReturnType<typeof documentService>["getIssueDocumentByKey"]>>>;
type NativeDocumentContent = { id: string | null; documentId: string; body: string; changeSummary?: string | null };
const UNKNOWN_DOCUMENT_REVISION_BODY = "[Document revision content omitted: historical source trust could not be established.]";

type Binding = {
  /** Server-derived scope for one addressed native completion review. */
  nativeReview?: NativeReviewAssignmentContext;
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
  normalizedSessionId?: string;
  pinnedMcpDigest?: string;
  /** Server-owned API origin and storage; never obtained from tool input. */
  apiUrl?: string;
  storage?: StorageService;
  /** Server-owned suppression for baseline evals; true never overrides operator opt-in. */
  connectorAssignments?: Pick<ConnectorAssignment, "tools">[];
  assignedMcpTools?: Awaited<ReturnType<typeof createAssignedMcpTools>>;
  apiToolsEnabled?: boolean;
  workMode?: "standard" | "planning" | "ask";
  casesEnabled?: boolean;
  workspaceRoot?: string;
  workspaceBridge?: boolean;
  /** Pinned provider identity; configuration edits cannot remove API file guards. */
  dotRuntime?: boolean;
  museRuntime?: boolean;
  externalAuthorizingUserId?: string;
  /** Grok retains its provider apps; this release exposes first-party Paperclip tools only. */
  firstPartyOnly?: boolean;
  /** Operator-approved Dot attachment access, pinned when the turn opens. */
  taskAttachmentRead?: boolean;
  runtimeContext?: NativeRuntimeContextSnapshot;
  assertBridgeAuthority?: (database?: Db) => Promise<void>;
  executionTargetKind?: "local" | "remote";
  readRemoteWorkspaceFile?: RemoteWorkspaceFileReader;
  readRemoteTaskFile?: RemoteWorkspaceFileReader;
  readRemoteApiFile?: (path: string, maxBytes: number) => Promise<Buffer>;
  currentWakeComments?: CurrentWakeCommentsBinding;
  chatAttachmentReadScope?: NativeChatAttachmentReadScope;
  syncIssueExternalObjects?: (issueId: string) => Promise<void>;
  stopTaskForReassignment?: (target: { companyId: string; issueId: string; agentId: string; runId: string | null }) => Promise<void>;
  enqueueWakeup?: (agentId: string, options: {
    source: "assignment" | "automation";
    triggerDetail: "system";
    reason: "issue_assigned" | "issue_commented";
    payload: Record<string, unknown>;
    idempotencyKey: string;
    requestedByActorType: "agent";
    requestedByActorId: string;
    contextSnapshot: Record<string, unknown>;
    issueStateGuard?: { statuses: string[]; assigneeAgentId: string; statusVersion?: number };
  }) => Promise<unknown>;
};

type ToolReceipt = {
  operationId: string;
  input: unknown;
  result: unknown;
};

// Coalesce live callers, but never use this process-local lock as crash proof.
// The database attempt record below is the authority after process loss.
const instructionCallLocks = new WeakMap<Db, Map<string, Promise<void>>>();
const instructionPreWriteFailureStatuses = new Set([400, 401, 403, 404, 409, 422]);
async function withInstructionCallLock<T>(db: Db, key: string, work: () => Promise<T>): Promise<T> {
  let locks = instructionCallLocks.get(db);
  if (!locks) instructionCallLocks.set(db, locks = new Map());
  const previous = locks.get(key);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  locks.set(key, pending);
  await previous;
  try { return await work(); }
  finally {
    release();
    if (locks.get(key) === pending) locks.delete(key);
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function apiToolResult(value: unknown) {
  const { operationId, ...response } = record(value);
  return { ...response, apiOperationId: operationId };
}

const TASK_API_PATHS: Readonly<Record<string, readonly [string, string]>> = {
  get_task: ["GET", "/api/issues/{id}"],
  comment_on_task: ["POST", "/api/issues/{id}/comments"],
  list_task_documents: ["GET", "/api/issues/{id}/documents"],
  read_task_document: ["GET", "/api/issues/{id}/documents/{key}"],
  write_task_document: ["PUT", "/api/issues/{id}/documents/{key}"],
};

function taskBridgeApiRequest(tool: string, input: Record<string, any>): RunnerApiCall {
  const [method, path] = TASK_API_PATHS[tool]!;
  const operation = runnerApiCatalog().find(operation => operation.method === method && operation.path === path);
  if (!operation) throw new Error("runner_task_api_operation_unavailable");
  const body = tool === "comment_on_task" ? { body: input.body } : tool === "write_task_document"
    ? { title: input.title, format: "markdown", body: input.body, baseRevisionId: input.baseRevisionId } : undefined;
  return { operationId: operation.operationId, pathParams: { id: input.taskId, ...(input.key ? { key: input.key } : {}) }, ...(body ? { body } : {}) };
}

function hireAgentApiRequest(input: Record<string, unknown>, binding: Pick<Binding, "companyId" | "agentId" | "issueId">): RunnerApiCall {
  const body: Record<string, unknown> = {
    name: requiredString(input.name), adapterType: "paperclip_runner", inheritRuntimeFrom: "caller",
    reportsTo: binding.agentId, sourceIssueId: binding.issueId,
  };
  if (input.role !== undefined) body.role = input.role;
  if (input.title !== undefined) body.title = input.title;
  if (input.capabilities !== undefined) body.capabilities = input.capabilities;
  if (typeof input.instructions === "string" && input.instructions.trim()) {
    body.instructionsBundle = { entryFile: "AGENTS.md", files: { "AGENTS.md": input.instructions } };
  }
  return { operationId: "POST /api/companies/{companyId}/agent-hires", pathParams: { companyId: binding.companyId }, body };
}

function hireAgentResult(value: unknown, provider: unknown) {
  return { ...apiToolResult(value), ...(provider === "openai_dot" ? { setupRequired: "This creates a separate Paperclip Dot agent. Its operator must pair a separate OpenAI Dot before it can run. The existing Dot binding and workspace permission are never inherited." } : {}) };
}

export class PaperclipRunnerToolAuthority {
  #taskAttachmentCache = new TaskAttachmentReadCache();
  close() { this.#taskAttachmentCache.close(); }
  constructor(readonly db: Db, readonly binding: Binding) {}

  definitions(): Array<Record<string, unknown>> {
    if (this.binding.nativeReview) {
      // Scope Paperclip control-plane actions. Provider file and shell access
      // still follow the configured agent/environment policy, including tests.
      return [
        ...CAPABILITY_SEMANTIC_TOOL_CATALOG
          .filter((tool) => NATIVE_REVIEW_READ_TOOLS.has(tool.operationId))
          .map((tool) => ({ name: tool.operationId, description: tool.description, inputSchema: tool.inputSchema })),
        {
          name: "resolve_review",
          description: "Record your decision on the one completion review assigned to this run. Inspect the submitted work first. Accept only if it meets the request; otherwise reject with specific changes. This does not change task ownership. After recording the decision, report your review complete with paperclip_finish. Do not redo the worker's task or wait for your own parent task to become runnable.",
          inputSchema: {
            type: "object", additionalProperties: false,
            properties: {
              decision: { type: "string", enum: ["accept", "reject"] },
              reason: { type: "string", description: "Required when rejecting: the specific changes the worker must make." },
            },
            required: ["decision"],
          },
        },
      ];
    }
    const workMode = this.binding.workMode ?? "standard";
    const definitions: Array<Record<string, unknown>> =
      CAPABILITY_SEMANTIC_TOOL_CATALOG.filter(
        (descriptor) =>
          IMPLEMENTED_OPERATIONS.has(descriptor.operationId) &&
          (!(descriptor.operationId === "handoff_case" || NATIVE_CASE_OPERATIONS.has(descriptor.operationId)) || this.binding.casesEnabled === true) &&
          (!this.binding.firstPartyOnly || !EXTERNAL_WORKSPACE_OPERATIONS.has(descriptor.operationId)) &&
          (runnerApiToolsEnabled(
            this.binding.companyId,
            this.binding.apiToolsEnabled,
          ) ||
            !["search_api", "call_api", "hire_agent"].includes(descriptor.operationId)) &&
          descriptor.allowedModes.includes(workMode) &&
          (descriptor.operationId !== "register_deliverable" ||
            (Boolean(this.binding.workspaceRoot) &&
              ((this.binding.executionTargetKind ?? "local") === "local" || Boolean(this.binding.readRemoteWorkspaceFile || this.binding.readRemoteTaskFile)))),
      ).map((descriptor) => ({
        name: descriptor.operationId,
        description:
          descriptor.operationId === "register_deliverable"
            ? "Prepare one verified workspace file for Paperclip's final task or external-chat response. This records the attachment, work product, and explicit same-run selection; it does not confirm provider delivery."
            : descriptor.description,
        inputSchema:
          descriptor.operationId === "register_deliverable"
            ? {
                ...descriptor.inputSchema,
                properties: {
                  ...descriptor.inputSchema.properties,
                  filename: {
                    ...(descriptor.inputSchema.properties?.filename ?? {}),
                    description:
                      "Basename for the prepared attachment. Directory components are rejected.",
                  },
                  byteSize: {
                    ...(descriptor.inputSchema.properties?.byteSize ?? {}),
                    minimum: 1,
                    maximum: MAX_ATTACHMENT_BYTES,
                  },
                  contentRef: {
                    ...(descriptor.inputSchema.properties?.contentRef ?? {}),
                    description: this.binding.readRemoteTaskFile
                      ? "Path to the file on the execution host: workspace-relative or absolute within a location granted to this task, including its agent home."
                      : "Workspace-relative source path. Absolute paths, URLs, traversal, and symlinks are rejected.",
                  },
                },
              }
            : descriptor.inputSchema,
      }));
    // Keep the provider session's direct tool catalog stable across ordinary
    // and truncated external-chat turns: Codex thread/resume cannot add tools,
    // so a reader missing at thread/start stays missing. Execution still fails
    // closed unless this exact run carries the server-verified binding/scope.
    definitions.push(READ_CURRENT_WAKE_COMMENTS_TOOL_DEFINITION);
    definitions.push(LIST_CHAT_ATTACHMENTS_TOOL_DEFINITION);
    definitions.push(REUSE_CHAT_ATTACHMENT_TOOL_DEFINITION);
    definitions.push(READ_CHAT_ATTACHMENT_TOOL_DEFINITION);
    if (this.binding.taskAttachmentRead) definitions.push(...TASK_ATTACHMENT_DEFINITIONS);
    definitions.push(...runnerBridgeDefinitions({ workspace: !this.binding.firstPartyOnly && !!this.binding.workspaceRoot && this.binding.workspaceBridge === true, skills: !!this.binding.runtimeContext, api: runnerApiToolsEnabled(this.binding.companyId, this.binding.apiToolsEnabled), mode: workMode }));
    const connectionTools = this.binding.firstPartyOnly ? [] : [...RUNTIME_CONNECTION_TOOL_DEFINITIONS,
      ...(this.binding.connectorAssignments ?? []).flatMap((assignment) => assignment.tools)];
    if (!this.binding.firstPartyOnly && this.binding.assignedMcpTools) definitions.push(READ_TOOL_RESULT_DEFINITION);
    const assignedTools = this.binding.firstPartyOnly ? [] : this.binding.assignedMcpTools?.definitions((tools) =>
      runnerCodexDynamicToolsFit([...connectionTools, ...tools, ...definitions])) ?? [];
    const all = [...connectionTools, ...assignedTools, ...definitions];
    return this.binding.museRuntime ? all.filter(definition => MUSE_NATIVE_OPERATIONS.has(String(definition.name))) : all;
  }

  async recover(call: Parameters<PaperclipRunnerToolAuthority["execute"]>[0]): Promise<{ result: unknown; isError?: boolean } | null> {
    await this.#assertToolScope(call.tool);
    if (!this.binding.museRuntime) await this.binding.assertBridgeAuthority?.();
    const context = await this.#boundContext();
    const { run } = context;
    if (RECOVERABLE_READ_OPERATIONS.has(call.tool)) return this.#recoverRead(call);
    if (call.tool === "update_case" || call.tool === "create_workflow" || call.tool === "update_workflow") {
      const callApi = (receiptKey: string, request: RunnerApiCall) => this.#callApi(receiptKey, request, {
        dedicatedCaseTool: call.tool, caseId: request.pathParams?.id, receiptOnly: true,
      });
      const result = call.tool === "update_case"
        ? await executeNativeCaseTool({ db: this.db, binding: this.binding, actor: this.#privacyActor(run),
            tool: call.tool, arguments: call.arguments, callApi })
        : await executeNativeWorkflowTool({ db: this.db, binding: this.binding,
            tool: call.tool, arguments: call.arguments, callApi });
      return result === undefined ? null : { result };
    }
    const input = record(call.arguments);
    if (call.tool === "create_project") {
      const apiUrl = this.binding.apiUrl ?? process.env.PAPERCLIP_API_URL;
      const token = this.#apiToken(context);
      if (!apiUrl || !token) throw new Error("Project tool authentication is unavailable");
      const result = await callProjectTool({ name: call.tool, arguments: input, apiUrl, token,
        companyId: this.binding.companyId, issueId: this.binding.issueId, agentId: this.binding.agentId,
        conversation: Boolean(context.issue.conversationAgentId), receiptOnly: true });
      return result === undefined ? null : { result };
    }
    if (call.tool === "update_agent_instructions" || call.tool === "restore_agent_instructions") {
      const receipt = record(record(run.resultJson?.semanticToolReceipts)[`instruction:${call.callId}`]);
      if (!Object.hasOwn(receipt, "result")) return null;
      return { result: await this.#withInstructionMutationReceipt(call.tool, call.callId, input, true) };
    }
    // Recovery goes through the receipt owner: it must use the same parsed
    // input, current authority and safe post-commit dispatch as an ordinary
    // retry, without ever falling through to an uncertain mutation.
    let recovered: unknown;
    if (call.tool === "set_task_title") recovered = await this.#setTaskTitle(input, true);
    else if (call.tool === "submit_complaint" || call.tool === "submit_suggestion") recovered = await this.#submitCommentary(call.tool, input, true);
    else if (call.tool === "create_task") recovered = await this.#createTask(input, null, true);
    else if (call.tool === "reassign_task") recovered = await this.#reassignTask(input, true);
    else if (call.tool === "set_task_monitor") recovered = await this.#setTaskMonitor(input, true);
    else if (typeof input.idempotencyKey === "string" && input.idempotencyKey.trim()) {
      // The other semantic mutations retain their original input and use
      // requiredString for their retry key. A null effect is receipt-only.
      recovered = await this.#withMutationReceipt(call.tool, requiredString(input.idempotencyKey), input, null);
    }
    if (recovered !== undefined) return { result: recovered };

    const callKey = toolCallKey(call.callId);
    if (call.tool === "call_api" || call.tool === "hire_agent" || Object.hasOwn(TASK_API_PATHS, call.tool)) {
      if (!runnerApiToolsEnabled(this.binding.companyId, this.binding.apiToolsEnabled)) return null;
      let request = call.arguments;
      if (Object.hasOwn(TASK_API_PATHS, call.tool)) {
        if (!this.definitions().some(definition => definition.name === call.tool)) return null;
        const parsed = RUNNER_BRIDGE_SCHEMAS.get(call.tool)!.safeParse(call.arguments);
        if (!parsed.success) return null;
        request = taskBridgeApiRequest(call.tool, parsed.data as Record<string, any>);
      } else if (call.tool === "hire_agent") request = hireAgentApiRequest(input, this.binding);
      let validated: ReturnType<typeof validateRunnerApiCall>;
      try {
        validated = validateRunnerApiCall(request, {
          ...this.binding, issueIdentifier: context.issue.identifier, workMode: context.issue.workMode,
        });
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return null;
        throw error;
      }
      const { input: apiInput, operation } = validated;
      if (readOnlyApiMethod(operation.method)) return this.#recoverRead(call);
      const result = await this.#completedApiReceipt(run.resultJson?.apiToolReceipts, call.callId, apiInput);
      if (result === undefined) return null;
      return { result: call.tool === "hire_agent" ? hireAgentResult(result, context.actor.adapterConfig?.provider) : apiToolResult(result) };
    }
    if (call.tool === "workspace_write" || call.tool === "workspace_run") {
      const bridge = record(record(run.resultJson?.bridgeToolReceipts)[callKey]);
      if (bridge.state === "completed" && bridge.tool === call.tool
        && bridge.digest === toolInputDigest({ tool: call.tool, arguments: call.arguments })
        && Object.hasOwn(bridge, "result")) return { result: bridge.result };
    }
    return null;
  }

  async #recoverRead(call: Parameters<PaperclipRunnerToolAuthority["execute"]>[0]) {
    try {
      return { result: await this.execute(call) };
    } catch (error) {
      // A known read failure is a tool outcome, not a failed transport. Keep
      // authorization, uncertain effects, and unexpected storage errors fatal.
      if (!(error instanceof Error && (RECOVERABLE_READ_ERRORS.has(error.message)
        || (error instanceof HttpError && [400, 404, 422].includes(error.status))))) throw error;
      await this.binding.assertBridgeAuthority?.();
      await this.#boundContext();
      return { isError: true, result: {
        success: false, contentItems: [{ type: "inputText", text: error.message }],
      } };
    }
  }

  async #completedApiReceipt(receipts: unknown, callId: string, input: RunnerApiCall): Promise<unknown> {
    const receipt = record(record(receipts)[toolCallKey(callId)]);
    if (receipt.state !== "completed" || receipt.digest !== toolInputDigest(input)) return undefined;
    const result = await this.#apiReceiptResult(receipt);
    return record(result).outcome === "unknown" ? undefined : result;
  }

  async #apiReceiptResult(receipt: { encryptedResult?: unknown; result?: unknown }): Promise<unknown> {
    if (!receipt.encryptedResult) return receipt.result;
    const text = await getSecretProvider("local_encrypted").resolveVersion({ material: record(receipt.encryptedResult), externalRef: null });
    return JSON.parse(text);
  }

  async #assertToolScope(tool: string): Promise<void> {
    if (this.binding.museRuntime) {
      await this.binding.assertBridgeAuthority?.();
      if (!MUSE_NATIVE_OPERATIONS.has(tool)) throw forbidden("This operation is outside the Muse first-party runtime profile");
    }
    if (this.binding.firstPartyOnly && (EXTERNAL_WORKSPACE_OPERATIONS.has(tool) || tool.startsWith("workspace_"))) throw forbidden("Paperclip workspace access is unavailable to this Grok Bot session.");
    if (this.binding.nativeReview && tool !== "resolve_review" && !NATIVE_REVIEW_READ_TOOLS.has(tool)) {
      throw forbidden("This review run may only inspect the assigned task and resolve its review.");
    }
  }

  async execute(call: {
    tool: string;
    callId: string;
    arguments: unknown;
  }): Promise<unknown> {
    if ((call.tool === "handoff_case" || call.tool === "create_case") && !this.binding.nativeReview) {
      if (this.binding.workMode && this.binding.workMode !== "standard") throw forbidden("Case tools require standard work mode");
      const create = call.tool === "create_case" ? createNativeCaseSchema.parse(call.arguments) : null;
      if (this.binding.casesEnabled !== true) throw forbidden("Cases are disabled");
      if (this.binding.museRuntime) await this.binding.assertBridgeAuthority?.();
      // Both operations use the principal-scoped handoff ledger. A committed
      // receipt stays replayable after ownership moved; fresh work reauthorizes.
      const [run] = await this.db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, this.binding.runId),
        eq(heartbeatRuns.companyId, this.binding.companyId), eq(heartbeatRuns.agentId, this.binding.agentId)));
      if (!run) throw forbidden("Run binding unavailable");
      const request = create ? {
        idempotencyKey: create.idempotencyKey,
        case: { create: { caseType: create.caseType, title: create.title,
          ...(create.summary !== undefined ? { summary: create.summary } : {}),
          ...(create.fields !== undefined ? { fields: create.fields } : {}),
          ...(create.projectId !== undefined ? { projectId: create.projectId } : {}),
        } },
        ...create.kickoff,
        workflow_document_text: create.workflow_document_text,
        ...(create.workflowId !== undefined ? { workflowId: create.workflowId } : {}),
        ...(create.initialDocuments !== undefined ? { initialDocuments: create.initialDocuments } : {}),
      } : call.arguments;
      return caseHandoffService(this.db).handoff(this.binding.companyId, this.#privacyActor(run), handoffCaseSchema.parse(request), {
        beforeAccept: async tx => { await this.#lockAuthorizedMutationContext(tx); },
      });
    }
    await this.#assertToolScope(call.tool);
    if (this.binding.nativeReview && call.tool === "resolve_review") return this.#resolveReview(call.arguments);
    if (Object.hasOwn(TASK_ATTACHMENT_SCHEMAS, call.tool)) {
      const authorize = async () => {
        const current = await this.#boundContext();
        if (!this.binding.taskAttachmentRead || current.actor.adapterType !== "paperclip_runner"
          || current.actor.adapterConfig?.provider !== "openai_dot" || current.actor.adapterConfig?.dotAttachmentAccess !== true)
          throw forbidden("Dot task attachment reading was not enabled or was disabled");
        await this.binding.assertBridgeAuthority?.();
      };
      await authorize();
      const schema = TASK_ATTACHMENT_SCHEMAS[call.tool as keyof typeof TASK_ATTACHMENT_SCHEMAS];
      const parsed = schema.safeParse(call.arguments);
      if (!parsed.success) return { outcome: "failed", code: "runner_attachment_invalid_arguments", message: "Arguments do not match this tool's advertised schema." };
      return settleRunnerBridgeRead(async () => {
        if (call.tool === "read_task_attachment") return readTaskAttachment({ db: this.db, binding: this.binding, arguments: parsed.data, storage: this.binding.storage, cache: this.#taskAttachmentCache, authorize });
        const result = await listTaskAttachments(this.db, this.binding, (parsed.data as { after?: string }).after);
        await authorize();
        return result;
      });
    }
    if (RUNNER_BRIDGE_SCHEMAS.has(call.tool)) {
      await this.#boundContext();
      if (!this.definitions().some(definition => definition.name === call.tool)) throw forbidden("Tool is not available to this run");
      const parsed = RUNNER_BRIDGE_SCHEMAS.get(call.tool)!.safeParse(call.arguments);
      if (!parsed.success) return { outcome: "failed", code: "runner_bridge_invalid_arguments", message: "Arguments do not match this tool's advertised schema." };
      const input = parsed.data as Record<string, any>;
      if (call.tool.startsWith("workspace_")) {
        const authorize = async () => { const current = await this.#boundContext();
          if (current.actor.adapterConfig?.dotWorkspaceAccess !== true) throw forbidden("Dot workspace access was disabled");
          await this.binding.assertBridgeAuthority?.();
          if (["workspace_write", "workspace_run"].includes(call.tool) && current.issue.workMode !== "standard") throw forbidden("This work mode cannot change files or run commands");
        };
        await authorize();
        const execute = () => executeWorkspaceTool(this.binding.workspaceRoot!, call.tool, input, authorize);
        return ["workspace_write", "workspace_run"].includes(call.tool) ? this.#bridgeMutation(call, execute) : settleRunnerBridgeRead(execute);
      }
      if (call.tool === "get_identity") {
        const { actor, run } = await this.#boundContext();
        const [person] = run.responsibleUserId ? await this.db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(eq(authUsers.id, run.responsibleUserId)) : [];
        return { agent: redactedActor(actor), responsibleUser: person ?? null, permissions: actor.permissions, tools: this.definitions().map(tool => tool.name) };
      }
      if (call.tool === "list_people") return this.db.select({ id: authUsers.id, name: authUsers.name, role: companyMemberships.membershipRole }).from(companyMemberships)
        .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
        .where(and(eq(companyMemberships.companyId, this.binding.companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.status, "active"), input.after ? sql`${authUsers.id} > ${input.after}` : undefined))
        .orderBy(authUsers.id).limit(input.limit);
      if (call.tool === "list_assigned_skills" || call.tool === "read_assigned_skill") {
        const current = await this.#boundContext();
        const visibility = await skillAccessService(this.db, this.#privacyActor(current.run)).condition(this.binding.companyId);
        const known = await this.db.select({ key: companySkills.key }).from(companySkills).where(eq(companySkills.companyId, this.binding.companyId));
        const permitted = await this.db.select({ key: companySkills.key }).from(companySkills).where(and(eq(companySkills.companyId, this.binding.companyId), visibility));
        const hidden = new Set(known.filter(skill => !permitted.some(allowed => allowed.key === skill.key)).map(skill => skill.key));
        const savedVersions = current.run.contextSnapshot?.skillVersions;
        const permittedKeys = new Set(permitted.map(skill => skill.key));
        const runtimeContext = { ...this.binding.runtimeContext!, skills: this.binding.runtimeContext!.skills.filter(skill =>
          !hidden.has(skill.key) && !(savedVersions && Object.prototype.hasOwnProperty.call(savedVersions, skill.key) && !permittedKeys.has(skill.key))) };
        if (call.tool === "list_assigned_skills") return runtimeContext.skills.map(skill => ({ key: skill.key, name: skill.runtimeName, versionId: skill.versionId, digest: skill.bundle.digest }));
        return settleRunnerBridgeRead(() => readAssignedSkill(runtimeContext, input));
      }
      return apiToolResult(await this.#callApi(call.callId, taskBridgeApiRequest(call.tool, input)));
    }
    if (this.binding.firstPartyOnly && (call.tool === READ_TOOL_RESULT || this.binding.assignedMcpTools?.has(call.tool) || isConnectorTool(call.tool)
      || RUNTIME_CONNECTION_TOOL_DEFINITIONS.some(tool => tool.name === call.tool))) throw forbidden("This Grok Bot connection exposes first-party Paperclip operations. Use your own provider apps under their existing permissions.");
    if (call.tool === READ_TOOL_RESULT) return this.#readToolResult(call.arguments);
    if (this.binding.assignedMcpTools?.has(call.tool)) {
      const current = await this.#boundContext();
      const result = await this.binding.assignedMcpTools.execute(call, current.issue.workMode as "standard" | "planning" | "ask");
      return captureRunnerToolResult(result, this.#responseCaptureIo("runner.assigned_tool"));
    }
    if (isConnectorTool(call.tool)) {
      if (!(this.binding.connectorAssignments ?? []).some((assignment) => assignment.tools.some((tool) => tool.name === call.tool))) throw forbidden("Connector tool is not available to this run");
      const { run } = await this.#boundContext({ includeChatWake: call.tool.startsWith("agentmail_") });
      const snapshot = record(run.contextSnapshot);
      if (call.tool.startsWith("agentmail_") && (isPaperclipExternalChatContractTurn(snapshot.paperclipWake) || String(snapshot.source ?? "").startsWith("chat:") || snapshot.paperclipExternalChatQuestionResponse)) throw forbidden("Restricted chat runs cannot use email actions");
      return executeConnectorTool(this.db, this.binding, call.tool, call.arguments);
    }
    if (RUNTIME_CONNECTION_TOOL_DEFINITIONS.some((tool) => tool.name === call.tool)) {
      await this.#boundContext();
      const { run } = await captureRunIdentity(this.db, this.binding, { readScope: "identity" });
      if (!run.responsibleUserId) throw forbidden("This task needs a responsible user before requesting a connection");
      const claims = {
        sub: this.binding.agentId, company_id: this.binding.companyId,
        run_id: this.binding.runId, responsible_user_id: run.responsibleUserId,
      };
      const connections = connectionIntentService(this.db);
      if (call.tool === "connections_search") {
        const input = connectionsSearchInputSchema.parse(call.arguments);
        return connections.search(claims, input.query, { retryProviderChoice: input.retryProviderChoice });
      }
      const input = connectionRequestInputSchema.parse(call.arguments);
      const result = await connections.request(claims, input.service, { selectionInteractionId: input.selectionInteractionId, targetService: input.targetService, connectionId: input.connectionId, toolNames: input.toolNames });
      if (result.state === "ready" && this.binding.pinnedMcpDigest && this.binding.enqueueWakeup) {
        const current = await resolveNativeRuntimeMcpSnapshot({ db: this.db, agent: { id: this.binding.agentId, companyId: this.binding.companyId }, runId: this.binding.runId });
        if (current.digest !== this.binding.pinnedMcpDigest) {
          const idempotencyKey = `connection-intent:tools:${this.binding.runId}:${current.digest}`;
          const delivered = () => this.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
            eq(agentWakeupRequests.companyId, this.binding.companyId), eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
            notInArray(agentWakeupRequests.status, ["skipped", "failed", "cancelled"]),
          )).limit(1);
          if (!(await delivered()).length) try { await this.binding.enqueueWakeup(this.binding.agentId, {
            source: "automation", triggerDetail: "system", reason: "issue_commented",
            payload: { issueId: this.binding.issueId, mutation: "connection_tools_refreshed" },
            idempotencyKey,
            issueStateGuard: { statuses: ["in_progress", "in_review"], assigneeAgentId: this.binding.agentId },
            requestedByActorType: "agent", requestedByActorId: this.binding.agentId,
            contextSnapshot: { issueId: this.binding.issueId, taskId: this.binding.issueId, refreshTools: true, wakeReason: "issue_commented", source: "connection_tools.refreshed" },
          }); } catch (error) { if (!(await delivered()).length) throw error; }
          return { ...result, instruction: "Access is already authorized. A continuation with updated tools is queued. Finish independent work, then yield. Do not request authorization again." };
        }
      }
      return result;
    }
    if (
      !IMPLEMENTED_OPERATIONS.has(call.tool) &&
      call.tool !== READ_CURRENT_WAKE_COMMENTS_TOOL_NAME &&
      call.tool !== LIST_CHAT_ATTACHMENTS_TOOL_NAME &&
      call.tool !== REUSE_CHAT_ATTACHMENT_TOOL_NAME &&
      call.tool !== READ_CHAT_ATTACHMENT_TOOL_NAME
    ) {
      throw new Error("paperclip_runner_tool_not_advertised");
    }
    if (
      !runnerApiToolsEnabled(
        this.binding.companyId,
        this.binding.apiToolsEnabled,
      ) &&
      ["search_api", "call_api", "hire_agent"].includes(call.tool)
    ) {
      throw new Error("paperclip_runner_tool_not_advertised");
    }
    const context = await this.#boundContext();
    const input = record(call.arguments);
    if (call.tool === READ_CHAT_ATTACHMENT_TOOL_NAME) {
      const scope = this.binding.chatAttachmentReadScope;
      const identityKeys = ["companyId", "issueId", "runId", "agentId"] as const;
      if (!scope || identityKeys.some((key) => scope.options.binding[key] !== this.binding[key])) {
        throw new Error("paperclip_runner_chat_attachment_read_scope_unavailable");
      }
      if (Object.keys(input).some((key) => key !== "sourceCommentId" && key !== "attachmentId")) {
        throw new Error("paperclip_runner_chat_attachment_read_arguments_invalid");
      }
      return scope.read({
        sourceCommentId: requiredUuid(input.sourceCommentId),
        attachmentId: requiredUuid(input.attachmentId),
      });
    }
    if (call.tool === READ_CURRENT_WAKE_COMMENTS_TOOL_NAME) {
      if (!this.binding.currentWakeComments) {
        throw new Error("paperclip_runner_tool_not_advertised");
      }
      return readCurrentWakeComments(
        this.db,
        this.binding.currentWakeComments,
        input,
      );
    }
    if (call.tool === LIST_CHAT_ATTACHMENTS_TOOL_NAME) {
      return listAuthorizedChatAttachments({
        db: this.db,
        binding: this.binding,
        sourceCommentId:
          input.sourceCommentId === null || input.sourceCommentId === undefined
            ? null
            : requiredUuid(input.sourceCommentId),
        limit: boundedLimit(input.limit, 20, 50),
        cursor:
          input.cursor === null || input.cursor === undefined
            ? null
            : requiredString(input.cursor),
      });
    }
    if (call.tool === REUSE_CHAT_ATTACHMENT_TOOL_NAME) {
      return this.#reuseChatAttachment(input);
    }
    const descriptor = CAPABILITY_SEMANTIC_TOOL_CATALOG.find(
      (candidate) => candidate.operationId === call.tool,
    );
    if (
      !descriptor ||
      !descriptor.allowedModes.includes(
        context.issue.workMode as "standard" | "planning" | "ask",
      )
    ) {
      throw new Error("paperclip_runner_tool_mode_denied");
    }
    switch (call.tool) {
      case "list_workflows":
      case "read_workflow":
      case "create_workflow":
      case "update_workflow":
        return executeNativeWorkflowTool({ db: this.db, binding: this.binding, tool: call.tool, arguments: call.arguments,
          callApi: (receiptKey, request) => this.#callApi(receiptKey, request, { dedicatedCaseTool: call.tool }) });
      case "read_case":
      case "update_case":
        if (context.issue.workMode !== "standard") throw forbidden("Case tools require standard work mode");
        return executeNativeCaseTool({ db: this.db, binding: this.binding, actor: this.#privacyActor(context.run),
          tool: call.tool, arguments: call.arguments,
          callApi: (receiptKey, request) => this.#callApi(receiptKey, request, { dedicatedCaseTool: call.tool, caseId: request.pathParams?.id }),
        });
      case "submit_complaint":
      case "submit_suggestion":
        return this.#submitCommentary(call.tool, input);
      case "read_agent_instructions":
      case "get_agent_instruction_history":
        return executeAgentInstructionTool({ db: this.db, binding: {
          companyId: this.binding.companyId, agentId: this.binding.agentId, runId: this.binding.runId,
        }, tool: call.tool, arguments: call.arguments });
      case "update_agent_instructions":
      case "restore_agent_instructions": {
        return this.#withInstructionMutationReceipt(call.tool, call.callId, input);
      }
      case "create_skill": {
        const apiUrl = this.binding.apiUrl ?? process.env.PAPERCLIP_API_URL;
        const token = this.#apiToken(context);
        if (!apiUrl || !token) throw new Error("Skill tool authentication is unavailable");
        return callCreateSkillTool({ arguments: input, apiUrl, token, companyId: this.binding.companyId });
      }
      case "update_skill": {
        const apiUrl = this.binding.apiUrl ?? process.env.PAPERCLIP_API_URL;
        const token = this.#apiToken(context);
        if (!apiUrl || !token) throw new Error("Skill tool authentication is unavailable");
        return callUpdateSkillTool({ arguments: input, apiUrl, token, companyId: this.binding.companyId });
      }
      case "get_workspace":
      case "list_workspaces":
      case "select_workspace":
      case "prepare_repository": {
        const apiUrl = this.binding.apiUrl ?? process.env.PAPERCLIP_API_URL;
        const token = this.#apiToken(context);
        if (!apiUrl || !token) throw new Error("Workspace tool authentication is unavailable");
        return callTaskWorkspaceTool({ name: call.tool, arguments: input, apiUrl, token, companyId: this.binding.companyId, issueId: this.binding.issueId, workspaceRoot: this.binding.workspaceRoot });
      }
      case "create_project":
      case "list_project_repositories":
      case "list_projects": {
        const apiUrl = this.binding.apiUrl ?? process.env.PAPERCLIP_API_URL;
        const token = this.#apiToken(context);
        if (!apiUrl || !token) throw new Error("Project tool authentication is unavailable");
        return callProjectTool({ name: call.tool, arguments: input, apiUrl, token,
          companyId: this.binding.companyId, issueId: this.binding.issueId, agentId: this.binding.agentId,
          conversation: Boolean(context.issue.conversationAgentId) });
      }
      case "search_api": return searchRunnerApi(call.arguments);
      case "hire_agent": {
        return hireAgentResult(await this.#callApi(call.callId, hireAgentApiRequest(input, this.binding)), context.actor.adapterConfig?.provider);
      }
      case "call_api": {
        // PRP reserves operationId/callId for semantic result identity. The
        // HTTP operation is metadata, including in previously saved receipts;
        // exposing it as operationId makes the runner reject a valid response.
        return apiToolResult(await this.#callApi(call.callId, call.arguments));
      }
      case "get_task_context": {
        const monitorCheckAt = !this.binding.nativeReview && context.issue.workMode === "standard" &&
          context.issue.executionRunId === this.binding.runId
          ? eligibleIssueMonitorWait(context.issue, this.binding.agentId) : null;
        const childTasks = await this.db.select().from(issues)
          .where(and(
            eq(issues.companyId, this.binding.companyId),
            eq(issues.parentId, this.binding.issueId),
            isNull(issues.hiddenAt),
            await issueReadSqlCondition(this.db, this.#privacyActor(context.run)),
          ))
          .orderBy(desc(issues.createdAt), desc(issues.id))
          .limit(101);
        const readableChildren = this.binding.museRuntime
          ? await this.#readableMuseTaskIds(context.run, childTasks.map(task => task.id)) : null;
        const visibleChildTasks = readableChildren ? childTasks.filter(task => readableChildren.has(task.id)) : childTasks;
        return {
          company: { id: this.binding.companyId },
          actor: redactedActor(context.actor),
          taskQuestionContext: await readTaskQuestionContext(this.db, {
            ...this.binding, conversationMode: isConversation(context.issue),
          }),
          activeTask: redactedTask(context.issue),
          completionContinuation: monitorCheckAt ? {
            kind: "monitor",
            summary: "Wait for the saved task monitor.",
            idempotencyKey: `task-monitor:${context.issue.id}:${monitorCheckAt}`,
          } : !this.binding.nativeReview && context.issue.workMode === "standard" && context.issue.executionRunId === this.binding.runId
            ? await pendingTaskRepositoryContinuation(this.db, { companyId: this.binding.companyId, issueId: this.binding.issueId,
                runId: this.binding.runId, workspaceId: context.issue.executionWorkspaceId })
              ?? await readPublishedGitHubReviewCompletionContinuation({ db: this.db, binding: this.binding })
            : null,
          childTasks: visibleChildTasks.slice(0, 100).map(redactedTask),
          childTasksTruncated: childTasks.length > 100,
          delegationGuidance: "Reuse existing child tasks for delegated work. Inspect a completed child's comments and documents before creating another task for the same deliverable. Use search_tasks if the child task list is truncated.",
          run: {
            id: this.binding.runId,
            status: context.run.status,
            invocationSource: context.run.invocationSource,
          },
          connectionGuidance: CONNECTION_INTENT_AGENT_GUIDANCE,
          acceptedPlan: await this.#acceptedPlan(context.run.contextSnapshot, context.issue),
          sourcePlanApproval: await this.#sourcePlanApproval(context),
          childReviewOutcomes: await this.#readableChildReviewOutcomes(context.run),
          ...(this.binding.nativeReview ? {
            assignedReview: (await getNativeReviewAssignment(this.db, {
              ...this.binding, contextSnapshot: this.binding.nativeReview,
              allowResolvedByRunId: this.binding.runId,
            }))?.interaction,
          } : {}),
        };
      }
      case "get_task_history": {
        const readerSourceTrust = await resolveActorSourceTrustForIssue({ db: this.db, issue: context.issue,
          actor: { actorType: "agent", actorId: this.binding.agentId, agentId: this.binding.agentId, runId: this.binding.runId } });
        const limit = boundedLimit(input.limit);
        const comments = await this.db.select({
          id: issueComments.id,
          body: issueComments.body,
          origin: issueComments.origin,
          sourceTrust: issueComments.sourceTrust,
          authorAgentId: issueComments.authorAgentId,
          authorUserId: issueComments.authorUserId,
          createdAt: issueComments.createdAt,
        }).from(issueComments)
          .where(and(
            eq(issueComments.companyId, this.binding.companyId),
            eq(issueComments.issueId, this.binding.issueId),
            isNull(issueComments.deletedAt),
          ))
          .orderBy(desc(issueComments.createdAt))
          .limit(limit);
        return { comments: comments.reverse().map(comment => {
          const visible = isLowTrustQuarantined(readerSourceTrust) ? comment : sanitizeQuarantinedCommentForHigherTrust(comment);
          return { ...visible, body: fastResponseHistoryBody(visible) };
        }) };
      }
      case "search_tasks": {
        const tasks = await issueService(this.db).list(this.binding.companyId, { readCondition: await issueReadSqlCondition(this.db, this.#privacyActor(context.run)) });
        const query = typeof input.query === "string" ? input.query.toLowerCase() : "";
        const statuses = Array.isArray(input.statuses) ? new Set(input.statuses.filter((value): value is string => typeof value === "string")) : null;
        const matching = tasks.filter((task) =>
          (!query || `${task.identifier} ${task.title} ${task.description ?? ""}`.toLowerCase().includes(query))
          && (!statuses || statuses.size === 0 || statuses.has(task.status))
        );
        const readable = this.binding.museRuntime ? await this.#readableMuseTaskIds(context.run, matching.map(task => task.id)) : null;
        return { tasks: matching.filter(task => !readable || readable.has(task.id))
          .slice(0, boundedLimit(input.limit)).map(redactedTask) };
      }
      case "list_documents":
        return { documents: await this.#visibleMuseDocuments(context.issue,
          await documentService(this.db).listIssueDocuments(this.binding.issueId)) };
      case "read_document": {
        const document = await documentService(this.db).getIssueDocumentByKey(this.binding.issueId, requiredString(input.key));
        if (!document) throw new Error("paperclip_runner_document_not_found");
        const [visible] = await this.#visibleMuseDocuments(context.issue, [document]);
        return { document: visible };
      }
      case "list_document_revisions": {
        const key = requiredString(input.key);
        const service = documentService(this.db);
        const revisions = await service.listIssueDocumentRevisions(this.binding.issueId, key);
        if (!this.binding.museRuntime || revisions.length === 0) return { revisions };
        const document = await service.getIssueDocumentByKey(this.binding.issueId, key);
        return { revisions: await this.#projectMuseDocumentContent(context.issue, revisions, document ? [document] : []) };
      }
      case "write_document": return this.#writeDocument(input);
      case "list_agents":
        return { actors: (await agentService(this.db).list(this.binding.companyId)).map(redactedActor) };
      case "get_agent": {
        const actor = await agentService(this.db).getById(requiredString(input.actorId));
        if (!actor || actor.companyId !== this.binding.companyId) throw new Error("paperclip_runner_agent_not_found");
        return { actor: redactedActor(actor) };
      }
      case "list_approvals":
        return { approvals: await approvalService(this.db).list(this.binding.companyId, undefined, await approvalReadSqlCondition(this.db, this.#privacyActor(context.run))) };
      case "get_approval": {
        const approval = await this.#approval(requiredString(input.approvalId));
        return { approval };
      }
      case "get_approval_context": {
        const approval = await this.#approval(requiredString(input.approvalId));
        const tasks = await this.db.select({ issue: issues }).from(issueApprovals)
          .innerJoin(issues, eq(issues.id, issueApprovals.issueId))
          .where(and(
            eq(issueApprovals.approvalId, approval.id),
            eq(issueApprovals.companyId, this.binding.companyId),
            eq(issues.companyId, this.binding.companyId),
            await issueReadSqlCondition(this.db, this.#privacyActor(context.run)),
          ));
        const readable = this.binding.museRuntime ? await this.#readableMuseTaskIds(context.run, tasks.map(row => row.issue.id)) : null;
        return { approval, tasks: tasks.filter(row => !readable || readable.has(row.issue.id)).map(row => row.issue) };
      }
      case "report_progress": return this.#reportProgress(input);
      case "request_human_input": return this.#requestHumanInput(input,
        (await captureRunIdentity(this.db, this.binding, { readScope: "identity" })).context?.id ?? null);
      case "create_task": return this.#createTask(input,
        (await captureRunIdentity(this.db, this.binding, { readScope: "identity" })).context?.id ?? null);
      case "reassign_task": return this.#reassignTask(input);
      case "set_task_title": return this.#setTaskTitle(input);
      case "set_task_monitor": return this.#setTaskMonitor(input);
      case "set_dependencies": return this.#setDependencies(input);
      case "register_deliverable": return this.#registerDeliverable(input);
      default: throw new Error("paperclip_runner_tool_not_bound");
    }
  }

  async #bridgeMutation(call: { tool: string; callId: string; arguments: unknown }, execute: () => Promise<unknown>) {
    if (!call.callId || call.callId.length > 500) throw badRequest("Use a stable bounded call ID");
    const key = toolCallKey(call.callId);
    const digest = toolInputDigest({ tool: call.tool, arguments: call.arguments });
    const prior = await this.db.transaction(async tx => {
      const context = await this.#lockAuthorizedMutationContext(tx as unknown as Db);
      const resultJson = record(context.run.resultJson), receipts = record(resultJson.bridgeToolReceipts);
      const old = record(receipts[key]);
      if (receipts[key]) {
        if (old.digest !== digest) throw badRequest("Call ID reused with different arguments");
        return { result: old.result ?? { outcome: "unknown", guidance: "A workspace effect may have occurred. Inspect files and state before issuing another mutation; this call will not execute again." } };
      }
      if (Object.keys(receipts).length >= 1000) throw badRequest("Workspace mutation limit reached");
      receipts[key] = { digest, tool: call.tool, state: "pending" };
      await tx.update(heartbeatRuns).set({ resultJson: { ...resultJson, bridgeToolReceipts: receipts } }).where(eq(heartbeatRuns.id, this.binding.runId));
      return null;
    });
    if (prior) return prior.result;
    let result: unknown;
    try { result = await execute(); } catch (error) { result = { outcome: "failed", message: error instanceof Error ? error.message : "Workspace operation failed" }; }
    await this.db.transaction(async tx => {
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, this.binding.runId), eq(heartbeatRuns.companyId, this.binding.companyId))).for("update");
      const resultJson = record(run?.resultJson), receipts = record(resultJson.bridgeToolReceipts);
      receipts[key] = { digest, tool: call.tool, state: "completed", result };
      await tx.update(heartbeatRuns).set({ resultJson: { ...resultJson, bridgeToolReceipts: receipts } }).where(eq(heartbeatRuns.id, this.binding.runId));
    });
    await logActivity(this.db, { companyId: this.binding.companyId, actorType: "agent", actorId: this.binding.agentId, runId: this.binding.runId,
      action: "runner.workspace_operation", entityType: "issue", entityId: this.binding.issueId, details: { tool: call.tool, requestFingerprint: digest, outcome: record(result).outcome ?? "completed" } });
    return result;
  }

  #apiScope(context: {
    issue: { workMode: string };
    run: { contextSnapshot: unknown };
  }) {
    const snapshot = record(context.run.contextSnapshot);
    const admittedKind = record(snapshot.paperclipAgentJwtScope).kind;
    const skillTest = admittedKind === "skill_test" || (admittedKind !== "standard"
      && (Boolean(snapshot.paperclipSkillTest) || context.issue.workMode === "skill_test"));
    return skillTest ? { kind: "skill_test" as const, issueId: this.binding.issueId } : { kind: "standard" as const };
  }

  #apiToken(context: {
    actor: { adapterType: string };
    issue: { workMode: string };
    run: { responsibleUserId: string | null; contextSnapshot: unknown };
  }) {
    return createLocalAgentJwt(this.binding.agentId, this.binding.companyId, context.actor.adapterType,
      this.binding.runId, context.run.responsibleUserId, this.#apiScope(context), this.binding.externalAuthorizingUserId);
  }

  async #callApi(callId: string, value: unknown, options?: { dedicatedCaseTool: string; caseId?: string; receiptOnly?: true }): Promise<unknown> {
    const bound = await this.#boundContext();
    const context = { ...this.binding, issueIdentifier: bound.issue.identifier, workMode: bound.issue.workMode };
    const { input, operation } = validateRunnerApiCall(value, context);
    // Only the strict dedicated case adapter may use its exact mapped route when
    // generic API discovery/calls are disabled. All route/run guards still apply.
    const dedicatedCaseRoute = options && NATIVE_CASE_OPERATIONS.has(options.dedicatedCaseTool)
      && operation.dedicatedTools.includes(options.dedicatedCaseTool)
      && (options.dedicatedCaseTool.endsWith("workflow") || options.dedicatedCaseTool === "list_workflows" || input.pathParams?.id === options.caseId)
      && this.binding.casesEnabled === true && bound.issue.workMode === "standard";
    const assertAvailable = (workMode: string) => {
      if (options && workMode !== "standard") throw forbidden("Case tools require standard work mode");
      if (!dedicatedCaseRoute && !runnerApiToolsEnabled(this.binding.companyId, this.binding.apiToolsEnabled)) {
        throw new Error("paperclip_runner_tool_not_advertised");
      }
    };
    const caseCaptureId = dedicatedCaseRoute ? options!.caseId
      : await caseIdForApiCapture(this.db, this.binding.companyId, operation.path, input.pathParams);
    if (this.binding.firstPartyOnly && /\/(?:workspaces|workspace-runtime|repositories|tool-gateway|tool-connections|tool-profiles|tools|connection-intents|connections|plugins)(?:\/|$)/.test(operation.path)) throw forbidden("Third-party tools through Paperclip are unavailable for this Grok Bot connection.");
    const sensitiveResponse = runnerApiSensitiveResponse(operation.method, operation.path);
    await this.#assertDotApiFileAccess(operation.path, input);
    if (options?.receiptOnly) {
      assertAvailable(bound.issue.workMode);
      return this.#completedApiReceipt(bound.run.resultJson?.apiToolReceipts, callId, input);
    }
    const apiUrl = this.binding.apiUrl ?? process.env.PAPERCLIP_API_URL;
    if (!apiUrl) throw new Error("Paperclip API origin is unavailable");
    const token = this.#apiToken(bound);
    if (!token) throw new Error("Paperclip run authentication is unavailable");
    const execute = async () => {
      const current = await this.#boundContext();
      assertAvailable(current.issue.workMode);
      const result = await executeRunnerApi(input, { ...context, workMode: current.issue.workMode }, {
        apiUrl, token,
        beforeDispatch: async () => {
          const fresh = await this.#boundContext();
          assertAvailable(fresh.issue.workMode);
          validateRunnerApiCall(input, { ...context, workMode: fresh.issue.workMode });
          await this.#assertDotApiFileAccess(operation.path, input);
        },
        readFile: (file) => this.#readApiFile(file),
        ...this.#responseCaptureIo("runner.call_api", caseCaptureId),
      });
      await this.#assertDotApiFileAccess(operation.path, input);
      return result;
    };
    if (readOnlyApiMethod(operation.method)) return execute();
    if (!callId || callId.length > 500) throw badRequest("A bounded runner call id is required");
    const provider = sensitiveResponse ? getSecretProvider("local_encrypted") : null;
    if (provider) await provider.createSecret({ value: "runner-api-receipt-key-check" });
    // Reserve durably before HTTP dispatch, without holding a DB lock over an
    // HTTP route that itself needs DB locks. A crash leaves an explicit unknown
    // outcome rather than replaying a possibly committed external mutation.
    const key = toolCallKey(callId);
    const digest = toolInputDigest(input);
    const prior = await this.db.transaction(async (tx) => {
      const locked = await this.#lockAuthorizedMutationContext(tx as unknown as Db);
      const resultJson = record(locked.run.resultJson);
      const receipts = record(resultJson.apiToolReceipts);
      const inherited = await priorRecoveryApiReceipt(tx as unknown as Db, { companyId: this.binding.companyId,
        issueId: this.binding.issueId, runId: this.binding.runId, operationId: operation.operationId, digest });
      if (inherited) return { result: await this.#apiReceiptResult(inherited) };
      const existing = record(receipts[key]);
      if (receipts[key]) {
        if (existing.digest !== digest) throw badRequest("API call id was reused with different arguments");
        const result = await this.#apiReceiptResult(existing);
        return { result: existing.encryptedResult ? result : result ?? { ok: false, status: null, error: "api_outcome_unknown", outcome: "unknown", guidance: "Inspect state before issuing another mutation." } };
      }
      if (Object.keys(receipts).length >= 512) throw badRequest("Run API mutation limit reached");
      receipts[key] = { digest, operationId: operation.operationId, state: "pending" };
      await tx.update(heartbeatRuns).set({ resultJson: { ...resultJson, apiToolReceipts: receipts } }).where(eq(heartbeatRuns.id, this.binding.runId));
      return null;
    });
    if (prior) return prior.result;
    const result = await execute();
    const storedResult = provider
      ? { encryptedResult: (await provider.createSecret({ value: JSON.stringify(result) })).material }
      : { result };
    // Some older routes attribute the agent but omit runId. Retain their domain
    // event and add the run-bound HTTP receipt, without logging request bodies.
    const apiActivity = await persistActivity(this.db, {
      companyId: this.binding.companyId, actorType: "agent", actorId: this.binding.agentId,
      agentId: this.binding.agentId, runId: this.binding.runId, issueId: this.binding.issueId,
      action: "runner.api_called", entityType: "issue", entityId: this.binding.issueId,
      details: { operationId: operation.operationId, requestFingerprint: digest, pathParams: input.pathParams ?? {}, status: result.status, outcome: record(result).outcome ?? (result.ok ? "succeeded" : "failed") },
    });
    publishActivity(apiActivity.publication);
    await this.db.transaction(async (tx) => {
      const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, this.binding.runId)).for("update");
      const resultJson = record(run?.resultJson);
      const receipts = record(resultJson.apiToolReceipts);
      receipts[key] = { digest, operationId: operation.operationId, state: "completed", ...storedResult };
      await tx.update(heartbeatRuns).set({ resultJson: { ...resultJson, apiToolReceipts: receipts } }).where(eq(heartbeatRuns.id, this.binding.runId));
    });
    return result;
  }

  async #readToolResult(value: unknown): Promise<unknown> {
    if (!this.binding.assignedMcpTools) throw forbidden("Saved app-tool results are unavailable to this run");
    const input = readToolResultSchema.parse(value);
    const context = await this.#boundContext();
    const authorize = async () => {
      await this.#boundContext();
      const [capture] = await this.db.select({ id: runnerApiResponseReservations.id })
        .from(runnerApiResponseReservations)
        .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, runnerApiResponseReservations.runId))
        .where(and(
          eq(runnerApiResponseReservations.assetId, input.artifactId),
          eq(runnerApiResponseReservations.companyId, this.binding.companyId),
          eq(heartbeatRuns.companyId, this.binding.companyId),
          eq(heartbeatRuns.agentId, this.binding.agentId),
          eq(heartbeatRuns.nativeIssueId, this.binding.issueId),
        )).limit(1);
      if (!capture) throw forbidden("Saved tool result is not available to this task");
    };
    await authorize();
    const apiUrl = this.binding.apiUrl ?? process.env.PAPERCLIP_API_URL;
    const token = this.#apiToken(context);
    if (!apiUrl || !token) throw new Error("Paperclip run authentication is unavailable");
    // This dedicated read grants only a saved result from this task. It remains
    // available without generic call_api and uses the same authenticated asset
    // route, range/UTF-8 decoding, and responsible-user checks as API reads.
    const { operationId, ...response } = await executeRunnerApi({
      operationId: "GET /api/assets/{assetId}/content",
      pathParams: { assetId: input.artifactId },
      responseText: { offsetBytes: input.offsetBytes },
    }, { ...this.binding, workMode: context.issue.workMode }, {
      apiUrl, token, beforeDispatch: authorize, responseTextPageBytes: RUNNER_TOOL_RESULT_MAX_BYTES,
      readFile: async () => { throw new Error("Saved result reads cannot upload files"); },
      saveResponse: async () => { throw new Error("Saved result reads cannot create assets"); },
    });
    return fitRunnerToolResultPage({ ...response, apiOperationId: operationId });
  }

  #responseCaptureIo(source: "runner.call_api" | "runner.assigned_tool", caseId?: string): Pick<RunnerApiIo, "reserveResponseCapture" | "saveResponse"> {
    let reservationId: string | undefined;
    let storageAttempted = false;
    return {
      reserveResponseCapture: async () => {
        const reservation = await this.#reserveApiResponseCapture();
        reservationId = reservation.id;
        return (completedBytes, cleaned) => reservation.settle(completedBytes, cleaned, storageAttempted);
      },
      saveResponse: async (bytes, contentType) => {
        if (!reservationId) throw new Error("API response storage reservation is missing");
        const storage = this.binding.storage ?? getStorageService();
        storageAttempted = true;
        const saved = await storage.putFile({ companyId: this.binding.companyId, namespace: caseId ? `cases/${caseId}/runner-api` : "runner-api", originalFilename: contentType.includes("json") ? "response.json" : "response.bin", contentType, ...(Buffer.isBuffer(bytes) ? { body: bytes } : { body: createReadStream(bytes.path), byteSize: bytes.byteSize, sha256: bytes.sha256 }) });
        const asset = await this.db.transaction(async tx => {
          await this.#lockApiCaptureCompany(tx as unknown as Db);
          const asset = await assetService(tx as unknown as Db).create(this.binding.companyId, { ...saved, createdByAgentId: this.binding.agentId });
          await tx.update(runnerApiResponseReservations).set({ assetId: asset.id, reservedBytes: asset.byteSize }).where(and(eq(runnerApiResponseReservations.id, reservationId!), eq(runnerApiResponseReservations.companyId, this.binding.companyId)));
          return asset;
        }).catch(async error => {
          // A failed commit acknowledgement can still leave a committed
          // asset. A locking read waits out that transaction before proving
          // the reservation is unlinked and safe to compensate.
          const reservation = await this.db.select({ assetId: runnerApiResponseReservations.assetId })
            .from(runnerApiResponseReservations).where(and(eq(runnerApiResponseReservations.id, reservationId!), eq(runnerApiResponseReservations.companyId, this.binding.companyId))).for("update")
            .then(rows => rows[0]).catch(() => undefined);
          if (reservation?.assetId === null) {
            const removed = await storage.deleteObject(this.binding.companyId, saved.objectKey).then(() => true, () => false);
            if (removed) storageAttempted = false;
          }
          throw error;
        });
        const activity = await persistActivity(this.db, { companyId: this.binding.companyId, actorType: "agent", actorId: this.binding.agentId, agentId: this.binding.agentId, runId: this.binding.runId, issueId: this.binding.issueId, action: "asset.created", entityType: "asset", entityId: asset.id, details: { source, byteSize: saved.byteSize } });
        publishActivity(activity.publication);
        return { artifactId: asset.id, url: `/api/assets/${asset.id}/content`, contentType, byteSize: saved.byteSize, sha256: saved.sha256 };
      },
    };
  }

  async #lockApiCaptureCompany(tx: Db): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`runner-api-capture:${this.binding.companyId}`}, 0))`);
  }

  async #reserveApiResponseCapture() {
    const release = acquireRunnerApiResponseSlot(this.binding.companyId);
    let id: string;
    try {
      id = await this.db.transaction(async tx => {
        await this.#lockApiCaptureCompany(tx as unknown as Db);
        const locked = await this.#lockAuthorizedMutationContext(tx as unknown as Db);
        const resultJson = record(locked.run.resultJson);
        const used = resultJson.apiResponseCaptureBytes ?? 0;
        if (typeof used !== "number" || !Number.isSafeInteger(used) || used < 0
          || used + RUNNER_API_RESPONSE_MAX_BYTES > RUNNER_API_RESPONSE_RUN_MAX_BYTES) {
          throw new RunnerApiResponseLimitError("api_response_capture_limit", "This run has insufficient capture budget (4 GiB per run). Read an existing asset or narrow the query.");
        }
        // One company lock covers all runs/processes. Stored assets include
        // snapshots from before reservations existed; attached reservations
        // are excluded so completed snapshots are counted exactly once.
        const [usage] = await tx.select({ bytes: sql<string>`
          coalesce((select sum(${assets.byteSize}) from ${assets}
            where ${assets.companyId} = ${this.binding.companyId}
              and (${assets.objectKey} like ${`${this.binding.companyId}/runner-api/%`}
                or exists (select 1 from ${runnerApiResponseReservations} capture
                  where capture.asset_id = ${assets.id} and capture.company_id = ${this.binding.companyId}))), 0)
          + coalesce((select sum(${runnerApiResponseReservations.reservedBytes}) from ${runnerApiResponseReservations}
            where ${runnerApiResponseReservations.companyId} = ${this.binding.companyId}
              and ${runnerApiResponseReservations.assetId} is null), 0)` }).from(heartbeatRuns).where(eq(heartbeatRuns.id, this.binding.runId));
        const companyBytes = Number(usage.bytes);
        if (!Number.isSafeInteger(companyBytes) || companyBytes < 0 || companyBytes + RUNNER_API_RESPONSE_MAX_BYTES > runnerApiCompanyCaptureMaxBytes()) {
          throw new RunnerApiResponseLimitError("api_response_company_storage_limit", "Company API snapshot storage quota is exhausted. Read an existing asset or ask the operator to remove old snapshots or increase the quota.");
        }
        // Reserve worst-case bytes durably before creating a temporary file.
        // Interrupted/failed captures keep the reservation, preventing retry
        // loops and process restarts from resetting this run's disk-I/O budget.
        await tx.update(heartbeatRuns).set({ resultJson: { ...resultJson, apiResponseCaptureBytes: used + RUNNER_API_RESPONSE_MAX_BYTES } }).where(eq(heartbeatRuns.id, this.binding.runId));
        const [reservation] = await tx.insert(runnerApiResponseReservations).values({ companyId: this.binding.companyId, runId: this.binding.runId, reservedBytes: RUNNER_API_RESPONSE_MAX_BYTES }).returning({ id: runnerApiResponseReservations.id });
        return reservation.id;
      });
    } catch (error) { release(); throw error; }
    let settled = false;
    return { id, settle: async (completedBytes?: number, cleaned?: boolean, storageAttempted?: boolean) => {
      if (settled) return;
      settled = true;
      try {
        await this.db.transaction(async tx => {
          await this.#lockApiCaptureCompany(tx as unknown as Db);
          // Reclaim a handled pre-storage failure only after disk cleanup.
          // Crashes, failed cleanup, and ambiguous storage failures keep their
          // reservation until an operator reconciles the possible orphan data.
          if (cleaned && !storageAttempted) await tx.delete(runnerApiResponseReservations).where(and(eq(runnerApiResponseReservations.id, id), isNull(runnerApiResponseReservations.assetId)));
          if (completedBytes === undefined) return;
          const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, this.binding.runId), eq(heartbeatRuns.companyId, this.binding.companyId))).for("update");
          if (!run) return;
          const resultJson = record(run.resultJson);
          const used = resultJson.apiResponseCaptureBytes;
          if (typeof used !== "number" || !Number.isSafeInteger(used) || used < RUNNER_API_RESPONSE_MAX_BYTES) return;
          await tx.update(heartbeatRuns).set({ resultJson: { ...resultJson, apiResponseCaptureBytes: used - RUNNER_API_RESPONSE_MAX_BYTES + completedBytes } }).where(eq(heartbeatRuns.id, run.id));
        });
      } finally { release(); }
    } };
  }

  async #dotOwnsApiAsset(assetId: string): Promise<boolean> {
    const [capture] = await this.db.select({ id: runnerApiResponseReservations.id }).from(runnerApiResponseReservations).where(and(
      eq(runnerApiResponseReservations.companyId, this.binding.companyId), eq(runnerApiResponseReservations.runId, this.binding.runId),
      eq(runnerApiResponseReservations.assetId, assetId),
    )).limit(1);
    if (capture) return true;
    const current = await this.#boundContext();
    if (!this.binding.workspaceBridge || current.actor.adapterConfig?.dotWorkspaceAccess !== true) return false;
    const [output] = await this.db.select({ id: issueAttachments.id }).from(issueAttachments).where(and(
      eq(issueAttachments.companyId, this.binding.companyId), eq(issueAttachments.issueId, this.binding.issueId),
      eq(issueAttachments.originatingRunId, this.binding.runId), eq(issueAttachments.assetId, assetId),
    )).limit(1);
    return !!output;
  }

  async #assertDotApiFileAccess(path: string, input: { pathParams?: Record<string, string>; files?: RunnerApiFile[] }) {
    if (this.binding.firstPartyOnly && (input.files?.length || /\/(?:attachments|assets)\/[^/]+\/content$/.test(path) || /\/file-resources\/content$/.test(path))) {
      throw forbidden("Use this Grok work session's bounded upload or download grant; direct file API access is unavailable.");
    }
    if (!this.binding.dotRuntime) return;
    const current = await this.#boundContext();
    await this.binding.assertBridgeAuthority?.();
    if (/^\/api\/attachments\/\{[^}]+\}\/content$/.test(path))
      throw forbidden("Dot must use read_task_attachment for verified contents of its current assigned task; direct attachment API downloads are disabled.");
    if (/^\/api\/issues\/\{[^}]+\}\/file-resources\/content$/.test(path))
      throw forbidden("Dot must use workspace_read with its separate workspace grant; direct workspace API downloads are disabled.");
    if (/^\/api\/assets\/\{[^}]+\}\/content$/.test(path)) {
      const assetId = input.pathParams?.assetId;
      if (!assetId || !/^[0-9a-f-]{36}$/i.test(assetId) || !await this.#dotOwnsApiAsset(assetId))
        throw forbidden("Dot may read API captures and outputs from this run only. Use read_task_attachment for assigned input files.");
    }
    for (const file of input.files ?? []) {
      if (file.path && (!this.binding.workspaceBridge || !this.binding.workspaceRoot || current.actor.adapterConfig?.dotWorkspaceAccess !== true))
        throw forbidden("Dot workspace access is required for API file uploads.");
      if (file.artifactId && (!/^[0-9a-f-]{36}$/i.test(file.artifactId) || !await this.#dotOwnsApiAsset(file.artifactId)))
        throw forbidden("Dot may upload API captures and outputs from this run only.");
    }
  }

  async #readApiFile(file: RunnerApiFile): Promise<{ bytes: Buffer; filename: string; contentType: string }> {
    if (this.binding.dotRuntime) {
      await this.#assertDotApiFileAccess("", { files: [file] });
      if (file.path) {
        const bytes = await readWorkspaceUploadFile(this.binding.workspaceRoot!, file.path);
        await this.#assertDotApiFileAccess("", { files: [file] });
        return { bytes, filename: basename(file.path), contentType: "application/octet-stream" };
      }
    }
    if (file.artifactId) {
      const asset = await assetService(this.db).getById(file.artifactId);
      if (!asset || asset.companyId !== this.binding.companyId) throw forbidden("Artifact is not available in this company");
      const assertArtifactAccess = async () => {
        const current = await this.#boundContext();
        if (!(await canActorReadAssetContent(this.db, { ...this.#privacyActor(current.run), keyScope: this.#apiScope(current) }, asset)))
          throw forbidden("Artifact is not available to this actor");
      };
      await assertArtifactAccess();
      if (asset.byteSize > RUNNER_API_MAX_BYTES) throw badRequest("Artifact exceeds API transfer limit");
      const object = await (this.binding.storage ?? getStorageService()).getObject(this.binding.companyId, asset.objectKey);
      const chunks: Buffer[] = [];
      let length = 0;
      try {
        for await (const chunk of object.stream) {
          const bytes = Buffer.from(chunk);
          length += bytes.length;
          if (length > RUNNER_API_MAX_BYTES) throw badRequest("Artifact exceeds API transfer limit");
          chunks.push(bytes);
        }
      } finally { object.stream.destroy(); }
      await assertArtifactAccess();
      return { bytes: Buffer.concat(chunks), filename: asset.originalFilename ?? "file", contentType: asset.contentType };
    }
    if (this.binding.executionTargetKind === "remote") {
      if (!this.binding.readRemoteApiFile) throw badRequest("Remote workspace file uploads are unavailable for this execution provider");
      await this.#boundContext();
      const bytes = await this.binding.readRemoteApiFile(file.path!, RUNNER_API_MAX_BYTES);
      await this.#boundContext();
      if (bytes.length > RUNNER_API_MAX_BYTES) throw badRequest("Workspace file exceeds API transfer limit");
      return { bytes, filename: basename(file.path!), contentType: "application/octet-stream" };
    }
    const resolved = await workspaceFileResourceService(this.db).prepareDownload(this.binding.issueId, { path: file.path!, workspace: "auto" });
    const handle = await openRunnerApiWorkspaceFile(resolved.realPath);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > RUNNER_API_MAX_BYTES) throw badRequest("Workspace file exceeds API transfer limit");
      const bytes = Buffer.alloc(RUNNER_API_MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > RUNNER_API_MAX_BYTES) throw badRequest("Workspace file exceeds API transfer limit");
      return { bytes: bytes.subarray(0, length), filename: basename(resolved.realPath), contentType: "application/octet-stream" };
    } finally { await handle.close(); }
  }

  async #approval(id: string) {
    const approval = await approvalService(this.db).getById(id);
    if (!approval || approval.companyId !== this.binding.companyId) throw new Error("paperclip_runner_approval_not_found");
    const context = await this.#boundContext();
    if (!(await canActorReadApproval(this.db, this.#privacyActor(context.run), id))) throw new Error("paperclip_runner_approval_not_found");
    return approval;
  }

  async #readableMuseTaskIds(run: { responsibleUserId: string | null }, taskIds: string[]): Promise<Set<string>> {
    const ids = [...new Set(taskIds)];
    if (!ids.length) return new Set();
    const decisions = await authorizationService(this.db).decideReads(this.#privacyActor(run),
      ids.map(issueId => ({ type: "issue", companyId: this.binding.companyId, issueId })));
    return new Set(ids.filter((_id, index) => decisions[index]?.allowed));
  }

  async #readableChildReviewOutcomes(run: { responsibleUserId: string | null }) {
    const outcomes = await childReviewOutcomes(this.db, this.binding.companyId, this.binding.issueId, this.#privacyActor(run));
    if (!this.binding.museRuntime) return outcomes;
    const taskId = (outcome: (typeof outcomes)[number]) => record(outcome.result).childTaskId;
    const readable = await this.#readableMuseTaskIds(run, outcomes.flatMap(outcome => {
      const id = taskId(outcome); return typeof id === "string" ? [id] : [];
    }));
    return outcomes.filter(outcome => { const id = taskId(outcome); return typeof id === "string" && readable.has(id); });
  }

  #privacyActor(run: { responsibleUserId: string | null }): AuthorizationActor {
    return { type: "agent", agentId: this.binding.agentId, companyId: this.binding.companyId,
      runId: this.binding.runId, source: "agent_jwt", onBehalfOfUserId: run.responsibleUserId,
      ...(this.binding.museRuntime ? { authorizingUserId: this.binding.externalAuthorizingUserId } : {}) };
  }

  async #boundContext(options: { includeChatWake?: boolean } = {}) {
    if (this.binding.museRuntime && !this.binding.externalAuthorizingUserId) throw forbidden("Muse authorizer is unavailable");
    const [row] = await this.db.select({ issue: issues, actor: agents, run: {
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      runtimeMode: heartbeatRuns.runtimeMode,
      status: heartbeatRuns.status,
      invocationSource: heartbeatRuns.invocationSource,
      responsibleUserId: heartbeatRuns.responsibleUserId,
      contextSnapshot: sql<Record<string, unknown> | null>`case when jsonb_typeof(${heartbeatRuns.contextSnapshot}) = 'object'
        then ${heartbeatRuns.contextSnapshot} - array['executionContinuation', 'paperclipTaskMarkdown',
          'paperclipTaskMarkdownCompact', 'paperclipTaskMarkdownAssignment', 'paperclipTaskMarkdownAssignmentCompact',
          'paperclipWorkspace', 'paperclipEnvironment', 'paperclipContinuationSummary', 'paperclipWakeComment']
          ${options.includeChatWake ? sql`` : sql`- 'paperclipWake'`}
        else ${heartbeatRuns.contextSnapshot} end`,
      resultJson: heartbeatRuns.resultJson,
    } })
      .from(heartbeatRuns)
      .innerJoin(issues, eq(issues.id, this.binding.issueId))
      .innerJoin(agents, eq(agents.id, this.binding.agentId))
      .where(and(
        eq(heartbeatRuns.id, this.binding.runId),
        eq(heartbeatRuns.companyId, this.binding.companyId),
        eq(heartbeatRuns.agentId, this.binding.agentId),
        eq(heartbeatRuns.nativeIssueId, this.binding.issueId),
        eq(issues.companyId, this.binding.companyId),
        ...(this.binding.nativeReview ? [] : [
          eq(issues.assigneeAgentId, this.binding.agentId),
          eq(issues.executionRunId, this.binding.runId),
        ]),
        eq(agents.companyId, this.binding.companyId),
      ))
      .limit(1);
    if (
      !row
      || row.run.runtimeMode !== "native"
      || row.run.status !== "running"
      || ["paused", "terminated", "pending_approval", "error"].includes(row.actor.status)
    ) {
      throw new Error("paperclip_runner_tool_binding_not_authorized");
    }
    const [company] = await this.db.select().from(companies).where(eq(companies.id, this.binding.companyId));
    if (company?.status !== "active" || (company.budgetMonthlyCents > 0 && company.spentMonthlyCents >= company.budgetMonthlyCents)
      || (row.actor.budgetMonthlyCents > 0 && row.actor.spentMonthlyCents >= row.actor.budgetMonthlyCents)) throw forbidden("Company or budget authority unavailable");
    if (this.binding.nativeReview) {
      const admitted = readNativeReviewAssignmentContext(row.run.contextSnapshot);
      if (!admitted || admitted.nativeReviewInteractionId !== this.binding.nativeReview.nativeReviewInteractionId
        || admitted.nativeReviewDecisionId !== this.binding.nativeReview.nativeReviewDecisionId) {
        throw forbidden("The run was not admitted for this review.");
      }
      const review = await getNativeReviewAssignment(this.db, {
        ...this.binding, contextSnapshot: this.binding.nativeReview,
        allowResolvedByRunId: this.binding.runId,
      });
      if (!review || (review.interaction.status === "pending" && row.issue.executionRunId !== this.binding.runId)) {
        throw forbidden("The assigned review is no longer available to this run.");
      }
    }
    const privacy = await authorizationService(this.db).decide({ actor: this.#privacyActor(row.run), action: "issue:read",
      resource: { type: "issue", companyId: this.binding.companyId, issueId: row.issue.id } });
    if (!privacy.allowed) throw forbidden("The task is no longer available to this run");
    return row;
  }

  async #resolveReview(value: unknown) {
    const input = record(value);
    if (Object.keys(input).some((key) => !["decision", "reason"].includes(key))
      || !["accept", "reject"].includes(String(input.decision))) {
      throw badRequest("Choose accept or reject for this run's assigned review.");
    }
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (input.decision === "reject" && !reason) throw badRequest("Explain the changes required before rejecting the review.");
    const context = await this.#boundContext();
    const review = await getNativeReviewAssignment(this.db, {
      ...this.binding, contextSnapshot: this.binding.nativeReview,
      allowResolvedByRunId: this.binding.runId,
    });
    if (!review) throw forbidden("Review is no longer assigned to this run.");
    const expectedStatus = input.decision === "accept" ? "accepted" : "rejected";
    if (review.interaction.status !== "pending") {
      if (review.interaction.status !== expectedStatus) throw badRequest("This review already has a different decision.");
      return { interactionId: review.interaction.id, status: expectedStatus, deduplicated: true };
    }
    const apiUrl = this.binding.apiUrl ?? process.env.PAPERCLIP_API_URL;
    const token = this.#apiToken(context);
    if (!apiUrl || !token) throw new Error("Review tool authentication is unavailable");
    // Use the existing resolution route so authorization, activity, dependency
    // wakes and request-changes continuation have one implementation.
    const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api/issues/${this.binding.issueId}/interactions/${review.interaction.id}/${input.decision}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Paperclip-Run-Id": this.binding.runId },
      body: JSON.stringify(input.decision === "reject" ? { reason } : {}),
    });
    if (!response.ok) throw new Error(`Review decision was not accepted (${response.status}): ${(await response.text()).slice(0, 2_000)}`);
    return { interactionId: review.interaction.id, status: expectedStatus };
  }

  async #reportProgress(input: Record<string, unknown>): Promise<unknown> {
    const body = typeof input.body === "string" ? input.body.trim() : "";
    const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
    if (!body || !idempotencyKey) throw new Error("paperclip_runner_tool_input_invalid");
    let publication: Awaited<ReturnType<typeof persistActivity>>["publication"] | null = null;
    const result = await this.#withMutationReceipt(
      "report_progress",
      idempotencyKey,
      input,
      async (tx, context) => {
        const sourceTrust = this.binding.museRuntime ? await resolveActorSourceTrustForIssue({ db: tx, issue: context.issue,
          actor: { actorType: "agent", actorId: this.binding.agentId, agentId: this.binding.agentId, runId: this.binding.runId } }) : undefined;
        const comment = await issueService(tx).addComment(
          this.binding.issueId,
          body,
          { agentId: this.binding.agentId, runId: this.binding.runId },
          { authorizationReason: "paperclip_runner_protocol", sourceTrust },
          tx,
        );
        const result = { commentId: comment.id, issueId: this.binding.issueId, disposition: "applied" };
        const activity = await persistActivity(tx, {
          companyId: this.binding.companyId,
          actorType: "agent",
          actorId: this.binding.agentId,
          agentId: this.binding.agentId,
          runId: this.binding.runId,
          issueId: this.binding.issueId,
          action: "issue.comment_added",
          entityType: "issue",
          entityId: this.binding.issueId,
          details: {
            commentId: comment.id,
            bodySnippet: comment.body.slice(0, 120),
            identifier: context.issue.identifier,
            issueTitle: context.issue.title,
            authorizationReason: "paperclip_runner_protocol",
            source: "paperclip_runner_protocol",
          },
        });
        publication = activity.publication;
        return result;
      },
    );
    if (publication) publishActivity(publication);
    return result;
  }

  async #writeDocument(input: Record<string, unknown>): Promise<unknown> {
    const idempotencyKey = requiredString(input.idempotencyKey);
    let publication: Awaited<ReturnType<typeof persistActivity>>["publication"] | null = null;
    const result = await this.#withMutationReceipt("write_document", idempotencyKey, input, async (tx, context) => {
      const sourceTrust = this.binding.museRuntime ? await resolveActorSourceTrustForIssue({ db: tx, issue: context.issue,
        actor: { actorType: "agent", actorId: this.binding.agentId, agentId: this.binding.agentId, runId: this.binding.runId } }) : undefined;
      const write = await documentService(tx).upsertIssueDocument({
        issueId: this.binding.issueId,
        key: requiredString(input.key),
        title: requiredString(input.title),
        format: "markdown",
        body: requiredString(input.body),
        baseRevisionId: nullableProviderId(input.baseRevisionId),
        changeSummary: input.changeSummary === null || input.changeSummary === undefined
          ? null
          : requiredString(input.changeSummary),
        createdByAgentId: this.binding.agentId,
        createdByRunId: this.binding.runId,
        sourceTrust,
      });
      const activity = await persistActivity(tx, {
        companyId: this.binding.companyId,
        actorType: "agent",
        actorId: this.binding.agentId,
        agentId: this.binding.agentId,
        runId: this.binding.runId,
        issueId: this.binding.issueId,
        action: write.created ? "issue.document_created" : "issue.document_updated",
        entityType: "issue",
        entityId: this.binding.issueId,
        details: {
          key: write.document.key,
          documentId: write.document.id,
          title: write.document.title,
          format: write.document.format,
          revisionNumber: write.document.latestRevisionNumber,
          source: "paperclip_runner_protocol",
        },
      });
      publication = activity.publication;
      const [target] = await tx.select({ identifier: issues.identifier, issuePrefix: companies.issuePrefix })
        .from(issues).innerJoin(companies, eq(companies.id, issues.companyId))
        .where(and(eq(issues.id, this.binding.issueId), eq(issues.companyId, this.binding.companyId)));
      if (!target) throw new Error("paperclip_runner_document_task_not_found");
      return {
        disposition: "applied",
        created: write.created,
        document: write.document,
        documentHref: `/${encodeURIComponent(target.issuePrefix)}/issues/${encodeURIComponent(target.identifier ?? this.binding.issueId)}#document-${encodeURIComponent(write.document.key)}`,
      };
    });
    if (publication) publishActivity(publication);
    return result;
  }

  async #assertCompanyPerson(tx: Db, userId: string) {
    const [member] = await tx.select({ id: companyMemberships.id }).from(companyMemberships).where(and(eq(companyMemberships.companyId, this.binding.companyId),
      eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active")));
    if (!member) throw forbidden("Person is not an active company member");
  }

  async #createTask(input: Record<string, unknown>, identityContextId: string | null, receiptOnly = false): Promise<unknown> {
    const idempotencyKey = requiredString(input.idempotencyKey);
    if (input.status !== undefined && input.status !== "backlog" && input.status !== "todo") {
      throw new Error("paperclip_runner_tool_input_invalid");
    }
    const assigneeUserId = input.assigneeUserId == null ? null : requiredString(input.assigneeUserId);
    if (assigneeUserId && input.assigneeActorId != null) throw badRequest("Choose one agent or person assignee");
    const assigneeAgentId = assigneeUserId ? null : input.assigneeActorId == null ? this.binding.agentId : requiredString(input.assigneeActorId);
    if (assigneeAgentId) {
      const assignee = await agentService(this.db).getById(assigneeAgentId);
      if (!assignee || assignee.companyId !== this.binding.companyId) throw new Error("paperclip_runner_agent_not_found");
    }
    const priority = input.priority === "critical" || input.priority === "high"
      || input.priority === "medium" || input.priority === "low"
      ? input.priority
      : "medium";
    const blockedByIssueIds = Array.isArray(input.blockedByTaskIds)
      ? input.blockedByTaskIds.map(requiredString)
      : [];
    const durableIdempotencyKey =
      `paperclip-runner:create-task:${this.binding.issueId}:${idempotencyKey}`;
    const inputFingerprint = createHash("sha256")
      .update(canonicalJson(input))
      .digest("hex");
    const authorizeCreate = async (tx: Db, context: {
      run: typeof heartbeatRuns.$inferSelect;
      issue: typeof issues.$inferSelect;
      actor: typeof agents.$inferSelect;
    }) => {
      const parentIssueId = context.issue.conversationAgentId ? null : context.issue.id;
      const projectId = nullableProviderId(input.projectId) ?? (parentIssueId ? context.issue.projectId : null);
      if (this.binding.museRuntime && projectId) {
        const access = await authorizationService(tx).decide({ actor: this.#privacyActor(context.run), action: "project:read",
          resource: { type: "project", companyId: this.binding.companyId, projectId } });
        if (!access.allowed) throw forbidden("Project is unavailable to this Muse run");
      }
      const scope = { projectId, parentIssueId, assigneeAgentId, assigneeUserId };
      const decision = await authorizationService(tx).decide({
        actor: this.#privacyActor(context.run),
        action: "tasks:assign",
        resource: { type: "issue", companyId: this.binding.companyId, ...scope },
        scope,
      });
      if (!decision.allowed) throw forbidden(decision.explanation);
      if (assigneeAgentId) await assertAssignableAgent(tx, this.binding.companyId, assigneeAgentId, { kind: "work" });
      if (assigneeUserId) await this.#assertCompanyPerson(tx, assigneeUserId);
      const project = projectId
        ? await tx.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.companyId, this.binding.companyId))).then(rows => rows[0] ?? null)
        : null;
      const trust = resolveCoreTrustPreset({
        companyId: this.binding.companyId, agent: context.actor, project,
        run: { companyId: this.binding.companyId, executionPolicy: context.run.contextSnapshot?.executionPolicy },
      });
      if (trust.kind === "denied") throw forbidden(trust.detail);
      return { projectId, trust };
    };
    let publication: Awaited<ReturnType<typeof persistActivity>>["publication"] | null = null;
    const result = await this.#withMutationReceipt("create_task", idempotencyKey, input, async (tx, context) => {
      const { projectId, trust } = await authorizeCreate(tx, context);
      const conversation = Boolean(context.issue.conversationAgentId);
      const existingChild = await tx.select().from(issues).where(and(
        eq(issues.companyId, this.binding.companyId),
        eq(issues.originId, durableIdempotencyKey),
      )).limit(1).then((rows) => rows[0] ?? null);
      if (existingChild) {
        if (existingChild.originFingerprint !== inputFingerprint) {
          throw new Error("paperclip_runner_tool_idempotency_conflict");
        }
        return {
          commandId: `create-task:${existingChild.id}`,
          disposition: "duplicate",
          stateRevision: existingChild.statusVersion,
          entityRefs: [existingChild.id],
          scheduledWakeIds: [],
          task: {
            id: existingChild.id,
            identifier: existingChild.identifier,
            parentId: existingChild.parentId,
            status: existingChild.status,
            assigneeActorId: existingChild.assigneeAgentId,
            assigneeUserId: existingChild.assigneeUserId,
          },
        };
      }
      let deduplicated = false;
      const issueId = randomUUID();
      const createInput = {
        id: issueId,
        projectId,
        workspaceSelectionActor: this.#privacyActor(context.run),
        ...(trust.kind === "low_trust_review" ? {
          executionPolicy: { ...normalizeIssueExecutionPolicy({ authorizationPolicy: { trustPreset: trust.preset, trustBoundary: trust.boundary } }) },
          sourceTrust: buildLowTrustSourceTrust({ issueId, runId: this.binding.runId, agentId: this.binding.agentId }),
        } : {}),
        initialPlan: nullableProviderId(input.initialPlan),
        title: requiredString(input.title),
        description: input.description === null || input.description === undefined
          ? null
          : requiredString(input.description),
        status: input.status === "backlog" ? "backlog" as const
          : blockedByIssueIds.length > 0 ? "blocked" as const : "todo" as const,
        workMode: "standard" as const,
        priority,
        assigneeAgentId,
        assigneeUserId,
        blockedByIssueIds,
        blockParentUntilDone: false,
        createdByAgentId: this.binding.agentId,
        originKind: "manual" as const,
        originId: durableIdempotencyKey,
        originRunId: this.binding.runId,
        originIdentityContextId: identityContextId,
        continuationIdentityContextId: identityContextId,
        originFingerprint: inputFingerprint,
        actorAgentId: this.binding.agentId,
        actorRunId: this.binding.runId,
        idempotencyKey: durableIdempotencyKey,
        onDeduplicated: () => { deduplicated = true; },
      };
      const child = conversation
        ? await issueService(tx).create(this.binding.companyId, createInput)
        : (await issueService(tx).createChild(this.binding.issueId, createInput)).issue;
      if (deduplicated && child.originFingerprint !== inputFingerprint) {
        throw new Error("paperclip_runner_tool_idempotency_conflict");
      }
      let childStatus = child.status;
      let childStatusVersion = child.statusVersion;
      if (child.status === "blocked" && blockedByIssueIds.length > 0) {
        const readiness = await issueService(tx).getDependencyReadiness(child.id, tx);
        if (readiness.isDependencyReady) {
          const readyChild = await issueService(tx).update(child.id, {
            status: "todo",
            actorAgentId: this.binding.agentId,
          }, tx);
          if (readyChild) {
            childStatus = readyChild.status;
            childStatusVersion = readyChild.statusVersion;
          }
        }
      }
      if (!deduplicated) {
        const activity = await persistActivity(tx, {
          companyId: this.binding.companyId, actorType: "agent", actorId: this.binding.agentId,
          agentId: this.binding.agentId, runId: this.binding.runId, issueId: child.id,
          action: "issue.created", entityType: "issue", entityId: child.id,
          details: { identifier: child.identifier, title: child.title, parentId: child.parentId,
            assigneeAgentId: child.assigneeAgentId, assigneeUserId: child.assigneeUserId, status: childStatus, source: "paperclip_runner_protocol" },
        });
        publication = activity.publication;
      }
      const wakeId = `created-child:${child.id}`;
      const shouldWake = !deduplicated && childStatus === "todo" && Boolean(child.assigneeAgentId);
      return {
        commandId: `create-task:${child.id}`,
        disposition: deduplicated ? "duplicate" : "applied",
        stateRevision: childStatusVersion,
        entityRefs: [child.id],
        scheduledWakeIds: shouldWake ? [wakeId] : [],
        task: {
          id: child.id,
          identifier: child.identifier,
          parentId: child.parentId,
          projectId: child.projectId,
          status: childStatus,
          assigneeActorId: child.assigneeAgentId,
          assigneeUserId: child.assigneeUserId,
        },
      };
    }, { receiptOnly, beforeReceiptReplay: async (tx, context) => { await authorizeCreate(tx, context); } }) as Record<string, unknown> | undefined;
    if (result === undefined) return undefined;

    if (publication) publishActivity(publication);
    const task = record(result.task);
    const childId = requiredString(task.id);
    const scheduledWakeIds = Array.isArray(result.scheduledWakeIds)
      ? result.scheduledWakeIds.filter((value): value is string => typeof value === "string")
      : [];
    const assignedAgentId = typeof task.assigneeActorId === "string"
      ? task.assigneeActorId
      : null;
    if (this.binding.enqueueWakeup && assignedAgentId && scheduledWakeIds.length > 0) {
      await this.binding.enqueueWakeup(assignedAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: {
          issueId: childId,
          mutation: "create_child",
          parentIssueId: task.parentId ?? null,
        },
        idempotencyKey: scheduledWakeIds[0]!,
        requestedByActorType: "agent",
        requestedByActorId: this.binding.agentId,
        contextSnapshot: {
          issueId: childId,
          source: "paperclip_runner.create_task",
          parentIssueId: task.parentId ?? null,
        },
      });
    }
    return result;
  }


  async #reassignTask(input: Record<string, unknown>, receiptOnly = false): Promise<unknown> {
    const key = requiredString(input.idempotencyKey);
    const taskId = requiredUuid(input.taskId);
    const assigneeUserId = input.assigneeUserId == null ? null : requiredString(input.assigneeUserId);
    if (assigneeUserId && input.assigneeActorId != null) throw badRequest("Choose one agent or person assignee");
    const assigneeAgentId = assigneeUserId ? null : requiredUuid(input.assigneeActorId);
    const expectedUser = input.expectedAssigneeUserId == null ? null : requiredString(input.expectedAssigneeUserId);
    const expectedOwner = input.expectedAssigneeActorId === null ? null : requiredUuid(input.expectedAssigneeActorId);
    const expectedVersion = input.expectedStatusVersion;
    const reason = requiredString(input.reason);
    if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0 || key.length > 240 || reason.length > 20_000) {
      throw new Error("paperclip_runner_tool_input_invalid");
    }
    if (taskId === this.binding.issueId) {
      throw new Error("paperclip_runner_reassignment_current_task: delegate with create_task; this tool cannot interrupt its own caller");
    }
    const durableKey = `reassign:${this.binding.issueId}:${key}`;
    const fingerprint = createHash("sha256").update(canonicalJson(input)).digest("hex");
    const priorReceipt = async (tx: Db): Promise<Record<string, unknown> | null> => {
      const [prior] = await tx.select({ details: activityLog.details }).from(activityLog).where(and(
        eq(activityLog.companyId, this.binding.companyId), eq(activityLog.action, "issue.reassigned"),
        sql`${activityLog.details}->>'reassignmentKey' = ${durableKey}`,
      )).limit(1);
      if (!prior) return null;
      if (prior.details?.inputFingerprint !== fingerprint) throw new Error("paperclip_runner_tool_idempotency_conflict");
      return record(prior.details?.receipt);
    };
    const authorize = async (tx: Db, run: typeof heartbeatRuns.$inferSelect) => {
      // Muse idle comments lock this target before admission. Never wait for
      // their target while holding the caller's admission lock.
      const [target] = await tx.select().from(issues).where(and(
        eq(issues.id, taskId), eq(issues.companyId, this.binding.companyId),
      )).for("update", this.binding.museRuntime ? { noWait: true } : undefined).catch((error: unknown) => {
        if (this.binding.museRuntime && (record(error).code === "55P03" || record(record(error).cause).code === "55P03")) {
          throw new HttpError(409, "paperclip_runner_reassignment_conflict: target is busy; retry after current work settles");
        }
        throw error;
      });
      if (!target) throw new Error("paperclip_runner_task_not_found");
      const actor = this.#privacyActor(run);
      for (const action of ["issue:read", "tasks:assign"] as const) {
        const decision = await authorizationService(tx).decide({ actor, action, resource: {
          type: "issue", companyId: this.binding.companyId, issueId: taskId, projectId: target.projectId,
          parentIssueId: target.parentId, assigneeAgentId: action === "tasks:assign" ? assigneeAgentId : target.assigneeAgentId,
          assigneeUserId: action === "tasks:assign" ? assigneeUserId : target.assigneeUserId, status: target.status,
        }, scope: { issueId: taskId, projectId: target.projectId, parentIssueId: target.parentId, assigneeAgentId, assigneeUserId } });
        if (!decision.allowed) throw forbidden(decision.explanation);
      }
      if (assigneeAgentId) await assertAssignableAgent(tx, this.binding.companyId, assigneeAgentId, { kind: "work" });
      if (assigneeUserId) await this.#assertCompanyPerson(tx, assigneeUserId);
      const [externalChat] = await tx.select({ id: chatConversations.id }).from(chatConversations).where(and(
        eq(chatConversations.companyId, this.binding.companyId), eq(chatConversations.issueId, taskId),
      )).limit(1);
      if (externalChat) throw new Error("paperclip_runner_reassignment_conversation_locked");
      return target;
    };
    const validate = (target: typeof issues.$inferSelect) => {
      if (target.conversationAgentId) throw new Error("paperclip_runner_reassignment_conversation_locked");
      if (["done", "cancelled", "in_review"].includes(target.status) || record(target.executionState).status === "pending") {
        throw new Error("paperclip_runner_reassignment_state_denied");
      }
      if (target.assigneeUserId !== expectedUser || target.assigneeAgentId !== expectedOwner || target.statusVersion !== expectedVersion) {
        throw new Error("paperclip_runner_reassignment_conflict: refresh search_tasks before deciding again");
      }
    };
    // Stop outside row locks: the runtime needs those locks to acknowledge cancellation.
    // A second locked check below prevents any intervening ownership/version change.
    const prepared = receiptOnly ? null : await this.db.transaction(async (tx) => {
      const context = await this.#lockAuthorizedMutationContext(tx as unknown as Db);
      if (context.issue.workMode !== "standard") throw new Error("paperclip_runner_tool_mode_denied");
      const target = await authorize(tx as unknown as Db, context.run);
      if (await priorReceipt(tx as unknown as Db)) return null;
      validate(target);
      return target;
    });
    // Cancellation and ownership commit cannot share locks. If the second
    // phase loses its preconditions, restore runnable work to the still-current
    // prior owner. The durable wake key deduplicates retries; the state guard
    // closes races with later reassignment, completion, and manual holds.
    const restoreInterruptedWork = async (error: unknown) => {
      if (!prepared?.executionRunId || !prepared.assigneeAgentId || !this.binding.enqueueWakeup) return;
      const [stopped] = await this.db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, prepared.executionRunId), eq(heartbeatRuns.companyId, this.binding.companyId),
        eq(heartbeatRuns.agentId, prepared.assigneeAgentId), eq(heartbeatRuns.status, "cancelled"),
        eq(heartbeatRuns.errorCode, "issue_reassigned"),
      ));
      if (!stopped) return;
      const [current] = await this.db.select().from(issues).where(and(
        eq(issues.id, taskId), eq(issues.companyId, this.binding.companyId),
      ));
      if (!current || current.assigneeAgentId !== prepared.assigneeAgentId || current.assigneeUserId ||
          current.conversationAgentId || !["todo", "in_progress"].includes(current.status) ||
          record(current.executionState).status === "pending") return;
      if (current.executionRunId && current.executionRunId !== prepared.executionRunId) return;
      try {
        await this.binding.enqueueWakeup(current.assigneeAgentId, {
          source: "assignment", triggerDetail: "system", reason: "issue_assigned",
          payload: { issueId: taskId, mutation: "reassign_task_rollback", interruptedRunId: prepared.executionRunId },
          idempotencyKey: `${durableKey}:restore:${prepared.executionRunId}:${current.statusVersion}`,
          requestedByActorType: "agent", requestedByActorId: this.binding.agentId,
          contextSnapshot: { issueId: taskId, source: "paperclip_runner.reassign_task_rollback", forceFreshSession: true },
          issueStateGuard: { statuses: ["todo", "in_progress"], assigneeAgentId: current.assigneeAgentId, statusVersion: current.statusVersion },
        });
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], "paperclip_runner_reassignment_restore_failed");
      }
    };
    if (prepared && prepared.assigneeAgentId && prepared.assigneeAgentId !== assigneeAgentId) {
      if (prepared.executionRunId && (!this.binding.stopTaskForReassignment || !this.binding.enqueueWakeup)) {
        throw new Error("paperclip_runner_reassignment_stop_unavailable");
      }
      try {
        await this.binding.stopTaskForReassignment?.({ companyId: this.binding.companyId, issueId: taskId,
          agentId: prepared.assigneeAgentId, runId: prepared.executionRunId });
      } catch (error) {
        await restoreInterruptedWork(error);
        throw error;
      }
    }
    let publication: Awaited<ReturnType<typeof persistActivity>>["publication"] | null = null;
    const result = await this.#withMutationReceipt("reassign_task", key, input, async (tx, context) => {
      if (context.issue.workMode !== "standard") throw new Error("paperclip_runner_tool_mode_denied");
      const target = await authorize(tx, context.run);
      const prior = await priorReceipt(tx);
      if (prior) return prior;
      validate(target);
      if (target.executionRunId && target.executionRunId !== prepared?.executionRunId) {
        throw new Error("paperclip_runner_reassignment_conflict: a new execution started; refresh before retrying");
      }
      if (target.executionRunId && target.assigneeAgentId !== assigneeAgentId) {
        const [run] = await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, target.executionRunId));
        if (run && ["running", "queued", "scheduled_retry"].includes(run.status)) throw new Error("paperclip_runner_reassignment_stop_unconfirmed");
      }
      const changed = target.assigneeAgentId !== assigneeAgentId || target.assigneeUserId !== assigneeUserId;
      const updated = changed ? await issueService(tx).update(taskId, {
        companyGuard: this.binding.companyId, assigneeAgentId, assigneeUserId,
        status: target.status === "in_progress" ? "todo" : target.status,
        statusVersion: target.statusVersion + 1, actorAgentId: this.binding.agentId,
      }, tx) : target;
      if (!updated) throw new Error("paperclip_runner_task_not_found");
      const receipt = {
        commandId: `reassign-task:${taskId}:${updated.statusVersion}`, disposition: changed ? "applied" : "duplicate",
        stateRevision: updated.statusVersion, entityRefs: [taskId],
        scheduledWakeIds: changed && assigneeAgentId && updated.status === "todo" ? [`${durableKey}:${updated.statusVersion}`] : [],
      };
      if (changed) await issueService(tx).addComment(taskId, reason, { agentId: this.binding.agentId, runId: this.binding.runId });
      const activity = await persistActivity(tx, {
        companyId: this.binding.companyId, actorType: "agent", actorId: this.binding.agentId,
        agentId: this.binding.agentId, runId: this.binding.runId, issueId: taskId,
        action: "issue.reassigned", entityType: "issue", entityId: taskId,
        details: { source: "paperclip_runner_protocol", reassignmentKey: durableKey, inputFingerprint: fingerprint,
          previousAssigneeAgentId: target.assigneeAgentId, previousAssigneeUserId: target.assigneeUserId,
          assigneeAgentId, assigneeUserId, reason, changed, receipt },
      });
      publication = activity.publication;
      return receipt;
    }, { receiptOnly, beforeReceiptReplay: async (tx, context) => { await authorize(tx, context.run); } }).catch(async (error: unknown) => {
      await restoreInterruptedWork(error);
      throw error;
    }) as {
      stateRevision: number; scheduledWakeIds: string[];
    } | undefined;
    if (result === undefined) return undefined;
    if (publication) publishActivity(publication);
    // Replay repairs a failed dispatch. The durable wake key and state/version guard
    // prevent duplicate successors and prevent waking a later, unrelated assignment.
    if (assigneeAgentId && result.scheduledWakeIds.length && this.binding.enqueueWakeup) {
      await this.binding.enqueueWakeup(assigneeAgentId, {
        source: "assignment", triggerDetail: "system", reason: "issue_assigned",
        payload: { issueId: taskId, mutation: "reassign_task", reason },
        idempotencyKey: result.scheduledWakeIds[0]!, requestedByActorType: "agent", requestedByActorId: this.binding.agentId,
        contextSnapshot: { issueId: taskId, source: "paperclip_runner.reassign_task", reassignmentReason: reason },
        issueStateGuard: { statuses: ["todo"], assigneeAgentId, statusVersion: result.stateRevision },
      });
    }
    return result;
  }

  async #submitCommentary(tool: "submit_complaint" | "submit_suggestion", input: Record<string, unknown>, receiptOnly = false): Promise<unknown> {
    const parsed = agentCommentaryToolInputSchema.safeParse(input);
    if (!parsed.success) throw badRequest("Feedback accepts only a nonempty body of at most 524288 characters and a retry key of at most 240 characters");
    const value = { ...parsed.data, kind: tool === "submit_complaint" ? "complaint" : "suggestion" };
    const authorize = (tx: Db) => this.#lockAuthorizedMutationContext(tx);
    const result = receiptOnly
      ? await submitAgentCommentary(this.db, this.binding, value, authorize, { receiptOnly: true })
      : await submitAgentCommentary(this.db, this.binding, value, authorize);
    return result ?? undefined;
  }

  async #setTaskTitle(input: Record<string, unknown>, receiptOnly = false): Promise<unknown> {
    const titleInput = setIssueTitleSchema.parse(input);
    requiredString(titleInput.idempotencyKey);
    // Use the shared title receipt so native and HTTP retries have the same
    // identity and cannot overwrite a later user edit when switching surfaces.
    const receipt = await this.db.transaction(async (tx) => {
      await this.#lockAuthorizedMutationContext(tx as unknown as Db);
      const actor = {
        actorType: "agent", actorId: this.binding.agentId, agentId: this.binding.agentId, runId: this.binding.runId,
      } as const;
      return receiptOnly
        ? setIssueTitle(tx as unknown as Db, this.binding.companyId, this.binding.issueId, titleInput, actor, { receiptOnly: true })
        : setIssueTitle(tx as unknown as Db, this.binding.companyId, this.binding.issueId, titleInput, actor);
    });
    if (!receipt) return undefined;
    const { result, publication } = receipt;
    if (publication) publishActivity(publication);
    const syncExternalObjects = this.binding.syncIssueExternalObjects ?? externalObjectService(this.db, {
      enabled: async () => (await instanceSettingsService(this.db).getExperimental()).enableExternalObjects === true,
    }).syncIssueSafely;
    await syncExternalObjects(this.binding.issueId);
    return result;
  }

  async #setTaskMonitor(value: Record<string, unknown>, receiptOnly = false): Promise<unknown> {
    const input = setTaskMonitorSchema.parse(value);
    if (input.monitor?.externalRef) input.monitor.externalRef = redactIssueMonitorExternalRef(input.monitor.externalRef);
    const targetId = input.taskId ?? this.binding.issueId;
    let publication: Parameters<typeof publishActivity>[0] | null = null;
    let replayed = false;
    let replayStatus: string | null = null;
    let replayMonitor: ReturnType<typeof summarizeIssueMonitor> | null = null;
    const authorizeTarget = async (tx: Db, context: { run: typeof heartbeatRuns.$inferSelect }) => {
      // A second owned task may itself be writing another task: fail on lock
      // contention instead of taking opposite issue/run locks and deadlocking.
      const [target] = await tx.select().from(issues).where(and(
        eq(issues.id, targetId), eq(issues.companyId, this.binding.companyId),
      )).for("update", { noWait: true });
      if (!target) throw notFound("Task not found");
      const actor = this.#privacyActor(context.run);
      const access = authorizationService(tx);
      for (const action of ["issue:read", "issue:mutate"] as const) {
        const decision = await access.decide({ actor, action, resource: {
          type: "issue", companyId: this.binding.companyId, issueId: target.id,
          status: target.status, assigneeAgentId: target.assigneeAgentId, assigneeUserId: target.assigneeUserId,
        } });
        if (!decision.allowed) throw forbidden(decision.explanation);
      }
      await assertCanManageIssueMonitor(access, { actor }, target.companyId, target.assigneeAgentId, true);
      if (target.assigneeAgentId !== this.binding.agentId || target.assigneeUserId ||
          !["in_progress", "in_review"].includes(target.status)) {
        throw forbidden("Monitors require an in-progress or in-review task assigned to this agent");
      }
      return { target, actor };
    };
    const result = await this.#withMutationReceipt("set_task_monitor", input.idempotencyKey, input, async (tx, context) => {
      const { target, actor } = await authorizeTarget(tx, context);
      // The task lock also serializes retries after a new run resumes the task.
      // Keep the durable receipt in the existing run ledger, without a new table.
      const [earlier] = await tx.select({
        receipt: sql<ToolReceipt>`${heartbeatRuns.resultJson}->'semanticToolReceipts'->${input.idempotencyKey}`,
      }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, this.binding.companyId),
        eq(heartbeatRuns.agentId, this.binding.agentId),
        eq(heartbeatRuns.nativeIssueId, this.binding.issueId),
        sql`${heartbeatRuns.resultJson}->'semanticToolReceipts' ? ${input.idempotencyKey}`,
      )).orderBy(desc(heartbeatRuns.createdAt)).limit(1);
      if (earlier?.receipt) {
        if (earlier.receipt.operationId !== "set_task_monitor" || canonicalJson(earlier.receipt.input) !== canonicalJson(input)) {
          throw new Error("paperclip_runner_tool_idempotency_conflict");
        }
        replayed = true;
        replayStatus = target.status;
        replayMonitor = summarizeIssueMonitor(target, normalizeIssueExecutionPolicy(target.executionPolicy));
        return { taskId: target.id, status: target.status, monitor: replayMonitor };
      }
      const patch = prepareIssueMonitorUpdate(target, input.monitor, actor);
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.issueMonitors);
      const [updated] = await tx.update(issues).set({ ...patch, updatedAt: new Date() })
        .where(and(eq(issues.id, target.id), eq(issues.companyId, this.binding.companyId))).returning();
      if (!updated) throw notFound("Task not found");
      const monitor = summarizeIssueMonitor(updated, normalizeIssueExecutionPolicy(updated.executionPolicy));
      const activity = await persistActivity(tx, {
        companyId: this.binding.companyId, actorType: "agent", actorId: this.binding.agentId,
        agentId: this.binding.agentId, runId: this.binding.runId,
        action: input.monitor ? "issue.monitor_scheduled" : "issue.monitor_cleared",
        entityType: "issue", entityId: target.id,
        details: { identifier: target.identifier, nextCheckAt: monitor.nextCheckAt,
          notes: monitor.notes, scheduledBy: monitor.scheduledBy, serviceName: monitor.serviceName,
          timeoutAt: monitor.timeoutAt, maxAttempts: monitor.maxAttempts, recoveryPolicy: monitor.recoveryPolicy },
      });
      publication = activity.publication;
      return { taskId: updated.id, status: updated.status, monitor };
    }, { receiptOnly, beforeReceiptReplay: async (tx, context) => {
      const { target } = await authorizeTarget(tx, context);
      replayed = true;
      replayStatus = target.status;
      replayMonitor = summarizeIssueMonitor(target, normalizeIssueExecutionPolicy(target.executionPolicy));
    } });
    if (result === undefined) return undefined;
    if (publication) publishActivity(publication);
    return { ...record(result), ...(replayed ? { status: replayStatus, monitor: replayMonitor } : {}), replayed };
  }

  async #setDependencies(input: Record<string, unknown>): Promise<unknown> {
    const idempotencyKey = requiredString(input.idempotencyKey);
    if (!Array.isArray(input.blockedByTaskIds)) {
      throw new Error("paperclip_runner_tool_input_invalid");
    }
    const blockedByIssueIds = input.blockedByTaskIds.map(requiredString);
    return this.#withMutationReceipt("set_dependencies", idempotencyKey, input, async (tx, context) => {
      if (this.binding.museRuntime) for (const issueId of blockedByIssueIds) {
        const decision = await authorizationService(tx).decide({ actor: this.#privacyActor(context.run), action: "issue:read",
          resource: { type: "issue", companyId: this.binding.companyId, issueId } });
        if (!decision.allowed) throw forbidden("Dependency task is unavailable");
      }
      const updated = await issueService(tx).update(this.binding.issueId, {
        blockedByIssueIds,
        actorAgentId: this.binding.agentId,
      }, tx);
      if (!updated) throw new Error("paperclip_runner_task_not_found");
      return {
        commandId: `set-dependencies:${updated.id}:${updated.statusVersion}`,
        disposition: "applied",
        stateRevision: updated.statusVersion,
        entityRefs: [updated.id, ...blockedByIssueIds],
        scheduledWakeIds: [],
      };
    });
  }

  async #registerDeliverable(input: Record<string, unknown>): Promise<unknown> {
    const idempotencyKey = requiredString(input.idempotencyKey);
    const workspaceRoot = this.binding.workspaceRoot?.trim();
    if (!workspaceRoot) {
      throw new Error("paperclip_runner_file_handoff_workspace_unavailable");
    }
    const current = await this.#boundContext();
    const authorizeWorkspace = async (actor: typeof agents.$inferSelect) => {
      if (this.binding.dotRuntime) {
        if (!this.binding.workspaceBridge || actor.adapterConfig?.dotWorkspaceAccess !== true)
          throw forbidden("Dot workspace access is required to publish workspace files.");
        assertRunnerWorkspacePathAllowed(typeof input.contentRef === "string" ? input.contentRef : "");
        await this.binding.assertBridgeAuthority?.();
      }
    };
    await authorizeWorkspace(current.actor);
    const fileBinding = {
      companyId: this.binding.companyId,
      issueId: this.binding.issueId,
      runId: this.binding.runId,
      agentId: this.binding.agentId,
      workspaceRoot,
      executionTargetKind: this.binding.executionTargetKind ?? "local",
      readRemoteWorkspaceFile: this.binding.readRemoteWorkspaceFile,
      readRemoteTaskFile: this.binding.readRemoteTaskFile,
    } as const;
    const prior = record(record(current.run.resultJson).semanticToolReceipts)[idempotencyKey];
    const verifiedFile = prior === undefined ? await readVerifiedWorkspaceFile(fileBinding, {
      filename: typeof input.filename === "string" ? input.filename : "",
      contentType: typeof input.contentType === "string" ? input.contentType : "",
      byteSize: typeof input.byteSize === "number" ? input.byteSize : Number.NaN,
      sha256: typeof input.sha256 === "string" ? input.sha256 : "",
      contentRef: typeof input.contentRef === "string" ? input.contentRef : "",
      title: typeof input.title === "string" ? input.title : "",
    }) : null;
    let publication:
      Awaited<ReturnType<typeof persistActivity>>["publication"] | null = null;
    let rollbackDefinitePreCommitFailure: (() => Promise<void>) | null = null;
    const result = await this.#withMutationReceipt(
      "register_deliverable",
      idempotencyKey,
      input,
      async (tx, context) => {
        await authorizeWorkspace(context.actor);
        if (!verifiedFile) throw new Error("paperclip_runner_file_handoff_receipt_changed");
        const prepared = await prepareNativeRunnerFileHandoff({
          db: tx,
          binding: fileBinding,
          verifiedFile,
          storage: this.binding.storage,
        });
        rollbackDefinitePreCommitFailure =
          prepared.rollbackDefinitePreCommitFailure;
        if (prepared.result.disposition === "applied") {
          const activity = await persistActivity(tx, {
            companyId: this.binding.companyId,
            actorType: "agent",
            actorId: this.binding.agentId,
            agentId: this.binding.agentId,
            runId: this.binding.runId,
            issueId: this.binding.issueId,
            action: "issue.attachment_added",
            entityType: "issue",
            entityId: this.binding.issueId,
            details: {
              attachmentId: prepared.result.entityRefs[0],
              workProductId: prepared.result.entityRefs[1],
              commentId: prepared.result.entityRefs[2],
              identifier: context.issue.identifier,
              issueTitle: context.issue.title,
              source: "paperclip_runner_protocol",
            },
          });
          publication = activity.publication;
        }
        return prepared.result;
      },
      {
        onDefinitePreCommitFailure: async () => {
          const rollback = rollbackDefinitePreCommitFailure;
          rollbackDefinitePreCommitFailure = null;
          await rollback?.();
        },
      },
    );
    if (publication) publishActivity(publication);
    return result;
  }

  async #reuseChatAttachment(input: Record<string, unknown>): Promise<unknown> {
    const idempotencyKey = requiredString(input.idempotencyKey);
    if (idempotencyKey.length > 200) {
      throw new Error("paperclip_runner_tool_input_invalid");
    }
    const sourceCommentId = requiredUuid(input.sourceCommentId);
    const attachmentId = requiredUuid(input.attachmentId);
    const title = requiredString(input.title);
    if (title.length > 500) throw new Error("paperclip_runner_tool_input_invalid");
    let source: ChatAttachmentReuseSource | null = null;
    let publication:
      Awaited<ReturnType<typeof persistActivity>>["publication"] | null = null;
    let rollbackDefinitePreCommitFailure: (() => Promise<void>) | null = null;
    const authorize = async (tx: Db, contextSnapshot: unknown) => {
      source = await authorizeChatAttachmentReuse({
        db: tx,
        binding: this.binding,
        contextSnapshot,
        sourceCommentId,
        attachmentId,
      });
    };
    const result = await this.#withMutationReceipt(
      REUSE_CHAT_ATTACHMENT_TOOL_NAME,
      idempotencyKey,
      input,
      async (tx, context) => {
        if (context.issue.workMode === "ask") {
          throw new Error("paperclip_runner_tool_mode_denied");
        }
        await authorize(tx, context.run.contextSnapshot);
        const resultJson = record(context.run.resultJson);
        for (const receipt of Object.values(record(resultJson.semanticToolReceipts))) {
          const candidate = receipt as ToolReceipt | undefined;
          if (candidate?.operationId !== REUSE_CHAT_ATTACHMENT_TOOL_NAME) continue;
          const priorInput = record(candidate.input);
          if (
            priorInput.sourceCommentId === sourceCommentId &&
            priorInput.attachmentId === attachmentId
          ) {
            return { ...record(candidate.result), disposition: "duplicate" };
          }
        }
        const prepared = await prepareReusedChatAttachment({
          db: tx,
          binding: this.binding,
          source: source!,
          title,
          storage: this.binding.storage,
        });
        rollbackDefinitePreCommitFailure =
          prepared.rollbackDefinitePreCommitFailure;
        const activity = await persistActivity(tx, {
          companyId: this.binding.companyId,
          actorType: "agent",
          actorId: this.binding.agentId,
          agentId: this.binding.agentId,
          runId: this.binding.runId,
          issueId: this.binding.issueId,
          action: "issue.attachment_added",
          entityType: "issue",
          entityId: this.binding.issueId,
          details: {
            attachmentId: prepared.result.prepared.attachmentId,
            workProductId: prepared.result.prepared.workProductId,
            commentId: prepared.result.prepared.commentId,
            identifier: context.issue.identifier,
            issueTitle: context.issue.title,
            source: "paperclip_runner_chat_attachment_reuse",
            sourceCommentId,
            sourceAttachmentId: attachmentId,
            sourceSha256: source!.sha256,
          },
        });
        publication = activity.publication;
        return prepared.result;
      },
      {
        beforeReceiptReplay: async (tx, context) => {
          if (context.issue.workMode === "ask") {
            throw new Error("paperclip_runner_tool_mode_denied");
          }
          await authorize(tx, context.run.contextSnapshot);
        },
        onDefinitePreCommitFailure: async () => {
          const rollback = rollbackDefinitePreCommitFailure;
          rollbackDefinitePreCommitFailure = null;
          await rollback?.();
        },
      },
    );
    if (publication) publishActivity(publication);
    return result;
  }

  async #visibleMuseDocuments(issue: typeof issues.$inferSelect, documents: NativeIssueDocument[]) {
    if (!this.binding.museRuntime) return documents;
    const visible = await this.#projectMuseDocumentContent(issue, documents.map(document => ({
      id: document.latestRevisionId, documentId: document.id, body: document.body ?? "",
    })), documents);
    return documents.map((document, index) => ({ ...document, body: visible[index]!.body }));
  }

  async #projectMuseDocumentContent<T extends NativeDocumentContent>(
    readerIssue: typeof issues.$inferSelect,
    entries: T[],
    currentDocuments: NativeIssueDocument[],
    sourceIssueId = this.binding.issueId,
  ): Promise<T[]> {
    if (!this.binding.museRuntime || entries.length === 0) return entries;
    const readerSourceTrust = await resolveActorSourceTrustForIssue({ db: this.db, issue: readerIssue,
      actor: { actorType: "agent", actorId: this.binding.agentId, agentId: this.binding.agentId, runId: this.binding.runId } });
    if (isLowTrustQuarantined(readerSourceTrust)) return entries;
    const ids = entries.flatMap(entry => entry.id ? [entry.id] : []);
    const provenance = ids.length === 0 ? [] : await this.db.select({
      id: documentRevisions.id, documentId: documentRevisions.documentId,
      createdByAgentId: documentRevisions.createdByAgentId, createdByUserId: documentRevisions.createdByUserId,
      createdByRunId: documentRevisions.createdByRunId, userId: authUsers.id, writerCompanyId: agents.companyId,
      runId: heartbeatRuns.id, runCompanyId: heartbeatRuns.companyId, runAgentId: heartbeatRuns.agentId,
      runIssueId: heartbeatRuns.nativeIssueId, runExecutionPolicy: sql<unknown>`${heartbeatRuns.contextSnapshot}->'executionPolicy'`,
    }).from(documentRevisions)
      .leftJoin(authUsers, eq(authUsers.id, documentRevisions.createdByUserId))
      .leftJoin(agents, and(eq(agents.id, documentRevisions.createdByAgentId), eq(agents.companyId, this.binding.companyId)))
      .leftJoin(heartbeatRuns, and(eq(heartbeatRuns.id, documentRevisions.createdByRunId), eq(heartbeatRuns.companyId, this.binding.companyId)))
      .where(and(eq(documentRevisions.companyId, this.binding.companyId), inArray(documentRevisions.id, ids)));
    const byRevision = new Map(provenance.map(row => [row.id, row]));
    const byDocument = new Map(currentDocuments.filter(document => document.companyId === this.binding.companyId
      && document.issueId === sourceIssueId).map(document => [document.id, document]));
    const withhold = (entry: T, body: string): T => ({ ...entry, body,
      ...("changeSummary" in entry ? { changeSummary: null } : {}) });
    return entries.map(entry => {
      const document = byDocument.get(entry.documentId);
      const original = entry.id ? byRevision.get(entry.id) : undefined;
      if (!document || !original || original.documentId !== document.id) return withhold(entry, UNKNOWN_DOCUMENT_REVISION_BODY);
      const current = document.latestRevisionId === entry.id;
      if (current && isLowTrustQuarantined(document.sourceTrust)) return withhold(entry, LOW_TRUST_QUARANTINED_BODY);
      if (current && document.sourceTrust?.disposition === "promoted"
        && document.sourceTrust.promotedFrom?.artifactKind === "document"
        && document.sourceTrust.promotedFrom.artifactId === document.id) return entry;
      if (original.createdByUserId && original.userId === original.createdByUserId
        && !original.createdByAgentId && !original.createdByRunId) return entry;
      if (!original.createdByAgentId || !original.createdByRunId || original.runId !== original.createdByRunId
        || original.writerCompanyId !== this.binding.companyId || original.runCompanyId !== this.binding.companyId
        || original.runAgentId !== original.createdByAgentId
        || original.runIssueId !== sourceIssueId) return withhold(entry, UNKNOWN_DOCUMENT_REVISION_BODY);
      const policy = original.runExecutionPolicy;
      if (policy !== null && policy !== undefined && (typeof policy !== "object" || Array.isArray(policy))) {
        return withhold(entry, UNKNOWN_DOCUMENT_REVISION_BODY);
      }
      const trust = resolveCoreTrustPreset({ companyId: this.binding.companyId,
        run: { companyId: original.runCompanyId, executionPolicy: policy } });
      if (trust.kind === "low_trust_review") return withhold(entry, LOW_TRUST_QUARANTINED_BODY);
      if (trust.kind === "standard" && ((current && document.sourceTrust === null)
        || trust.sourcePresets.run === trust.preset)) return entry;
      return withhold(entry, UNKNOWN_DOCUMENT_REVISION_BODY);
    });
  }

  async #sourcePlanApproval(context: { issue: typeof issues.$inferSelect; run: Pick<typeof heartbeatRuns.$inferSelect, "responsibleUserId"> }) {
    const plan = await handoffPlanContext(this.db, context.issue, this.#privacyActor(context.run));
    if (!plan || !this.binding.museRuntime) return plan;
    const document = await documentService(this.db).getIssueDocumentByKey(plan.sourceIssueId, "plan");
    const [visible] = await this.#projectMuseDocumentContent(context.issue, [{
      id: plan.revisionId, documentId: document?.id ?? "", body: plan.markdown,
    }], document ? [document] : [], plan.sourceIssueId);
    return { ...plan, markdown: visible!.body };
  }

  async #acceptedPlan(contextSnapshot: unknown, issue: typeof issues.$inferSelect): Promise<{
    documentId: string;
    revisionId: string;
    revisionNumber: number;
    markdown: string;
  } | null> {
    const acceptedTarget = record(
      record(record(contextSnapshot).planReviewInteraction).acceptedTargetRevision,
    );
    let revisionId = typeof acceptedTarget.revisionId === "string"
      ? acceptedTarget.revisionId
      : null;
    if (!revisionId) revisionId = await this.#latestAcceptedPlanRevisionId();
    if (!revisionId) return null;

    const [revision] = await this.db.select({
      documentId: documentRevisions.documentId,
      revisionId: documentRevisions.id,
      revisionNumber: documentRevisions.revisionNumber,
      markdown: documentRevisions.body,
    })
      .from(documentRevisions)
      .innerJoin(issueDocuments, and(
        eq(issueDocuments.documentId, documentRevisions.documentId),
        eq(issueDocuments.companyId, this.binding.companyId),
        eq(issueDocuments.issueId, this.binding.issueId),
        eq(issueDocuments.key, "plan"),
      ))
      .where(and(
        eq(documentRevisions.id, revisionId),
        eq(documentRevisions.companyId, this.binding.companyId),
      ))
      .limit(1);
    if (!revision || !this.binding.museRuntime) return revision ?? null;
    const document = await documentService(this.db).getIssueDocumentByKey(this.binding.issueId, "plan");
    const [visible] = await this.#projectMuseDocumentContent(issue, [{
      id: revision.revisionId, documentId: revision.documentId, body: revision.markdown,
    }], document ? [document] : []);
    return { ...revision, markdown: visible!.body };
  }

  async #latestAcceptedPlanRevisionId(): Promise<string | null> {
    const rows = await this.db.select({ payload: issueThreadInteractions.payload })
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, this.binding.companyId),
        eq(issueThreadInteractions.issueId, this.binding.issueId),
        eq(issueThreadInteractions.kind, "request_confirmation"),
        eq(issueThreadInteractions.status, "accepted"),
      ))
      .orderBy(desc(issueThreadInteractions.resolvedAt), desc(issueThreadInteractions.createdAt));
    for (const row of rows) {
      const target = record(record(row.payload).target);
      if (
        target.type === "issue_document"
        && (target.issueId === undefined || target.issueId === this.binding.issueId)
        && target.key === "plan"
        && typeof target.revisionId === "string"
        && target.revisionId.length > 0
      ) return target.revisionId;
    }
    return null;
  }

  async #withInstructionMutationReceipt(
    tool: "update_agent_instructions" | "restore_agent_instructions",
    callId: string,
    input: Record<string, unknown>,
    recoveryOnly = false,
  ): Promise<unknown> {
    if (!callId || callId.length > 500) throw badRequest("A bounded runner call id is required");
    const key = `instruction:${callId}`;
    const digest = createHash("sha256").update(canonicalJson(input)).digest("hex");
    const targetAgentId = typeof input.targetAgentId === "string" ? input.targetAgentId : this.binding.agentId;
    const authorize = async (tx: Db) => {
      const [target] = await tx.select({ id: agents.id, companyId: agents.companyId }).from(agents)
        .where(and(eq(agents.id, targetAgentId), eq(agents.companyId, this.binding.companyId)));
      if (!target) throw notFound("Agent not found");
      return authorizeInstructionCommit(tx, {
        type: "agent", source: "agent_jwt", companyId: this.binding.companyId,
        agentId: this.binding.agentId, runId: this.binding.runId,
      }, target);
    };
    return withInstructionCallLock(this.db, `${this.binding.companyId}:${this.binding.runId}:${key}`, async () => {
      // A filesystem rename cannot roll back with PostgreSQL. Commit proof of
      // the attempt *before* permitting that effect. If the effect transaction
      // or its acknowledgement is lost, a missing result is unknown, not a
      // license to run the instruction write a second time.
      const reserved = recoveryOnly ? false : await this.db.transaction(async (tx) => {
        const context = await this.#lockAuthorizedMutationContext(tx as unknown as Db);
        const bound = await authorize(tx as unknown as Db);
        const resultJson = record(context.run.resultJson);
        if (record(resultJson.semanticToolReceipts)[key] !== undefined) return false;
        const attempts = record(resultJson.instructionToolAttempts);
        const prior = record(attempts[key]);
        if (attempts[key] !== undefined) {
          if (prior.operationId !== tool || prior.inputDigest !== digest) {
            throw new Error("paperclip_runner_tool_idempotency_conflict");
          }
          const failure = record(prior.failure);
          if (typeof failure.status === "number" && instructionPreWriteFailureStatuses.has(failure.status)
            && typeof failure.message === "string") {
            throw new HttpError(failure.status, failure.message, failure.details);
          }
          throw new SemanticToolOutcomeUnknownError(`paperclip_runner_instruction_outcome_unknown call_id=${callId} operation_id=${tool} input_digest=${digest}`);
        }
        if (Object.keys(attempts).length >= 512) throw badRequest("Run instruction mutation limit reached");
        attempts[key] = { operationId: tool, inputDigest: digest, targetAgentId };
        await tx.update(heartbeatRuns).set({ resultJson: { ...resultJson, instructionToolAttempts: attempts } })
          .where(eq(heartbeatRuns.id, this.binding.runId));
        await tx.insert(activityLog).values({
          companyId: this.binding.companyId, actorType: "agent", actorId: this.binding.agentId,
          agentId: this.binding.agentId, runId: this.binding.runId,
          responsibleUserId: bound.type === "agent" ? bound.onBehalfOfUserId : null,
          action: "agent.instruction_write_attempted", entityType: "agent", entityId: targetAgentId,
          details: { callId, operationId: tool, inputDigest: digest },
        });
        return true;
      });
      try {
        return await this.#withMutationReceipt(tool, key, input, async (tx) => {
          // Recovery reuses current authorization and receipt validation. If
          // the saved receipt vanished after inspection, never repeat the write.
          if (recoveryOnly) throw new SemanticToolOutcomeUnknownError(`paperclip_runner_instruction_receipt_unavailable call_id=${callId}`);
          return executeAgentInstructionTool({ db: tx, binding: {
            companyId: this.binding.companyId, agentId: this.binding.agentId, runId: this.binding.runId,
          }, tool, arguments: input });
        }, { beforeReceiptReplay: async (tx) => { await authorize(tx); } });
      } catch (error) {
        // Instruction validation, authorization and CAS errors precede the
        // file write. Storage errors and lost commit acknowledgements do not
        // prove that a reserved filesystem effect rolled back.
        if (!reserved) throw error;
        if (error instanceof HttpError && instructionPreWriteFailureStatuses.has(error.status)) {
          const failure = { status: error.status, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
          try {
            // Save the definite failure before exposing it as a final answer.
            // This is evidence of the admitted call, not another mutation, so
            // retain it even if the run stopped after the effect rolled back.
            await this.db.transaction(async (tx) => {
              const [run] = await tx.select().from(heartbeatRuns).where(and(
                eq(heartbeatRuns.id, this.binding.runId), eq(heartbeatRuns.companyId, this.binding.companyId),
                eq(heartbeatRuns.agentId, this.binding.agentId),
              )).for("update");
              if (!run) throw new Error("instruction_failure_run_missing");
              const resultJson = record(run.resultJson);
              const attempts = record(resultJson.instructionToolAttempts);
              const prior = record(attempts[key]);
              if (prior.operationId !== tool || prior.inputDigest !== digest
                || record(resultJson.semanticToolReceipts)[key] !== undefined) {
                throw new Error("instruction_failure_receipt_conflict");
              }
              attempts[key] = { ...prior, failure };
              await tx.update(heartbeatRuns).set({ resultJson: { ...resultJson, instructionToolAttempts: attempts } })
                .where(eq(heartbeatRuns.id, this.binding.runId));
            });
          } catch (persistenceError) {
            throw new SemanticToolOutcomeUnknownError(
              `paperclip_runner_instruction_failure_receipt_unavailable call_id=${callId}`,
              { cause: new AggregateError([error, persistenceError], "Definite instruction failure could not be saved") },
            );
          }
          throw error;
        }
        throw new SemanticToolOutcomeUnknownError(
          `paperclip_runner_instruction_outcome_unknown call_id=${callId}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    });
  }

  async #withMutationReceipt(
    operationId: string,
    idempotencyKey: string,
    input: Record<string, unknown>,
    effect: ((
      tx: Db,
      context: {
        run: typeof heartbeatRuns.$inferSelect;
        issue: typeof issues.$inferSelect;
        actor: typeof agents.$inferSelect;
      },
    ) => Promise<unknown>) | null,
    options: {
      receiptOnly?: boolean;
      onDefinitePreCommitFailure?: () => Promise<void>;
      beforeReceiptReplay?: (
        tx: Db,
        context: {
          run: typeof heartbeatRuns.$inferSelect;
          issue: typeof issues.$inferSelect;
          actor: typeof agents.$inferSelect;
        },
      ) => Promise<void>;
    } = {},
  ): Promise<unknown> {
    const mutate = async (tx: ExternalAdmissionTransaction) => {
      try {
        const context = await this.#lockAuthorizedMutationContext(
          tx as unknown as Db,
        );
        const isFilePreparation =
          operationId === "register_deliverable" ||
          operationId === REUSE_CHAT_ATTACHMENT_TOOL_NAME;
        const snapshot = record(context.run.contextSnapshot);
        const wake = snapshot.paperclipWake;
        const normalized = normalizePaperclipWakePayload(wake);
        let provider =
          normalized?.issue?.id === this.binding.issueId &&
          isPaperclipExternalChatContractTurn(wake)
            ? normalized.externalChatProvider
            : null;
        if (
          isFilePreparation &&
          snapshot.source === "issue.interaction.respond" &&
          snapshot.paperclipExternalChatQuestionResponse
        ) {
          // Answer text is invocation-only, so the persisted wake cannot use
          // the prompt-shape question predicate. Resolve the durable answer
          // chain and current reach/principal before effects or receipt replay;
          // a marker alone never supplies the provider or new authority.
          const authorized = await authorizeChatConversationForBoundRun(
            tx as unknown as Db,
            this.binding,
            context.run.contextSnapshot,
            "nonblocking",
          );
          const [endpoint] = await tx
            .select({ provider: chatEndpoints.provider })
            .from(chatEndpoints)
            .where(
              and(
                eq(chatEndpoints.id, authorized.endpointId),
                eq(chatEndpoints.companyId, this.binding.companyId),
                eq(chatEndpoints.assignedAgentId, this.binding.agentId),
              ),
            );
          if (!endpoint || endpoint.provider === "agentmail") {
            throw new Error("paperclip_runner_chat_attachment_binding_denied");
          }
          provider = endpoint.provider;
        }
        // Describe file preparation from the locked, server-built wake, never
        // from file/tool arguments. Replays of older receipts gain the same
        // honest delivery guidance without repeating their committed effect.
        const describeResult = (result: unknown): unknown => {
          if (!isFilePreparation) return result;
          return {
            ...record(result),
            fileDelivery: paperclipChatFilePreparationDelivery(provider),
          };
        };
        const resultJson = record(context.run.resultJson);
        const receipts = record(resultJson.semanticToolReceipts);
        const prior = receipts[idempotencyKey] as ToolReceipt | undefined;
        if (prior !== undefined) {
          if (
            prior.operationId !== operationId ||
            canonicalJson(prior.input) !== canonicalJson(input)
          ) {
            if (effect === null || options.receiptOnly) return undefined;
            throw new Error("paperclip_runner_tool_idempotency_conflict");
          }
          await options.beforeReceiptReplay?.(tx as unknown as Db, context);
          return describeResult(prior.result);
        }
        if (effect === null || options.receiptOnly) return undefined;
        const result = JSON.parse(
          JSON.stringify(
            describeResult(await effect(tx as unknown as Db, context)),
          ),
        ) as unknown;
        receipts[idempotencyKey] = {
          operationId,
          input,
          result,
        } satisfies ToolReceipt;
        await tx
          .update(heartbeatRuns)
          .set({
            resultJson: { ...resultJson, semanticToolReceipts: receipts },
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, this.binding.runId));
        return result;
      } catch (error) {
        await options.onDefinitePreCommitFailure?.().catch(() => undefined);
        throw error;
      }
    };
    return this.db.transaction(async tx => {
      if (operationId === "create_task") {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${this.binding.companyId}`}, 0))`);
      }
      return mutate(tx);
    });
  }

  async #lockAuthorizedMutationContext(tx: Db): Promise<{
    run: typeof heartbeatRuns.$inferSelect;
    issue: typeof issues.$inferSelect;
    actor: typeof agents.$inferSelect;
  }> {
    if (this.binding.museRuntime) {
      await withExternalExecutionAdmission(tx as unknown as ExternalAdmissionTransaction,
        this.binding.companyId, this.binding.agentId, this.binding.runId, async () => {});
    }
    // Match identity activation and queue mutations before locking the run.
    await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, this.binding.issueId), eq(issues.companyId, this.binding.companyId),
    )).for("update");
    // Authorization for writes is intentionally re-read only after the
    // transaction starts. Locking the run and issue in the same statement
    // closes the gap between the discovery-time check and the mutation: a
    // reassignment, replacement run, or terminal transition must commit either
    // before this check (and be rejected) or after this transaction completes.
    const [context] = await tx
      .select({ run: heartbeatRuns, issue: issues, actor: agents })
      .from(heartbeatRuns)
      .innerJoin(issues, eq(issues.id, this.binding.issueId))
      .innerJoin(agents, eq(agents.id, this.binding.agentId))
      .where(and(
        eq(heartbeatRuns.id, this.binding.runId),
        eq(heartbeatRuns.companyId, this.binding.companyId),
        eq(heartbeatRuns.agentId, this.binding.agentId),
        eq(heartbeatRuns.nativeIssueId, this.binding.issueId),
        eq(issues.companyId, this.binding.companyId),
        eq(issues.assigneeAgentId, this.binding.agentId),
        eq(issues.executionRunId, this.binding.runId),
        eq(agents.companyId, this.binding.companyId),
      ))
      .for("update")
      .limit(1);
    if (
      !context
      || context.run.runtimeMode !== "native"
      || context.run.status !== "running"
      || context.run.companyId !== this.binding.companyId
      || context.run.agentId !== this.binding.agentId
      || context.run.nativeIssueId !== this.binding.issueId
      || context.issue.companyId !== this.binding.companyId
      || context.issue.assigneeAgentId !== this.binding.agentId
      || context.issue.executionRunId !== this.binding.runId
      || context.actor.companyId !== this.binding.companyId
      || ["paused", "terminated", "pending_approval", "error"].includes(context.actor.status)
    ) {
      throw new Error("paperclip_runner_tool_binding_not_authorized");
    }
    if (this.binding.museRuntime) {
      const decision = await authorizationService(tx).decide({
        actor: this.#privacyActor(context.run), action: "issue:mutate",
        resource: { type: "issue", companyId: this.binding.companyId, issueId: context.issue.id,
          projectId: context.issue.projectId, parentIssueId: context.issue.parentId,
          status: context.issue.status, assigneeAgentId: context.issue.assigneeAgentId, assigneeUserId: context.issue.assigneeUserId },
      });
      if (!decision.allowed) throw forbidden(decision.explanation);
      await this.binding.assertBridgeAuthority?.(tx);
    }
    await assertNoCaseHandoffMutation(tx, this.binding.runId, this.binding.issueId);
    return context;
  }

  async #requestHumanInput(input: Record<string, unknown>, identityContextId: string | null): Promise<unknown> {
    const interactionKind = requiredString(input.interactionKind);
    const interactionKinds = {
      confirmation: "request_confirmation",
      checkbox: "request_checkbox_confirmation",
      questions: "ask_user_questions",
      suggest_tasks: "suggest_tasks",
      item_verdicts: "request_item_verdicts",
    } as const;
    const kind = interactionKinds[
      interactionKind as keyof typeof interactionKinds
    ];
    if (!kind) throw new Error("paperclip_runner_interaction_kind_invalid");
    const prompt = requiredString(input.prompt);
    const idempotencyKey = requiredString(input.idempotencyKey);
    let publication: Awaited<ReturnType<typeof persistActivity>>["publication"] | null = null;
    const result = await this.#withMutationReceipt(
      "request_human_input",
      idempotencyKey,
      input,
      async (tx, context) => {
        const suppliedPayload = record(input.payload);
        const targetRevisionId = nullableProviderId(input.targetRevisionId);
        const suppliedTarget = record(suppliedPayload.target);
        const inferredPlanningTarget = targetRevisionId !== null
          && suppliedPayload.target === undefined
          && kind === "request_confirmation"
          && context.issue.workMode === "planning"
          ? {
              type: "issue_document",
              issueId: context.issue.id,
              key: "plan",
              revisionId: targetRevisionId,
            }
          : null;
        if (targetRevisionId !== null && suppliedPayload.target === undefined && inferredPlanningTarget === null) {
          throw new Error('paperclip_runner_interaction_target_incomplete: targetRevisionId also requires payload.target = { type: "issue_document", key: "plan", revisionId: targetRevisionId }. Use the actual document key. If the source plan already authorized this scope, do not request approval again merely because the execution task has a new plan document.');
        }
        const normalizedPayload = inferredPlanningTarget !== null
          ? { ...suppliedPayload, target: inferredPlanningTarget }
          : suppliedTarget.type === "issue_document"
          ? {
              ...suppliedPayload,
              target: {
                ...suppliedTarget,
                issueId: suppliedTarget.issueId ?? context.issue.id,
                revisionId: suppliedTarget.revisionId ?? targetRevisionId,
              },
            }
          : suppliedPayload;
        const interaction = await issueThreadInteractionService(tx).create(context.issue, {
          kind,
          idempotencyKey,
          sourceRunId: this.binding.runId,
          title: requiredString(input.title),
          summary: prompt,
          continuationPolicy: requiredString(input.continuationPolicy),
          payload: {
            ...normalizedPayload,
            version: 1,
            prompt,
            ...(kind === "request_confirmation" ? {
              detailsMarkdown: normalizedPayload.detailsMarkdown ?? "",
              acceptLabel: normalizedPayload.acceptLabel ?? "Confirm",
              rejectLabel: normalizedPayload.rejectLabel ?? "Request changes",
              rejectRequiresReason: normalizedPayload.rejectRequiresReason ?? false,
              supersedeOnUserComment: normalizedPayload.supersedeOnUserComment ?? false,
            } : {}),
          },
        } as never, { agentId: this.binding.agentId, userId: null, identityContextId });
        const activity = await persistActivity(tx, {
          companyId: this.binding.companyId,
          actorType: "agent",
          actorId: this.binding.agentId,
          agentId: this.binding.agentId,
          runId: this.binding.runId,
          issueId: this.binding.issueId,
          action: "issue.thread_interaction_created",
          entityType: "issue",
          entityId: this.binding.issueId,
          details: {
            interactionId: interaction.id,
            interactionKind: interaction.kind,
            interactionStatus: interaction.status,
            continuationPolicy: interaction.continuationPolicy,
            source: "paperclip_runner_protocol",
          },
        });
        publication = activity.publication;
        return { interaction, disposition: "applied" };
      },
    );
    if (publication) publishActivity(publication);
    return result;
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("paperclip_runner_tool_input_invalid");
  return value.trim();
}

/**
 * Some native tool transports cannot faithfully express a nullable string in
 * their provider-facing schema and send the JSON null sentinel as a string.
 * Normalize only the well-known empty/null sentinels at the control-plane
 * boundary; real revision ids remain untouched and optimistic concurrency is
 * still enforced by the document service.
 */
function nullableProviderId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = requiredString(value);
  return normalized === "null" || normalized === "undefined" ? null : normalized;
}

function requiredUuid(value: unknown): string {
  const normalized = requiredString(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(normalized)) {
    throw new Error("paperclip_runner_tool_input_invalid");
  }
  return normalized;
}

function boundedLimit(value: unknown, fallback = 50, maximum = 100): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(1, Math.min(value, maximum))
    : fallback;
}

function redactedActor(actor: {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title?: string | null;
  status: string;
  reportsTo?: string | null;
  capabilities?: string | null;
}) {
  return {
    id: actor.id,
    companyId: actor.companyId,
    name: actor.name,
    role: actor.role,
    title: actor.title ?? null,
    status: actor.status,
    reportsTo: actor.reportsTo ?? null,
    capabilities: actor.capabilities ?? null,
  };
}

function redactedTask(task: typeof issues.$inferSelect) {
  return {
    id: task.id,
    url: publicChatTaskUrl(task.id),
    companyId: task.companyId,
    identifier: task.identifier,
    title: task.title,
    titleNeedsGeneration: task.titleNeedsGeneration,
    description: task.description,
    status: task.status,
    statusVersion: task.statusVersion,
    priority: task.priority,
    workMode: task.workMode,
    assigneeAgentId: task.assigneeAgentId,
    assigneeUserId: task.assigneeUserId,
    executionRunId: task.executionRunId,
    ...(task.monitorNextCheckAt || task.monitorLastTriggeredAt ? {
      monitor: summarizeIssueMonitor(task, normalizeIssueExecutionPolicy(task.executionPolicy)),
    } : {}),
    parentId: task.parentId,
    projectId: task.projectId,
    goalId: task.goalId,
  };
}
