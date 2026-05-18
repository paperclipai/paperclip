import { isDroppableDeltaLine, rewriteToolResultLine } from "../pi-event-types.js";

export type LogStream = "stdout" | "stderr";
export type OnLog = (stream: LogStream, chunk: string) => Promise<void>;

/**
 * Hard cap on the partial-line buffer. pi-coding-agent NDJSON lines are
 * typically <100KB, but bash/shell `tool_execution_end` lines can carry
 * tens of MB of captured stdout, and accumulated-state delta lines have
 * been observed at ~46MB. We must let those lines fully accumulate so the
 * per-line filter (rewriteToolResultLine) can truncate them to 80KB head+tail
 * before they hit disk; the cap is only a defense-in-depth backstop against
 * a genuinely unbounded line. 64MB accommodates the realistic worst-case
 * tool result while keeping memory bounded.
 */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

export interface BufferedOnLogHandle {
  /**
   * Receive a raw chunk of stdout/stderr from a child process. stdout chunks
   * are buffered by line; stderr chunks pass through immediately. Each
   * complete stdout line is forwarded to the provided onLog unless it is an
   * accumulated-state delta event (see isDroppableDeltaLine).
   *
   * Calls are internally serialized — concurrent invocations queue behind
   * the in-flight one, so callers don't need to await before invoking again
   * and `stdoutBuffer` is never mutated by two stacks at once. `flush`
   * waits for any pending handle work before draining the trailing fragment.
   */
  handle: OnLog;
  /**
   * Flush any trailing partial line that did not end with a newline. Called
   * after the child process exits to avoid losing the final fragment.
   * Bypasses the delta filter — partial lines fail JSON.parse anyway and we
   * prefer keeping data over silent truncation.
   */
  flush: () => Promise<void>;
}

/**
 * Builds a buffered onLog wrapper that:
 *   1. Splits child-process stdout into newline-delimited lines.
 *   2. Drops accumulated-state delta `message_update` events (see
 *      isDroppableDeltaLine and parse.ts's PI_DELTA).
 *   3. Forwards stderr chunks through unchanged.
 *
 * Stateful (holds the partial-line buffer); create one per child process.
 */
export function createBufferedOnLog(onLog: OnLog): BufferedOnLogHandle {
  let stdoutBuffer = "";
  // Promise chain that serializes handle + flush calls. Production callers
  // (runChildProcess) already serialize via their own logChain, but tests
  // and future callers should not need to know that — the helper enforces
  // its own invariant so concurrent calls cannot interleave buffer state.
  let queue: Promise<void> = Promise.resolve();

  const processStdoutChunk = async (chunk: string): Promise<void> => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    // Drain any complete lines first so a single batched stdout call (e.g.
    // sandbox runners that forward `result.stdout` in one piece) does not
    // trip the cap on the aggregate buffer and lose the whole transcript.
    stdoutBuffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      if (!rawLine) continue;
      if (isDroppableDeltaLine(rawLine)) continue;
      // Truncate large bash/tool result bodies and strip the duplicate copy
      // carried in `turn_end.toolResults` — both unfiltered today, both bloat
      // the persisted log on any verbose shell tool call.
      const line = rewriteToolResultLine(rawLine);
      await onLog("stdout", line + "\n");
    }

    // Apply the cap only to the trailing partial fragment. A single line
    // exceeding MAX_LINE_BYTES means pi-agent emitted an unbounded line
    // without a newline — drop it and alarm rather than risk OOM.
    if (stdoutBuffer.length > MAX_LINE_BYTES) {
      const dropped = stdoutBuffer.length;
      stdoutBuffer = "";
      await onLog(
        "stderr",
        `[paperclip] dropped ${dropped} bytes from pi stdout buffer (no newline within ${MAX_LINE_BYTES} bytes)\n`,
      );
    }
  };

  const handle: OnLog = (stream, chunk) => {
    queue = queue.then(async () => {
      if (stream === "stderr") {
        await onLog(stream, chunk);
        return;
      }
      await processStdoutChunk(chunk);
    });
    return queue;
  };

  const flush = (): Promise<void> => {
    queue = queue.then(async () => {
      if (stdoutBuffer) {
        await onLog("stdout", stdoutBuffer);
        stdoutBuffer = "";
      }
    });
    return queue;
  };

  return { handle, flush };
}
