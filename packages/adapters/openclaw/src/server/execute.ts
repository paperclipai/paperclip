import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";
import { isHookEndpoint } from "./execute-common.js";
import { executeSse } from "./execute-sse.js";
import { executeWebhook } from "./execute-webhook.js";

function normalizeTransport(value: unknown): "sse" | "webhook" | null {
  const normalized = asString(value, "sse").trim().toLowerCase();
  if (!normalized || normalized === "sse") return "sse";
  if (normalized === "webhook") return "webhook";
  return null;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const url = asString(ctx.config.url, "").trim();
  if (!url) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "OpenClaw adapter missing url",
      errorCode: "openclaw_url_missing",
    };
  }

  const transportInput = ctx.config.streamTransport ?? ctx.config.transport;
  const transport = normalizeTransport(transportInput);
  if (!transport) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `OpenClaw adapter does not support transport: ${String(transportInput)}`,
      errorCode: "openclaw_stream_transport_unsupported",
    };
  }

  // /hooks/* endpoints (e.g. /hooks/wake, /hooks/agent) are fire-and-forget HTTP;
  // they do not support SSE streaming. Automatically fall back to webhook transport
  // so users don't need to set `transport: "webhook"` manually when using these URLs.
  if (transport === "sse" && isHookEndpoint(url)) {
    await ctx.onLog("stdout", "[openclaw] hook endpoint detected; using webhook transport (fire-and-forget)\n");
    return executeWebhook(ctx, url);
  }

  if (transport === "webhook") {
    return executeWebhook(ctx, url);
  }

  return executeSse(ctx, url);
}
