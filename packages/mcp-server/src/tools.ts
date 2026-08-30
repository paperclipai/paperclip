import { createHash } from "node:crypto";
import { z } from "zod";
import {
  addIssueCommentSchema,
  askUserQuestionsPayloadSchema,
  checkoutIssueSchema,
  createApprovalSchema,
  createIssueInputSchema,
  issueThreadInteractionContinuationPolicySchema,
  requestCheckboxConfirmationPayloadSchema,
  requestConfirmationPayloadSchema,
  suggestedTaskDraftSchema,
  suggestTasksPayloadSchema,
  updateIssueSchema,
  upsertIssueDocumentSchema,
  linkIssueApprovalSchema,
} from "@paperclipai/shared";
import { PaperclipApiClient } from "./client.js";
import { formatErrorResponse, formatTextResponse } from "./format.js";

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodObject;
  execute: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
}

function makeTool<TSchema extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<TSchema>,
  execute: (input: z.infer<typeof schema>) => Promise<unknown>,
): ToolDefinition {
  return {
    name,
    description,
    schema,
    execute: async (input) => {
      try {
        const parsed = schema.parse(input);
        return formatTextResponse(await execute(parsed));
      } catch (error) {
        return formatErrorResponse(error);
      }
    },
  };
}

function parseOptionalJson(raw: string | undefined | null): unknown {
  if (!raw || raw.trim().length === 0) return undefined;
  return JSON.parse(raw);
}

const companyIdOptional = z.string().guid().optional().nullable();
const agentIdOptional = z.string().guid().optional().nullable();
const issueIdSchema = z.string().min(1);
const projectIdSchema = z.string().min(1);
const goalIdSchema = z.string().guid();
const approvalIdSchema = z.string().guid();
const documentKeySchema = z.string().trim().min(1).max(64);
const isoDateTime = z.string().datetime({ offset: true });
const issueTimingToolShape = {
  neededAt: isoDateTime.nullable().optional(),
  reviewBy: isoDateTime.nullable().optional(),
  estimatedReviewMinutes: z.number().int().min(1).max(8 * 60).nullable().optional(),
};

const suggestedTaskToolSchema = z.object({
  ...suggestedTaskDraftSchema.shape,
  ...issueTimingToolShape,
}).superRefine((value, ctx) => {
  if (value.assigneeAgentId && value.assigneeUserId) {
    ctx.addIssue({
      code: "custom",
      message: "Suggested tasks can only target one assignee",
      path: ["assigneeAgentId"],
    });
  }
});

const suggestTasksToolPayloadSchema = z.object({
  ...suggestTasksPayloadSchema.shape,
  tasks: z.array(suggestedTaskToolSchema).min(1).max(50),
}).superRefine((value, ctx) => {
  const seenClientKeys = new Set<string>();
  for (const [index, task] of value.tasks.entries()) {
    if (seenClientKeys.has(task.clientKey)) {
      ctx.addIssue({
        code: "custom",
        message: "clientKey must be unique within one interaction",
        path: ["tasks", index, "clientKey"],
      });
      continue;
    }
    seenClientKeys.add(task.clientKey);
  }
});

const delegateTaskDraftSchema = z.object({
  clientKey: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(20000).nullable().optional(),
  priority: z.enum(["critical", "high", "medium", "low"]).optional(),
  neededAt: isoDateTime.nullable().optional(),
  reviewBy: isoDateTime.nullable().optional(),
  estimatedReviewMinutes: z.number().int().min(1).max(8 * 60).nullable().optional(),
});

const proposeDayPlanSchema = z.object({
  companyId: companyIdOptional,
  date: z.string().date(),
  summary: z.string().trim().min(1).max(20000),
  tasks: z.array(delegateTaskDraftSchema).min(1).max(20),
  projectId: z.string().guid().nullable().optional(),
  goalId: z.string().guid().nullable().optional(),
  assigneeAgentId: agentIdOptional,
});

