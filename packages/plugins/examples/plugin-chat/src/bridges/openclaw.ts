// No import needed — globalThis.WebSocket is available in Node 22

export type OpenClawStreamEvent =
  | { type: "token"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export async function* streamOpenClawMessage(
  gatewayUrl: string,
  gatewayToken: string,
  sessionKey: string,
  prompt: string,
  userId: string,
): AsyncGenerator<OpenClawStreamEvent> {
  const url = gatewayToken
    ? `${gatewayUrl}?token=${encodeURIComponent(gatewayToken)}`
    : gatewayUrl;

  type QueueItem = OpenClawStreamEvent | null;
  const queue: QueueItem[] = [];
  let notify: (() => void) | null = null;

  function enqueue(item: QueueItem) {
    queue.push(item);
    if (notify) {
      const fn = notify;
      notify = null;
      fn();
    }
  }

  async function waitForItem(): Promise<QueueItem> {
    if (queue.length > 0) return queue.shift()!;
    return new Promise<void>((resolve) => {
      notify = resolve;
    }).then(() => queue.shift()!);
  }

  const ws = new WebSocket(url);

  const connectionTimeout = setTimeout(() => {
    ws.close();
    enqueue({ type: "error", message: "Connection timeout" });
  }, 30_000);

  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => {
      clearTimeout(connectionTimeout);
      resolve();
    });
    ws.addEventListener("error", (ev) => {
      clearTimeout(connectionTimeout);
      reject(new Error((ev as ErrorEvent).message ?? "WebSocket error"));
    });
  });

  ws.addEventListener("message", (ev: MessageEvent) => {
    try {
      const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (msg.type === "event" && msg.event === "agent") {
        const payload = msg.payload as Record<string, unknown> | undefined;
        if (payload?.delta) {
          enqueue({ type: "token", text: String(payload.delta) });
        }
        if (payload?.done === true) {
          enqueue({ type: "done" });
          enqueue(null); // sentinel
        }
      } else if (msg.type === "error") {
        enqueue({ type: "error", message: String(msg.error ?? "unknown error") });
        enqueue(null);
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.addEventListener("error", (ev: Event) => {
    clearTimeout(connectionTimeout);
    enqueue({ type: "error", message: (ev as ErrorEvent).message ?? "WebSocket error" });
    enqueue(null);
  });

  ws.addEventListener("close", () => {
    enqueue(null);
  });

  try {
    await opened;
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    return;
  }

  ws.send(
    JSON.stringify({
      type: "req",
      method: "agent",
      params: { prompt, sessionKey, userId },
    }),
  );

  while (true) {
    const item = await waitForItem();
    if (item === null) break;
    yield item;
    if (item.type === "done" || item.type === "error") break;
  }

  ws.close();
}
