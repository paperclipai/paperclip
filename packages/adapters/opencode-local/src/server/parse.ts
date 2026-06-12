import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

// ---------------------------------------------------------------------------
// SAG-722: comment sanitization — strip leaked tool-call JSON, echoed system
// prompts, and internal-reasoning XML blocks before text reaches the summary.
// ---------------------------------------------------------------------------

function isPureJson(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return false;
  const first = t[0];
  if (first !== "{" && first !== "[") return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT_ECHO_PATTERNS: RegExp[] = [
  /^You are woken by reason:/i,
  /^You are agent\b/i,
  /^I am agent\b/i,
  /^The above agent instructions were loaded from\b/i,
  /^This base directory is authoritative for\b/i,
  /^Treat this wake payload as/i,
];

// Match full <tag>…</tag> blocks for known internal-reasoning wrappers.
const INTERNAL_XML_BLOCK_RE = /<(analysis|thinking|antml:thinking|antml:function_calls)>[\s\S]*?<\/\1>/gi;

// Detect JSON tool-call objects embedded mid-text. Models leak several dialects
// when they can't use the structured channel — broadened from the original
// {"type":"function",...} form after SAG-819#72f09e77 (8b IC leaked the bare
// {"name":"webfetch","parameters":{...}} shape that the narrower detector missed).
const INLINE_TOOL_CALL_PATTERNS: RegExp[] = [
  // OpenAI-style: {"type":"function", ...}
  /\{\s*"type"\s*:\s*"function"/i,
  // Bare-name dialect (Llama/Qwen 8b): {"name":"<ident>", ..., "parameters"|"arguments": ...}
  /\{\s*"name"\s*:\s*"[A-Za-z_][\w.\-]*"[\s\S]{0,200}?"(?:parameters|arguments)"\s*:/i,
  // OpenCode bridge dialect: {"tool":"<ident>", ..., "args"|"input": ...}
  /\{\s*"tool"\s*:\s*"[A-Za-z_][\w.\-]*"[\s\S]{0,200}?"(?:args|input|arguments|parameters)"\s*:/i,
];

function hasInlineToolCall(text: string): boolean {
  return INLINE_TOOL_CALL_PATTERNS.some((re) => re.test(text));
}

export function sanitizeModelText(text: string): string | null {
  if (isPureJson(text)) return null;
  if (SYSTEM_PROMPT_ECHO_PATTERNS.some((re) => re.test(text.trimStart()))) return null;
  // Drop blocks where the model slipped an inline text-mode tool call anywhere
  // in the text — the prose that precedes the JSON is also internal reasoning.
  if (hasInlineToolCall(text)) return null;
  const stripped = text.replace(INTERNAL_XML_BLOCK_RE, "").trim();
  return stripped.length > 0 ? stripped : null;
}

// ---------------------------------------------------------------------------

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const toolErrors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const currentSessionId = asString(event.sessionID, "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    const type = asString(event.type, "");

    if (type === "text") {
      const part = parseObject(event.part);
      const text = asString(part.text, "").trim();
      if (text) {
        const sanitized = sanitizeModelText(text);
        if (sanitized) messages.push(sanitized);
      }
      continue;
    }

    if (type === "step_finish") {
      const part = parseObject(event.part);
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      usage.inputTokens += asNumber(tokens.input, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0);
      usage.outputTokens += asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
      costUsd += asNumber(part.cost, 0);
      continue;
    }

    if (type === "tool_use") {
      const part = parseObject(event.part);
      const state = parseObject(part.state);
      if (asString(state.status, "") === "error") {
        const text = asString(state.error, "").trim();
        if (text) toolErrors.push(text);
      }
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message).trim();
      if (text) errors.push(text);
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    toolErrors,
  };
}

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}
