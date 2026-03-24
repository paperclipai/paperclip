import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginHealthDiagnostics,
  type PluginJobContext,
  type PluginWebhookInput,
} from "@paperclipai/plugin-sdk";
import type { SlackConfig } from "./types.js";
import { PLUGIN_ID, JOB_KEYS, WEBHOOK_KEYS, DATA_KEYS } from "./constants.js";
import { verifySlackSignature } from "./utils/signature.js";
import { handleSlackEvent } from "./event-handlers/slack-to-paperclip.js";
import { registerPaperclipEventHandlers } from "./event-handlers/paperclip-to-slack.js";
import { startSocketMode, stopSocketMode } from "./socket-mode.js";
import { SlackClient } from "./slack-client.js";
import { buildAgentMaps, resolveToken } from "./sync/agent-mapper.js";
import { getThread, getMessageTs } from "./sync/thread-mapper.js";

// ---------------------------------------------------------------------------
// Module-level context reference (set once in setup, used in onWebhook)
// ---------------------------------------------------------------------------

let currentContext: PluginContext | null = null;

// ---------------------------------------------------------------------------
// Config helper
// ---------------------------------------------------------------------------

async function getConfig(ctx: PluginContext): Promise<SlackConfig> {
  return ctx.config.get() as Promise<SlackConfig>;
}

// ---------------------------------------------------------------------------
// Data handlers
// ---------------------------------------------------------------------------

async function registerDataHandlers(ctx: PluginContext): Promise<void> {
  // Thread info for issue detail tab
  ctx.data.register(DATA_KEYS.THREAD_FOR_ISSUE, async (params) => {
    const issueId = typeof params.issueId === "string" ? params.issueId : "";
    if (!issueId) return null;
    return getThread(ctx, issueId);
  });

  // Message ts for comment annotation badge
  ctx.data.register(DATA_KEYS.MESSAGE_TS_FOR_COMMENT, async (params) => {
    const commentId = typeof params.commentId === "string" ? params.commentId : "";
    if (!commentId) return null;
    return getMessageTs(ctx, commentId);
  });

  // Cached channel list for settings UI
  ctx.data.register(DATA_KEYS.CHANNEL_LIST, async () => {
    const config = await getConfig(ctx);
    const token = resolveToken(config, buildAgentMaps(config), config.defaultAgentId);
    if (!token) return [];
    const client = new SlackClient(token, ctx.http);
    return client.listChannels().catch(() => []);
  });
}

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

