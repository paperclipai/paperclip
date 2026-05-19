import type { ToolResult, PluginContext } from "@paperclipai/plugin-sdk";
import { JiraClient } from "../jira-client.js";
import { TOOL_NAMES } from "../manifest.js";
import { resolveJiraClient } from "./shared.js";

interface GetIssueParams {
  key: string;
}

export function registerGetIssueTool(ctx: PluginContext): void {
  ctx.tools.register(
    TOOL_NAMES.getIssue,
    {
      displayName: "Get Jira Issue",
      description:
        "Fetch a Jira issue by key. Returns key, summary, status, assignee, and available transitions.",
      parametersSchema: {
        type: "object",
        required: ["key"],
        properties: {
          key: { type: "string", description: "Jira issue key, e.g. PD-123" },
        },
      },
    },
    async (params): Promise<ToolResult> => {
      const { key } = params as GetIssueParams;
      if (!key?.trim()) {
        return { error: "key is required" };
      }

      const client = await resolveJiraClient(ctx);
      const issue = await client.getIssue(key.trim().toUpperCase());

      return {
        content: `Issue ${issue.key}: ${issue.summary} — Status: ${issue.status}, Assignee: ${issue.assignee ?? "Unassigned"}`,
        data: issue,
      };
    },
  );
}