const approveDayPlanSchema = z.object({
  issueId: issueIdSchema,
  interactionId: z.string().guid(),
  selectedClientKeys: z.array(z.string().trim().min(1).max(120)).min(1).max(20).optional(),
});

const createDelegateTaskSchema = z.object({
  companyId: companyIdOptional,
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(20000).nullable().optional(),
  priority: z.enum(["critical", "high", "medium", "low"]).optional(),
  neededAt: isoDateTime.nullable().optional(),
  reviewBy: isoDateTime.nullable().optional(),
  estimatedReviewMinutes: z.number().int().min(1).max(8 * 60).nullable().optional(),
  projectId: z.string().guid().nullable().optional(),
  goalId: z.string().guid().nullable().optional(),
  assigneeAgentId: agentIdOptional,
});

const reviewDelegateTaskSchema = z.object({
  issueId: issueIdSchema,
  verdict: z.enum(["accept", "request_changes"]),
  comment: z.string().trim().max(20000).nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.verdict === "request_changes" && !value.comment) {
    ctx.addIssue({ code: "custom", path: ["comment"], message: "Requesting changes requires a comment" });
  }
});

const listIssuesSchema = z.object({
  companyId: companyIdOptional,
  status: z.string().optional(),
  projectId: z.string().guid().optional(),
  assigneeAgentId: z.string().guid().optional(),
  participantAgentId: z.string().guid().optional(),
  assigneeUserId: z.string().optional(),
  touchedByUserId: z.string().optional(),
  inboxArchivedByUserId: z.string().optional(),
  unreadForUserId: z.string().optional(),
  labelId: z.string().guid().optional(),
  executionWorkspaceId: z.string().guid().optional(),
  originKind: z.string().optional(),
  originId: z.string().optional(),
  includeRoutineExecutions: z.boolean().optional(),
  includeLiveDescendantSummary: z.boolean().optional(),
  q: z.string().optional(),
});

const listCommentsSchema = z.object({
  issueId: issueIdSchema,
  after: z.string().guid().optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const upsertDocumentToolSchema = z.object({
  issueId: issueIdSchema,
  key: documentKeySchema,
  title: z.string().trim().max(200).nullable().optional(),
  format: z.enum(["markdown"]).default("markdown"),
  body: z.string().max(524288),
  changeSummary: z.string().trim().max(500).nullable().optional(),
  baseRevisionId: z.string().guid().nullable().optional(),
});

const createIssueToolSchema = z.object({
  companyId: companyIdOptional,
}).merge(createIssueInputSchema
  .omit({ neededAt: true, reviewBy: true, estimatedReviewMinutes: true })
  .extend(issueTimingToolShape));

const updateIssueToolSchema = z.object({
  issueId: issueIdSchema,
}).merge(updateIssueSchema
  .omit({ neededAt: true, reviewBy: true, estimatedReviewMinutes: true })
  .extend(issueTimingToolShape));

const checkoutIssueToolSchema = z.object({
  issueId: issueIdSchema,
  agentId: agentIdOptional,
  expectedStatuses: checkoutIssueSchema.shape.expectedStatuses.optional(),
});

const addCommentToolSchema = z.object({
  issueId: issueIdSchema,
}).merge(addIssueCommentSchema);

const createSuggestTasksToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().guid().nullable().optional(),
  sourceRunId: z.string().guid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
  payload: suggestTasksToolPayloadSchema,
});

const createAskUserQuestionsToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().guid().nullable().optional(),
  sourceRunId: z.string().guid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
  payload: askUserQuestionsPayloadSchema,
});

const createRequestConfirmationToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().guid().nullable().optional(),
  sourceRunId: z.string().guid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("none"),
  payload: requestConfirmationPayloadSchema,
});

const createRequestCheckboxConfirmationToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().guid().nullable().optional(),
  sourceRunId: z.string().guid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
  payload: requestCheckboxConfirmationPayloadSchema,
});

