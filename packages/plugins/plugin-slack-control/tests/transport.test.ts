import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "../src/runtime.js";
import { company, config, envelope, message } from "./helpers.js";

type TestSocket = EventEmitter & { options: Record<string, unknown> };
const mocks = vi.hoisted(() => ({
  auth: vi.fn(), info: vi.fn(), post: vi.fn(), start: vi.fn(), stop: vi.fn(), destroy: vi.fn(), web: vi.fn(),
  sockets: [] as TestSocket[], agents: [] as Array<{ destroy(): Promise<void> }>,
}));
vi.mock("undici", () => ({ fetch: vi.fn(), buildConnector: () => vi.fn(), Agent: class {
  constructor() { mocks.agents.push(this); }
  destroy() { return mocks.destroy(this); }
} }));
vi.mock("@slack/web-api", () => ({ WebClient: class {
  constructor(...args: unknown[]) { mocks.web(...args); }
  auth = { test: mocks.auth }; conversations = { info: mocks.info }; chat = { postMessage: mocks.post };
} }));
vi.mock("@slack/socket-mode", async () => {
  const { EventEmitter } = await import("node:events");
  return { LogLevel: { ERROR: "error" }, SocketModeClient: class extends EventEmitter {
    constructor(readonly options: Record<string, unknown>) { super(); mocks.sockets.push(this); }
    start() { return mocks.start(this); }
    disconnect() { return mocks.stop(this); }
  } };
});
import { slackConnection } from "../src/worker.js";

const connections: Connection[] = [];
const networkError = { code: "slack_webapi_request_error", message: "synthetic-private-provider-payload" };
const flush = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); mocks.sockets.length = 0; mocks.agents.length = 0;
  mocks.auth.mockResolvedValue({ team_id: config.workspaceId, bot_id: "BBOT" });
  mocks.info.mockResolvedValue({ channel: { is_im: true, user: message.userId } });
  mocks.start.mockImplementation(async (socket: TestSocket) => { socket.emit("connected"); });
  mocks.stop.mockImplementation(async (socket: TestSocket) => { socket.emit("disconnected"); });
  mocks.destroy.mockResolvedValue(undefined);
});
afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.stop().catch(() => {})));
  expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
});
function context() {
  const api = { secrets: { resolve: vi.fn().mockResolvedValueOnce("xapp-synthetic").mockResolvedValueOnce("xoxb-synthetic") }, logger: { warn: vi.fn(), error: vi.fn() } };
  return { api, ctx: api as unknown as PluginContext };
}
async function create(ctx = context().ctx) {
  const connection = await slackConnection(ctx)(config, company); connections.push(connection); return connection;
}
async function start(connection: Connection, receive = vi.fn().mockResolvedValue(undefined)) { await connection.start(receive); await flush(); return receive; }

