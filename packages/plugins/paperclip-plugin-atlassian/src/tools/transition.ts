import type { ToolResult, PluginContext } from "@paperclipai/plugin-sdk";
import { TOOL_NAMES } from "../manifest.js";
import { resolveJiraClient, resolveTransitionId } from "./shared.js";

interface TransitionParams {
  key: string;
  transition: string;
}

export function registerTransitionTool(ctx: PluginContext): void {
  ctx.tools.register(
    TOOL_NAMES.transition,
    {
      displayName: "Transition Jira Issue",
      description:
        "Move a Jira issue to a new workflow status. Accepts either a numeric transition ID or a logical name defined in transitionMapping.",
      parametersSchema: {
        type: "object",
        required: ["key", "transition"],
        properties: {
          key: { type: "string", description: "Jira issue key, e.g. PD-123" },
          transition: {
            type: "string",
            description:
              "Transition ID (e.g. \"21\") or logical name from transitionMapping (e.g. \"done\")",
          },
        },
      },
    },
    async (params): Promise<ToolResult> => {
      const { key, transition } = params as TransitionParams;
      if (!key?.trim()) {
        return { error: "key is required" };
      }
      if (!transition?.trim()) {
        return { error: "transition is required" };
      }

      const config = await ctx.config.get();
      const transitionMapping = (config.transitionMapping ?? {}) as Record<string, string>;
      const resolvedId = resolveTransitionId(transition.trim(), transitionMapping);

      const client = await resolveJiraClient(ctx);
      const issueKey = key.trim().toUpperCase();

      const available = await client.getTransitions(issueKey);
      const target = available.find((t) => t.id === resolvedId);
      if (!target) {
        const ids = available.map((t) => `${t.id}:${t.name}`).join(", ");
        return {
          error: `Transition ID "${resolvedId}" not available for ${issueKey}. Available: ${ids}`,
        };
      }

      await client.transition(issueKey, resolvedId);

      await ctx.activity.log({
        companyId: ctx.manifest.id,
        message: `Transitioned ${issueKey} to "${target.to.name}" (transition ${resolvedId})`,
        entityType: "jira-issue",
        entityId: issueKey,
      });

      return {
        content: `Transitioned ${issueKey} to "${target.to.name}"`,
        data: { ok: true, key: issueKey, transitionId: resolvedId, newStatus: target.to.name },
      };
    },
  );
}
