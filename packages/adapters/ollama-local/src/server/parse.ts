/**
 * NDJSON parser for Ollama /api/chat streams.
 *
 * Contract (verified in M0 spike — see GEM-6 comment):
 *   - Each frame shape: { model, created_at, message:{role,content}, done,
 *     done_reason?, total_duration, load_duration, prompt_eval_count,
 *     prompt_eval_duration, eval_count, eval_duration }
 *   - Durations are nanoseconds.
 *   - Partial JSON across chunk boundaries is the norm, not an edge case.
 *     A line buffer that flushes only on "\n" is mandatory.
 *   - Empty lines between frames must be skipped.
 *   - On the final frame, `done:true` and (usually) a `done_reason`.
 */

import type { UsageSummary } from "@paperclipai/adapter-utils";

export interface OllamaChatFinalFrame {
  model?: string;
  created_at?: string;
  done: true;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  message?: { role?: string; content?: string };
}

export interface OllamaChatDeltaFrame {
  model?: string;
  created_at?: string;
  done: false;
  message: { role?: string; content?: string };
}

export type OllamaChatFrame = OllamaChatDeltaFrame | OllamaChatFinalFrame;

export interface ParsedOllamaStream {
  assistantText: string;
  finalFrame: OllamaChatFinalFrame | null;
  frameCount: number;
  parseErrorCount: number;
  truncated: boolean;
  /** Compact usage summary for AdapterExecutionResult. */
  usage?: UsageSummary;
}

/**
 * Yield newline-terminated lines from a streaming byte source. Handles
 * multi-byte UTF-8 across chunk boundaries via TextDecoder({stream:true}) and
 * buffers partial lines until a "\n" is seen. Blank lines are skipped.
 */
export async function* ollamaNdjsonLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) {
        const tail = buffer.trim();
        if (tail) yield tail;
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) yield line;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function parseFrame(line: string): OllamaChatFrame | null {
  try {
    const obj = JSON.parse(line);
    if (obj && typeof obj === "object") return obj as OllamaChatFrame;
    return null;
  } catch {
    return null;
  }
}

/**
 * Iterate an Ollama /api/chat response stream, accumulating the assistant
 * message, counting frames, and extracting the final metadata frame.
 *
 * @param body Response body stream from fetch().
 * @param signal Optional AbortSignal; checked before each read.
 * @param contextWindow Configured num_ctx; used to detect silent truncation
 *                      (Ollama does not emit a dedicated overflow frame).
 * @param onDelta Optional callback for incremental assistant content.
 */
export async function parseOllamaChatStream(
  body: ReadableStream<Uint8Array>,
  options: {
    signal?: AbortSignal;
    contextWindow?: number;
    onDelta?: (piece: string) => void | Promise<void>;
  } = {},
): Promise<ParsedOllamaStream> {
  let assistantText = "";
  let finalFrame: OllamaChatFinalFrame | null = null;
  let frameCount = 0;
  let parseErrorCount = 0;

  for await (const line of ollamaNdjsonLines(body, options.signal)) {
    frameCount += 1;
    const frame = parseFrame(line);
    if (!frame) {
      parseErrorCount += 1;
      continue;
    }
    const piece = frame.message?.content ?? "";
    if (piece) {
      assistantText += piece;
      if (options.onDelta) await options.onDelta(piece);
    }
    if (frame.done === true) {
      finalFrame = frame;
    }
  }

  const promptEvalCount = finalFrame?.prompt_eval_count ?? 0;
  const evalCount = finalFrame?.eval_count ?? 0;
  const truncated =
    typeof options.contextWindow === "number" &&
    options.contextWindow > 0 &&
    promptEvalCount >= options.contextWindow;

  return {
    assistantText,
    finalFrame,
    frameCount,
    parseErrorCount,
    truncated,
    usage:
      promptEvalCount > 0 || evalCount > 0
        ? {
            inputTokens: promptEvalCount,
            outputTokens: evalCount,
          }
        : undefined,
  };
}
