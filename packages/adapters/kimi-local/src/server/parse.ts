import { asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

export interface ParsedKimiToolCall {
  id: string | null;
  name: string;
  arguments: unknown;
}

export interface ParsedKimiToolResult {
  toolCallId: string | null;
  content: string;
}

export interface ParsedKimiJsonl {
  sessionId: string | null;
  summary: string;
  toolCalls: ParsedKimiToolCall[];
  toolResults: ParsedKimiToolResult[];
  errorMessage: string | null;
}

/**
 * Kimi tool_call `function.arguments` is a JSON-encoded string. Parse it when
 * possible so downstream consumers see structured input; fall back to the raw
 * string when it is not valid JSON.
 */
function parseToolCallArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message =
    asString(rec.message, "").trim() ||
    asString(rec.error, "").trim() ||
    asString(rec.detail, "").trim() ||
    asString(rec.code, "").trim();
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

/**
 * Parse `kimi -p ... --output-format stream-json` stdout.
 *
 * Verified event shapes (kimi 0.27.0):
 * - {"role":"assistant","content":"..."}
 * - {"role":"assistant","tool_calls":[{"type":"function","id":"...","function":{"name":"...","arguments":"{...}"}}]}
 * - {"role":"tool","tool_call_id":"...","content":"..."}
 * - {"role":"meta","type":"session.resume_hint","session_id":"...","command":"kimi -r ...","content":"..."}
 */
export function parseKimiJsonl(stdout: string): ParsedKimiJsonl {
  let sessionId: string | null = null;
  let errorMessage: string | null = null;
  const textParts: string[] = [];
  const toolCalls: ParsedKimiToolCall[] = [];
  const toolResults: ParsedKimiToolResult[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const role = asString(event.role, "").trim().toLowerCase();

    if (role === "assistant") {
      const content = asString(event.content, "").trim();
      if (content) textParts.push(content);
      const calls = Array.isArray(event.tool_calls) ? event.tool_calls : [];
      for (const callRaw of calls) {
        const call = parseObject(callRaw);
        const fn = parseObject(call.function);
        const name = asString(fn.name, asString(call.name, "")).trim();
        if (!name) continue;
        toolCalls.push({
          id: asString(call.id, "").trim() || null,
          name,
          arguments: parseToolCallArguments(fn.arguments ?? call.arguments),
        });
      }
      continue;
    }

    if (role === "tool") {
      toolResults.push({
        toolCallId: asString(event.tool_call_id, "").trim() || null,
        content: asString(event.content, ""),
      });
      continue;
    }

    if (role === "meta") {
      const type = asString(event.type, "").trim();
      if (type === "session.resume_hint") {
        sessionId = asString(event.session_id, "").trim() || sessionId;
      }
      continue;
    }

    // Defensive: kimi has no dedicated error event in the verified schema, but
    // tolerate {"role":"error"} / {"type":"error"} lines if they ever appear.
    const type = asString(event.type, "").trim().toLowerCase();
    if (role === "error" || type === "error") {
      const text = errorText(event.error ?? event.message ?? event.content ?? event.detail).trim();
      if (text) errorMessage = text;
    }
  }

  return {
    sessionId,
    summary: textParts.join("\n\n").trim(),
    toolCalls,
    toolResults,
    errorMessage,
  };
}

export interface KimiRuntimeEvent {
  eventType: string;
  message?: string;
  payload?: Record<string, unknown>;
}

/**
 * Map a single `kimi -p ... --output-format stream-json` line to live runtime
 * events for `onEvent`, which drive the issue-thread activity indicator
 * (`currentToolName` / `lastAssistantSnippet` / `lastEventAt`).
 *
 * Kimi emits complete messages in bursts with no token-level streaming, so
 * without this the issue thread never sees a tool name or assistant snippet and
 * sits on a stale "no output for N s" line while the model thinks. Tool results
 * are intentionally omitted so the last meaningful "Using X" / assistant snippet
 * is not overwritten by a generic label; the raw run-log stream keeps the
 * activity timer fresh across tool execution.
 */
export function extractKimiRuntimeEvents(line: string): KimiRuntimeEvent[] {
  const event = parseJson(line);
  if (!event) return [];
  const role = asString(event.role, "").trim().toLowerCase();
  if (role !== "assistant") return [];

  const events: KimiRuntimeEvent[] = [];
  const content = asString(event.content, "").trim();
  if (content) {
    events.push({ eventType: "assistant", message: content, payload: { content } });
  }
  const calls = Array.isArray(event.tool_calls) ? event.tool_calls : [];
  for (const callRaw of calls) {
    const call = parseObject(callRaw);
    const fn = parseObject(call.function);
    const name = asString(fn.name, asString(call.name, "")).trim();
    if (name) {
      events.push({ eventType: "tool_call", payload: { toolName: name } });
    }
  }
  return events;
}

function normalizedHaystack(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

export function isKimiSessionUnrecoverableError(stdout: string, stderr: string): boolean {
  return /unknown\s+session|session(?:\s+.*)?\s+not\s+found|resume\s+.*\s+not\s+found|cannot\s+resume|failed\s+to\s+resume|invalid\s+session/i.test(
    normalizedHaystack(stdout, stderr),
  );
}

export function isKimiTransientNetworkError(stdout: string, stderr: string): boolean {
  return /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch\s+failed|socket\s+hang\s+up/i.test(
    normalizedHaystack(stdout, stderr),
  );
}

export function describeKimiFailure(input: {
  errorMessage?: string | null;
  stderr?: string;
}): string | null {
  const detail =
    (typeof input.errorMessage === "string" ? input.errorMessage.trim() : "") ||
    (input.stderr ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ||
    "";
  if (!detail) return null;
  const clean = detail.replace(/\s+/g, " ").trim();
  const max = 240;
  return `Kimi run failed: ${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean}`;
}

const KIMI_AUTH_REQUIRED_RE =
  /(?:\bkimi\s+login\b|\blogin\s+required\b|not\s+(?:logged\s+in|authenticated)|\b401\b|unauthorized|device\s+code|authentication\s+(?:required|failed)|invalid\s+api[_ ]?key)/i;

export function detectKimiAuthRequired(input: {
  stdout: string;
  stderr: string;
}): { requiresAuth: boolean } {
  const requiresAuth = normalizedHaystack(input.stdout, input.stderr)
    .split(/\r?\n/)
    .some((line) => KIMI_AUTH_REQUIRED_RE.test(line));
  return { requiresAuth };
}
