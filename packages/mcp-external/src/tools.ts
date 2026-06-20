import { z, type ZodRawShape } from "zod";
import { PaperclipApiError, type PaperclipApiClient } from "./client.js";

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodObject<ZodRawShape>;
  execute: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const CONFLICT_MESSAGE =
  "Conflict (409): resource is already checked out or owned by another agent. Do not retry this request.";

/** Python `_err` parity: a non-throwing error payload the MCP client reads as data. */
interface ErrorPayload {
  isError: true;
  message: string;
  status?: number;
}

function errorResult(message: string, status?: number) {
  const payload: ErrorPayload = { isError: true, message };
  if (status !== undefined) payload.status = status;
  return textResult(payload);
}

/**
 * Run a tool's API work and convert the canonical Python server's result/error
 * shapes: empty/204 -> { ok: true }; 409 -> do-not-retry payload; other API
 * errors -> { isError, status, message }. Non-API errors (e.g. company
 * resolution) are re-thrown; the MCP SDK converts them to an isError tool
 * result carrying the error message (not a separate protocol-error channel).
 */
async function runTool(
  fn: () => Promise<unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    const data = await fn();
    return textResult(data ?? { ok: true });
  } catch (error) {
    if (error instanceof PaperclipApiError) {
      if (error.status === 409) return errorResult(CONFLICT_MESSAGE, 409);
      const bodyText = typeof error.body === "string" ? error.body : JSON.stringify(error.body ?? "");
      return errorResult(`HTTP ${error.status} from Paperclip API: ${bodyText.slice(0, 400)}`, error.status);
    }
    throw error;
  }
}

function clampLimit(limit: unknown, max: number): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.trunc(limit) : 50;
  return Math.max(1, Math.min(n, max));
}

const ISSUE_STATUSES = new Set(["todo", "in_progress", "blocked", "done", "cancelled"]);
const ISSUE_PRIORITIES = new Set(["urgent", "high", "medium", "low"]);
const PROJECT_STATUSES = new Set(["backlog", "planned", "in_progress", "completed", "cancelled"]);
const APPROVAL_STATUSES = new Set(["pending", "approved", "rejected", "revision_requested"]);

