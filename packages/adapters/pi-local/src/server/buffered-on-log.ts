import { isDroppableDeltaLine } from "./parse.js";

export type LogStream = "stdout" | "stderr";
export type OnLog = (stream: LogStream, chunk: string) => Promise<void>;

export interface BufferedOnLogHandle {
  /**
   * Receive a raw chunk of stdout/stderr from a child process. stdout chunks
   * are buffered by line; stderr chunks pass through immediately. Each
   * complete stdout line is forwarded to the provided onLog unless it is an
   * accumulated-state delta event (see isDroppableDeltaLine).
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

  const handle: OnLog = async (stream, chunk) => {
    if (stream === "stderr") {
      // Pass stderr through immediately (not JSONL).
      await onLog(stream, chunk);
      return;
    }

    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line) continue;
      if (isDroppableDeltaLine(line)) continue;
      await onLog(stream, line + "\n");
    }
  };

  const flush = async () => {
    if (stdoutBuffer) {
      await onLog("stdout", stdoutBuffer);
      stdoutBuffer = "";
    }
  };

  return { handle, flush };
}
