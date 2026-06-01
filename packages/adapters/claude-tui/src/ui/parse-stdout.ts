import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Translate the adapter's `claude_tui.*` envelope lines (emitted from
 * src/server/execute.ts) into TranscriptEntry records the Paperclip UI knows
 * how to render. Anything we don't recognize falls back to a plain `stdout`
 * entry so it remains visible.
 */
export function parseClaudeTuiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }
  const type = asString(parsed.type);

  if (type === "claude_tui.init") {
    return [
      {
        kind: "init",
        ts,
        model: asString(parsed.model, "unknown"),
        sessionId: asString(parsed.sessionId),
      },
    ];
  }

  if (type === "claude_tui.chunk") {
    const text = asString(parsed.text);
    if (!text) return [];
    return [{ kind: "assistant", ts, text, delta: true }];
  }

  if (type === "claude_tui.turn_start") {
    const prompt = asString(parsed.prompt);
    if (!prompt) return [];
    return [{ kind: "user", ts, text: prompt }];
  }

  if (type === "claude_tui.turn_end") {
    const responseText = asString(parsed.responseText);
    const usagePct = parsed.usagePct;
    // The TUI doesn't expose token counts — leave them at 0 and let the
    // result entry's text carry the human-readable summary (incl. usage_pct).
    const usagePctText =
      typeof usagePct === "number" && Number.isFinite(usagePct)
        ? ` (usage_pct=${usagePct.toFixed(1)})`
        : "";
    return [
      {
        kind: "result",
        ts,
        text: `${responseText}${usagePctText}`.trim(),
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: asString(parsed.exitReason, "turn_end"),
        isError: false,
        errors: [],
      },
    ];
  }

  if (type === "claude_tui.modal") {
    const kind = asString(parsed.kind);
    const action = asString(parsed.action);
    const keySent = asString(parsed.keySent);
    return [
      {
        kind: "system",
        ts,
        text: `modal: ${kind} → ${action}${keySent ? ` (key=${keySent})` : ""}`,
      },
    ];
  }

  if (type === "claude_tui.exit") {
    const reason = asString(parsed.reason);
    const detail = asString(parsed.detail);
    return [
      {
        kind: "system",
        ts,
        text: `exit: ${reason}${detail ? ` — ${detail}` : ""}`,
      },
    ];
  }

  // Keep token-shape compatibility with the standard result kind for the
  // (unlikely) case that the Python driver decides to send one directly.
  if (type === "claude_tui.result") {
    return [
      {
        kind: "result",
        ts,
        text: asString(parsed.text),
        inputTokens: asNumber(parsed.inputTokens),
        outputTokens: asNumber(parsed.outputTokens),
        cachedTokens: asNumber(parsed.cachedTokens),
        costUsd: asNumber(parsed.costUsd),
        subtype: asString(parsed.subtype, "result"),
        isError: parsed.isError === true,
        errors: Array.isArray(parsed.errors)
          ? parsed.errors.filter((value): value is string => typeof value === "string")
          : [],
      },
    ];
  }

  return [{ kind: "stdout", ts, text: line }];
}
