// ---------------------------------------------------------------------------
// Oz local run output parser
//
// oz agent run --output-format json produces NDJSON (newline-delimited JSON).
// Each line is a JSON object with a `type` field.
//
// Known event types (empirically verified):
//   system          – run lifecycle: run_started, conversation_started
//   agent           – agent text response
//   agent_reasoning – agent thinking/reasoning text
//   tool_call       – tool invocation (run_command, read_file, edit_file, …)
//   tool_result     – tool execution result with exit_code and output
//
// Falls back to raw text extraction if JSON parsing fails.
// ---------------------------------------------------------------------------

// -- Typed event shapes ------------------------------------------------------

export interface OzSystemEvent {
  type: "system";
  event_type: string;
  run_id?: string;
  run_url?: string;
  conversation_id?: string;
  message?: string;
  error?: string;
  [key: string]: unknown;
}

export interface OzAgentEvent {
  type: "agent";
  text: string;
}

export interface OzAgentReasoningEvent {
  type: "agent_reasoning";
  text: string;
}

export interface OzToolCallEvent {
  type: "tool_call";
  tool: string;
  command?: string;
  path?: string;
  [key: string]: unknown;
}

export interface OzToolResultEvent {
  type: "tool_result";
  tool: string;
  status: string;
  exit_code?: number;
  output?: string;
  [key: string]: unknown;
}

export type OzEvent =
  | OzSystemEvent
  | OzAgentEvent
  | OzAgentReasoningEvent
  | OzToolCallEvent
  | OzToolResultEvent
  | { type: string; [key: string]: unknown };

// -- NDJSON line parser ------------------------------------------------------

export function parseNdjsonLine(line: string): OzEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj === "object" && obj !== null && typeof obj.type === "string") {
      return obj as OzEvent;
    }
    return null;
  } catch {
    return null;
  }
}

// -- Error/auth patterns (used for both structured and raw output) ------------

const AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|please\s+log\s+in|authentication\s+required|unauthorized|login\s+required|run\s+`?oz\s+login`?)/i;
const UNKNOWN_CONVERSATION_RE =
  /(?:conversation\s+not\s+found|unknown\s+conversation|no\s+conversation\s+found|invalid\s+conversation)/i;
const CREDITS_EXHAUSTED_RE =
  /(?:run\s+out\s+of\s+credits|insufficient\s+credits|no\s+credits|out\s+of\s+credits)/i;

// -- Full output parser (post-run) -------------------------------------------

export interface OzParsedOutput {
  conversationId: string | null;
  runId: string | null;
  runUrl: string | null;
  events: OzEvent[];
  errorMessage: string | null;
  requiresAuth: boolean;
  creditsExhausted: boolean;
  summary: string | null;
}

function extractFromEvents(events: OzEvent[]): {
  conversationId: string | null;
  runId: string | null;
  runUrl: string | null;
  summary: string | null;
} {
  let conversationId: string | null = null;
  let runId: string | null = null;
  let runUrl: string | null = null;
  let lastAgentText: string | null = null;

  for (const ev of events) {
    if (ev.type === "system") {
      const sys = ev as OzSystemEvent;
      if (sys.event_type === "conversation_started" && typeof sys.conversation_id === "string") {
        conversationId = sys.conversation_id;
      }
      if (sys.event_type === "run_started") {
        if (typeof sys.run_id === "string") runId = sys.run_id;
        if (typeof sys.run_url === "string") runUrl = sys.run_url;
      }
    }
    if (ev.type === "agent") {
      const text = (ev as OzAgentEvent).text.trim();
      if (text.length > 0) lastAgentText = text;
    }
  }

  const summary = lastAgentText ? lastAgentText.slice(0, 500) : null;
  return { conversationId, runId, runUrl, summary };
}

function extractErrorFromEvents(events: OzEvent[], stderr: string): string | null {
  for (const ev of events) {
    if (ev.type === "system") {
      const sys = ev as OzSystemEvent;
      if (
        sys.event_type === "error" ||
        sys.event_type === "run_failed" ||
        sys.event_type === "run_error"
      ) {
        const msg =
          typeof sys.message === "string" ? sys.message :
          typeof sys.error === "string" ? sys.error :
          null;
        if (msg) return msg;
      }
    }
  }
  for (const line of stderr.split(/\r?\n/)) {
    const t = line.trim();
    if (/^error:/i.test(t) || /^fatal:/i.test(t)) return t;
  }
  return stderr.split(/\r?\n/).find((l) => l.trim())?.trim() ?? null;
}

export function parseOzOutput(stdout: string, stderr: string): OzParsedOutput {
  const events: OzEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const ev = parseNdjsonLine(line);
    if (ev) events.push(ev);
  }

  const combined = [stdout, stderr].join("\n");
  const requiresAuth = AUTH_REQUIRED_RE.test(combined);
  const creditsExhausted = CREDITS_EXHAUSTED_RE.test(combined);

  if (events.length > 0) {
    const extracted = extractFromEvents(events);
    return {
      ...extracted,
      events,
      errorMessage: extractErrorFromEvents(events, stderr),
      requiresAuth,
      creditsExhausted,
    };
  }

  // Fallback: raw text parsing for non-JSON output
  const CONVERSATION_URL_RE =
    /(?:oz\.warp\.dev|app\.warp\.dev)\/(?:runs|agent\/runs|conversations)\/([a-zA-Z0-9_-]{8,})/;
  const CONVERSATION_FLAG_RE = /conversation[:\s]+([a-zA-Z0-9_-]{8,})/i;
  const urlMatch = combined.match(CONVERSATION_URL_RE);
  const flagMatch = combined.match(CONVERSATION_FLAG_RE);
  const conversationId = urlMatch?.[1] ?? flagMatch?.[1] ?? null;

  let errorMessage: string | null = null;
  for (const line of combined.split(/\r?\n/)) {
    const t = line.trim();
    if (/^error:/i.test(t) || /^fatal:/i.test(t)) { errorMessage = t; break; }
  }
  if (!errorMessage) {
    errorMessage = stderr.split(/\r?\n/).find((l) => l.trim())?.trim() ?? null;
  }

  let summary: string | null = null;
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const plain = (lines[i] ?? "").trim().replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (plain.length > 10) { summary = plain.slice(0, 500); break; }
  }

  return { conversationId, runId: null, runUrl: null, events: [], errorMessage, requiresAuth, creditsExhausted, summary };
}

export function isOzUnknownConversationError(stdout: string, stderr: string): boolean {
  return UNKNOWN_CONVERSATION_RE.test([stdout, stderr].join("\n"));
}

export function isOzAuthRequired(stdout: string, stderr: string): boolean {
  return AUTH_REQUIRED_RE.test([stdout, stderr].join("\n"));
}

export function isOzCreditsExhausted(stdout: string, stderr: string): boolean {
  return CREDITS_EXHAUSTED_RE.test([stdout, stderr].join("\n"));
}
