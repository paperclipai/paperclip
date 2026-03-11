import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const PLUGIN_NAME = "llm-chat-example";

/**
 * The SSE channel name used to stream LLM response chunks to the UI.
 * Must match the channel passed to usePluginStream() in the UI component.
 */
const STREAM_CHANNEL = "llm-chat";

/**
 * Shape of the providers data returned by the "llm.providers" data handler.
 */
interface ProviderInfo {
  id: string;
  label: string;
  models: Array<{ id: string; label: string }>;
}

/**
 * Parameters accepted by the "llm.chat.send" action.
 */
interface SendParams {
  companyId: string;
  adapterType: string;
  model: string;
  message: string;
  /** Existing session ID for multi-turn continuity; omit to start a new session. */
  sessionId?: string;
}

/**
 * Parameters accepted by the "llm.chat.close" action.
 */
interface CloseParams {
  companyId: string;
  sessionId: string;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup`);

    /**
     * Data handler: returns all LLM providers that support direct sessions,
     * together with their available models in a single response.
     *
     * The UI calls usePluginData("llm.providers", {}) to populate
     * the provider/model selectors.
     */
    ctx.data.register("llm.providers", async () => {
      const providers = await ctx.llm.providers.list();
      const results: ProviderInfo[] = await Promise.all(
        providers.map(async (provider) => {
          try {
            const models = await ctx.llm.providers.models.list(provider.id);
            return { id: provider.id, label: provider.label, models };
          } catch {
            return { id: provider.id, label: provider.label, models: [] };
          }
        }),
      );
      return { providers: results };
    });

    /**
     * Action handler: create or resume an LLM session and send a message.
     *
     * On first call (no sessionId) a new session is created.
     * On subsequent calls the same sessionId is passed, preserving the
     * conversation thread across sends (the adapter CLI session ID is
     * stored in plugin_state and threaded automatically by the host).
     *
     * Response chunks are published to the SSE bus via streamChannel so
     * the browser UI can display them in real time without waiting for the
     * full response. The final assembled content is also returned in the
     * action result for convenience.
     */
    ctx.actions.register("llm.chat.send", async (params: Record<string, unknown>) => {
      const { companyId, adapterType, model, message, sessionId: existingSessionId } =
        params as unknown as SendParams;

      if (!companyId || !adapterType || !model || !message) {
        throw new Error("companyId, adapterType, model, and message are required");
      }

      // Create a new session on the first message; resume on subsequent ones.
      const session = existingSessionId
        ? await ctx.llm.sessions.resume(existingSessionId, companyId)
        : await ctx.llm.sessions.create({ companyId, adapterType, model });

      // Send the message. The host streams chunks directly to the SSE bus
      // via streamChannel. The resolved content contains the full response.
      const result = await ctx.llm.sessions.send(session.sessionId, companyId, {
        message,
        streamChannel: STREAM_CHANNEL,
      });

      return { sessionId: session.sessionId, content: result.content };
    });

    /**
     * Action handler: close an LLM session when the user is done chatting.
     * Safe to call multiple times (idempotent).
     */
    ctx.actions.register("llm.chat.close", async (params: Record<string, unknown>) => {
      const { companyId, sessionId } = params as unknown as CloseParams;
      if (!companyId || !sessionId) {
        throw new Error("companyId and sessionId are required");
      }
      await ctx.llm.sessions.close(sessionId, companyId);
      return { ok: true };
    });
  },

  async onHealth() {
    return { status: "ok", message: `${PLUGIN_NAME} ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
