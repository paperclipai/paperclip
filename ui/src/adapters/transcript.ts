import type { TranscriptEntry, StdoutLineParser } from "./types";

type RunLogChunk = { ts: string; stream: "stdout" | "stderr" | "system"; chunk: string };

export function buildTranscript(chunks: RunLogChunk[], parser: StdoutLineParser): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let stdoutBuffer = "";

  for (const chunk of chunks) {
    if (chunk.stream === "stderr") {
      entries.push({ kind: "stderr", ts: chunk.ts, text: chunk.chunk });
      continue;
    }
    if (chunk.stream === "system") {
      entries.push({ kind: "system", ts: chunk.ts, text: chunk.chunk });
      continue;
    }

    const combined = stdoutBuffer + chunk.chunk;
    const lines = combined.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      entries.push(...parser(trimmed, chunk.ts));
    }
  }

  const trailing = stdoutBuffer.trim();
  if (trailing) {
    const ts = chunks.length > 0 ? chunks[chunks.length - 1]!.ts : new Date().toISOString();
    entries.push(...parser(trailing, ts));
  }

  return entries;
}
