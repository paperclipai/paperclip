import { SocketModeClient, LogLevel, type Logger } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { Agent, buildConnector, fetch } from "undici";
import type { Socket } from "node:net";
import type { Config } from "./config.js";
import type { Connection, ConnectionStatus } from "./runtime.js";

// SDK logs can contain tokens, URLs and message bodies. Never forward them.
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {} };
type Reason = NonNullable<ConnectionStatus["lastFailure"]>;
type Failure = { reason: Reason; retry: boolean; retryAfterMs?: number };
class ConnectionFailure extends Error {
  constructor(readonly reason: Reason) { super(reason); }
}
function classify(error: unknown): Failure {
  if (error instanceof ConnectionFailure) return { reason: error.reason, retry: error.reason === "connection_timeout" };
  const value = error as { code?: unknown; statusCode?: unknown; retryAfter?: unknown; data?: { error?: unknown } } | null;
  if (value?.code === "slack_webapi_request_error") return { reason: "network_error", retry: true };
  if (value?.code === "slack_webapi_rate_limited_error" || value?.statusCode === 429) {
    const seconds = value.retryAfter;
    // Never retry before the provider allows it. Node clamps oversized timers
    // to one millisecond, so unsupported waits require operator recovery.
    if (typeof seconds === "number" && seconds > 2_147_483_647 / 1000) return { reason: "rate_limited", retry: false };
    return { reason: "rate_limited", retry: true, retryAfterMs: typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000 };
  }
  if (value?.code === "slack_webapi_http_error" && typeof value.statusCode === "number" && value.statusCode >= 500 && value.statusCode < 600) return { reason: "network_error", retry: true };
  if (value?.code === "slack_webapi_platform_error") {
    if (["not_authed", "invalid_auth", "account_inactive", "user_removed_from_team", "team_disabled", "token_revoked", "token_expired"].includes(String(value.data?.error))) return { reason: "authentication_failed", retry: false };
    if (["missing_scope", "not_allowed_token_type"].includes(String(value.data?.error))) return { reason: "permission_denied", retry: false };
    if (["service_unavailable", "internal_error", "fatal_error"].includes(String(value.data?.error))) return { reason: "network_error", retry: true };
  }
  return { reason: "provider_error", retry: false };
}
async function deadline<T>(work: Promise<T>, ms: number, reason: Reason): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ConnectionFailure(reason)), ms); timer.unref();
    })]);
  } finally { clearTimeout(timer!); }
}

