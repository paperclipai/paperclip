import { PaperclipApiError } from "./paperclip-api.js";
import type { ToolContext, ToolHandler } from "./tools.js";

function issueIdFromArgs(args: Record<string, unknown>, ctx: ToolContext): string {
  const id = args.issue_id;
  if (typeof id === "string" && id.trim().length > 0) return id.trim();
  if (ctx.currentIssueId) return ctx.currentIssueId;
  throw new Error("issue_id is required (no current issue in context)");
}

function formatApiError(err: unknown): Record<string, unknown> {
  if (err instanceof PaperclipApiError) {
    return { isError: true, status: err.status, message: err.message, endpoint: err.endpoint };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, message };
}

export function buildPaperclipTools(ctx: ToolContext): ToolHandler[] {
  if (!ctx.paperclipApi) return [];

  const api = ctx.paperclipApi;

  const GET_ISSUE: ToolHandler = {
    name: "get_issue",
    description: "Fetch a Paperclip issue by ID. Defaults to the current issue if issue_id is omitted.",
    parameters: {
      type: "object",
      properties: {
        issue_id: { type: "string", description: "Issue ID to fetch. Defaults to the current issue if omitted." },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const id = issueIdFromArgs(args, ctx);
        return await api.getIssue(id);
      } catch (err) {
        return formatApiError(err);
      }
    },
  };

  const UPDATE_ISSUE_STATUS: ToolHandler = {
    name: "update_issue_status",
    description: "Update the status of a Paperclip issue.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "in_progress", "blocked", "done", "cancelled"],
        },
        issue_id: { type: "string", description: "Issue ID. Defaults to the current issue if omitted." },
      },
      required: ["status"],
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const id = issueIdFromArgs(args, ctx);
        return await api.updateIssue(id, { status: args.status });
      } catch (err) {
        return formatApiError(err);
      }
    },
  };

  const ADD_COMMENT: ToolHandler = {
    name: "add_comment",
    description: "Add a markdown comment to a Paperclip issue.",
    parameters: {
      type: "object",
      properties: {
        body: { type: "string", description: "Markdown comment body." },
        issue_id: { type: "string", description: "Issue ID. Defaults to the current issue if omitted." },
      },
      required: ["body"],
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const id = issueIdFromArgs(args, ctx);
        const body = typeof args.body === "string" ? args.body : String(args.body);
        return await api.addIssueComment(id, { body });
      } catch (err) {
        return formatApiError(err);
      }
    },
  };

  const LIST_COMMENTS: ToolHandler = {
    name: "list_comments",
    description: "List comments on a Paperclip issue.",
    parameters: {
      type: "object",
      properties: {
        issue_id: { type: "string", description: "Issue ID. Defaults to the current issue if omitted." },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const id = issueIdFromArgs(args, ctx);
        return await api.listIssueComments(id);
      } catch (err) {
        return formatApiError(err);
      }
    },
  };

  const CREATE_SUB_ISSUE: ToolHandler = {
    name: "create_sub_issue",
    description: "Create a sub-issue under the current issue. companyId is taken from agent context.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        assignee_id: { type: "string", description: "Agent ID to assign. Use list_agents to discover IDs." },
        priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
      },
      required: ["title"],
      additionalProperties: false,
    },
    async execute(args) {
      try {
        if (!ctx.companyId) throw new Error("companyId not available in context");
        const parentIssueId = ctx.currentIssueId ?? undefined;
        const issue: Record<string, unknown> = { title: args.title };
        if (typeof args.description === "string") issue.description = args.description;
        if (typeof args.assignee_id === "string") issue.assigneeAgentId = args.assignee_id;
        if (typeof args.priority === "string") issue.priority = args.priority;
        if (parentIssueId) issue.parentIssueId = parentIssueId;
        return await api.createIssue(ctx.companyId, issue);
      } catch (err) {
        return formatApiError(err);
      }
    },
  };

  const LIST_ISSUES: ToolHandler = {
    name: "list_issues",
    description: "List issues for the company.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string" },
        assignee_id: { type: "string" },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        if (!ctx.companyId) throw new Error("companyId not available in context");
        const query: Record<string, string> = {};
        if (typeof args.status === "string") query.status = args.status;
        if (typeof args.assignee_id === "string") query.assigneeId = args.assignee_id;
        if (typeof args.limit === "number") query.limit = String(args.limit);
        return await api.listCompanyIssues(ctx.companyId, query);
      } catch (err) {
        return formatApiError(err);
      }
    },
  };

  const LIST_AGENTS: ToolHandler = {
    name: "list_agents",
    description: "List agents in the company. Returns id, name, role, adapterType, model, and status.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      try {
        if (!ctx.companyId) throw new Error("companyId not available in context");
        const agents = await api.listCompanyAgents(ctx.companyId);
        return agents.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
          adapterType: a.adapterType,
          model: a.model,
          status: a.status,
        }));
      } catch (err) {
        return formatApiError(err);
      }
    },
  };

  const HIRE_AGENT: ToolHandler = {
    name: "hire_agent",
    description: "Hire a new agent. Requires approval unless autoApprove is enabled.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        role: { type: "string" },
        adapter_type: { type: "string" },
        model: { type: "string" },
      },
      required: ["name", "role", "adapter_type"],
      additionalProperties: false,
    },
    async execute(args) {
      try {
        if (!ctx.companyId) throw new Error("companyId not available in context");
        const hire: Record<string, unknown> = {
          name: args.name,
          role: args.role,
          adapterType: args.adapter_type,
        };
        if (typeof args.model === "string") hire.model = args.model;

        if (ctx.autoApprove) {
          return await api.hireAgent(ctx.companyId, hire);
        } else {
          const result = await api.createApproval(ctx.companyId, {
            type: "hire_agent",
            payload: hire,
            requestedBy: ctx.agentId,
          });
          return { pending: true, approval: result };
        }
      } catch (err) {
        return formatApiError(err);
      }
    },
  };

  const REQUEST_APPROVAL: ToolHandler = {
    name: "request_approval",
    description: "Request human approval for an action.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why approval is needed." },
        action: { type: "string", description: "What will happen if approved." },
      },
      required: ["reason", "action"],
      additionalProperties: false,
    },
    async execute(args) {
      try {
        if (!ctx.companyId) throw new Error("companyId not available in context");
        const result = await api.createApproval(ctx.companyId, {
          reason: args.reason,
          action: args.action,
          requestedBy: ctx.agentId,
        });
        return { pending: true, approval: result };
      } catch (err) {
        return formatApiError(err);
      }
    },
  };

  return [
    GET_ISSUE,
    UPDATE_ISSUE_STATUS,
    ADD_COMMENT,
    LIST_COMMENTS,
    CREATE_SUB_ISSUE,
    LIST_ISSUES,
    LIST_AGENTS,
    HIRE_AGENT,
    REQUEST_APPROVAL,
  ];
}
