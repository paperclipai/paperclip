import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { normalizeNanoClawGatewayStreamLine } from "../shared/stream.js";

export function parseNanoClawGatewayStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const normalized = normalizeNanoClawGatewayStreamLine(line);
  if (normalized.stream === "stderr") {
    return [{ kind: "stderr", ts, text: normalized.line }];
  }

  const trimmed = normalized.line.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[nanoclaw-gateway]")) {
    return [{ kind: "system", ts, text: trimmed.replace(/^\[nanoclaw-gateway\]\s*/, "") }];
  }

  return [{ kind: "stdout", ts, text: normalized.line }];
}