/** One owner for initial connection and reconnects; all network work is cancellable. */
export function createSlackConnection(config: Config, appToken: string, botToken: string, warn: (message: string) => void): Connection {
  let stopped = false;
  let task: Promise<void> | undefined;
  let finishStop!: () => void;
  const stopping = new Promise<void>((resolve) => { finishStop = resolve; });
  let status: ConnectionStatus = { state: "connecting", lastFailure: null, retryAt: null };
  let identity: Connection["authenticatedIdentity"];
  let activeWeb: WebClient | null = null;
  let cleanupFailed = false;

  async function run(receive: Parameters<Connection["start"]>[0]) {
    let failures = 0;
    while (!stopped) {
      let live = true;
      let socket: SocketModeClient | undefined;
      let opening: Promise<void> = Promise.resolve();
      const sockets = new Set<Socket>();
      const connect = buildConnector({});
      const dispatcher = new Agent({ connect(options, callback) {
        connect(options, (error, raw) => {
          if (!raw) { callback(error, null); return; }
          if (!live || stopped) { raw.destroy(); callback(new Error("Slack connection stopped"), null); return; }
          sockets.add(raw); raw.once("close", () => sockets.delete(raw)); callback(null, raw);
        });
      } });
      let failure: Failure | null = null;
      let disconnected!: (failure: Failure) => void;
      const ended = new Promise<Failure>((resolve) => { disconnected = resolve; });
      status = { state: "connecting", lastFailure: status.lastFailure, retryAt: null };
      identity = undefined;
      try {
        const web = new WebClient(botToken, { logger: quiet, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 10_000,
          // WebClient uses DOM FormData types; undici accepts that same runtime body.
          fetch: (url, init) => fetch(url, { ...init, dispatcher } as Parameters<typeof fetch>[1]) });
        socket = new SocketModeClient({ appToken, logger: quiet, logLevel: LogLevel.ERROR, dispatcher, autoReconnectEnabled: false,
          clientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 10_000 } });
        const current = () => live && !stopped;
        socket.on("connected", () => {
          if (current()) { activeWeb = web; status = { state: "connected", lastFailure: null, retryAt: null }; }
        });
        const lost = () => {
          if (!current()) return;
          activeWeb = null; status = { state: "connecting", lastFailure: "connection_lost", retryAt: null };
          disconnected({ reason: "connection_lost", retry: true });
        };
        socket.on("disconnected", lost);
        socket.on("error", lost);
        socket.on("slack_event", ({ type, body, ack }: { type: string; body: unknown; ack: () => Promise<void> }) => {
          if (!current() || status.state !== "connected") return;
          // The SDK emits slack_event, not events_api. Filter its envelope here.
          if (type !== "events_api") {
            void ack().catch(() => warn("Unsupported Slack event acknowledgement failed."));
          } else {
            void receive(body, ack).catch(() => warn("Slack event was not acknowledged; a provider retry may follow."));
          }
        });
        opening = (async () => {
          const auth = await web.auth.test();
          if (!current()) return;
          if (auth.team_id !== config.workspaceId || !auth.bot_id) throw new ConnectionFailure("workspace_mismatch");
          identity = { workspaceId: auth.team_id, botId: auth.bot_id,
            botUserId: typeof auth.user_id === "string" && /^[UW][A-Z0-9]{2,32}$/.test(auth.user_id) ? auth.user_id : null };
          await socket!.start();
        })();
        failure = await Promise.race([deadline(opening, 30_000, "connection_timeout").then(() => null, classify), ended, stopping.then(() => null)]);
        if (!failure && !stopped) {
          failures = 0;
          failure = await Promise.race([ended, stopping.then(() => null)]);
        }
      } catch (error) { failure = classify(error); }
      finally {
        live = false; activeWeb = null;
        if (!stopped) status = { state: "connecting", lastFailure: failure?.reason ?? null, retryAt: null };
        try {
          await deadline((async () => {
            // disconnect() alone cannot abort start() awaiting apps.connections.open.
            // Destroy the public shared dispatcher, then wait for startup to settle
            // and close again in case it installed a websocket during cancellation.
            const disconnecting = socket?.disconnect();
            // Upgraded WebSockets detach from the Agent pool. As in the SDK's
            // default connector, own the raw sockets so a stalled peer is closed.
            for (const raw of sockets) raw.destroy();
            await Promise.all([disconnecting, dispatcher.destroy(), opening.catch(() => {})]);
            await socket?.disconnect();
          })(), 5_000, "cleanup_failed");
        } catch {
          cleanupFailed = true; failure = { reason: "cleanup_failed", retry: false };
          status = { state: "error", lastFailure: "cleanup_failed", retryAt: null };
        }
      }
      if (stopped) break;
      if (!failure?.retry) {
        status = { state: "error", lastFailure: failure?.reason ?? "provider_error", retryAt: null };
        break;
      }
      const delay = Math.max(Math.min(1000 * 2 ** Math.min(failures++, 6), 60_000), failure.retryAfterMs ?? 0);
      status = { state: "connecting", lastFailure: failure.reason, retryAt: Date.now() + delay };
      let timer: ReturnType<typeof setTimeout>;
      try { await Promise.race([stopping, new Promise<void>((resolve) => { timer = setTimeout(resolve, delay); timer.unref(); })]); }
      finally { clearTimeout(timer!); }
    }
  }
  function readyWeb() {
    if (stopped || status.state !== "connected" || !activeWeb) throw new ConnectionFailure("connection_lost");
    return activeWeb;
  }
  return {
    get authenticatedIdentity() { return identity; },
    connectionStatus: () => ({ ...status }),
    isConnected: () => !stopped && status.state === "connected",
    async start(receive) {
      if (stopped || task) throw new Error("Slack connection already started or stopped");
      // Do not hold the host's configuration invocation open during an outage.
      task = run(receive).catch(() => { status = { state: "error", lastFailure: "provider_error", retryAt: null }; });
    },
    async stop() {
      stopped = true; finishStop(); await task; identity = undefined;
      if (cleanupFailed) throw new ConnectionFailure("cleanup_failed");
    },
    async verifyDirectMessage(message) {
      const result = await readyWeb().conversations.info({ channel: message.channelId });
      const channel = result.channel;
      return channel?.is_im === true && channel.is_mpim !== true && "user" in channel && channel.user === message.userId;
    },
    async reply(message, text) {
      const plain = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      await readyWeb().chat.postMessage({ channel: message.channelId, thread_ts: message.threadTs ?? message.ts, text: plain,
        unfurl_links: false, unfurl_media: false, parse: "none", mrkdwn: false });
    },
  };
}
