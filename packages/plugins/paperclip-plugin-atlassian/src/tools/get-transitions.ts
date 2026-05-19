import type { ToolResult, PluginContext } from "@paperclipai/plugin-sdk";
import { TOOL_NAMES } from "../manifest.js";
import { resolveJiraClient } from "./shared.js";

interface GetTransitionsParams {
  key: string;
}

export function registerGetTransitionsTool(ctx: PluginContext): void {
  ctx.tools.register(
    TOOL_NAMES.getTransitions,
    {
      displayName: "Get Jira Transitions",
      description: "List the available workflow transitions for a Jira issue.",
      parametersSchema: {
        type: "object",
        required: ["key"],
        properties: {
          key: { type: "string", description: "Jira issue key, e.g. PD-123" },
        },
      },
    },
    async (params): Promise<ToolResult> => {
      const { key } = params as GetTransitionsParams;
      if (!key?.trim()) {
        return { error: "key is required" };
      }

      const client = await resolveJiraClient(ctx);
      const transitions = await client.getTransitions(key.trim().toUpperCase());

      const lines = transitions.map(
        (t) => `[${t.id}] ${t.name} → ${t.to.name}`,
      );

      return {
        content: lines.length
          ? lines.join("\n")
          : `No transitions available for ${key}`,
        data: { key: key.trim().toUpperCase(), transitions },
      };
    },
  );
}
