/**
 * paperclip-plugin-alertmanager — worker entrypoint.
 *
 * Receives Alertmanager v2 webhook deliveries, dedups per-alert by
 * fingerprint, and produces Paperclip issues with the right assignee,
 * priority, and observability drill-in links. Resolution status updates the
 * tracked issue per the configured autoCloseOnResolve policy.
 *
 * The plugin emits two domain events that sibling plugins (e.g. Slack) can
 * subscribe to without coupling to AM directly:
 *   - plugin.alertmanager.alert.firing
 *   - plugin.alertmanager.alert.resolved
 *
 * See `docs/specs/2026-04-29-alertmanager-plugin-spec.md` for the full design.
 */

import {
  definePlugin,
  startWorkerRpcHost,
  type PluginContext,
  type PluginWebhookInput,
} from "@paperclipai/plugin-sdk";
import { DEFAULT_OWNER_MAP } from "./constants.js";
import { handleWebhook } from "./webhook-handler.js";
import type { AlertmanagerPluginConfig, OwnerMap } from "./types.js";

// ---------------------------------------------------------------------------
// Module-level worker state
//
// `setup()` populates these once at startup; the webhook handler reads them.
// Pattern mirrors paperclip-plugin-slack/src/worker.ts:78–82.
// ---------------------------------------------------------------------------

let pluginCtx: PluginContext | null = null;
let pluginConfig: AlertmanagerPluginConfig | null = null;
/** Resolved bearer token, kept in memory only — never written to state. */
let resolvedWebhookToken: string | null = null;

function mergeOwnerMap(ownerMap: OwnerMap | undefined): OwnerMap {
  const merged: OwnerMap = {};
  for (const [labelKey, valueMap] of Object.entries(DEFAULT_OWNER_MAP)) {
    merged[labelKey] = { ...valueMap };
  }
  for (const [labelKey, valueMap] of Object.entries(ownerMap ?? {})) {
    merged[labelKey] = { ...(merged[labelKey] ?? {}), ...valueMap };
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Internal: apply a freshly-resolved config snapshot to the worker's in-memory
// state. Used by both setup() (first start) and onConfigChanged() (operator
// edits the instance config at runtime, no restart required).
// ---------------------------------------------------------------------------

async function applyConfig(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
): Promise<void> {
  pluginConfig = {
    ...config,
    ownerMap: mergeOwnerMap(config.ownerMap),
  };

  if (!pluginConfig.defaultCompanyId) {
    ctx.logger.warn(
      "paperclip-plugin-alertmanager: defaultCompanyId is not configured — incoming alerts will be dropped until it is set",
    );
  }

  // Resolve the bearer token once. The secret-ref path is the recommended
  // production posture; webhookToken is the dev-mode fallback (documented as
  // such in the manifest schema and README).
  if (pluginConfig.webhookTokenRef) {
    try {
      resolvedWebhookToken = await ctx.secrets.resolve(pluginConfig.webhookTokenRef);
    } catch (err) {
      ctx.logger.error(
        `paperclip-plugin-alertmanager: failed to resolve webhookTokenRef: ${String(err)}`,
      );
      resolvedWebhookToken = null;
    }
  } else if (pluginConfig.webhookToken) {
    resolvedWebhookToken = pluginConfig.webhookToken;
  } else {
    ctx.logger.warn(
      "paperclip-plugin-alertmanager: no webhookToken or webhookTokenRef configured — webhook endpoint will reject every request",
    );
    resolvedWebhookToken = null;
  }
}

export const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    const rawConfig = await ctx.config.get();
    await applyConfig(ctx, rawConfig as unknown as AlertmanagerPluginConfig);
    ctx.logger.info("paperclip-plugin-alertmanager started");
  },

  async onConfigChanged(newConfig) {
    const ctx = pluginCtx;
    if (!ctx) return;
    await applyConfig(ctx, newConfig as unknown as AlertmanagerPluginConfig);
    ctx.logger.info(
      "paperclip-plugin-alertmanager: config reloaded without restart",
    );
  },

  async onWebhook(input: PluginWebhookInput) {
    const ctx = pluginCtx;
    const config = pluginConfig;
    if (!ctx || !config) {
      // Setup hasn't completed — bail safely instead of throwing so AM
      // doesn't see a 500 and retry storm us.
      return;
    }
    await handleWebhook(ctx, config, resolvedWebhookToken, input);
  },

  async onHealth() {
    return { status: "ok" };
  },
});

export default plugin;

// Start the RPC host unconditionally — same rationale as Slack plugin
// (worker.ts:1786–1791): runWorker's argv match is fragile through symlinks.
startWorkerRpcHost({ plugin });
