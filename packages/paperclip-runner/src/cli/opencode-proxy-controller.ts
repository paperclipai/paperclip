import type { OpenCodeProxyFrameOptions } from "./opencode-proxy-output.js";

type Waiter = { resolve(value: unknown): void; reject(error: Error): void; retainEnvelope: boolean };

export function abandonedToolCallError(): Error {
  return new Error(
    "Paperclip tool call was abandoned by the MCP client before it was dispatched; it did not run.",
  );
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Requests the proxy sends to its runnerd controller, and their responses.
 *
 * A request with a signal stays withdrawable while its frame is still queued
 * in this process. Once written, it belongs to runnerd and its response is
 * awaited even if the MCP client leaves.
 */
export function createOpenCodeProxyControllerRequests(
  send: (frame: unknown, options?: OpenCodeProxyFrameOptions) => void,
) {
  const pending = new Map<string, Waiter>();
  let inputClosed = false;
  let nextId = 1;
  const rejectAll = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  return {
    request(method: string, params: unknown, retainEnvelope = false, signal?: AbortSignal): Promise<unknown> {
      if (inputClosed) return Promise.reject(new Error("OpenCode controller input is closed"));
      if (signal?.aborted) return Promise.reject(abandonedToolCallError());
      const id = `opencode-${nextId++}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, retainEnvelope });
        send({ id, method, params }, signal ? {
          signal,
          onAbandoned: () => {
            if (pending.delete(id)) reject(abandonedToolCallError());
          },
        } : undefined);
      });
    },
    /** Settles the waiter for a controller response; false when none waits. */
    respond(message: { id: string | number; result?: unknown; error?: unknown }): boolean {
      const waiter = pending.get(String(message.id));
      if (!waiter) return false;
      pending.delete(String(message.id));
      if (message.error !== undefined) {
        waiter.reject(new Error(JSON.stringify(message.error)));
      } else {
        const contentItems = record(message.result).contentItems;
        waiter.resolve(
          !waiter.retainEnvelope && Array.isArray(contentItems)
            ? (contentItems[0] ?? message.result)
            : message.result,
        );
      }
      return true;
    },
    rejectAll,
    closeInput(error: Error): void {
      inputClosed = true;
      rejectAll(error);
    },
  };
}
