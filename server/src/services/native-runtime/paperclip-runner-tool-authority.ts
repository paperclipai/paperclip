import { publicChatTaskUrl } from "../chat-task-url.js";
import { assertAssignableAgent } from "../agent-assignability.js";
import { authorizationService } from "../authorization.js";
import { handoffPlanContext } from "./handoff-plan-context.js";
import { callCreateSkillTool } from "../skill-tools.js";
import { callProjectTool } from "../project-tools.js";
import { isConnectorTool, executeConnectorTool, type ConnectorAssignment } from "../connector-runtime.js";
import { resolveNativeRuntimeMcpSnapshot } from "./runtime-context.js";
import { connectionIntentService } from "../connection-intents.js";
import { RUNTIME_CONNECTION_TOOL_DEFINITIONS } from "../connection-tool-definitions.js";
import { connectionsSearchInputSchema, connectionRequestInputSchema, CONNECTION_INTENT_AGENT_GUIDANCE } from "@paperclipai/shared";
import { createHash } from "node:crypto";
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
import { workspaceFileResourceService } from "../workspace-file-resources.js";
import { badRequest, forbidden } from "../../errors.js";
import { searchRunnerApi } from "./runner-api-catalog.js";
import { executeRunnerApi, validateRunnerApiCall, RUNNER_API_MAX_BYTES, type RunnerApiFile } from "./runner-api-client.js";
import { and, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  chatEndpoints,
  chatConversations,
  documentRevisions,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueDocuments,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../../vendor/paperclip-runner/index.js";
import { agentService } from "../agents.js";
import { approvalService } from "../approvals.js";
import { documentService } from "../documents.js";
import { issueService } from "../issues.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { getNativeReviewAssignment, readNativeReviewAssignmentContext, type NativeReviewAssignmentContext } from "./native-review-participant.js";
import { childReviewOutcomes } from "./child-review-outcomes.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { captureRunIdentity } from "../run-identity.js";
import { prepareNativeRunnerFileHandoff, type RemoteWorkspaceFileReader } from "./native-runner-file-handoff.js";
import { MAX_ATTACHMENT_BYTES } from "../../attachment-types.js";
import {
  READ_CURRENT_WAKE_COMMENTS_TOOL_DEFINITION,
  READ_CURRENT_WAKE_COMMENTS_TOOL_NAME,
  readCurrentWakeComments,
  type CurrentWakeCommentsBinding,
} from "./current-wake-comments.js";
import {
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

const IMPLEMENTED_OPERATIONS = new Set([
  "search_api", "call_api", "hire_agent",
  "get_task_context", "get_task_history", "search_tasks", "report_progress",
  "request_human_input",
  "create_skill", "create_task", "reassign_task", "set_dependencies", "create_project", "list_project_repositories", "list_projects", "register_deliverable",
  "list_documents", "read_document", "list_document_revisions", "write_document",
  "list_agents", "get_agent", "list_approvals", "get_approval", "get_approval_context",
]);

const NATIVE_REVIEW_READ_TOOLS = new Set([
  "get_task_context", "get_task_history", "list_documents", "read_document", "list_document_revisions",
]);

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
  connectorAssignments?: ConnectorAssignment[];
  apiToolsEnabled?: boolean;
  workMode?: "standard" | "planning" | "ask";
  workspaceRoot?: string;
  executionTargetKind?: "local" | "remote";
  readRemoteWorkspaceFile?: RemoteWorkspaceFileReader;
  currentWakeComments?: CurrentWakeCommentsBinding;
  chatAttachmentReadScope?: NativeChatAttachmentReadScope;
  stopTaskForReassignment?: (target: { companyId: string; issueId: string; agentId: string; runId: string | null }) => Promise<void>;
  enqueueWakeup?: (agentId: string, options: {
    source: "assignment";
    triggerDetail: "system";
    reason: "issue_assigned";
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

export class PaperclipRunnerToolAuthority {
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
          (runnerApiToolsEnabled(
            this.binding.companyId,
            this.binding.apiToolsEnabled,
          ) ||
            !["search_api", "call_api", "hire_agent"].includes(descriptor.operationId)) &&
          descriptor.allowedModes.includes(workMode) &&
          (descriptor.operationId !== "register_deliverable" ||
            (Boolean(this.binding.workspaceRoot) &&
              ((this.binding.executionTargetKind ?? "local") === "local" || Boolean(this.binding.readRemoteWorkspaceFile)))),
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
                    description:
                      "Workspace-relative source path. Absolute paths, URLs, traversal, and symlinks are rejected.",
                  },
                },
              }
            : descriptor.inputSchema,
      }));
    // Keep the provider session's direct tool catalog stable across ordinary
    // and truncated external-chat turns. Execution still fails closed unless
    // this exact run carries a server-verified current-wake binding.
    definitions.push(READ_CURRENT_WAKE_COMMENTS_TOOL_DEFINITION);
    definitions.push(LIST_CHAT_ATTACHMENTS_TOOL_DEFINITION);
    definitions.push(REUSE_CHAT_ATTACHMENT_TOOL_DEFINITION);
    definitions.push(READ_CHAT_ATTACHMENT_TOOL_DEFINITION);
    return [...RUNTIME_CONNECTION_TOOL_DEFINITIONS, ...(this.binding.connectorAssignments ?? []).flatMap((assignment) => assignment.tools), ...definitions];
  }

  async execute(call: {
    tool: string;
    callId: string;
    arguments: unknown;
  }): Promise<unknown> {
    if (this.binding.nativeReview) {
      if (call.tool === "resolve_review") return this.#resolveReview(call.arguments);
      if (!NATIVE_REVIEW_READ_TOOLS.has(call.tool)) {
        throw forbidden("This review run may only inspect the assigned task and resolve its review.");
      }
    }
    if (isConnectorTool(call.tool)) {
      if (!(this.binding.connectorAssignments ?? []).some((assignment) => assignment.tools.some((tool) => tool.name === call.tool))) throw forbidden("Connector tool is not available to this run");
      const { run } = await this.#boundContext();
      const snapshot = record(run.contextSnapshot);
      if (call.tool.startsWith("agentmail_") && (isPaperclipExternalChatContractTurn(snapshot.paperclipWake) || String(snapshot.source ?? "").startsWith("chat:") || snapshot.paperclipExternalChatQuestionResponse)) throw forbidden("Restricted chat runs cannot use email actions");
      return executeConnectorTool(this.db, this.binding, call.tool, call.arguments);
    }
    if (RUNTIME_CONNECTION_TOOL_DEFINITIONS.some((tool) => tool.name === call.tool)) {
      await this.#boundContext();
      const { run } = await captureRunIdentity(this.db, this.binding);
      if (!run.responsibleUserId) throw forbidden("This task needs a responsible user before requesting a connection");
      const claims = {
        sub: this.binding.agentId, company_id: this.binding.companyId,
        run_id: this.binding.runId, responsible_user_id: run.responsibleUserId,
      };
      const connections = connectionIntentService(this.db);
      if (call.tool === "connections_search") return connections.search(claims, connectionsSearchInputSchema.parse(call.arguments).query);
      const result = await connections.request(claims, connectionRequestInputSchema.parse(call.arguments).service);
      if (result.state === "ready" && this.binding.pinnedMcpDigest && this.binding.enqueueWakeup) {
        const current = await resolveNativeRuntimeMcpSnapshot({ db: this.db, agent: { id: this.binding.agentId, companyId: this.binding.companyId }, runId: this.binding.runId });
        if (current.digest !== this.binding.pinnedMcpDigest) {
          const idempotencyKey = `connection-intent:tools:${this.binding.runId}:${current.digest}`;
          const delivered = () => this.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
            eq(agentWakeupRequests.companyId, this.binding.companyId), eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
            notInArray(agentWakeupRequests.status, ["skipped", "failed", "cancelled"]),
          )).limit(1);
          if (!(await delivered()).length) try { await this.binding.enqueueWakeup(this.binding.agentId, {
            source: "assignment", triggerDetail: "system", reason: "issue_assigned",
            payload: { issueId: this.binding.issueId, mutation: "connection_tools_refreshed" },
            idempotencyKey,
            issueStateGuard: { statuses: ["in_progress", "in_review"], assigneeAgentId: this.binding.agentId },
            requestedByActorType: "agent", requestedByActorId: this.binding.agentId,
            contextSnapshot: { issueId: this.binding.issueId, taskId: this.binding.issueId, forceFreshSession: true, wakeReason: "issue_assigned", source: "connection_tools.refreshed" },
          }); } catch (error) { if (!(await delivered()).length) throw error; }
          return { ...result, instruction: "Access is already authorized. A fresh continuation with updated tools is queued. Finish independent work, then yield. Do not request authorization again." };
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
      case "create_skill": {
        const apiUrl = this.binding.apiUrl ?? process.env.PAPERCLIP_API_URL;
        const token = createLocalAgentJwt(this.binding.agentId, this.binding.companyId, context.actor.adapterType, this.binding.runId, context.run.responsibleUserId);
        if (!apiUrl || !token) throw new Error("Skill tool authentication is unavailable");
        return callCreateSkillTool({ arguments: input, apiUrl, token, companyId: this.binding.companyId });
      }
      case "create_project":
      case "list_project_repositories":
      case "list_projects": {
        const apiUrl = this.binding.apiUrl ?? process.env.PAPERCLIP_API_URL;
        const token = createLocalAgentJwt(this.binding.agentId, this.binding.companyId, context.actor.adapterType, this.binding.runId, context.run.responsibleUserId);
        if (!apiUrl || !token) throw new Error("Project tool authentication is unavailable");
        return callProjectTool({ name: call.tool, arguments: input, apiUrl, token,
          companyId: this.binding.companyId, issueId: this.binding.issueId, agentId: this.binding.agentId,
          conversation: Boolean(context.issue.conversationAgentId) });
      }
      case "search_api": return searchRunnerApi(call.arguments);
      case "hire_agent": {
        const body: Record<string, unknown> = {
          name: requiredString(input.name),
          adapterType: "paperclip_runner",
          inheritRuntimeFrom: "caller",
          reportsTo: this.binding.agentId,
          sourceIssueId: this.binding.issueId,
        };
        if (input.role !== undefined) body.role = input.role;
        if (input.title !== undefined) body.title = input.title;
        if (input.capabilities !== undefined) body.capabilities = input.capabilities;
        if (typeof input.instructions === "string" && input.instructions.trim()) {
          body.instructionsBundle = {
            entryFile: "AGENTS.md",
            files: { "AGENTS.md": input.instructions },
          };
        }
        const { operationId, ...response } = record(await this.#callApi(call.callId, {
          operationId: "POST /api/companies/{companyId}/agent-hires",
          pathParams: { companyId: this.binding.companyId },
          body,
        }));
        return { ...response, apiOperationId: operationId };
      }
      case "call_api": {
        // PRP reserves operationId/callId for semantic result identity. The
        // HTTP operation is metadata, including in previously saved receipts;
        // exposing it as operationId makes the runner reject a valid response.
        const { operationId, ...response } = record(await this.#callApi(call.callId, call.arguments));
        return { ...response, apiOperationId: operationId };
      }
      case "get_task_context": {
        const childTasks = await this.db.select().from(issues)
          .where(and(
            eq(issues.companyId, this.binding.companyId),
            eq(issues.parentId, this.binding.issueId),
            isNull(issues.hiddenAt),
          ))
          .orderBy(desc(issues.createdAt), desc(issues.id))
          .limit(101);
        return {
          company: { id: this.binding.companyId },
          actor: redactedActor(context.actor),
          activeTask: redactedTask(context.issue),
          childTasks: childTasks.slice(0, 100).map(redactedTask),
          childTasksTruncated: childTasks.length > 100,
          delegationGuidance: "Reuse existing child tasks for delegated work. Inspect a completed child's comments and documents before creating another task for the same deliverable. Use search_tasks if the child task list is truncated.",
          run: {
            id: this.binding.runId,
            status: context.run.status,
            invocationSource: context.run.invocationSource,
          },
          connectionGuidance: CONNECTION_INTENT_AGENT_GUIDANCE,
          acceptedPlan: await this.#acceptedPlan(context.run.contextSnapshot),
          sourcePlanApproval: await handoffPlanContext(this.db, context.issue),
          childReviewOutcomes: await childReviewOutcomes(this.db, this.binding.companyId, this.binding.issueId),
          ...(this.binding.nativeReview ? {
            assignedReview: (await getNativeReviewAssignment(this.db, {
              ...this.binding, contextSnapshot: this.binding.nativeReview,
              allowResolvedByRunId: this.binding.runId,
            }))?.interaction,
          } : {}),
        };
      }
      case "get_task_history": {
        const limit = boundedLimit(input.limit);
        const comments = await this.db.select({
          id: issueComments.id,
          body: issueComments.body,
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
        return { comments: comments.reverse() };
      }
      case "search_tasks": {
        const tasks = await issueService(this.db).list(this.binding.companyId);
        const query = typeof input.query === "string" ? input.query.toLowerCase() : "";
        const statuses = Array.isArray(input.statuses) ? new Set(input.statuses.filter((value): value is string => typeof value === "string")) : null;
        return { tasks: tasks.filter((task) =>
          (!query || `${task.identifier} ${task.title} ${task.description ?? ""}`.toLowerCase().includes(query))
          && (!statuses || statuses.size === 0 || statuses.has(task.status))
        ).slice(0, boundedLimit(input.limit)).map(redactedTask) };
      }
      case "list_documents":
        return { documents: await documentService(this.db).listIssueDocuments(this.binding.issueId) };
      case "read_document": {
        const document = await documentService(this.db).getIssueDocumentByKey(this.binding.issueId, requiredString(input.key));
        if (!document) throw new Error("paperclip_runner_document_not_found");
        return { document };
      }
      case "list_document_revisions":
        return { revisions: await documentService(this.db).listIssueDocumentRevisions(this.binding.issueId, requiredString(input.key)) };
      case "write_document": return this.#writeDocument(input);
      case "list_agents":
        return { actors: (await agentService(this.db).list(this.binding.companyId)).map(redactedActor) };
      case "get_agent": {
        const actor = await agentService(this.db).getById(requiredString(input.actorId));
        if (!actor || actor.companyId !== this.binding.companyId) throw new Error("paperclip_runner_agent_not_found");
        return { actor: redactedActor(actor) };
      }
      case "list_approvals":
        return { approvals: await approvalService(this.db).list(this.binding.companyId) };
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
          ));
        return { approval, tasks: tasks.map((row) => row.issue) };
      }
      case "report_progress": return this.#reportProgress(input);
      case "request_human_input": return this.#requestHumanInput(input,
        (await captureRunIdentity(this.db, this.binding)).context?.id ?? null);
      case "create_task": return this.#createTask(input,
        (await captureRunIdentity(this.db, this.binding)).context?.id ?? null);
      case "reassign_task": return this.#reassignTask(input);
      case "set_dependencies": return this.#setDependencies(input);
      case "register_deliverable": return this.#registerDeliverable(input);
      default: throw new Error("paperclip_runner_tool_not_bound");
    }
  }

  async #callApi(callId: string, value: unknown): Promise<unknown> {
    const bound = await this.#boundContext();
    const context = { ...this.binding, issueIdentifier: bound.issue.identifier, workMode: bound.issue.workMode };
    const { input, operation } = validateRunnerApiCall(value, context);
    const apiUrl = this.binding.apiUrl ?? process.env.PAPERCLIP_API_URL;
    if (!apiUrl) throw new Error("Paperclip API origin is unavailable");
    const token = createLocalAgentJwt(this.binding.agentId, this.binding.companyId, bound.actor.adapterType, this.binding.runId, bound.run.responsibleUserId);
    if (!token) throw new Error("Paperclip run authentication is unavailable");
    const execute = async () => {
      const current = await this.#boundContext();
      if (!runnerApiToolsEnabled(this.binding.companyId, this.binding.apiToolsEnabled)) throw new Error("paperclip_runner_tool_not_advertised");
      return executeRunnerApi(input, { ...context, workMode: current.issue.workMode }, {
        apiUrl, token,
        beforeDispatch: async () => {
          const fresh = await this.#boundContext();
          if (!runnerApiToolsEnabled(this.binding.companyId, this.binding.apiToolsEnabled)) throw new Error("paperclip_runner_tool_not_advertised");
          validateRunnerApiCall(input, { ...context, workMode: fresh.issue.workMode });
        },
        readFile: (file) => this.#readApiFile(file),
        saveResponse: async (bytes, contentType) => {
          const storage = this.binding.storage ?? getStorageService();
          const saved = await storage.putFile({ companyId: this.binding.companyId, namespace: "runner-api", originalFilename: contentType.includes("json") ? "response.json" : "response.bin", contentType, body: bytes });
          const asset = await assetService(this.db).create(this.binding.companyId, { ...saved, createdByAgentId: this.binding.agentId });
          const activity = await persistActivity(this.db, { companyId: this.binding.companyId, actorType: "agent", actorId: this.binding.agentId, agentId: this.binding.agentId, runId: this.binding.runId, issueId: this.binding.issueId, action: "asset.created", entityType: "asset", entityId: asset.id, details: { source: "runner.call_api", byteSize: saved.byteSize } });
          publishActivity(activity.publication);
          return { artifactId: asset.id, url: `/api/assets/${asset.id}/content`, contentType, byteSize: saved.byteSize, sha256: saved.sha256 };
        },
      });
    };
    if (["GET", "HEAD", "OPTIONS"].includes(operation.method)) return execute();
    if (!callId || callId.length > 500) throw badRequest("A bounded runner call id is required");
    // Reserve durably before HTTP dispatch, without holding a DB lock over an
    // HTTP route that itself needs DB locks. A crash leaves an explicit unknown
    // outcome rather than replaying a possibly committed external mutation.
    const key = createHash("sha256").update(callId).digest("hex");
    const digest = createHash("sha256").update(canonicalJson(input)).digest("hex");
    const prior = await this.db.transaction(async (tx) => {
      const locked = await this.#lockAuthorizedMutationContext(tx as unknown as Db);
      const resultJson = record(locked.run.resultJson);
      const receipts = record(resultJson.apiToolReceipts);
      const existing = record(receipts[key]);
      if (receipts[key]) {
        if (existing.digest !== digest) throw badRequest("API call id was reused with different arguments");
        return { result: existing.result ?? { ok: false, status: null, error: "api_outcome_unknown", outcome: "unknown", guidance: "Inspect state before issuing another mutation." } };
      }
      if (Object.keys(receipts).length >= 512) throw badRequest("Run API mutation limit reached");
      receipts[key] = { digest, operationId: operation.operationId, state: "pending" };
      await tx.update(heartbeatRuns).set({ resultJson: { ...resultJson, apiToolReceipts: receipts } }).where(eq(heartbeatRuns.id, this.binding.runId));
      return null;
    });
    if (prior) return prior.result;
    const result = await execute();
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
      receipts[key] = { digest, operationId: operation.operationId, state: "completed", result };
      await tx.update(heartbeatRuns).set({ resultJson: { ...resultJson, apiToolReceipts: receipts } }).where(eq(heartbeatRuns.id, this.binding.runId));
    });
    return result;
  }

  async #readApiFile(file: RunnerApiFile): Promise<{ bytes: Buffer; filename: string; contentType: string }> {
    if (file.artifactId) {
      const asset = await assetService(this.db).getById(file.artifactId);
      if (!asset || asset.companyId !== this.binding.companyId) throw forbidden("Artifact is not available in this company");
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
      return { bytes: Buffer.concat(chunks), filename: asset.originalFilename ?? "file", contentType: asset.contentType };
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
    return approval;
  }

  async #boundContext() {
    const [row] = await this.db.select({ issue: issues, actor: agents, run: heartbeatRuns })
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
    const token = createLocalAgentJwt(this.binding.agentId, this.binding.companyId,
      context.actor.adapterType, this.binding.runId, context.run.responsibleUserId);
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
        const comment = await issueService(tx).addComment(
          this.binding.issueId,
          body,
          { agentId: this.binding.agentId, runId: this.binding.runId },
          { authorizationReason: "paperclip_runner_protocol" },
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
    const result = await this.#withMutationReceipt("write_document", idempotencyKey, input, async (tx) => {
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
      return {
        disposition: "applied",
        created: write.created,
        document: write.document,
      };
    });
    if (publication) publishActivity(publication);
    return result;
  }

  async #createTask(input: Record<string, unknown>, identityContextId: string | null): Promise<unknown> {
    const idempotencyKey = requiredString(input.idempotencyKey);
    if (input.status !== undefined && input.status !== "backlog" && input.status !== "todo") {
      throw new Error("paperclip_runner_tool_input_invalid");
    }
    const assigneeAgentId = input.assigneeActorId === null || input.assigneeActorId === undefined
      ? this.binding.agentId
      : requiredString(input.assigneeActorId);
    const assignee = await agentService(this.db).getById(assigneeAgentId);
    if (!assignee || assignee.companyId !== this.binding.companyId) {
      throw new Error("paperclip_runner_agent_not_found");
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
    let publication: Awaited<ReturnType<typeof persistActivity>>["publication"] | null = null;
    const result = await this.#withMutationReceipt("create_task", idempotencyKey, input, async (tx, context) => {
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
          },
        };
      }
      let deduplicated = false;
      const createInput = {
        projectId: nullableProviderId(input.projectId),
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
            assigneeAgentId: child.assigneeAgentId, status: childStatus, source: "paperclip_runner_protocol" },
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
        },
      };
    }) as Record<string, unknown>;

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


  async #reassignTask(input: Record<string, unknown>): Promise<unknown> {
    const key = requiredString(input.idempotencyKey);
    const taskId = requiredUuid(input.taskId);
    const assigneeAgentId = requiredUuid(input.assigneeActorId);
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
      const [target] = await tx.select().from(issues).where(and(eq(issues.id, taskId), eq(issues.companyId, this.binding.companyId))).for("update");
      if (!target) throw new Error("paperclip_runner_task_not_found");
      const actor = { type: "agent" as const, source: "agent_jwt" as const, companyId: this.binding.companyId,
        agentId: this.binding.agentId, runId: this.binding.runId, onBehalfOfUserId: run.responsibleUserId };
      for (const action of ["issue:read", "tasks:assign"] as const) {
        const decision = await authorizationService(tx).decide({ actor, action, resource: {
          type: "issue", companyId: this.binding.companyId, issueId: taskId, projectId: target.projectId,
          parentIssueId: target.parentId, assigneeAgentId: action === "tasks:assign" ? assigneeAgentId : target.assigneeAgentId,
          assigneeUserId: action === "tasks:assign" ? null : target.assigneeUserId, status: target.status,
        } });
        if (!decision.allowed) throw forbidden(decision.explanation);
      }
      await assertAssignableAgent(tx, this.binding.companyId, assigneeAgentId, { kind: "work" });
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
      if (target.assigneeUserId || target.assigneeAgentId !== expectedOwner || target.statusVersion !== expectedVersion) {
        throw new Error("paperclip_runner_reassignment_conflict: refresh search_tasks before deciding again");
      }
    };
    // Stop outside row locks: the runtime needs those locks to acknowledge cancellation.
    // A second locked check below prevents any intervening ownership/version change.
    const prepared = await this.db.transaction(async (tx) => {
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
      const changed = target.assigneeAgentId !== assigneeAgentId;
      const updated = changed ? await issueService(tx).update(taskId, {
        companyGuard: this.binding.companyId, assigneeAgentId, assigneeUserId: null,
        status: target.status === "in_progress" ? "todo" : target.status,
        statusVersion: target.statusVersion + 1, actorAgentId: this.binding.agentId,
      }, tx) : target;
      if (!updated) throw new Error("paperclip_runner_task_not_found");
      const receipt = {
        commandId: `reassign-task:${taskId}:${updated.statusVersion}`, disposition: changed ? "applied" : "duplicate",
        stateRevision: updated.statusVersion, entityRefs: [taskId],
        scheduledWakeIds: changed && updated.status === "todo" ? [`${durableKey}:${updated.statusVersion}`] : [],
      };
      if (changed) await issueService(tx).addComment(taskId, reason, { agentId: this.binding.agentId, runId: this.binding.runId });
      const activity = await persistActivity(tx, {
        companyId: this.binding.companyId, actorType: "agent", actorId: this.binding.agentId,
        agentId: this.binding.agentId, runId: this.binding.runId, issueId: taskId,
        action: "issue.reassigned", entityType: "issue", entityId: taskId,
        details: { source: "paperclip_runner_protocol", reassignmentKey: durableKey, inputFingerprint: fingerprint,
          previousAssigneeAgentId: target.assigneeAgentId, assigneeAgentId, reason, changed, receipt },
      });
      publication = activity.publication;
      return receipt;
    }, { beforeReceiptReplay: async (tx, context) => { await authorize(tx, context.run); } }).catch(async (error: unknown) => {
      await restoreInterruptedWork(error);
      throw error;
    }) as {
      stateRevision: number; scheduledWakeIds: string[];
    };
    if (publication) publishActivity(publication);
    // Replay repairs a failed dispatch. The durable wake key and state/version guard
    // prevent duplicate successors and prevent waking a later, unrelated assignment.
    if (result.scheduledWakeIds.length && this.binding.enqueueWakeup) {
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

  async #setDependencies(input: Record<string, unknown>): Promise<unknown> {
    const idempotencyKey = requiredString(input.idempotencyKey);
    if (!Array.isArray(input.blockedByTaskIds)) {
      throw new Error("paperclip_runner_tool_input_invalid");
    }
    const blockedByIssueIds = input.blockedByTaskIds.map(requiredString);
    return this.#withMutationReceipt("set_dependencies", idempotencyKey, input, async (tx) => {
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
    let publication:
      Awaited<ReturnType<typeof persistActivity>>["publication"] | null = null;
    let rollbackDefinitePreCommitFailure: (() => Promise<void>) | null = null;
    const result = await this.#withMutationReceipt(
      "register_deliverable",
      idempotencyKey,
      input,
      async (tx, context) => {
        const prepared = await prepareNativeRunnerFileHandoff({
          db: tx,
          binding: {
            companyId: this.binding.companyId,
            issueId: this.binding.issueId,
            runId: this.binding.runId,
            agentId: this.binding.agentId,
            workspaceRoot,
            executionTargetKind: this.binding.executionTargetKind ?? "local",
            readRemoteWorkspaceFile: this.binding.readRemoteWorkspaceFile,
          },
          deliverable: {
            filename: typeof input.filename === "string" ? input.filename : "",
            contentType:
              typeof input.contentType === "string" ? input.contentType : "",
            byteSize:
              typeof input.byteSize === "number" ? input.byteSize : Number.NaN,
            sha256: typeof input.sha256 === "string" ? input.sha256 : "",
            contentRef:
              typeof input.contentRef === "string" ? input.contentRef : "",
            title: typeof input.title === "string" ? input.title : "",
          },
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

  async #acceptedPlan(contextSnapshot: unknown): Promise<{
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
    return revision ?? null;
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

  async #withMutationReceipt(
    operationId: string,
    idempotencyKey: string,
    input: Record<string, unknown>,
    effect: (
      tx: Db,
      context: {
        run: typeof heartbeatRuns.$inferSelect;
        issue: typeof issues.$inferSelect;
        actor: typeof agents.$inferSelect;
      },
    ) => Promise<unknown>,
    options: {
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
    return this.db.transaction(async (tx) => {
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
            throw new Error("paperclip_runner_tool_idempotency_conflict");
          }
          await options.beforeReceiptReplay?.(tx as unknown as Db, context);
          return describeResult(prior.result);
        }
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
    });
  }

  async #lockAuthorizedMutationContext(tx: Db): Promise<{
    run: typeof heartbeatRuns.$inferSelect;
    issue: typeof issues.$inferSelect;
    actor: typeof agents.$inferSelect;
  }> {
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
              supersedeOnUserComment: normalizedPayload.supersedeOnUserComment ?? true,
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
    description: task.description,
    status: task.status,
    statusVersion: task.statusVersion,
    priority: task.priority,
    workMode: task.workMode,
    assigneeAgentId: task.assigneeAgentId,
    executionRunId: task.executionRunId,
    parentId: task.parentId,
    projectId: task.projectId,
    goalId: task.goalId,
  };
}
