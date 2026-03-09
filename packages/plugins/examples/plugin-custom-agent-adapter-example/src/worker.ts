import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const plugin = definePlugin({
  async setup(ctx) {
    const notifyAdapterService = async (payload: Record<string, unknown>) => {
      const config = await ctx.config.get();
      const webhookRef = asString(config.adapterWebhookSecretRef);
      if (!webhookRef) {
        ctx.logger.warn("custom-adapter notify skipped: adapterWebhookSecretRef missing");
        return;
      }

      try {
        const webhookUrl = await ctx.secrets.resolve(webhookRef);
        await ctx.http.fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
      } catch (error) {
        ctx.logger.error("custom-adapter notify failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    ctx.events.on("agent.run.started", async (event) => {
      const runId = asString(event.entityId);
      await notifyAdapterService({ type: "agent.run.started", runId, payload: event.payload });
      await ctx.activity.log({
        companyId: event.companyId,
        message: "[custom-adapter-reference] forwarded agent.run.started",
        entityType: "run",
        entityId: runId || undefined
      });
      if (runId) {
        await ctx.state.set({ scopeKind: "run", scopeId: runId, stateKey: "custom_adapter_forwarded" }, true);
      }
    });

    ctx.tools.register(
      "run-custom-adapter-check",
      {
        displayName: "Run Custom Adapter Check",
        description: "Validate connectivity with the custom adapter extension service.",
        parametersSchema: {
          type: "object",
          properties: {
            agentId: { type: "string" }
          },
          required: ["agentId"]
        }
      },
      async (params, runCtx) => {
        const agentId = asString((params as { agentId?: string }).agentId) || runCtx.agentId;

        await ctx.events.emit("custom-adapter-check.requested", runCtx.companyId, {
          agentId,
          requestedByRunId: runCtx.runId,
        });

        await notifyAdapterService({
          type: "custom-adapter-check.requested",
          agentId,
          companyId: runCtx.companyId,
          projectId: runCtx.projectId,
          runId: runCtx.runId,
        });

        return {
          content: `Custom adapter connectivity check requested for agent ${agentId}.`,
          data: { agentId }
        };
      },
    );
  },

  async onValidateConfig(config) {
    if (!asString(config.adapterWebhookSecretRef)) {
      return { ok: false, errors: ["adapterWebhookSecretRef is required"] };
    }
    return { ok: true };
  },

  async onHealth() {
    return {
      status: "ok",
      message: "Custom adapter reference example plugin ready"
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
