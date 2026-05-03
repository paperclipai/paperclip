import type { ChatSession } from "../api/chat";

export type ChatStreamEvent =
  | { type: "session_state"; session: ChatSession }
  | { type: "message_started"; messageId: string; role: "assistant" }
  | { type: "text_delta"; delta: string }
  | {
      type: "tool_use_block";
      toolUseId: string;
      name: string;
      input: unknown;
      mutating: boolean;
    }
  | { type: "permission_required"; toolUseId: string; name: string; input: unknown }
  | { type: "tool_result_block"; toolUseId: string; ok: boolean; result: unknown }
  | { type: "message_completed"; messageId: string }
  | { type: "done"; stopReason: string }
  | { type: "error"; error: string; code?: string }
  | { type: "ping" };

export interface StreamHandle {
  done: Promise<void>;
  abort: () => void;
}

export function postChatMessageStream(
  sessionId: string,
  text: string,
  onEvent: (event: ChatStreamEvent) => void,
  attachmentIds: string[] = [],
): StreamHandle {
  const controller = new AbortController();
  const done = (async () => {
    let res: Response;
    try {
      res = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ text, attachmentIds }),
        credentials: "include",
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      onEvent({ type: "error", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* ignore */
      }
      const errMsg =
        (body as { error?: string } | null)?.error ?? `Request failed: ${res.status}`;
      const code = (body as { code?: string } | null)?.code;
      onEvent({ type: "error", error: errMsg, code });
      return;
    }
    if (!res.body) {
      onEvent({ type: "error", error: "No response body for SSE stream" });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        let sepIdx;
        while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, sepIdx);
          buf = buf.slice(sepIdx + 2);
          // Parse SSE block: lines of `event: x` and `data: y`
          let dataLine: string | null = null;
          for (const line of block.split("\n")) {
            if (line.startsWith("data:")) {
              dataLine = (dataLine ?? "") + line.slice(5).trimStart();
            }
          }
          if (!dataLine) continue;
          try {
            const parsed = JSON.parse(dataLine) as ChatStreamEvent;
            onEvent(parsed);
          } catch {
            /* skip malformed event */
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      onEvent({ type: "error", error: err instanceof Error ? err.message : String(err) });
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  })();

  return {
    done,
    abort: () => controller.abort(),
  };
}
