import { asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { applyTurnBoundary, createTurnBoundaryState } from "../shared/turn-boundary.js";

export interface ParsedGrokJsonl {
  sessionId: string | null;
  summary: string;
  thought: string;
  errorMessage: string | null;
  stopReason: string | null;
  requestId: string | null;
  disposition: {
    status: string;
    hasBlocker: boolean;
    blocker?: string;
    reviewer?: string;
  } | null;
}

const PAPERCLIP_DISPOSITION_RE = /(?:^|\n)\s*`?PAPERCLIP_DISPOSITION\s*:?\s*(\{[^\n]*\})`?\s*(?=$|\n)/g;

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

function extractPaperclipDisposition(text: string): {
  disposition: ParsedGrokJsonl["disposition"];
  cleanedText: string;
} {
  let match: RegExpExecArray | null = null;
  let lastValid:
    | {
        disposition: NonNullable<ParsedGrokJsonl["disposition"]>;
        index: number;
        fullMatch: string;
      }
    | null = null;

  while ((match = PAPERCLIP_DISPOSITION_RE.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1] ?? "null") as Record<string, unknown> | null;
      const status = typeof parsed?.status === "string" ? parsed.status.trim() : "";
      if (!status) continue;
      lastValid = {
        disposition: {
          status,
          hasBlocker: parsed?.hasBlocker === true,
          ...(typeof parsed?.blocker === "string" && parsed.blocker.trim().length > 0
            ? { blocker: parsed.blocker.trim() }
            : {}),
          ...(typeof parsed?.reviewer === "string" && parsed.reviewer.trim().length > 0
            ? { reviewer: parsed.reviewer.trim() }
            : {}),
        },
        index: match.index,
        fullMatch: match[0],
      };
    } catch {
      continue;
    }
  }

  if (!lastValid) {
    return { disposition: null, cleanedText: text.trim() };
  }

  const cleanedText = `${text.slice(0, lastValid.index)}${text.slice(lastValid.index + lastValid.fullMatch.length)}`
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    disposition: lastValid.disposition,
    cleanedText,
  };
}

export function parseGrokJsonl(stdout: string): ParsedGrokJsonl {
  let sessionId: string | null = null;
  let stopReason: string | null = null;
  let requestId: string | null = null;
  let errorMessage: string | null = null;
  const thoughtParts: string[] = [];
  const textParts: string[] = [];
  const thoughtBoundary = createTurnBoundaryState();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "").trim();
    if (type === "thought") {
      const text = asString(event.data, "");
      if (text) thoughtParts.push(applyTurnBoundary(thoughtBoundary, text));
      continue;
    }

    if (type === "text") {
      const text = asString(event.data, "");
      if (text) textParts.push(text);
      continue;
    }

    if (type === "end") {
      sessionId = asString(event.sessionId, "").trim() || sessionId;
      stopReason = asString(event.stopReason, "").trim() || stopReason;
      requestId = asString(event.requestId, "").trim() || requestId;
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message ?? event.detail ?? event.data).trim();
      if (text) errorMessage = text;
    }
  }

  const { disposition, cleanedText } = extractPaperclipDisposition(textParts.join("").trim());

  return {
    sessionId,
    summary: cleanedText,
    thought: thoughtParts.join("").trim(),
    errorMessage,
    stopReason,
    requestId,
    disposition,
  };
}

export function isGrokUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session(?:\s+.*)?\s+not\s+found|resume\s+.*\s+not\s+found|invalid\s+session/i.test(haystack);
}
