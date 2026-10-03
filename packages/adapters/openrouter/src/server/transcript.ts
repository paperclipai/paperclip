/**
 * Typed TranscriptEntry emitters.
 *
 * Paperclip's run viewer expects each transcript entry as a single-line JSON
 * object on stdout. The UI's parseStdout module turns those lines into
 * TranscriptEntry objects (see adapter-utils/types.ts).
 *
 * Every emit() call writes exactly one line ending in "\n".
 *
 * Why a wrapper instead of inline JSON.stringify everywhere:
 *   - guarantees the entry shape matches the discriminated union
 *   - one place to add tracing / debug prefixes later
 *   - prevents accidentally splitting an entry across two onLog calls
 */

import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export type OnLog = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

function nowIso(): string {
  return new Date().toISOString();
}

async function emit(onLog: OnLog, entry: TranscriptEntry): Promise<void> {
  await onLog("stdout", `${JSON.stringify(entry)}\n`);
}

export async function emitInit(
  onLog: OnLog,
  params: { model: string; sessionId: string },
): Promise<void> {
  await emit(onLog, {
    kind: "init",
    ts: nowIso(),
    model: params.model,
    sessionId: params.sessionId,
  });
}

export async function emitAssistant(
  onLog: OnLog,
  text: string,
  opts: { delta?: boolean } = {},
): Promise<void> {
  await emit(onLog, {
    kind: "assistant",
    ts: nowIso(),
    text,
    delta: opts.delta ?? false,
  });
}

export async function emitThinking(
  onLog: OnLog,
  text: string,
  opts: { delta?: boolean } = {},
): Promise<void> {
  await emit(onLog, {
    kind: "thinking",
    ts: nowIso(),
    text,
    delta: opts.delta ?? false,
  });
}

export async function emitToolCall(
  onLog: OnLog,
  params: { name: string; input: unknown; toolUseId?: string },
): Promise<void> {
  await emit(onLog, {
    kind: "tool_call",
    ts: nowIso(),
    name: params.name,
    input: params.input,
    toolUseId: params.toolUseId,
  });
}

export async function emitToolResult(
  onLog: OnLog,
  params: { toolUseId: string; toolName?: string; content: string; isError: boolean },
): Promise<void> {
  await emit(onLog, {
    kind: "tool_result",
    ts: nowIso(),
    toolUseId: params.toolUseId,
    toolName: params.toolName,
    content: params.content,
    isError: params.isError,
  });
}

export async function emitResult(
  onLog: OnLog,
  params: {
    text: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    costUsd?: number;
    subtype?: string;
    isError?: boolean;
    errors?: string[];
  },
): Promise<void> {
  await emit(onLog, {
    kind: "result",
    ts: nowIso(),
    text: params.text,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    cachedTokens: params.cachedTokens ?? 0,
    costUsd: params.costUsd ?? 0,
    subtype: params.subtype ?? "success",
    isError: params.isError ?? false,
    errors: params.errors ?? [],
  });
}

export async function emitSystem(onLog: OnLog, text: string): Promise<void> {
  await emit(onLog, { kind: "system", ts: nowIso(), text });
}

export async function emitStderr(onLog: OnLog, text: string): Promise<void> {
  // stderr entries also live in the transcript union; they go on stdout as JSON
  // (the actual stderr stream is reserved for raw adapter diagnostics).
  await emit(onLog, { kind: "stderr", ts: nowIso(), text });
}

/**
 * Raw stderr write — bypasses the JSON envelope. Use for adapter-level
 * diagnostics that should appear in the run log but not in the transcript.
 */
export async function writeRawStderr(onLog: OnLog, text: string): Promise<void> {
  await onLog("stderr", text.endsWith("\n") ? text : `${text}\n`);
}
