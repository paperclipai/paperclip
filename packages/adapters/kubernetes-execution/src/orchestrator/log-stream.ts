import type { KubernetesApiClient } from "../types.js";

/**
 * Streams logs from a Pod's container via `pods/log?follow=true&timestamps=true`,
 * line-buffers the response, strips the leading RFC3339 timestamp, and forwards
 * each line to `onLog`. Reconnects automatically using `sinceTime=<lastTimestamp>`
 * so we don't double-buffer on transient server-side closes.
 *
 * The handle's `done` Promise resolves once the loop exits (after `abort()`).
 */
export interface LogStreamHandle {
  abort(): void;
  done: Promise<void>;
}

export interface StartLogStreamInput {
  client: KubernetesApiClient;
  namespace: string;
  podName: string;
  containerName: string;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

export function startLogStream(input: StartLogStreamInput): LogStreamHandle {
  const controller = new AbortController();
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });

  const start = async () => {
    let lastTimestamp: string | undefined;
    while (!controller.signal.aborted) {
      try {
        const path =
          `/api/v1/namespaces/${encodeURIComponent(input.namespace)}/pods/${encodeURIComponent(input.podName)}/log` +
          `?container=${encodeURIComponent(input.containerName)}&follow=true&timestamps=true` +
          (lastTimestamp ? `&sinceTime=${encodeURIComponent(lastTimestamp)}` : "");
        const response = await input.client.requestStream("GET", path);
        if (!response.ok || !response.body) break;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
          // stream:true preserves partial UTF-8 sequences across chunk boundaries.
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const sep = line.indexOf(" ");
            if (sep > 0) {
              const ts = line.slice(0, sep);
              lastTimestamp = ts;
              await input.onLog("stdout", line.slice(sep + 1));
            } else if (line.length > 0) {
              await input.onLog("stdout", line);
            }
          }
        }
        if (controller.signal.aborted) break;
        // Stream ended cleanly but pod may still be running — back off and reconnect.
        await new Promise((r) => setTimeout(r, 500));
      } catch {
        if (controller.signal.aborted) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    resolveDone();
  };

  // Kick off in the background; the loop above handles its own errors and reconnects.
  start().catch(() => {
    /* swallow; abort path always resolves done */
  });

  return {
    abort: () => controller.abort(),
    done,
  };
}
