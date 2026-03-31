import { redactHomePathUserSegments, redactTranscriptEntryPaths } from "@paperclipai/adapter-utils";
import type { TranscriptEntry, StdoutLineParser } from "./types";

export type RunLogChunk = { ts: string; stream: "stdout" | "stderr" | "system"; chunk: string };
type TranscriptBuildOptions = { censorUsernameInLogs?: boolean };

export function appendTranscriptEntry(entries: TranscriptEntry[], entry: TranscriptEntry) {
  if ((entry.kind === "thinking" || entry.kind === "assistant") && entry.delta) {
    const last = entries[entries.length - 1];
    if (last && last.kind === entry.kind && last.delta) {
      last.text += entry.text;
      last.ts = entry.ts;
      return;
    }
  }
  entries.push(entry);
}

export function appendTranscriptEntries(entries: TranscriptEntry[], incoming: TranscriptEntry[]) {
  for (const entry of incoming) {
    appendTranscriptEntry(entries, entry);
  }
}

export function buildTranscript(
  chunks: RunLogChunk[],
  parser: StdoutLineParser,
  opts?: TranscriptBuildOptions,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let stdoutBuffer = "";
  const redactionOptions = { enabled: opts?.censorUsernameInLogs ?? false };

  for (const chunk of chunks) {
    if (chunk.stream === "stderr") {
      entries.push({ kind: "stderr", ts: chunk.ts, text: redactHomePathUserSegments(chunk.chunk, redactionOptions) });
      continue;
    }
    if (chunk.stream === "system") {
      entries.push({ kind: "system", ts: chunk.ts, text: redactHomePathUserSegments(chunk.chunk, redactionOptions) });
      continue;
    }

    const combined = stdoutBuffer + chunk.chunk;
    const lines = combined.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      appendTranscriptEntries(entries, parser(trimmed, chunk.ts).map((entry) => redactTranscriptEntryPaths(entry, redactionOptions)));
    }
  }

  const trailing = stdoutBuffer.trim();
  if (trailing) {
    const ts = chunks.length > 0 ? chunks[chunks.length - 1]!.ts : new Date().toISOString();
    appendTranscriptEntries(entries, parser(trailing, ts).map((entry) => redactTranscriptEntryPaths(entry, redactionOptions)));
  }

  return entries;
}
