import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { SlackConfig } from "./types.js";
import { handleSlackEvent } from "./event-handlers/slack-to-paperclip.js";

// ---------------------------------------------------------------------------
// Slack Socket Mode — persistent WebSocket inbound event stream
// Uses the native Node 22+ WebSocket global (no external package needed)
// ---------------------------------------------------------------------------

let activeWs: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let isStopped = false;

export async function startSocketMode(ctx: PluginContext, config: SlackConfig): Promise<void> {
  if (!config.appToken) return;
  isStopped = false;
  ctx.logger.info("Socket Mode: starting");
  await openConnection(ctx, config);
}

export function stopSocketMode(): void {
  isStopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (activeWs) {
    try { activeWs.close(1000, "shutting down"); } catch { /* ignore */ }
    activeWs = null;
  }
}

async function openConnection(ctx: PluginContext, config: SlackConfig): Promise<void> {
  if (isStopped) return;

  let wsUrl: string;
  try {
    const res = await ctx.http.fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.appToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    const data = await res.json() as { ok: boolean; url?: string; error?: string };
    if (!data.ok || !data.url) {
      ctx.logger.error("Socket Mode: failed to open connection", { error: data.error });
      scheduleReconnect(ctx, config, 30_000);
      return;
    }
    wsUrl = data.url;
  } catch (err) {
    ctx.logger.error("Socket Mode: apps.connections.open failed", { error: String(err) });
    scheduleReconnect(ctx, config, 15_000);
    return;
  }

  const ws = new WebSocket(wsUrl);
  activeWs = ws;

  ws.addEventListener("open", () => {
    ctx.logger.info("Socket Mode: WebSocket connected");
  });

  ws.addEventListener("message", (event: MessageEvent) => {
    void handleMessage(ctx, event.data as string);
  });

  ws.addEventListener("error", () => {
    ctx.logger.warn("Socket Mode: WebSocket error — will reconnect");
  });

  ws.addEventListener("close", (event: CloseEvent) => {
    activeWs = null;
    ctx.logger.warn("Socket Mode: WebSocket closed", { code: event.code });
    if (!isStopped && event.code !== 1000) {
      scheduleReconnect(ctx, config, 5_000);
    }
  });
}

async function handleMessage(ctx: PluginContext, raw: string): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  // Acknowledge every envelope immediately
  if (msg.envelope_id && activeWs?.readyState === WebSocket.OPEN) {
    activeWs.send(JSON.stringify({ envelope_id: msg.envelope_id }));
  }

  if (msg.type === "events_api") {
    const freshConfig = await ctx.config.get() as SlackConfig;
    const payload = msg.payload as import("./types.js").SlackEventEnvelope;
    await handleSlackEvent(ctx, freshConfig, payload).catch((err: unknown) => {
      ctx.logger.error("Socket Mode: event handler failed", { error: String(err) });
    });
    return;
  }

  // Slack requests us to reconnect
  if (msg.type === "disconnect") {
    ctx.logger.info("Socket Mode: server requested disconnect, reconnecting");
    try { activeWs?.close(); } catch { /* ignore */ }
    activeWs = null;
    const freshConfig = await ctx.config.get() as SlackConfig;
    scheduleReconnect(ctx, freshConfig, 500);
  }
}

function scheduleReconnect(ctx: PluginContext, config: SlackConfig, delay: number): void {
  if (isStopped) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openConnection(ctx, config).catch((err: unknown) => {
      ctx.logger.error("Socket Mode: reconnect error", { error: String(err) });
    });
  }, delay);
}
