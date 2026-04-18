interface TranscriptEntry {
  kind: string;
  ts: string;
  text?: string;
  delta?: boolean;
  name?: string;
  input?: unknown;
  toolUseId?: string;
  toolName?: string;
  content?: string;
  isError?: boolean;
}

export function createStdoutParser() {
  function parseLine(line: string, ts: string): TranscriptEntry[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    // Try JSON parse for structured events
    if (trimmed.startsWith("{")) {
      try {
        const event = JSON.parse(trimmed);
        if (event && typeof event === "object" && typeof event.kind === "string") {
          return [{ ...event, ts }];
        }
      } catch {
        // Not valid JSON — fall through
      }
    }

    return [{ kind: "assistant", ts, text: trimmed, delta: true }];
  }

  function reset() {
    // No state to reset
  }

  return { parseLine, reset };
}
