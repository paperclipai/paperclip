export interface PaperclipContext {
  apiUrl: string;
  authToken: string;
  runId: string;
  agentId: string;
  companyId: string;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

async function callApi(
  method: string,
  path: string,
  ctx: PaperclipContext,
  body?: unknown,
): Promise<ToolResult> {
  try {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${ctx.authToken}`,
      "Content-Type": "application/json",
    };
    if (method !== "GET") {
      headers["X-Paperclip-Run-Id"] = ctx.runId;
    }

    const response = await fetch(`${ctx.apiUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      return { content: `HTTP ${response.status}: ${errText}`, isError: true };
    }

    const data = await response.json();
    return { content: JSON.stringify(data), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Network error: ${msg}`, isError: true };
  }
}

export async function executePaperclipTool(
  name: string,
  args: Record<string, unknown>,
  ctx: PaperclipContext,
): Promise<ToolResult> {
  switch (name) {
    case "paperclip_get_identity":
      return callApi("GET", "/api/agents/me", ctx);

    case "paperclip_get_inbox":
      return callApi("GET", "/api/agents/me/inbox-lite", ctx);

    case "paperclip_checkout_issue": {
      const issueId = String(args.issueId);
      const expectedStatuses = Array.isArray(args.expectedStatuses)
        ? args.expectedStatuses
        : ["todo", "backlog", "blocked", "in_review"];
      return callApi("POST", `/api/issues/${issueId}/checkout`, ctx, {
        agentId: ctx.agentId,
        expectedStatuses,
      });
    }

    case "paperclip_update_issue": {
      const issueId = String(args.issueId);
      const body: Record<string, unknown> = {};
      if (args.status) body.status = args.status;
      if (args.comment) body.comment = args.comment;
      if (args.priority) body.priority = args.priority;
      if (args.title) body.title = args.title;
      if (args.description) body.description = args.description;
      return callApi("PATCH", `/api/issues/${issueId}`, ctx, body);
    }

    case "paperclip_add_comment": {
      const issueId = String(args.issueId);
      return callApi("POST", `/api/issues/${issueId}/comments`, ctx, {
        body: String(args.body),
      });
    }

    case "paperclip_get_issue_context": {
      const issueId = String(args.issueId);
      return callApi("GET", `/api/issues/${issueId}/heartbeat-context`, ctx);
    }

    case "paperclip_get_comments": {
      const issueId = String(args.issueId);
      return callApi("GET", `/api/issues/${issueId}/comments`, ctx);
    }

    case "paperclip_create_subtask": {
      return callApi("POST", `/api/companies/${ctx.companyId}/issues`, ctx, {
        title: String(args.title),
        description: args.description ? String(args.description) : undefined,
        parentId: String(args.parentId),
        assigneeAgentId: args.assigneeAgentId ? String(args.assigneeAgentId) : undefined,
        priority: args.priority ? String(args.priority) : "medium",
        status: args.status ? String(args.status) : "todo",
      });
    }

    default:
      return { content: `Unknown Paperclip tool: ${name}`, isError: true };
  }
}