export function createToolDefinitions(client: PaperclipApiClient): ToolDefinition[] {

  const getAgentSchema = z.object({
    agent_id: z
      .string()
      .default("me")
      .describe('Agent UUID, or the literal "me" for the currently authenticated agent.'),
  });

  async function runListIssues(args: Record<string, unknown>) {
    const company = await client.resolveCompany({ override: args.company_id as string | undefined });
    const query: Record<string, string | number | undefined> = {
      status: String((args.status as string | undefined) ?? "todo,in_progress"),
      limit: clampLimit(args.limit, 200),
    };
    if (args.assignee_agent_id) query.assigneeAgentId = String(args.assignee_agent_id);
    if (args.project_id) query.projectId = String(args.project_id);
    if (args.label) query.label = String(args.label);
    if (args.q) query.q = String(args.q);
    return client.requestJson("GET", `/companies/${encodeURIComponent(company)}/issues`, { query, companyId: company });
  }

  return [
    {
      name: "get_agent",
      description: "Get details for a specific agent, or the currently authenticated agent.",
      schema: getAgentSchema,
      execute: async (args) =>
        runTool(async () => {
          const agentId = String((args.agent_id as string | undefined) ?? "me").trim() || "me";
          const path = agentId.toLowerCase() === "me" ? "/agents/me" : `/agents/${encodeURIComponent(agentId)}`;
          return client.requestJson("GET", path);
        }),
    },
    {
      name: "list_issues",
      description: "List issues (tasks) in a company.",
      schema: z.object({
        status: z.string().default("todo,in_progress").describe(
          "Comma-separated statuses: todo, in_progress, blocked, done, cancelled. Default: todo,in_progress",
        ),
        assignee_agent_id: z.string().default("").describe("Filter by assignee agent UUID. Empty for all."),
        project_id: z.string().default("").describe("Filter by project UUID. Empty for all."),
        label: z.string().default("").describe("Filter by label name. Empty to skip."),
        q: z.string().default("").describe("Full-text query. Empty to skip."),
        limit: z.number().int().default(50).describe("Max results (1-200). Default: 50."),
        company_id: z.string().default("").describe("Target company by context (UUID or prefix). Empty for default."),
      }),
      execute: async (args) => runTool(() => runListIssues(args)),
    },
    {
      name: "paperclip_search_issues",
      description:
        "Search Paperclip issues by text. Compatibility alias for list_issues(q=...).",
      schema: z.object({
        query: z.string().describe("Full-text issue search query."),
        status: z.string().default("todo,in_progress").describe(
          "Comma-separated statuses: todo, in_progress, blocked, done, cancelled. Default: todo,in_progress",
        ),
        assignee_agent_id: z.string().default("").describe("Filter by assignee agent UUID. Empty for all."),
        project_id: z.string().default("").describe("Filter by project UUID. Empty for all."),
        label: z.string().default("").describe("Filter by label name. Empty to skip."),
        limit: z.number().int().default(50).describe("Max results (1-200). Default: 50."),
        company_id: z.string().default("").describe("Target company by context (UUID or prefix). Empty for default."),
      }),
      execute: async (args) =>
        runTool(() => runListIssues({ ...args, q: args.query })),
    },
    {
      name: "get_issue",
      description:
        "Get the full details of a single Paperclip issue by UUID or key (e.g. PEN-307). Resolves cross-company server-side.",
      schema: z.object({
        issue_id: z.string().describe('Issue UUID or human-readable key (e.g. "CY-42"). Pass through verbatim.'),
      }),
      execute: async (args) =>
        runTool(() => client.requestJson("GET", `/issues/${encodeURIComponent(String(args.issue_id))}`)),
    },
    {
      name: "create_issue",
      description: "Create a new Paperclip issue (task) and optionally assign it to an agent.",
      schema: z.object({
        title: z.string().describe("Short, imperative task title."),
        description: z.string().default("").describe("Full instructions/context (Markdown)."),
        assignee_agent_id: z.string().default("").describe("Assignee agent UUID. Empty to leave unassigned."),
        project_id: z.string().default("").describe("Project UUID. Empty for none."),
        parent_issue_id: z.string().default("").describe("Parent issue UUID for a subtask. Empty for top-level."),
        priority: z.string().default("medium").describe("urgent, high, medium, or low. Default: medium."),
        company_id: z.string().default("").describe("Target company by context (UUID or prefix). Empty for default."),
        blocked_by_issue_ids: z
          .array(z.string())
          .nullable()
          .optional()
          .describe("UUIDs of issues that block this one. Same company only."),
      }),
      execute: async (args) =>
        runTool(async () => {
          const company = await client.resolveCompany({ override: args.company_id as string | undefined });
          const body: Record<string, unknown> = {
            title: String(args.title),
            priority: String((args.priority as string | undefined) ?? "medium"),
          };
          if (args.description) body.description = String(args.description);
          if (args.assignee_agent_id) body.assigneeAgentId = String(args.assignee_agent_id);
          if (args.project_id) body.projectId = String(args.project_id);
          if (args.parent_issue_id) body.parentIssueId = String(args.parent_issue_id);
          if (args.blocked_by_issue_ids != null) body.blockedByIssueIds = args.blocked_by_issue_ids;
          return client.requestJson("POST", `/companies/${encodeURIComponent(company)}/issues`, { body, companyId: company });
        }),
    },
    {
      name: "update_issue",
      description: "Update an existing issue. Only fields you provide are changed.",
      schema: z.object({
        issue_id: z.string().describe('Issue UUID or identifier (e.g. "CY-42").'),
        title: z.string().default("").describe("New title. Empty to keep."),
        description: z.string().default("").describe("New description (Markdown). Empty to keep."),
        status: z.string().default("").describe("todo, in_progress, blocked, done, or cancelled. Empty to keep."),
        assignee_agent_id: z.string().default("").describe("New assignee agent UUID. Empty to keep."),
        priority: z.string().default("").describe("urgent, high, medium, or low. Empty to keep."),
        project_id: z
          .string()
          .nullable()
          .optional()
          .describe("New project UUID, or empty string to clear. Omit to keep."),
        company_id: z.string().default("").describe("Target company by context (UUID or prefix). Empty to rely on issue-key routing."),
        blocked_by_issue_ids: z
          .array(z.string())
          .nullable()
          .optional()
          .describe("COMPLETE desired blocker set (replaces existing); [] clears; omit to keep."),
      }),
      execute: async (args) => {
        const status = String((args.status as string | undefined) ?? "");
        if (status && !ISSUE_STATUSES.has(status)) {
          return errorResult(`Invalid status '${status}'. Allowed: todo, in_progress, blocked, done, cancelled.`);
        }
        const priority = String((args.priority as string | undefined) ?? "");
        if (priority && !ISSUE_PRIORITIES.has(priority)) {
          return errorResult(`Invalid priority '${priority}'. Allowed: urgent, high, medium, low.`);
        }
        const body: Record<string, unknown> = {};
        if (args.title) body.title = String(args.title);
        if (args.description) body.description = String(args.description);
        if (status) body.status = status;
        if (args.assignee_agent_id) body.assigneeAgentId = String(args.assignee_agent_id);
        if (priority) body.priority = priority;
        // project_id omitted (undefined) or explicit null → don't send (keep); "" → send null to clear; non-empty → send as-is
        if (args.project_id !== undefined && args.project_id !== null) {
          body.projectId = String(args.project_id) || null;
        }
        // blocked_by_issue_ids omitted (undefined) or null → don't send; [] or [...] → send (replaces existing)
        if (args.blocked_by_issue_ids != null) body.blockedByIssueIds = args.blocked_by_issue_ids;
        if (Object.keys(body).length === 0) {
          return errorResult(
            "No fields to update. Provide at least one of: title, description, status, assignee_agent_id, priority, project_id, blocked_by_issue_ids.",
          );
        }
        const override = (args.company_id as string | undefined)?.trim();
        return runTool(async () => {
          const companyId = override ? await client.resolveCompany({ override }) : null;
          return client.requestJson("PATCH", `/issues/${encodeURIComponent(String(args.issue_id))}`, { body, companyId });
        });
      },
    },
    // NOTE: faithfully mirrors the Python external server, which sends a bodyless
    // POST /issues/<id>/checkout. The current backend's checkoutIssueSchema requires
    // agentId + expectedStatuses, so this 400s against current master — a pre-existing
    // bug in the Python external surface (an external USER bearer has no agent identity:
    // GET /agents/me -> 401). Fixing it needs an external-checkout design decision
    // (which agent does a user check out as?), tracked as a cutover follow-up — not a
    // wave-1 port change. release_issue mirrors the same bodyless shape.
    {
      name: "checkout_issue",
      description:
        "Atomically assign an issue to the current agent and mark it in_progress. 409 = owned by another agent; do NOT retry.",
      schema: z.object({ issue_id: z.string().describe("Issue UUID or identifier to check out.") }),
      execute: async (args) =>
        runTool(() => client.requestJson("POST", `/issues/${encodeURIComponent(String(args.issue_id))}/checkout`)),
    },
    {
      name: "release_issue",
      description: "Release an issue: unassign it and revert it to its previous state. Inverse of checkout_issue.",
      schema: z.object({ issue_id: z.string().describe("Issue UUID or identifier to release.") }),
      execute: async (args) =>
        runTool(() => client.requestJson("POST", `/issues/${encodeURIComponent(String(args.issue_id))}/release`)),
    },
    {
      name: "delete_issue",
      description: "Permanently delete an issue. This action cannot be undone.",
      schema: z.object({ issue_id: z.string().describe("Issue UUID or identifier to delete.") }),
      execute: async (args) =>
        runTool(() => client.requestJson("DELETE", `/issues/${encodeURIComponent(String(args.issue_id))}`)),
    },
    {
      name: "comment_on_issue",
      description: "Add a comment to an issue (supports Markdown).",
      schema: z.object({
        issue_id: z.string().describe("Issue UUID or identifier."),
        body: z.string().describe("Comment text. Markdown supported."),
        reopen: z.boolean().default(false).describe("Reopen the issue when posting (only if currently closed)."),
      }),
      execute: async (args) =>
        runTool(() => {
          const payload: Record<string, unknown> = { body: String(args.body) };
          if (args.reopen === true) payload.reopen = true;
          return client.requestJson("POST", `/issues/${encodeURIComponent(String(args.issue_id))}/comments`, { body: payload });
        }),
    },
    {
      name: "list_projects",
      description: "List projects in a company.",
      schema: z.object({
        company_id: z.string().default("").describe("Target company by context (UUID or prefix). Empty for default."),
      }),
      execute: async (args) =>
        runTool(async () => {
          const company = await client.resolveCompany({ override: args.company_id as string | undefined });
          return client.requestJson("GET", `/companies/${encodeURIComponent(company)}/projects`, { companyId: company });
        }),
    },
    {
      name: "get_project",
      description: "Get a project by UUID or company-scoped short reference.",
      schema: z.object({
        project_id: z.string().describe("Project UUID or company-scoped project reference."),
        company_id: z.string().default("").describe("Target company by context (UUID or prefix). Empty for default."),
      }),
      execute: async (args) =>
        runTool(async () => {
          const company = await client.resolveCompany({ override: args.company_id as string | undefined });
          return client.requestJson("GET", `/projects/${encodeURIComponent(String(args.project_id))}`, {
            query: { companyId: company },
            companyId: company,
          });
        }),
    },
    {
      name: "create_project",
      description: "Create a project in a company.",
      schema: z.object({
        name: z.string().describe("Project name."),
        description: z.string().default("").describe("Project description. Empty for none."),
        status: z.string().default("backlog").describe("backlog, planned, in_progress, completed, cancelled. Default: backlog."),
        goal_id: z.string().default("").describe("Deprecated default goal UUID. Prefer goal_ids."),
        goal_ids: z.array(z.string()).nullable().optional().describe("Goal UUIDs to link."),
        lead_agent_id: z.string().default("").describe("Lead agent UUID. Empty for none."),
        target_date: z.string().default("").describe("Target date string. Empty for none."),
        color: z.string().default("").describe("Project color. Empty for default."),
        company_id: z.string().default("").describe("Target company by context (UUID or prefix). Empty for default."),
      }),
      execute: async (args) => {
        // Python parity (server.py create_project): empty status defaults to "backlog"
        // (mirrors `status or "backlog"`); only a NON-empty invalid status errors. The
        // `|| "backlog"` is load-bearing — do not simplify to `?? "backlog"` alone, which
        // would error on empty status instead of defaulting it.
        const status = String((args.status as string | undefined) ?? "backlog") || "backlog";
        if (!PROJECT_STATUSES.has(status)) {
          return errorResult(`Invalid status '${status}'. Allowed: backlog, cancelled, completed, in_progress, planned.`);
        }
        return runTool(async () => {
          const company = await client.resolveCompany({ override: args.company_id as string | undefined });
          const body: Record<string, unknown> = { name: String(args.name), status };
          if (args.description) body.description = String(args.description);
          if (args.goal_id) body.goalId = String(args.goal_id);
          if (args.goal_ids != null) body.goalIds = args.goal_ids;
          if (args.lead_agent_id) body.leadAgentId = String(args.lead_agent_id);
          if (args.target_date) body.targetDate = String(args.target_date);
          if (args.color) body.color = String(args.color);
          return client.requestJson("POST", `/companies/${encodeURIComponent(company)}/projects`, { body, companyId: company });
        });
      },
    },
    {
      name: "update_project",
      description: "Update a project. Only fields you provide are changed.",
      schema: z.object({
        project_id: z.string().describe("Project UUID or company-scoped project reference."),
        name: z.string().default("").describe("New name. Empty to keep."),
        description: z.string().nullable().optional().describe("New description, or empty string to clear. Omit to keep."),
        status: z.string().default("").describe("backlog, planned, in_progress, completed, cancelled. Empty to keep."),
        goal_id: z.string().nullable().optional().describe("Deprecated default goal UUID, or empty string to clear."),
        goal_ids: z.array(z.string()).nullable().optional().describe("Full set of linked goal UUIDs."),
        lead_agent_id: z.string().nullable().optional().describe("New lead agent UUID, or empty string to clear."),
        target_date: z.string().nullable().optional().describe("New target date, or empty string to clear."),
        color: z.string().nullable().optional().describe("New project color, or empty string to clear."),
        company_id: z.string().default("").describe("Target company by context (UUID or prefix). Empty for default."),
      }),
      execute: async (args) => {
        const status = String((args.status as string | undefined) ?? "");
        if (status && !PROJECT_STATUSES.has(status)) {
          return errorResult(`Invalid status '${status}'. Allowed: backlog, cancelled, completed, in_progress, planned.`);
        }
        const body: Record<string, unknown> = {};
        if (args.name) body.name = String(args.name);
        if (args.description !== undefined && args.description !== null) body.description = String(args.description) || null;
        if (status) body.status = status;
        if (args.goal_id !== undefined && args.goal_id !== null) body.goalId = String(args.goal_id) || null;
        if (args.goal_ids != null) body.goalIds = args.goal_ids;
        if (args.lead_agent_id !== undefined && args.lead_agent_id !== null) body.leadAgentId = String(args.lead_agent_id) || null;
        if (args.target_date !== undefined && args.target_date !== null) body.targetDate = String(args.target_date) || null;
        if (args.color !== undefined && args.color !== null) body.color = String(args.color) || null;
        if (Object.keys(body).length === 0) {
          return errorResult(
            "No fields to update. Provide at least one of: name, description, status, goal_id, goal_ids, lead_agent_id, target_date, color.",
          );
        }
        return runTool(async () => {
          const company = await client.resolveCompany({ override: args.company_id as string | undefined });
          return client.requestJson("PATCH", `/projects/${encodeURIComponent(String(args.project_id))}`, { body, companyId: company });
        });
      },
    },
    {
      name: "list_goals",
      description: "List all strategic goals for a company.",
      schema: z.object({
        company_id: z.string().default("").describe("Target company by context (UUID or prefix). Empty for default."),
      }),
      execute: async (args) =>
        runTool(async () => {
          const company = await client.resolveCompany({ override: args.company_id as string | undefined });
          return client.requestJson("GET", `/companies/${encodeURIComponent(company)}/goals`, { companyId: company });
        }),
    },
    {
      name: "create_goal",
      description: "Create a new strategic goal for a company.",
      schema: z.object({
        title: z.string().describe("Goal title."),
        description: z.string().default("").describe("Extended context/success criteria (Markdown)."),
        company_id: z.string().default("").describe("Target company by context (UUID or prefix). Empty for default."),
      }),
      execute: async (args) =>
        runTool(async () => {
          const company = await client.resolveCompany({ override: args.company_id as string | undefined });
          const body: Record<string, unknown> = { title: String(args.title) };
          if (args.description) body.description = String(args.description);
          return client.requestJson("POST", `/companies/${encodeURIComponent(company)}/goals`, { body, companyId: company });
        }),
    },
    {
      name: "update_goal",
      description: "Update an existing goal's title or description.",
      schema: z.object({
        goal_id: z.string().describe("Goal UUID."),
        title: z.string().default("").describe("New title. Empty to keep."),
        description: z.string().default("").describe("New description. Empty to keep."),
      }),
      execute: async (args) => {
        const body: Record<string, unknown> = {};
        // Python parity (server.py update_goal): title/description are truthy-only —
        // empty values are OMITTED (keep), NOT cleared. Unlike update_project, this
        // endpoint has no null-clear. Do not "align" with update_project's nullable
        // pattern; that would diverge from the external reference.
        if (args.title) body.title = String(args.title);
        if (args.description) body.description = String(args.description);
        if (Object.keys(body).length === 0) {
          return errorResult("No fields to update. Provide at least one of: title, description.");
        }
        return runTool(() => client.requestJson("PATCH", `/goals/${encodeURIComponent(String(args.goal_id))}`, { body }));
      },
    },
    {
      name: "list_agents",
      description: "List all agents in a company with their name, role, status, and config.",
      schema: z.object({
        company_id: z.string().default("").describe("Target company by context (UUID or prefix). Empty for default."),
      }),
      execute: async (args) =>
        runTool(async () => {
          const company = await client.resolveCompany({ override: args.company_id as string | undefined });
          return client.requestJson("GET", `/companies/${encodeURIComponent(company)}/agents`, { companyId: company });
        }),
    },
    {
      name: "invoke_agent_heartbeat",
      description:
        "Manually trigger an immediate heartbeat (work cycle) for an agent. Use to wake an idle agent, force it to pick up assignments, or run it off-schedule.",
      schema: z.object({ agent_id: z.string().describe("UUID of the agent to trigger.") }),
      execute: async (args) =>
        runTool(() => client.requestJson("POST", `/agents/${encodeURIComponent(String(args.agent_id))}/heartbeat/invoke`)),
    },
    {
      name: "list_approvals",
      description: "List approval requests in a company.",
      schema: z.object({
        status: z.string().default("pending").describe(
          "pending, approved, rejected, or revision_requested. Default: pending.",
        ),
        company_id: z.string().default("").describe("Target company by context (UUID or prefix). Empty for default."),
      }),
      execute: async (args) => {
        // Python parity (server.py list_approvals:750-752): validates `if status not in allowed`
        // with NO `if status and` guard — so empty "" ERRORS; omitted defaults to "pending".
        // Use `??` only (NOT `|| "pending"`, which would wrongly rescue "").
        const status = String((args.status as string | undefined) ?? "pending");
        if (!APPROVAL_STATUSES.has(status)) {
          return errorResult(`Invalid status '${status}'. Allowed: approved, pending, rejected, revision_requested.`);
        }
        return runTool(async () => {
          const company = await client.resolveCompany({ override: args.company_id as string | undefined });
          return client.requestJson("GET", `/companies/${encodeURIComponent(company)}/approvals`, { query: { status }, companyId: company });
        });
      },
    },
    {
      name: "approve",
      description: "Approve a pending approval request.",
      schema: z.object({
        approval_id: z.string().describe("Approval UUID."),
        comment: z.string().default("").describe("Optional approval note to attach."),
      }),
      execute: async (args) =>
        runTool(() => {
          // Python parity (server.py:765-768): always sends a body object (even {}). Do NOT
          // make this bodyless — contrast with checkout_issue which is truly bodyless.
          const body: Record<string, unknown> = {};
          if (args.comment) body.comment = String(args.comment);
          return client.requestJson("POST", `/approvals/${encodeURIComponent(String(args.approval_id))}/approve`, { body });
        }),
    },
    {
      name: "reject",
      description: "Reject a pending approval request.",
      schema: z.object({
        approval_id: z.string().describe("Approval UUID."),
        comment: z.string().default("").describe("Reason for rejection — strongly recommended so the agent understands why."),
      }),
      execute: async (args) =>
        runTool(() => {
          // Python parity (server.py:779-782): always sends a body object (even {}).
          const body: Record<string, unknown> = {};
          if (args.comment) body.comment = String(args.comment);
          return client.requestJson("POST", `/approvals/${encodeURIComponent(String(args.approval_id))}/reject`, { body });
        }),
    },
    {
      name: "request_approval_revision",
      description:
        "Request a revision on a pending approval without fully rejecting it. The submitting agent receives the comment and can resubmit.",
      schema: z.object({
        approval_id: z.string().describe("Approval UUID."),
        comment: z.string().describe("Required. Specific feedback describing what must change before approval."),
      }),
      execute: async (args) => {
        // Python parity (server.py:795-796): `if not comment.strip(): return _err(...)`.
        // Comment has NO schema default — required field, must be non-blank.
        const comment = String((args.comment as string | undefined) ?? "");
        if (!comment.trim()) {
          return errorResult("A comment is required when requesting a revision.");
        }
        return runTool(() =>
          client.requestJson("POST", `/approvals/${encodeURIComponent(String(args.approval_id))}/request-revision`, { body: { comment } }),
        );
      },
    },
    {
      name: "get_dashboard",
      description:
        "Get a high-level health summary for a company: agent count, open/in-progress/blocked issue counts, stale tasks, recent activity, current-period cost totals.",
      schema: z.object({
        company_id: z.string().default("").describe("Target company by context (UUID or prefix). Empty for default."),
      }),
      execute: async (args) =>
        runTool(async () => {
          const company = await client.resolveCompany({ override: args.company_id as string | undefined });
          return client.requestJson("GET", `/companies/${encodeURIComponent(company)}/dashboard`, { companyId: company });
        }),
    },
    {
      name: "get_cost_summary",
      description:
        "Get aggregate token usage and spend for a company this billing period (total spend, remaining budget, per-agent breakdown).",
      schema: z.object({
        company_id: z.string().default("").describe("Target company by context (UUID or prefix). Empty for default."),
      }),
      execute: async (args) =>
        runTool(async () => {
          const company = await client.resolveCompany({ override: args.company_id as string | undefined });
          return client.requestJson("GET", `/companies/${encodeURIComponent(company)}/costs/summary`, { companyId: company });
        }),
    },
    {
      name: "list_activity",
      description: "Retrieve the audit trail of recent actions in a company.",
      schema: z.object({
        agent_id: z.string().default("").describe("Filter to a specific agent UUID. Empty for all."),
        limit: z.number().int().default(20).describe("Max entries (1-100). Default: 20."),
        company_id: z.string().default("").describe("Target company by context (UUID or prefix). Empty for default."),
      }),
      execute: async (args) =>
        runTool(async () => {
          const company = await client.resolveCompany({ override: args.company_id as string | undefined });
          // Python list_activity defaults limit=20 (clampLimit's generic fallback is 50) and clamps to 100.
          const query: Record<string, string | number | undefined> = {
            limit: clampLimit((args.limit as number | undefined) ?? 20, 100),
          };
          if (args.agent_id) query.agentId = String(args.agent_id);
          return client.requestJson("GET", `/companies/${encodeURIComponent(company)}/activity`, { query, companyId: company });
        }),
    },
  ];
}
