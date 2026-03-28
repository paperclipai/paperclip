import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { streamOpenClawMessage } from "./bridges/openclaw.js";
import { ACTION_KEYS, DATA_KEYS, DEFAULT_CONFIG, STREAM_CHANNELS } from "./constants.js";

type ChatConfig = {
  gatewayUrl?: string;
  defaultAgentId?: string;
  gatewayToken?: string;
};

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
};

type SessionState = {
  messages: ChatMessage[];
  sessionKey: string;
};

function sessionScopeKey(companyId: string, userId: string, sessionId: string) {
  return {
    scopeKind: "company" as const,
    scopeId: companyId,
    namespace: "chat",
    stateKey: `session:${userId}:${sessionId}`,
  };
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("paperclip-chat plugin ready");

    // DATA: session-history
    ctx.data.register(DATA_KEYS.sessionHistory, async (params) => {
      const companyId = String(params.companyId ?? "");
      const userId = String(params.userId ?? "default");
      const sessionId = String(params.sessionId ?? "default");
      if (!companyId) return { messages: [], sessionKey: sessionId };
      const stored = await ctx.state.get(sessionScopeKey(companyId, userId, sessionId));
      return stored ?? { messages: [], sessionKey: sessionId };
    });

    // DATA: plugin-config (expose resolved config to UI)
    ctx.data.register(DATA_KEYS.config, async (_params) => {
      const config = (await ctx.config.get()) as ChatConfig;
      return {
        gatewayUrl: config.gatewayUrl ?? DEFAULT_CONFIG.gatewayUrl,
        defaultAgentId: config.defaultAgentId ?? DEFAULT_CONFIG.defaultAgentId,
      };
    });

    // ACTION: send-message
    ctx.actions.register(ACTION_KEYS.sendMessage, async (params) => {
      const companyId = String(params.companyId ?? "");
      const userId = String(params.userId ?? "default");
      const sessionId = String(params.sessionId ?? "default");
      const text = String(params.text ?? "");
      if (!companyId || !text) throw new Error("companyId and text are required");

      const config = (await ctx.config.get()) as ChatConfig;
      const gatewayUrl = config.gatewayUrl ?? DEFAULT_CONFIG.gatewayUrl;
      const gatewayToken = config.gatewayToken ?? "";
      const sessionKey = `${companyId}:${userId}:${sessionId}`;

      // Load existing state
      const scopeKey = sessionScopeKey(companyId, userId, sessionId);
      const stored = ((await ctx.state.get(scopeKey)) ?? { messages: [], sessionKey }) as SessionState;
      stored.messages.push({ role: "user", text, timestamp: new Date().toISOString() });
      await ctx.state.set(scopeKey, stored);

      // Stream response
      const streamChannel = `${STREAM_CHANNELS.chat}:${companyId}:${userId}:${sessionId}`;
      ctx.streams.open(streamChannel, companyId);

      let fullResponse = "";
      try {
        for await (const event of streamOpenClawMessage(gatewayUrl, gatewayToken, sessionKey, text, userId)) {
          if (event.type === "token") {
            fullResponse += event.text;
            ctx.streams.emit(streamChannel, { type: "token", text: event.text });
          } else if (event.type === "done") {
            ctx.streams.emit(streamChannel, { type: "done" });
            ctx.streams.close(streamChannel);
            break;
          } else if (event.type === "error") {
            ctx.streams.emit(streamChannel, { type: "error", message: event.message });
            ctx.streams.close(streamChannel);
            break;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.streams.emit(streamChannel, { type: "error", message: msg });
        ctx.streams.close(streamChannel);
        ctx.logger.error("OpenClaw stream error", { error: msg });
      }

      if (fullResponse) {
        stored.messages.push({ role: "assistant", text: fullResponse, timestamp: new Date().toISOString() });
        await ctx.state.set(scopeKey, stored);
      }

      return { streamChannel, sessionId };
    });

    // ACTION: new-session (clears history for a session key)
    ctx.actions.register(ACTION_KEYS.newSession, async (params) => {
      const companyId = String(params.companyId ?? "");
      const userId = String(params.userId ?? "default");
      const sessionId = `session-${Date.now()}`;
      if (!companyId) throw new Error("companyId is required");
      const scopeKey = sessionScopeKey(companyId, userId, sessionId);
      await ctx.state.set(scopeKey, { messages: [], sessionKey: sessionId });
      return { sessionId };
    });
  },

  async onHealth() {
    return { status: "ok", message: "paperclip-chat plugin ready" };
  },

  async onValidateConfig(config) {
    const c = config as ChatConfig;
    if (c.gatewayUrl && !c.gatewayUrl.startsWith("ws")) {
      return { ok: false, errors: ["gatewayUrl must start with ws:// or wss://"] };
    }
    return { ok: true };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
