import type { SdkMessage, SdkRunResult, SdkRunStatus } from "./sdk-types.js";

/**
 * Events the cursor-sdk adapter writes to onLog("stdout", ...). Each event is one
 * JSON object per line. The shape is intentionally compatible with cursor-local's
 * stream-json events for the overlapping types (system/init, assistant, user,
 * result), so existing transcript renderers that fall through to the cursor-local
 * parser still work.
 *
 * Adapter-specific UI parser (./ui/parse-stdout.ts) handles the new SDK-only
 * event types (thinking, tool_call, status, task, request).
 */
export type EmittableEvent =
  | { type: "system"; subtype: "init"; model: string; sessionId?: string; runtime: string }
  | { type: "assistant"; message: { text: string } }
  | { type: "assistant"; message: { content: Array<{ type: "tool_call"; name: string; tool_use_id?: string; input: unknown }> } }
  | { type: "user"; message: { text: string } }
  | { type: "thinking"; text: string; subtype?: "delta" }
  | { type: "tool_call"; subtype: "started" | "completed"; call_id: string; tool_call: Record<string, unknown>; is_error?: boolean }
  | { type: "status"; status: string; runStatus?: SdkRunStatus }
  | { type: "task"; subtype?: string; text?: string }
  | { type: "request"; subtype?: string; text?: string }
  | { type: "result"; subtype: string; result: string; is_error?: boolean; durationMs?: number; git?: Record<string, unknown> }
  | { type: "error"; message: string };

export type EmitFn = (event: EmittableEvent) => Promise<void>;

/**
 * Build an EmitFn from Paperclip's onLog. Each event becomes one stdout line so
 * downstream parsers see canonical NDJSON.
 */
export function makeEmitter(onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>): EmitFn {
  return async (event) => {
    await onLog("stdout", `${JSON.stringify(event)}\n`);
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pickAssistantText(message: unknown, topLevelText: string): string {
  if (topLevelText) return topLevelText;
  if (typeof message === "string") return message;
  if (message && typeof message === "object") {
    const m = message as Record<string, unknown>;
    if (typeof m.text === "string") return m.text;
    if (Array.isArray(m.content)) {
      const parts: string[] = [];
      for (const partRaw of m.content) {
        if (!partRaw || typeof partRaw !== "object") continue;
        const part = partRaw as Record<string, unknown>;
        if (part.type === "text" || part.type === "output_text") {
          if (typeof part.text === "string") parts.push(part.text);
        }
      }
      if (parts.length > 0) return parts.join("");
    }
  }
  return "";
}

/**
 * Translate an SDK message into one or more Paperclip stream events. Returns []
 * to skip uninteresting events (e.g. empty deltas).
 */
export function translateSdkMessage(msg: SdkMessage, ctx: { runtime: string }): EmittableEvent[] {
  switch (msg.type) {
    case "system": {
      // SDK emits an init-like system event with model + tools metadata.
      return [{
        type: "system",
        subtype: "init",
        model: asString(msg.model) || "cursor",
        runtime: ctx.runtime,
      }];
    }
    case "assistant": {
      const text = pickAssistantText(msg.message, asString(msg.text));
      if (!text) return [];
      return [{ type: "assistant", message: { text } }];
    }
    case "user": {
      const text = pickAssistantText(msg.message, asString(msg.text));
      if (!text) return [];
      return [{ type: "user", message: { text } }];
    }
    case "thinking": {
      const delta = msg.delta as { text?: string } | undefined;
      const text = asString(msg.text) || asString(delta?.text);
      if (!text.trim()) return [];
      const subtype = asString(msg.subtype).toLowerCase();
      const isDelta = subtype === "delta" || (msg.delta !== undefined);
      return [{ type: "thinking", text, ...(isDelta ? { subtype: "delta" as const } : {}) }];
    }
    case "tool_call": {
      const subtype = asString(msg.subtype).toLowerCase() === "completed" ? "completed" : "started";
      const callId = asString(msg.call_id) || "tool_call";
      const name = asString(msg.name) || "tool";
      // Wrap tool_call so the cursor-local-shaped parser can handle it.
      const toolCall: Record<string, unknown> = {
        [name]: {
          args: msg.args,
          result: msg.result,
          status: msg.status,
        },
      };
      const isError = msg.is_error === true || asString(msg.status).toLowerCase() === "error" || asString(msg.status).toLowerCase() === "failed";
      return [{ type: "tool_call", subtype, call_id: callId, tool_call: toolCall, ...(isError ? { is_error: true } : {}) }];
    }
    case "status": {
      const runStatus = msg.runStatus as SdkRunStatus | undefined;
      const status = asString(msg.status) || asString(runStatus) || "running";
      return [{ type: "status", status, runStatus }];
    }
    case "task": {
      return [{ type: "task", subtype: asString(msg.subtype) || undefined, text: asString(msg.text) || undefined }];
    }
    case "request": {
      return [{ type: "request", subtype: asString(msg.subtype) || undefined, text: asString(msg.text) || asString(msg.prompt) || undefined }];
    }
    default:
      return [];
  }
}

export function buildResultEvent(result: SdkRunResult): EmittableEvent {
  const isError = result.status === "error" || result.status === "cancelled";
  return {
    type: "result",
    subtype: result.status,
    result: result.result ?? "",
    is_error: isError || undefined,
    ...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
    ...(result.git ? { git: { ...result.git } } : {}),
  } as EmittableEvent;
}
