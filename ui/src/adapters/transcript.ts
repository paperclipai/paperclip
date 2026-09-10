import { redactHomePathUserSegments, redactTranscriptEntryPaths } from "@paperclipai/adapter-utils";
import type { TranscriptEntry, StdoutLineParser, TranscriptParserSource } from "./types";

export type RunLogChunk = { ts: string; stream: "stdout" | "stderr" | "system"; chunk: string; seq?: number };
type TranscriptBuildOptions = { censorUsernameInLogs?: boolean };
type RedactionOptions = { enabled: boolean };

function resolveStdoutParser(source: StdoutLineParser | TranscriptParserSource) {
  if (typeof source === "function") {
    return { parseLine: source, reset: null as (() => void) | null };
  }
  if (source.createStdoutParser) {
    const parser = source.createStdoutParser();
    return { parseLine: parser.parseLine, reset: parser.reset };
  }
  return { parseLine: source.parseStdoutLine, reset: null as (() => void) | null };
}

export function appendTranscriptEntry(entries: TranscriptEntry[], entry: TranscriptEntry) {
  if (entry.kind === "thinking" || entry.kind === "assistant") {
    if (entry.itemId !== undefined) {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const previous = entries[index];
        if (
          !previous ||
          previous.kind !== entry.kind ||
          previous.itemId !== entry.itemId ||
          previous.channel !== entry.channel
        ) {
          continue;
        }

        if (entry.delta) {
          previous.text += entry.text;
          previous.ts = entry.ts;
          previous.delta = true;
          if (previous.kind === "thinking" && entry.kind === "thinking" && entry.lifecycle) {
            previous.lifecycle = entry.lifecycle;
          }
        } else {
          entries[index] = { ...entry, text: entry.text || previous.text };
        }
        return;
      }
    }

    if (entry.delta && entry.itemId === undefined) {
      const last = entries[entries.length - 1];
      if (
        last &&
        last.kind === entry.kind &&
        last.delta &&
        last.itemId === undefined &&
        last.channel === entry.channel
      ) {
        last.text += entry.text;
        last.ts = entry.ts;
        return;
      }
    }
  }
  entries.push(entry);
}

export function appendTranscriptEntries(entries: TranscriptEntry[], incoming: TranscriptEntry[]) {
  for (const entry of incoming) {
    appendTranscriptEntry(entries, entry);
  }
}

function truncateTranscriptLine(line: string, maxLength = 160) {
  if (line.length <= maxLength) return line;
  return `${line.slice(0, maxLength - 3)}...`;
}

function formatTranscriptParserError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function createTranscriptParseErrorEntry(
  line: string,
  ts: string,
  error: unknown,
  redactionOptions: RedactionOptions,
): TranscriptEntry {
  const errorText = formatTranscriptParserError(error) || "unknown parser error";
  const preview = truncateTranscriptLine(line);
  return {
    kind: "result",
    ts,
    text: redactHomePathUserSegments(
      `Chat transcript error: ${errorText}. Falling back for line: ${preview}`,
      redactionOptions,
    ),
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    subtype: "transcript_parse_error",
    isError: true,
    errors: [],
  };
}

function appendParsedTranscriptLine(args: {
  entries: TranscriptEntry[];
  line: string;
  ts: string;
  parseLine: (line: string, ts: string) => TranscriptEntry[];
  reset: (() => void) | null;
  redactionOptions: RedactionOptions;
}) {
  const { entries, line, ts, parseLine, reset, redactionOptions } = args;
  try {
    appendTranscriptEntries(
      entries,
      parseLine(line, ts).map((entry) => redactTranscriptEntryPaths(entry, redactionOptions)),
    );
  } catch (error) {
    reset?.();
    appendTranscriptEntry(entries, createTranscriptParseErrorEntry(line, ts, error, redactionOptions));
  }
}

export function buildTranscript(
  chunks: RunLogChunk[],
  parserSource: StdoutLineParser | TranscriptParserSource,
  opts?: TranscriptBuildOptions,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let stdoutBuffer = "";
  const redactionOptions = { enabled: opts?.censorUsernameInLogs ?? false };
  const { parseLine, reset } = resolveStdoutParser(parserSource);

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
      appendParsedTranscriptLine({
        entries,
        line: trimmed,
        ts: chunk.ts,
        parseLine,
        reset,
        redactionOptions,
      });
    }
  }

  const trailing = stdoutBuffer.trim();
  if (trailing) {
    const ts = chunks.length > 0 ? chunks[chunks.length - 1]!.ts : new Date().toISOString();
    appendParsedTranscriptLine({
      entries,
      line: trailing,
      ts,
      parseLine,
      reset,
      redactionOptions,
    });
  }

  reset?.();

  return entries;
}
