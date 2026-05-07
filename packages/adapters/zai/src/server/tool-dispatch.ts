import type { ToolDefinition } from "@paperclipai/mcp-server";
import type { ZaiToolCall } from "../shared/types.js";

export interface ToolDispatchOk {
  ok: true;
  output: unknown;
  /** Wall-clock time the dispatch took, in ms. */
  elapsedMs: number;
}

export interface ToolDispatchErr {
  ok: false;
  /** Stable error code so the model can branch (`unknown_tool`, `bad_arguments`, `tool_threw`). */
  code: "unknown_tool" | "bad_arguments" | "tool_threw";
  message: string;
  /** Optional structured detail (HTTP status, response body, etc). */
  detail?: unknown;
  elapsedMs: number;
}

export type ToolDispatchResult = ToolDispatchOk | ToolDispatchErr;

export interface DispatchInput {
  toolsByName: Map<string, ToolDefinition>;
  call: ZaiToolCall;
}

/**
 * Stringify a tool dispatch result into a single string suitable for the
 * `content` field of a `role: "tool"` message back to Z.AI.
 *
 * The returned string is JSON. The model is instructed (by convention from
 * OpenAI-compatible APIs) that tool messages are JSON. We standardise the
 * envelope so the model can write one branch:
 *   { "ok": true, "output": ... }              // success
 *   { "ok": false, "error": { code, message } } // failure
 */
export function stringifyToolResult(result: ToolDispatchResult): string {
  if (result.ok) {
    return JSON.stringify({ ok: true, output: result.output });
  }
  return JSON.stringify({
    ok: false,
    error: {
      code: result.code,
      message: result.message,
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    },
  });
}

function parseArguments(raw: string | undefined | null): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  if (!raw || raw.length === 0) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "tool arguments must be a JSON object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `tool arguments are not valid JSON: ${message}` };
  }
}

function unwrapMcpToolOutput(content: { content: Array<{ type: "text"; text: string }> }): unknown {
  // makeTool() wraps every output in formatTextResponse() / formatErrorResponse(), which
  // returns `{ content: [{ type: "text", text: <stringified-json-or-error> }] }`.
  // For Z.AI we want the raw value, not the MCP wire envelope, so we unwrap it
  // and re-parse the JSON if possible.
  const first = content.content[0];
  if (!first || typeof first.text !== "string") return content;
  const text = first.text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Dispatch a single Z.AI tool_call against the Paperclip tools catalog.
 *
 * Errors NEVER throw — they're returned as ToolDispatchErr so the agentic loop
 * can feed the failure back to the model as a `role: "tool"` message and let
 * the model recover (retry with corrected args, fall back to a different tool,
 * or give up gracefully).
 */
export async function dispatchToolCall(input: DispatchInput): Promise<ToolDispatchResult> {
  const startedAt = Date.now();
  const tool = input.toolsByName.get(input.call.function.name);
  if (!tool) {
    return {
      ok: false,
      code: "unknown_tool",
      message: `Unknown tool: ${input.call.function.name}`,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const parsed = parseArguments(input.call.function.arguments);
  if (!parsed.ok) {
    return {
      ok: false,
      code: "bad_arguments",
      message: parsed.reason,
      elapsedMs: Date.now() - startedAt,
    };
  }

  try {
    const wireResult = await tool.execute(parsed.value);
    const output = unwrapMcpToolOutput(wireResult);

    // formatErrorResponse() also returns a `{ content: [...] }` envelope, but
    // the inner JSON has shape `{ error: { ... } }`. Detect that and surface
    // it to the model as a structured failure.
    if (
      output &&
      typeof output === "object" &&
      !Array.isArray(output) &&
      "error" in (output as Record<string, unknown>)
    ) {
      const errorRecord = (output as Record<string, unknown>).error;
      const message =
        errorRecord && typeof errorRecord === "object" && "message" in (errorRecord as Record<string, unknown>) &&
        typeof (errorRecord as Record<string, unknown>).message === "string"
          ? ((errorRecord as Record<string, unknown>).message as string)
          : "Tool returned an error";
      return {
        ok: false,
        code: "tool_threw",
        message,
        detail: errorRecord,
        elapsedMs: Date.now() - startedAt,
      };
    }

    return {
      ok: true,
      output,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const detail =
      err && typeof err === "object" && "status" in err
        ? {
            status: (err as { status?: unknown }).status,
            body: (err as { body?: unknown }).body,
          }
        : undefined;
    return {
      ok: false,
      code: "tool_threw",
      message,
      ...(detail !== undefined ? { detail } : {}),
      elapsedMs: Date.now() - startedAt,
    };
  }
}
