import type { ToolResult, PluginContext } from "@paperclipai/plugin-sdk";
import { TOOL_NAMES } from "../manifest.js";
import { resolveJiraClient } from "./shared.js";

interface AssignIssueParams {
  key: string;
  accountId: string | null;
}

export function registerAssignIssueTool(ctx: PluginContext): void {
  ctx.tools.register(
    TOOL_NAMES.assignIssue,
    {
      displayName: "Assign Jira Issue",
      description: "Assign a Jira issue to a specific user by Atlassian account ID.",
      parametersSchema: {
        type: "object",
        required: ["key", "accountId"],
        properties: {
          key: { type: "string", description: "Jira issue key, e.g. PD-123" },
          accountId: {
            type: "string",
            description: "Atlassian account ID of the assignee, or null to unassign.",
          },
        },
      },
    },
    async (params): Promise<ToolResult> => {
      const { key, accountId } = params as AssignIssueParams;
      if (!key?.trim()) {
        return { error: "key is required" };
      }

      const client = await resolveJiraClient(ctx);
      const issueKey = key.trim().toUpperCase();
      const normalizedAccountId = accountId?.trim() || null;

      await client.assignIssue(issueKey, normalizedAccountId);

      const assigneeLabel = normalizedAccountId ?? "Unassigned";
      return {
        content: `Assigned ${issueKey} to ${assigneeLabel}`,
        data: { ok: true, key: issueKey, accountId: normalizedAccountId },
      };
    },
  );
}
