import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { GoogleToolError } from "./errors.js";
import type { GoogleHttp } from "./google-http.js";

export interface RestToolSpec<Args> {
  definition: Tool;
  args: z.ZodType<Args>;
  run(args: Args, http: GoogleHttp): Promise<CallToolResult>;
}

export interface RestTool {
  definition: Tool;
  call(rawArgs: unknown, http: GoogleHttp): Promise<CallToolResult>;
}

export function defineTool<Args>(spec: RestToolSpec<Args>): RestTool {
  return {
    definition: spec.definition,
    async call(rawArgs, http) {
      const parsed = spec.args.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ");
        return { isError: true, content: [{ type: "text", text: `Invalid arguments for ${spec.definition.name}: ${detail}` }] };
      }
      try {
        return await spec.run(parsed.data, http);
      } catch (error) {
        if (error instanceof GoogleToolError) return toolErrorResult(error);
        throw error;
      }
    },
  };
}

export function structuredResult(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

export function toolErrorResult(error: GoogleToolError): CallToolResult {
  return { isError: true, content: [{ type: "text", text: error.message }] };
}

export function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
