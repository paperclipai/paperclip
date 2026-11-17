import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { GoogleToolError } from "./errors.js";
import type { GoogleHttp } from "./google-http.js";

/**
 * One tool as written: its MCP definition (following Google's MCP reference),
 * an argument parser, and a `run` that sequences the tool's pure request and
 * result functions over `GoogleHttp`.
 */
export interface RestToolSpec<Args> {
  definition: Tool;
  args: z.ZodType<Args>;
  run(args: Args, http: GoogleHttp): Promise<CallToolResult>;
}

/** A tool as the registry calls it: arguments are parsed at this boundary. */
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

/** An MCP result carrying the same object as text and as structured content. */
export function structuredResult(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

export function toolErrorResult(error: GoogleToolError): CallToolResult {
  // No structured content: an error result is not shaped like the tool's output schema.
  return { isError: true, content: [{ type: "text", text: error.message }] };
}

/** Drop keys whose value is undefined, so results only carry populated fields. */
export function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
