import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { GoogleToolError } from "./errors.js";
import type { GoogleHttp } from "./google-http.js";

export const FALLBACK_MAX_RESULT_BYTES = 250_000;

export interface ToolLimits {
  maxResultBytes: number;
}

export const FALLBACK_TOOL_LIMITS: ToolLimits = { maxResultBytes: FALLBACK_MAX_RESULT_BYTES };

export interface RestToolSpec<Args> {
  definition: Tool;
  args: z.ZodType<Args>;
  whenTooLarge?: string | ((args: Args) => string);
  run(args: Args, http: GoogleHttp, limits: ToolLimits): Promise<CallToolResult>;
}

export interface RestTool {
  definition: Tool;
  call(rawArgs: unknown, http: GoogleHttp, limits?: ToolLimits): Promise<CallToolResult>;
}

export function defineTool<Args>(spec: RestToolSpec<Args>): RestTool {
  const readOnly = spec.definition.annotations?.readOnlyHint === true;
  if (readOnly !== (spec.whenTooLarge !== undefined)) {
    throw new Error(`${spec.definition.name}: a read tool must say how to ask for less, and a write tool must not`);
  }
  return {
    definition: spec.definition,
    async call(rawArgs, http, limits = FALLBACK_TOOL_LIMITS) {
      const parsed = spec.args.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ");
        return { isError: true, content: [{ type: "text", text: `Invalid arguments for ${spec.definition.name}: ${detail}` }] };
      }
      try {
        const result = await spec.run(parsed.data, http, limits);
        if (!spec.whenTooLarge) return result;
        const advice = typeof spec.whenTooLarge === "string" ? spec.whenTooLarge : spec.whenTooLarge(parsed.data);
        return withinResultBudget(result, limits.maxResultBytes, advice);
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

export function serializedResultBytes(result: CallToolResult): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

export const byteCount = (bytes: number) => bytes.toLocaleString("en-US");

export function resultTooLargeMessage(bytes: number, maxBytes: number, advice: string): string {
  return `The result is ${byteCount(bytes)} bytes, more than the ${byteCount(maxBytes)} bytes this tool can return, so it was not returned. ${advice}`;
}

export function withinResultBudget(result: CallToolResult, maxBytes: number, advice: string): CallToolResult {
  const bytes = serializedResultBytes(result);
  if (bytes <= maxBytes) return result;
  return toolErrorResult(new GoogleToolError("too_large", resultTooLargeMessage(bytes, maxBytes, advice)));
}

export function toolErrorResult(error: GoogleToolError): CallToolResult {
  return { isError: true, content: [{ type: "text", text: error.message }] };
}

export function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
