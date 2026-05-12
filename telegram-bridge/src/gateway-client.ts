/**
 * gateway-client — talks to the mattclaw-gateway-daemon (port 19919) over
 * WebSocket. Used for the conversational route: Telegram inbound becomes
 * a `conversation` method call instead of an issue creation.
 *
 * The gateway daemon runs on localhost only. This client uses Bun's global
 * WebSocket (no `ws` package dependency).
 */

const GATEWAY_URL = process.env.MATTCLAW_GATEWAY_URL ?? "ws://127.0.0.1:19919";
const PROTOCOL_VERSION = 3;

export type ConversationCallParams = {
  chatId: string | number;
  agent?: string;
  message: string;
  workspace?: string;
  timeoutMs?: number;
};

export type ConversationCallResult = {
  reply: string;
  sessionId: string | null;
  violations: Array<{ kind: string; matched: string; severity: string }>;
  retried: boolean;
  exitCode: number;
  notesWritten?: string[];
};

type Frame =
  | { type: "challenge"; nonce: string }
  | { type: "req"; id: string; method: string; params: unknown }
  | { type: "res"; id: string; ok: true; payload: unknown }
  | { type: "res"; id: string; ok: false; error: { message: string; code?: string } }
  | { type: "event"; runId?: string; kind: string; payload: unknown };

function genId(): string {
  return `req-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export async function callConversation(params: ConversationCallParams): Promise<ConversationCallResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY_URL);
    const callTimeout = setTimeout(() => {
      try { ws.close(); } catch { /* noop */ }
      reject(new Error(`gateway-client: timeout after ${(params.timeoutMs ?? 90_000) + 5_000}ms`));
    }, (params.timeoutMs ?? 90_000) + 5_000);

    let connectId: string | null = null;
    let conversationId: string | null = null;
    let connected = false;

    ws.onopen = () => {
      // Wait for challenge before sending connect
    };

    ws.onmessage = (evt) => {
      let frame: Frame;
      try {
        frame = JSON.parse(typeof evt.data === "string" ? evt.data : evt.data.toString()) as Frame;
      } catch {
        return;
      }
      if (frame.type === "challenge") {
        // Send connect
        connectId = genId();
        ws.send(JSON.stringify({
          type: "req",
          id: connectId,
          method: "connect",
          params: { minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION, auth: { deviceToken: "bridge-local" } },
        }));
        return;
      }
      if (frame.type === "res" && frame.id === connectId) {
        if (!frame.ok) {
          clearTimeout(callTimeout);
          try { ws.close(); } catch { /* noop */ }
          reject(new Error(`gateway connect failed: ${frame.error?.message}`));
          return;
        }
        connected = true;
        conversationId = genId();
        ws.send(JSON.stringify({
          type: "req",
          id: conversationId,
          method: "conversation",
          params: {
            chatId: params.chatId,
            agent: params.agent ?? "karl",
            message: params.message,
            workspace: params.workspace ?? "personal",
            timeoutMs: params.timeoutMs ?? 90_000,
          },
        }));
        return;
      }
      if (frame.type === "res" && frame.id === conversationId) {
        clearTimeout(callTimeout);
        try { ws.close(); } catch { /* noop */ }
        if (!frame.ok) {
          reject(new Error(`conversation method failed: ${frame.error?.message}`));
          return;
        }
        resolve(frame.payload as ConversationCallResult);
        return;
      }
    };

    ws.onerror = (err) => {
      clearTimeout(callTimeout);
      reject(new Error(`gateway-client ws error: ${(err as ErrorEvent).message ?? "unknown"}`));
    };

    ws.onclose = () => {
      if (!connected) {
        clearTimeout(callTimeout);
        reject(new Error("gateway-client: connection closed before completion"));
      }
    };
  });
}
