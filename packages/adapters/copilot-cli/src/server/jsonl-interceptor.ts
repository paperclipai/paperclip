export type LogFn = (stream: "stdout" | "stderr", text: string) => Promise<void>;

export interface JsonlLogInterceptor {
  /** Feed a raw output chunk from runChildProcess onLog into the interceptor. */
  onChunk: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  /**
   * Flush any buffered content that did not end with a newline.
   * Call once after runChildProcess resolves.
   */
  flush: () => Promise<void>;
}

/**
 * Create a line-buffered JSONL log interceptor.
 *
 * The interceptor wraps an outer `onLog` function so that:
 * - stderr (and any non-stdout stream) is passed through unchanged.
 * - stdout chunks are line-buffered; each complete line is forwarded as-is
 *   to `onLog`, preserving the raw JSONL for client-side parsing by
 *   parse-stdout.ts (which produces the structured "Nice" transcript view).
 * - Empty lines are suppressed.
 *
 * After runChildProcess resolves, call `flush()` to emit any trailing content
 * that was not terminated by a newline.
 */
export function createJsonlLogInterceptor(onLog: LogFn): JsonlLogInterceptor {
  let buffer = "";

  return {
    async onChunk(stream, chunk) {
      if (stream !== "stdout") {
        await onLog(stream, chunk);
        return;
      }
      const combined = buffer + chunk;
      const lines = combined.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line) {
          await onLog("stdout", line + "\n");
        }
      }
    },

    async flush() {
      if (buffer) {
        const trimmed = buffer.trim();
        if (trimmed) {
          await onLog("stdout", buffer + "\n");
        }
        buffer = "";
      }
    },
  };
}
