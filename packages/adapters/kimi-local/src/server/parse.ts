import type { UsageSummary } from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject, parseJson } from "@paperclipai/adapter-utils/server-utils";

const KIMI_AUTH_REQUIRED_RE = /(?:not\s+logged\s+in|please\s+log\s+in|please\s+run\s+`?kimi\s+login`?|login\s+required|requires\+login|unauthorized|authentication\s+required)/i;

interface KimiContentBlock {
  type: string;
  text?: string;
  think?: string;
  encrypted?: unknown;
}

interface KimiMessage {
  role: string;
  content: KimiContentBlock[];
}

/**
 * Parse Kimi's stream-json output format.
 * Kimi outputs JSON lines with different message types.
 */
export function parseKimiStreamJson(stdout: string): {
  sessionId: string | null;
  model: string;
  costUsd: number | null;
  usage: UsageSummary | null;
  summary: string;
  resultJson: Record<string, unknown> | null;
  messages: KimiMessage[];
} {
  const messages: KimiMessage[] = [];
  let sessionId: string | null = null;
  let model = "";

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    // Parse assistant messages
    const role = asString(event.role, "");
    if (role === "assistant") {
      const content = Array.isArray(event.content) ? event.content : [];
      messages.push({ role: "assistant", content });
      continue;
    }

    // Parse system messages for session info
    const type = asString(event.type, "");
    if (type === "system" || type === "init") {
      const sid = asString(event.session_id, "");
      if (sid) sessionId = sid;
      const m = asString(event.model, "");
      if (m) model = m;
    }
  }

  // Extract text content from messages for summary
  const texts: string[] = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "text" && block.text) {
        texts.push(block.text);
      }
    }
  }

  // Kimi doesn't currently provide usage in stream output
  const usage: UsageSummary = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  return {
    sessionId,
    model,
    costUsd: null,
    usage,
    summary: texts.join("\n\n").trim(),
    resultJson: messages.length > 0 ? { messages } : null,
    messages,
  };
}

function extractKimiErrorMessages(parsed: Record<string, unknown>): string[] {
  const messages: string[] = [];

  // Check for error field
  const error = asString(parsed.error, "");
  if (error) messages.push(error);

  // Check for errors array
  const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
  for (const entry of errors) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
    } else if (typeof entry === "object" && entry !== null) {
      const obj = entry as Record<string, unknown>;
      const msg = asString(obj.message, "") || asString(obj.error, "") || asString(obj.code, "");
      if (msg) messages.push(msg);
    }
  }

  return messages;
}

export function extractKimiSessionId(stdout: string): string | null {
  // Look for "To resume this session: kimi -r <session-id>"
  const match = stdout.match(/kimi\s+(?:-r|--resume)\s+([a-f0-9-]+)/i);
  if (match) return match[1];

  // Also try to find UUID pattern in output
  const uuidMatch = stdout.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  return uuidMatch ? uuidMatch[1] : null;
}

export function detectKimiLoginRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean; loginUrl: string | null } {
  const resultText = asString(input.parsed?.result, "").trim();
  const messages = [resultText, ...extractKimiErrorMessages(input.parsed ?? {}), input.stdout, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const requiresLogin = messages.some((line) => KIMI_AUTH_REQUIRED_RE.test(line));

  // Kimi OAuth doesn't provide a direct URL in output
  return {
    requiresLogin,
    loginUrl: requiresLogin ? "https://kimi.com/login" : null,
  };
}

export function describeKimiFailure(parsed: Record<string, unknown>): string | null {
  const error = asString(parsed.error, "").trim();
  const errors = extractKimiErrorMessages(parsed);

  let detail = error;
  if (!detail && errors.length > 0) {
    detail = errors[0] ?? "";
  }

  const parts = ["Kimi run failed"];
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

export function isKimiMaxTurnsResult(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;

  const resultText = asString(parsed.result, "").trim().toLowerCase();
  return /max(?:imum)?\s+steps?/i.test(resultText);
}

export function isKimiUnknownSessionError(stdout: string, stderr: string): boolean {
  const allText = `${stdout}\n${stderr}`.toLowerCase();
  return /no\s+(?:session|conversation)\s+found|session\s+not\s+found|invalid\s+session/i.test(allText);
}
