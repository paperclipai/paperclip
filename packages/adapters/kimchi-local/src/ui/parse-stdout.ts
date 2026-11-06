import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { parseAcpxStdoutLine } from "@paperclipai/adapter-utils/acpx-engine/ui";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Map one kimchi_local stdout line to transcript entries. kimchi_local is
 * ACP-only, so runs emit acpx.* events (streaming text deltas, tool-call
 * status lifecycle) handled by the shared acpx transcript parser; anything
 * else the engine echoes (plain text, an error line) falls back to raw
 * stdout/stderr entries.
 */
export function parseKimchiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (parsed && asString(parsed.type).startsWith("acpx.")) {
    return parseAcpxStdoutLine(line, ts);
  }

  if (parsed && (asString(parsed.type).trim().toLowerCase() === "error" || asString(parsed.role).trim().toLowerCase() === "error")) {
    const text =
      asString(parsed.content) ||
      asString(parsed.message) ||
      asString(parsed.error) ||
      "Kimchi error";
    return [{ kind: "stderr", ts, text }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