describe("official Slack transport boundary", () => {
  it("receives an Events API envelope through the actual Socket Mode SDK dispatcher", async () => {
    const actual = await vi.importActual<typeof import("@slack/socket-mode")>("@slack/socket-mode");
    const connection = await create();
    const receive = vi.fn(async (_body: unknown, ack: () => Promise<void>) => { await ack(); });
    await start(connection, receive);
    const send = vi.fn().mockResolvedValue(undefined);
    const sdk = Object.assign(Object.create(actual.SocketModeClient.prototype), {
      logger: { debug() {}, getLevel: () => actual.LogLevel.ERROR }, send,
      emit(name: string, payload: unknown) { mocks.sockets[0]!.emit(name, payload); },
    }) as { onWebSocketMessage(data: string, isBinary: boolean): Promise<void> };
    await sdk.onWebSocketMessage(JSON.stringify({
      type: "events_api", envelope_id: "synthetic-envelope", accepts_response_payload: false,
      payload: envelope(), retry_attempt: 0,
    }), false);
    expect(receive).toHaveBeenCalledExactlyOnceWith(envelope(), expect.any(Function));
    expect(send).toHaveBeenCalledExactlyOnceWith("synthetic-envelope", undefined);
  });
  it("resolves only company-bound references and gives reconnect ownership to one supervisor", async () => {
    const { ctx, api } = context(); const connection = await create(ctx);
    expect(api.secrets.resolve).toHaveBeenNthCalledWith(1, config.appToken, { companyId: company, configPath: "appToken" });
    expect(api.secrets.resolve).toHaveBeenNthCalledWith(2, config.botToken, { companyId: company, configPath: "botToken" });
    expect(connection.isConnected()).toBe(false); await start(connection);
    expect(mocks.web).toHaveBeenCalledWith("xoxb-synthetic", expect.objectContaining({ retryConfig: { retries: 0 }, rejectRateLimitedCalls: true }));
    expect(mocks.sockets[0]!.options).toMatchObject({ autoReconnectEnabled: false, dispatcher: mocks.agents[0], clientOptions: { retryConfig: { retries: 0 } } });
    await connection.stop(); expect(mocks.destroy).toHaveBeenCalledTimes(1);
    expect(connection.isConnected()).toBe(false);
  });
  it("exposes only bot identity metadata from the existing authentication check", async () => {
    mocks.auth.mockResolvedValue({ team_id: config.workspaceId, bot_id: "BBOT", user_id: "UBOT", token: "synthetic-private-token", response_metadata: { headers: "synthetic-private-headers" } });
    const connection = await create(); await start(connection);
    expect(connection.authenticatedIdentity).toEqual({ workspaceId: config.workspaceId, botId: "BBOT", botUserId: "UBOT" });
    expect(mocks.auth).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(connection.authenticatedIdentity)).not.toContain("private");
  });
  it("acknowledges non-Events-API envelopes without dispatching commands", async () => {
    const connection = await create(); const receive = await start(connection); const ack = vi.fn().mockResolvedValue(undefined);
    mocks.sockets[0]!.emit("slack_event", { type: "interactive", body: envelope(), ack });
    expect(receive).not.toHaveBeenCalled(); expect(ack).toHaveBeenCalledOnce();
  });
  it.each([{ team_id: "TOTHER", bot_id: "BBOT" }, { team_id: config.workspaceId }])("rejects another workspace or a user token: %j", async (auth) => {
    mocks.auth.mockResolvedValue(auth); const connection = await create(); await start(connection);
    expect(connection.connectionStatus!()).toEqual({ state: "error", lastFailure: "workspace_mismatch", retryAt: null });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.auth).toHaveBeenCalledTimes(1);
  });
  it("requires an actual one-to-one conversation with the mapped user, including after recovery", async () => {
    const connection = await create(); await start(connection);
    expect(await connection.verifyDirectMessage(message)).toBe(true);
    mocks.sockets[0]!.emit("disconnected"); await flush();
    await expect(connection.verifyDirectMessage(message)).rejects.toThrow("connection_lost");
    await vi.advanceTimersByTimeAsync(1000);
    for (const channel of [{ is_im: false, user: message.userId }, { is_im: true, is_mpim: true, user: message.userId }, { is_im: true, user: "UOTHER" }, { is_im: true }]) {
      mocks.info.mockResolvedValue({ channel }); expect(await connection.verifyDirectMessage(message)).toBe(false);
    }
  });
  it("replies only to the source IM/thread with mentions and URL unfurling disabled", async () => {
    const connection = await create(); await start(connection);
    await connection.reply(message, "<@UOTHER> https://example.org");
    expect(mocks.post).toHaveBeenCalledWith({ channel: message.channelId, thread_ts: message.ts, text: "&lt;@UOTHER&gt; https://example.org", unfurl_links: false, unfurl_media: false, parse: "none", mrkdwn: false });
    const logger = mocks.sockets[0]!.options.logger as { error(value: unknown): void; debug(value: unknown): void };
    logger.error("xapp-do-not-log"); logger.debug({ text: "private body" });
  });
});

