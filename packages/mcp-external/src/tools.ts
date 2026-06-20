import { z, type ZodRawShape } from "zod";
import type { PaperclipApiClient } from "./client.js";

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

export function createToolDefinitions(client: PaperclipApiClient): ToolDefinition[] {
  const getAgentSchema = z.object({
    agent_id: z
      .string()
      .default("me")
      .describe('Agent UUID, or the literal "me" for the currently authenticated agent.'),
  });

  return [
    {
      name: "get_agent",
      description: "Get details for a specific agent, or the currently authenticated agent.",
      schema: getAgentSchema,
      execute: async (args) => {
        const agentId = String((args.agent_id as string | undefined) ?? "me").trim() || "me";
        const path = agentId.toLowerCase() === "me" ? "/agents/me" : `/agents/${encodeURIComponent(agentId)}`;
        const data = await client.requestJson("GET", path);
        return textResult(data);
      },
    },
  ];
}