const approvalDecisionSchema = z.object({
  approvalId: approvalIdSchema,
  action: z.enum(["approve", "reject", "requestRevision", "resubmit"]),
  decisionNote: z.string().optional(),
  payloadJson: z.string().optional(),
});

const createApprovalToolSchema = z.object({
  companyId: companyIdOptional,
}).merge(createApprovalSchema);

const apiRequestSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1),
  jsonBody: z.string().optional(),
});

const workspaceRuntimeControlTargetSchema = z.object({
  workspaceCommandId: z.string().min(1).optional().nullable(),
  runtimeServiceId: z.string().guid().optional().nullable(),
  serviceIndex: z.number().int().nonnegative().optional().nullable(),
});

const issueWorkspaceRuntimeControlSchema = z.object({
  issueId: issueIdSchema,
  action: z.enum(["start", "stop", "restart"]),
}).merge(workspaceRuntimeControlTargetSchema);

const waitForIssueWorkspaceServiceSchema = z.object({
  issueId: issueIdSchema,
  runtimeServiceId: z.string().guid().optional().nullable(),
  serviceName: z.string().min(1).optional().nullable(),
  timeoutSeconds: z.number().int().positive().max(300).optional(),
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableDayPlanKey(date: string, tasks: unknown) {
  const digest = createHash("sha256").update(JSON.stringify(tasks)).digest("hex").slice(0, 16);
  return `delegate-day-plan:${date}:${digest}`;
}

function groupDelegateIssues(rows: unknown) {
  const issues = Array.isArray(rows)
    ? rows.filter((row): row is Record<string, unknown> => (
        Boolean(row)
        && typeof row === "object"
        && (row as Record<string, unknown>).workMode !== "planning"
      ))
    : [];
  const completedToday = new Date().toISOString().slice(0, 10);
  return {
    needsYou: issues.filter((issue) => issue.status === "blocked"),
    readyToReview: issues.filter((issue) => issue.status === "in_review"),
    working: issues.filter((issue) => issue.status === "in_progress"),
    upNext: issues.filter((issue) => issue.status === "todo" || issue.status === "backlog"),
    doneToday: issues.filter((issue) => (
      issue.status === "done"
      && typeof issue.completedAt === "string"
      && issue.completedAt.slice(0, 10) === completedToday
    )),
  };
}

function readCurrentExecutionWorkspace(context: unknown): Record<string, unknown> | null {
  if (!context || typeof context !== "object") return null;
  const workspace = (context as { currentExecutionWorkspace?: unknown }).currentExecutionWorkspace;
  return workspace && typeof workspace === "object" ? workspace as Record<string, unknown> : null;
}

function readWorkspaceRuntimeServices(workspace: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const raw = workspace?.runtimeServices;
  return Array.isArray(raw)
    ? raw.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
}

function selectRuntimeService(
  services: Array<Record<string, unknown>>,
  input: { runtimeServiceId?: string | null; serviceName?: string | null },
) {
  if (input.runtimeServiceId) {
    return services.find((service) => service.id === input.runtimeServiceId) ?? null;
  }
  if (input.serviceName) {
    return services.find((service) => service.serviceName === input.serviceName) ?? null;
  }
  return services.find((service) => service.status === "running" || service.status === "starting")
    ?? services[0]
    ?? null;
}

async function getIssueWorkspaceRuntime(client: PaperclipApiClient, issueId: string) {
  const context = await client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/heartbeat-context`);
  const workspace = readCurrentExecutionWorkspace(context);
  return {
    context,
    workspace,
    runtimeServices: readWorkspaceRuntimeServices(workspace),
  };
}

export function createToolDefinitions(client: PaperclipApiClient): ToolDefinition[] {
  return [
    makeTool(
      "paperclipListCompanies",
      "List Paperclip companies available to the local user",
      z.object({}),
      async () => client.requestJson("GET", "/companies"),
    ),
    makeTool(
      "paperclipMe",
      "Get the current authenticated Paperclip actor details",
      z.object({}),
      async () => client.requestJson("GET", "/agents/me"),
    ),
    makeTool(
      "paperclipInboxLite",
      "Get the current authenticated agent inbox-lite assignment list",
      z.object({}),
      async () => client.requestJson("GET", "/agents/me/inbox-lite"),
    ),
    makeTool(
      "paperclipListAgents",
      "List agents in a company",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/agents`),
    ),
    makeTool(
      "paperclipListSkills",
      "List the company skill library (all installed skills, independent of which agents have them enabled)",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/skills`),
    ),
    makeTool(
      "paperclipGetAgent",
      "Get a single agent by id",
      z.object({ agentId: z.string().min(1), companyId: companyIdOptional }),
      async ({ agentId, companyId }) => {
        const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
        return client.requestJson("GET", `/agents/${encodeURIComponent(agentId)}${qs}`);
      },
    ),
    makeTool(
      "paperclipListIssues",
      "List issues for a company with optional filters",
      listIssuesSchema,
      async (input) => {
        const companyId = client.resolveCompanyId(input.companyId);
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(input)) {
          if (key === "companyId" || value === undefined || value === null) continue;
          params.set(key, String(value));
        }
        const qs = params.toString();
        return client.requestJson("GET", `/companies/${companyId}/issues${qs ? `?${qs}` : ""}`);
      },
    ),
    makeTool(
      "paperclipGetMyWork",
      "Get the user's work grouped into Needs you, Ready to review, Working, Up next, and Done today",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => {
        const resolvedCompanyId = client.resolveCompanyId(companyId);
        const rows = await client.requestJson("GET", `/companies/${resolvedCompanyId}/issues`);
        return groupDelegateIssues(rows);
      },
    ),
    makeTool(
      "paperclipGetIssue",
      "Get a single issue by UUID or identifier",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}`),
    ),
    makeTool(
      "paperclipGetHeartbeatContext",
      "Get compact heartbeat context for an issue",
      z.object({ issueId: issueIdSchema, wakeCommentId: z.string().guid().optional() }),
      async ({ issueId, wakeCommentId }) => {
        const qs = wakeCommentId ? `?wakeCommentId=${encodeURIComponent(wakeCommentId)}` : "";
        return client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/heartbeat-context${qs}`);
      },
    ),
    makeTool(
      "paperclipListComments",
      "List issue comments with incremental options",
      listCommentsSchema,
      async ({ issueId, after, order, limit }) => {
        const params = new URLSearchParams();
        if (after) params.set("after", after);
        if (order) params.set("order", order);
        if (limit) params.set("limit", String(limit));
        const qs = params.toString();
        return client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/comments${qs ? `?${qs}` : ""}`);
      },
    ),
    makeTool(
      "paperclipGetComment",
      "Get a specific issue comment by id",
      z.object({ issueId: issueIdSchema, commentId: z.string().guid() }),
      async ({ issueId, commentId }) =>
        client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`),
    ),
    makeTool(
      "paperclipListIssueApprovals",
      "List approvals linked to an issue",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/approvals`),
    ),
    makeTool(
      "paperclipListDocuments",
      "List issue documents",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/documents`),
    ),
    makeTool(
      "paperclipGetDocument",
      "Get one issue document by key",
      z.object({ issueId: issueIdSchema, key: documentKeySchema }),
      async ({ issueId, key }) =>
        client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`),
    ),
    makeTool(
      "paperclipListDocumentRevisions",
      "List revisions for an issue document",
      z.object({ issueId: issueIdSchema, key: documentKeySchema }),
      async ({ issueId, key }) =>
        client.requestJson(
          "GET",
          `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}/revisions`,
        ),
    ),
    makeTool(
      "paperclipListProjects",
      "List projects in a company",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/projects`),
    ),
    makeTool(
      "paperclipGetProject",
      "Get a project by id or company-scoped short reference",
      z.object({ projectId: projectIdSchema, companyId: companyIdOptional }),
      async ({ projectId, companyId }) => {
        const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
        return client.requestJson("GET", `/projects/${encodeURIComponent(projectId)}${qs}`);
      },
    ),
    makeTool(
      "paperclipGetIssueWorkspaceRuntime",
      "Get the current execution workspace and runtime services for an issue, including service URLs",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => getIssueWorkspaceRuntime(client, issueId),
    ),
    makeTool(
      "paperclipControlIssueWorkspaceServices",
      "Start, stop, or restart the current issue execution workspace runtime services",
      issueWorkspaceRuntimeControlSchema,
      async ({ issueId, action, ...target }) => {
        const runtime = await getIssueWorkspaceRuntime(client, issueId);
        const workspaceId = typeof runtime.workspace?.id === "string" ? runtime.workspace.id : null;
        if (!workspaceId) {
          throw new Error("Issue has no current execution workspace");
        }
        return client.requestJson(
          "POST",
          `/execution-workspaces/${encodeURIComponent(workspaceId)}/runtime-services/${action}`,
          { body: target },
        );
      },
    ),
    makeTool(
      "paperclipWaitForIssueWorkspaceService",
      "Wait until an issue execution workspace runtime service is running and has a URL when one is exposed",
      waitForIssueWorkspaceServiceSchema,
      async ({ issueId, runtimeServiceId, serviceName, timeoutSeconds }) => {
        const deadline = Date.now() + (timeoutSeconds ?? 60) * 1000;
        let latest: Awaited<ReturnType<typeof getIssueWorkspaceRuntime>> | null = null;
        while (Date.now() <= deadline) {
          latest = await getIssueWorkspaceRuntime(client, issueId);
          const service = selectRuntimeService(latest.runtimeServices, { runtimeServiceId, serviceName });
          if (service?.status === "running" && service.healthStatus !== "unhealthy") {
            return {
              workspace: latest.workspace,
              service,
            };
          }
          await sleep(1000);
        }

        return {
          timedOut: true,
          latestWorkspace: latest?.workspace ?? null,
          latestRuntimeServices: latest?.runtimeServices ?? [],
        };
      },
    ),
    makeTool(
      "paperclipListGoals",
      "List goals in a company",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/goals`),
    ),
    makeTool(
      "paperclipGetGoal",
      "Get a goal by id",
      z.object({ goalId: goalIdSchema }),
      async ({ goalId }) => client.requestJson("GET", `/goals/${encodeURIComponent(goalId)}`),
    ),
    makeTool(
      "paperclipListApprovals",
      "List approvals in a company",
      z.object({ companyId: companyIdOptional, status: z.string().optional() }),
      async ({ companyId, status }) => {
        const qs = status ? `?status=${encodeURIComponent(status)}` : "";
        return client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/approvals${qs}`);
      },
    ),
    makeTool(
      "paperclipCreateApproval",
      "Create a board approval request, optionally linked to one or more issues",
      createApprovalToolSchema,
      async ({ companyId, ...body }) =>
        client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/approvals`, {
          body,
        }),
    ),
    makeTool(
      "paperclipGetApproval",
      "Get an approval by id",
      z.object({ approvalId: approvalIdSchema }),
      async ({ approvalId }) => client.requestJson("GET", `/approvals/${encodeURIComponent(approvalId)}`),
    ),
    makeTool(
      "paperclipGetApprovalIssues",
      "List issues linked to an approval",
      z.object({ approvalId: approvalIdSchema }),
      async ({ approvalId }) => client.requestJson("GET", `/approvals/${encodeURIComponent(approvalId)}/issues`),
    ),
    makeTool(
      "paperclipListApprovalComments",
      "List comments for an approval",
      z.object({ approvalId: approvalIdSchema }),
      async ({ approvalId }) => client.requestJson("GET", `/approvals/${encodeURIComponent(approvalId)}/comments`),
    ),
    makeTool(
      "paperclipCreateIssue",
      "Create a new issue",
      createIssueToolSchema,
      async ({ companyId, ...body }) =>
        client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/issues`, { body }),
    ),
    makeTool(
      "paperclipCreateTask",
      "Create one approved task for the personal worker",
      createDelegateTaskSchema,
      async ({ companyId, assigneeAgentId, ...body }) =>
        client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/issues`, {
          body: {
            ...body,
            status: "todo",
            workMode: "standard",
            assigneeAgentId: client.resolveAgentId(assigneeAgentId),
          },
        }),
    ),
    makeTool(
      "paperclipProposeDayPlan",
      "Create a selectable day-plan version without starting work. A revised call creates a new version; approve only the latest interaction.",
      proposeDayPlanSchema,
      async ({ companyId, date, summary, tasks, projectId, goalId, assigneeAgentId }) => {
        const resolvedCompanyId = client.resolveCompanyId(companyId);
        const resolvedAgentId = client.resolveAgentId(assigneeAgentId);
        const planIssue = await client.requestJson<Record<string, unknown>>(
          "POST",
          `/companies/${resolvedCompanyId}/issues`,
          {
            body: {
              title: `Plan for ${date}`,
              description: summary,
              status: "todo",
              workMode: "planning",
              priority: "medium",
              projectId: projectId ?? null,
              goalId: goalId ?? null,
              idempotencyKey: `delegate-day-plan:${date}`,
              allowDuplicate: false,
            },
          },
        );
        const issueId = typeof planIssue.id === "string" ? planIssue.id : null;
        if (!issueId) throw new Error("Paperclip did not return a day-plan issue id");
        const proposedTasks = tasks.map((task) => ({ ...task, assigneeAgentId: resolvedAgentId }));
        const interaction = await client.requestJson(
          "POST",
          `/issues/${encodeURIComponent(issueId)}/interactions`,
          {
            body: {
              kind: "suggest_tasks",
              idempotencyKey: stableDayPlanKey(date, proposedTasks),
              title: `Plan for ${date}`,
              summary,
              continuationPolicy: "none",
              resolverPolicy: "human_only",
              payload: { version: 1, defaultParentId: issueId, tasks: proposedTasks },
            },
          },
        );
        return { planIssue, interaction };
      },
    ),
    makeTool(
      "paperclipApproveDayPlan",
      "Approve selected tasks from a proposed day plan and start their assigned work",
      approveDayPlanSchema,
      async ({ issueId, interactionId, selectedClientKeys }) =>
        client.requestJson(
          "POST",
          `/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/accept`,
          { body: { selectedClientKeys } },
        ),
    ),
    makeTool(
      "paperclipReviewTask",
      "Accept submitted work or request changes with a required comment",
      reviewDelegateTaskSchema,
      async ({ issueId, verdict, comment }) =>
        client.requestJson("PATCH", `/issues/${encodeURIComponent(issueId)}`, {
          body: verdict === "accept"
            ? { status: "done", ...(comment ? { comment } : {}) }
            : { status: "todo", comment, resume: true },
        }),
    ),
    makeTool(
      "paperclipUpdateIssue",
      "Patch an issue, optionally including a comment; include resume=true when intentionally requesting follow-up on resumable closed work",
      updateIssueToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("PATCH", `/issues/${encodeURIComponent(issueId)}`, { body }),
    ),
    makeTool(
      "paperclipCheckoutIssue",
      "Checkout an issue for an agent",
      checkoutIssueToolSchema,
      async ({ issueId, agentId, expectedStatuses }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/checkout`, {
          body: {
            agentId: client.resolveAgentId(agentId),
            expectedStatuses: expectedStatuses ?? ["todo", "backlog", "blocked"],
          },
        }),
    ),
    makeTool(
      "paperclipReleaseIssue",
      "Release an issue checkout",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/release`, { body: {} }),
    ),
    makeTool(
      "paperclipAddComment",
      "Add a comment to an issue; include resume=true when intentionally requesting follow-up on resumable closed work",
      addCommentToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/comments`, { body }),
    ),
    makeTool(
      "paperclipSuggestTasks",
      "Create a suggest_tasks interaction on an issue",
      createSuggestTasksToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "suggest_tasks",
            ...body,
          },
        }),
    ),
    makeTool(
      "paperclipAskUserQuestions",
      "Create an ask_user_questions interaction on an issue",
      createAskUserQuestionsToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "ask_user_questions",
            ...body,
          },
        }),
    ),
    makeTool(
      "paperclipRequestConfirmation",
      "Create a request_confirmation interaction on an issue",
      createRequestConfirmationToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "request_confirmation",
            ...body,
          },
        }),
    ),
    makeTool(
      "paperclipRequestCheckboxConfirmation",
      "Create a request_checkbox_confirmation interaction on an issue",
      createRequestCheckboxConfirmationToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "request_checkbox_confirmation",
            ...body,
          },
        }),
    ),
    makeTool(
      "paperclipUpsertIssueDocument",
      "Create or update an issue document",
      upsertDocumentToolSchema,
      async ({ issueId, key, ...body }) =>
        client.requestJson(
          "PUT",
          `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`,
          { body },
        ),
    ),
    makeTool(
      "paperclipRestoreIssueDocumentRevision",
      "Restore a prior revision of an issue document",
      z.object({
        issueId: issueIdSchema,
        key: documentKeySchema,
        revisionId: z.string().guid(),
      }),
      async ({ issueId, key, revisionId }) =>
        client.requestJson(
          "POST",
          `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}/revisions/${encodeURIComponent(revisionId)}/restore`,
          { body: {} },
        ),
    ),
    makeTool(
      "paperclipLinkIssueApproval",
      "Link an approval to an issue",
      z.object({ issueId: issueIdSchema }).merge(linkIssueApprovalSchema),
      async ({ issueId, approvalId }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/approvals`, {
          body: { approvalId },
        }),
    ),
    makeTool(
      "paperclipUnlinkIssueApproval",
      "Unlink an approval from an issue",
      z.object({ issueId: issueIdSchema, approvalId: approvalIdSchema }),
      async ({ issueId, approvalId }) =>
        client.requestJson(
          "DELETE",
          `/issues/${encodeURIComponent(issueId)}/approvals/${encodeURIComponent(approvalId)}`,
        ),
    ),
    makeTool(
      "paperclipApprovalDecision",
      "Approve, reject, request revision, or resubmit an approval",
      approvalDecisionSchema,
      async ({ approvalId, action, decisionNote, payloadJson }) => {
        const path =
          action === "approve"
            ? `/approvals/${encodeURIComponent(approvalId)}/approve`
            : action === "reject"
              ? `/approvals/${encodeURIComponent(approvalId)}/reject`
              : action === "requestRevision"
                ? `/approvals/${encodeURIComponent(approvalId)}/request-revision`
                : `/approvals/${encodeURIComponent(approvalId)}/resubmit`;

        const body =
          action === "resubmit"
            ? { payload: parseOptionalJson(payloadJson) ?? {} }
            : { decisionNote };

        return client.requestJson("POST", path, { body });
      },
    ),
    makeTool(
      "paperclipAddApprovalComment",
      "Add a comment to an approval",
      z.object({ approvalId: approvalIdSchema, body: z.string().min(1) }),
      async ({ approvalId, body }) =>
        client.requestJson("POST", `/approvals/${encodeURIComponent(approvalId)}/comments`, {
          body: { body },
        }),
    ),
    makeTool(
      "paperclipApiRequest",
      "Make a JSON request to an existing Paperclip /api endpoint for unsupported operations",
      apiRequestSchema,
      async ({ method, path, jsonBody }) => {
        if (!path.startsWith("/") || path.includes("..")) {
          throw new Error("path must start with / and be relative to /api, and must not contain '..'");
        }
        return client.requestJson(method, path, {
          body: parseOptionalJson(jsonBody),
        });
      },
    ),
  ];
}