async function registerJobs(ctx: PluginContext): Promise<void> {
  ctx.jobs.register(JOB_KEYS.TOKEN_HEALTH, async (_job: PluginJobContext) => {
    const config = await getConfig(ctx);
    const agents = config.agents ?? [];
    let healthy = 0;
    let failed = 0;

    for (const agent of agents) {
      const client = new SlackClient(agent.botToken, ctx.http);
      const result = await client.authTest().catch((err: unknown) => ({
        ok: false,
        error: String(err),
      }));

      const level = result.ok ? "info" : "error";
      const msg = result.ok
        ? `Token healthy for ${agent.displayName ?? agent.agentId}`
        : `Token FAILED for ${agent.displayName ?? agent.agentId}: ${result.error}`;

      await ctx.activity.log({
        companyId: "__system__",
        message: msg,
        metadata: { plugin: PLUGIN_ID, agentId: agent.agentId, level },
      });

      result.ok ? healthy++ : failed++;
    }

    ctx.logger.info("Token health check complete", { healthy, failed });
  });

  ctx.jobs.register(JOB_KEYS.CHANNEL_SYNC, async (_job: PluginJobContext) => {
    const config = await getConfig(ctx);
    const token = resolveToken(config, buildAgentMaps(config), config.defaultAgentId);
    if (!token) {
      ctx.logger.warn("Channel sync skipped: no agent token configured");
      return;
    }
    const client = new SlackClient(token, ctx.http);
    const channels = await client.listChannels().catch(() => []);
    ctx.logger.info("Channel sync complete", { count: channels.length });
  });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx: PluginContext): Promise<void> {
    currentContext = ctx;

    ctx.logger.info(`${PLUGIN_ID} starting up`);

    // Paperclip → Slack (post issues, comments, status changes)
    registerPaperclipEventHandlers(ctx);

    // Jobs
    await registerJobs(ctx);

    // Data for UI components
    await registerDataHandlers(ctx);

    // Slack → Paperclip via Socket Mode (if appToken configured)
    const config = await getConfig(ctx);
    if (config.appToken) {
      startSocketMode(ctx, config).catch((err: unknown) => {
        ctx.logger.error("Socket Mode startup failed", { error: String(err) });
      });
    } else {
      ctx.logger.info(`${PLUGIN_ID} running in Events API (webhook) mode — set appToken to enable Socket Mode`);
    }

    ctx.logger.info(`${PLUGIN_ID} ready`);
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    const ctx = currentContext;
    if (!ctx) {
      return { status: "error", message: "Plugin context not initialised" };
    }
    const config = await getConfig(ctx);
    const agentCount = config.agents?.length ?? 0;
    const channelCount = config.channelMappings?.length ?? 0;

    return {
      status: agentCount > 0 ? "ok" : "degraded",
      message:
        agentCount > 0
          ? `${agentCount} agent bot(s) and ${channelCount} channel mapping(s) configured`
          : "No agent bot tokens configured — add tokens in plugin settings",
      details: { agentCount, channelCount },
    };
  },

  async onValidateConfig(config: Record<string, unknown>) {
    const typed = config as SlackConfig;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!typed.signingSecret) {
      warnings.push("signingSecret is not set — webhook signature verification will be skipped (insecure)");
    }

    if (!typed.agents || typed.agents.length === 0) {
      errors.push("At least one agent bot token must be configured");
    } else {
      for (const agent of typed.agents) {
        if (!agent.agentId) errors.push("Agent entry is missing agentId");
        if (!agent.botToken) errors.push(`Agent ${agent.agentId ?? "(unknown)"} is missing botToken`);
        if (!agent.botToken?.startsWith("xoxb-")) {
          warnings.push(`Agent ${agent.agentId ?? "(unknown)"} botToken does not look like an xoxb- token`);
        }
      }
    }

    if (typed.appToken && !typed.appToken.startsWith("xapp-")) {
      warnings.push("appToken does not look like an xapp- token (Socket Mode app-level token)");
    }

    return { ok: errors.length === 0, errors, warnings };
  },

  async onWebhook(input: PluginWebhookInput): Promise<void> {
    if (input.endpointKey !== WEBHOOK_KEYS.SLACK_EVENTS) {
      throw new Error(`Unsupported webhook endpoint: ${input.endpointKey}`);
    }

    const ctx = currentContext;
    if (!ctx) throw new Error("Plugin context not initialised");

    const config = await getConfig(ctx);

    // Signature verification — try per-agent secrets first, fall back to global signingSecret.
    // When at least one secret is configured, the signature headers are REQUIRED.
    // A request that omits them is rejected so the endpoint cannot be spoofed by an
    // attacker who merely knows the webhook URL.
    const sig = (input.headers["x-slack-signature"] ?? input.headers["X-Slack-Signature"]) as string;
    const ts = (input.headers["x-slack-request-timestamp"] ?? input.headers["X-Slack-Request-Timestamp"]) as string;
    const secrets = [
      ...(config.agents ?? []).map((a) => a.signingSecret).filter(Boolean) as string[],
      ...(config.signingSecret ? [config.signingSecret] : []),
    ];
    if (secrets.length > 0) {
      if (!sig || !ts) {
        throw new Error("Missing Slack signature headers — request rejected");
      }
      const valid = secrets.some((secret) => verifySlackSignature(sig, ts, input.rawBody, secret));
      if (!valid) {
        throw new Error("Invalid Slack signature — request rejected");
      }
    }

    const body = input.parsedBody as import("./types.js").SlackEventEnvelope;
    await handleSlackEvent(ctx, config, body);
  },

  async onConfigChanged(newConfig: Record<string, unknown>): Promise<void> {
    const ctx = currentContext;
    if (!ctx) return;
    const typed = newConfig as SlackConfig;
    const agentCount = Array.isArray(typed.agents) ? typed.agents.length : 0;
    ctx.logger.info(`${PLUGIN_ID} config updated`, { agentCount });

    // Restart Socket Mode if appToken changed
    stopSocketMode();
    if (typed.appToken) {
      startSocketMode(ctx, typed).catch((err: unknown) => {
        ctx.logger.error("Socket Mode restart failed", { error: String(err) });
      });
    }
  },

  async onShutdown(): Promise<void> {
    currentContext?.logger.info(`${PLUGIN_ID} shutting down`);
    stopSocketMode();
    currentContext = null;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
