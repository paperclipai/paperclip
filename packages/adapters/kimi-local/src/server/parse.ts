import { asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

export interface ParsedKimiJsonl {
  sessionId: string | null;
  summary: string;
  errorMessage: string | null;
  stopReason: string | null;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message =
    asString(rec?.message, "").trim() ||
    asString(rec?.error, "").trim() ||
    asString(rec?.detail, "").trim() ||
    asString(rec?.code, "").trim();
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

const SESSION_HINT_RE = /To resume this session:\s*kimi\s+-r\s+(\S+)/i;

export function parseKimiJsonl(stdout: string): ParsedKimiJsonl {
  let sessionId: string | null = null;
  let stopReason: string | null = null;
  let errorMessage: string | null = null;
  const textParts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // Extract session hint from plain text lines
    const hintMatch = SESSION_HINT_RE.exec(line);
    if (hintMatch?.[1]) {
      sessionId = hintMatch[1].trim();
      continue;
    }

    const event = parseJson(line);
    if (!event) {
      // Non-JSON line — could be plain text output or error
      textParts.push(line);
      continue;
    }

    const role = asString(event.role, "").trim();

    if (role === "assistant") {
      const content = event.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          const rec = parseObject(item);
          if (!rec) continue;
          const type = asString(rec.type, "").trim();
          if (type === "text") {
            const text = asString(rec.text, "");
            if (text) textParts.push(text);
          }
        }
      } else {
        const text = asString(content, "");
        if (text) textParts.push(text);
      }
      continue;
    }

    if (role === "tool") {
      const rawContent = event.content;
      if (Array.isArray(rawContent)) {
        const texts: string[] = [];
        for (const item of rawContent) {
          const rec = parseObject(item);
          if (!rec) continue;
          const type = asString(rec.type, "").trim();
          if (type === "text") {
            const text = asString(rec.text, "");
            if (text) texts.push(text);
          }
        }
        if (texts.length > 0) textParts.push(`[tool result] ${texts.join("")}`);
      } else {
        const content = asString(rawContent, "");
        if (content) textParts.push(`[tool result] ${content}`);
      }
      continue;
    }

    if (role === "error" || event.error) {
      const text = errorText(event.error ?? event.message ?? event.detail ?? event.content).trim();
      if (text) errorMessage = text;
    }

    // Capture stop reason from result/done/finish events when present
    const maybeStop =
      asString(event.stop_reason, "").trim() ||
      asString(event.finish_reason, "").trim() ||
      asString(event.stopReason, "").trim();
    if (maybeStop) stopReason = maybeStop;
  }

  return {
    sessionId,
    summary: textParts.join("").trim(),
    errorMessage,
    stopReason,
  };
}

export function isKimiUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session(?:\s+.*)?\s+not\s+found|resume\s+.*\s+not\s+found|invalid\s+session/i.test(haystack);
}
