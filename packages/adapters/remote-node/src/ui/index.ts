import type { CreateConfigValues, TranscriptEntry } from "@paperclipai/adapter-utils";

/**
 * Parse a single stdout line from the remote node adapter.
 * Remote node logs are relayed from the runner in JSON-line format,
 * same as claude_local. Fall back to plain stdout entry.
 */
export function parseRemoteNodeStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (obj.type === "system" && typeof obj.message === "string") {
      return [{ kind: "system", ts, text: obj.message }];
    }
    // Pass through structured events from the local adapter running on the node
    if (obj.type === "assistant" && typeof obj.message === "string") {
      return [{ kind: "assistant", ts, text: obj.message }];
    }
    return [{ kind: "stdout", ts, text: trimmed }];
  } catch {
    return [{ kind: "stdout", ts, text: trimmed }];
  }
}

export function buildRemoteNodeConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  // nodeId would be set from the config fields component
  const raw = v as unknown as Record<string, unknown>;
  if (raw.nodeId) ac.nodeId = raw.nodeId;
  if (v.model) ac.localAdapterConfig = { model: v.model };
  return ac;
}