describe("bounded connection recovery", () => {
  it("retries initial auth network failures without resolving secrets again or holding configuration open", async () => {
    mocks.auth.mockRejectedValueOnce(networkError);
    const { ctx, api } = context(); const connection = await create(ctx); await start(connection);
    expect(connection.connectionStatus!()).toMatchObject({ state: "connecting", lastFailure: "network_error" });
    expect(mocks.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.isConnected()).toBe(true); expect(api.secrets.resolve).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(connection.connectionStatus!())).not.toContain("private");
  });
  it("recovers from a failed reconnect request with no parallel clients, then ignores old events", async () => {
    const connection = await create(); const receive = await start(connection);
    const old = mocks.sockets[0]!;
    mocks.start.mockRejectedValueOnce(networkError);
    old.emit("disconnected"); await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.connectionStatus!()).toMatchObject({ state: "connecting", lastFailure: "network_error" });
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999); expect(mocks.start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(connection.isConnected()).toBe(true);
    expect(mocks.sockets).toHaveLength(3); expect(mocks.auth).toHaveBeenCalledTimes(3);
    const ack = vi.fn(); old.emit("connected"); old.emit("slack_event", { type: "events_api", body: envelope(), ack });
    expect(receive).not.toHaveBeenCalled(); expect(ack).not.toHaveBeenCalled();
    mocks.sockets[2]!.emit("slack_event", { type: "events_api", body: envelope(), ack }); expect(receive).toHaveBeenCalledOnce();
  });
  it.each(["invalid_auth", "token_revoked", "missing_scope"])("stops credential retries for %s and exposes only a fixed category", async (reason) => {
    mocks.start.mockRejectedValue({ code: "slack_webapi_platform_error", data: { error: reason, token: "private-token" } });
    const connection = await create(); await start(connection); await vi.advanceTimersByTimeAsync(300_000);
    expect(connection.connectionStatus!()).toEqual({ state: "error", lastFailure: reason === "missing_scope" ? "permission_denied" : "authentication_failed", retryAt: null });
    expect(mocks.start).toHaveBeenCalledTimes(1); expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });
  it("bounds a missing hello handshake, destroys the old transport and retries", async () => {
    mocks.start.mockImplementationOnce((socket: TestSocket) => new Promise((_, reject) => { socket.once("disconnected", () => reject(networkError)); }));
    const connection = await create(); await start(connection);
    await vi.advanceTimersByTimeAsync(29_999); expect(mocks.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.connectionStatus!()).toMatchObject({ state: "connecting", lastFailure: "connection_timeout" });
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); expect(connection.isConnected()).toBe(true);
  });
  it("waits for dispatcher destruction before creating another attempt", async () => {
    let finish!: () => void;
    mocks.destroy.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const connection = await create(); await start(connection);
    mocks.sockets[0]!.emit("disconnected"); await flush();
    await vi.advanceTimersByTimeAsync(2000); expect(mocks.sockets).toHaveLength(1);
    finish(); await flush(); await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.sockets).toHaveLength(2); expect(connection.isConnected()).toBe(true);
  });
  it("cancels pending authentication and does not let a late response start a socket", async () => {
    let finish!: (auth: unknown) => void;
    mocks.auth.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    mocks.destroy.mockImplementationOnce(async () => { finish({ team_id: config.workspaceId, bot_id: "BBOT" }); });
    const connection = await create(); await start(connection); await connection.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.auth).toHaveBeenCalledTimes(1);
    expect(connection.authenticatedIdentity).toBeUndefined();
  });
  it("cancels the handshake on shutdown and ignores late connected/message events", async () => {
    mocks.start.mockImplementationOnce((socket: TestSocket) => new Promise((_, reject) => { socket.once("disconnected", () => reject(networkError)); }));
    const connection = await create(); const receive = await start(connection); await connection.stop();
    const old = mocks.sockets[0]!; old.emit("connected"); old.emit("slack_event", { type: "events_api", body: envelope(), ack: vi.fn() });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(connection.isConnected()).toBe(false); expect(receive).not.toHaveBeenCalled(); expect(mocks.sockets).toHaveLength(1);
  });
  it("cancels backoff on shutdown and does not permit a second owner", async () => {
    mocks.auth.mockRejectedValue(networkError); const connection = await create(); await start(connection);
    await expect(connection.start(vi.fn())).rejects.toThrow("already started");
    await connection.stop(); await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.auth).toHaveBeenCalledTimes(1);
  });
  it("caps transient backoff and honours a longer rate-limit delay", async () => {
    mocks.auth.mockRejectedValue(networkError); const connection = await create(); await start(connection);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      expect(connection.connectionStatus!().retryAt! - Date.now()).toBe(delay);
      await vi.advanceTimersByTimeAsync(delay);
    }
    await connection.stop();
    mocks.auth.mockRejectedValue({ code: "slack_webapi_rate_limited_error", retryAfter: 120 });
    const limited = await create(); await start(limited);
    expect(limited.connectionStatus!().retryAt! - Date.now()).toBe(120_000);
  });
  it("does not shorten a valid two-hour provider rate limit", async () => {
    mocks.auth.mockRejectedValueOnce({ code: "slack_webapi_rate_limited_error", retryAfter: 7200 });
    const connection = await create(); await start(connection);
    expect(connection.connectionStatus!().retryAt! - Date.now()).toBe(7_200_000);
    await vi.advanceTimersByTimeAsync(7_199_999); expect(mocks.auth).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(connection.isConnected()).toBe(true);
  });
  it.each([2_147_484, Infinity])("halts instead of overflowing an unsupported provider wait: %s", async (retryAfter) => {
    mocks.auth.mockRejectedValue({ code: "slack_webapi_rate_limited_error", retryAfter });
    const connection = await create(); await start(connection);
    expect(connection.connectionStatus!()).toEqual({ state: "error", lastFailure: "rate_limited", retryAt: null });
    await vi.advanceTimersByTimeAsync(7_200_000); expect(mocks.auth).toHaveBeenCalledTimes(1);
  });
  it("halts when cleanup cannot be confirmed instead of opening a competing client", async () => {
    mocks.destroy.mockImplementationOnce(() => new Promise(() => {}));
    const connection = await create(); await start(connection); mocks.sockets[0]!.emit("disconnected"); await flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(connection.connectionStatus!()).toEqual({ state: "error", lastFailure: "cleanup_failed", retryAt: null });
    await vi.advanceTimersByTimeAsync(120_000); expect(mocks.sockets).toHaveLength(1);
    await expect(connection.stop()).rejects.toThrow("cleanup_failed");
  });
});
