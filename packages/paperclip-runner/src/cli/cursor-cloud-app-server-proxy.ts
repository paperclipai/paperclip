#!/usr/bin/env node
import { constants } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import type { HarnessSession, PersistedHarnessSession } from "../contracts/harness-driver.js";
import { parseNativeRuntimeContext } from "../contracts/runtime-context.js";
import { CursorCloudDriver, CURSOR_CLOUD_DRIVER_KIND, CURSOR_CLOUD_DRIVER_VERSION, type CursorCloudSessionHandle } from "../drivers/cursor-cloud/cursor-cloud-driver.js";
import { cursorCloudRecord, parseCursorCloudBinding, parseNativeCursorCloudConfig } from "../drivers/cursor-cloud/config.js";
import { enqueueSerialInput } from "./serial-input-queue.js";

type Rpc = { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };
const MAX_FRAME_BYTES = 2_097_152;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;

async function privateJson(path: string, maxBytes: number): Promise<unknown> {
  const handle = await openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Cursor Cloud configuration file must be owned, private and bounded");
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw new Error("Cursor Cloud configuration changed during admission");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)));
  } finally { await handle.close(); }
}

export function startCursorCloudAppServerProxy(options: {
  input?: Readable;
  output?: Writable;
  diagnostic?: Writable;
  environment?: NodeJS.ProcessEnv;
} = {}): { done: Promise<void>; shutdown(): Promise<void> } {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const diagnostic = options.diagnostic ?? process.stderr;
  const env = options.environment ?? process.env;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  let sequence = 0;
  let session: CursorCloudSessionHandle | null = null;
  let cwd = "";
  let model = "";
  let closed = false;
  let shuttingDown: Promise<void> | null = null;
  let commandQueue = Promise.resolve();
  let buffer = Buffer.alloc(0);
  let bootstrapFailed = false;
  let finish!: () => void;
  const done = new Promise<void>(resolveDone => { finish = resolveDone; });

  function send(value: unknown): void {
    const encoded = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES || output.writableLength + Buffer.byteLength(encoded) > 4_194_304) throw new Error("Cursor Cloud output frame/consumer exceeded its bound");
    output.write(encoded);
  }
  function requestController(params: Record<string, unknown>): Promise<unknown> {
    if (closed || pending.size >= 128) return Promise.reject(new Error("Cursor Cloud controller is closed or exceeds its pending-call bound"));
    const id = `cursor-cloud-${++sequence}`;
    const promise = new Promise<unknown>((resolveValue, reject) => pending.set(id, { resolve: resolveValue, reject }));
    send({ id, method: "item/tool/call", params });
    return promise;
  }
  async function openSession(params: Record<string, unknown>, resume: boolean): Promise<unknown> {
    if (session) throw new Error("Cursor Cloud thread is already open");
    const configPath = env.PAPERCLIP_CURSOR_CLOUD_CONFIG_PATH?.trim();
    if (!configPath) throw new Error("PAPERCLIP_CURSOR_CLOUD_CONFIG_PATH is required");
    const raw = cursorCloudRecord(await privateJson(configPath, 65_536));
    const { binding: rawBinding, ...publicConfig } = raw;
    const binding = parseCursorCloudBinding(rawBinding);
    const config = parseNativeCursorCloudConfig(publicConfig);
    if (binding.normalizedSessionId !== env.PAPERCLIP_NORMALIZED_SESSION_ID) throw new Error("Cursor Cloud normalized session binding mismatch");
    const runtimeContextPath = env.PAPERCLIP_NATIVE_RUNTIME_CONTEXT_PATH?.trim();
    const runtimeContext = runtimeContextPath ? parseNativeRuntimeContext(await privateJson(runtimeContextPath, 1_048_576)) : null;
    cwd = resolve(text(params.cwd, process.cwd())); model = text(params.model);
    const runId = env.PAPERCLIP_RUN_ID;
    if (!runId) throw new Error("PAPERCLIP_RUN_ID is required");
    const relayUrl = env.PAPERCLIP_CURSOR_CLOUD_RELAY_URL;
    const relayToken = env.PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN;
    const socketPath = env.PAPERCLIP_CURSOR_CLOUD_RELAY_SOCKET_PATH;
    const relayExpiresAt = Number(env.PAPERCLIP_CURSOR_CLOUD_RELAY_EXPIRES_AT);
    if (!relayUrl || !relayToken || !socketPath || !Number.isSafeInteger(relayExpiresAt) || relayExpiresAt <= 0) throw new Error("Cursor Cloud semantic relay binding and expiry are required");
    const driver = new CursorCloudDriver({ model, config, binding, runtimeDirectory: dirname(resolve(configPath)), artifactRoot: env.PAPERCLIP_CURSOR_CLOUD_ARTIFACT_ROOT, relay: { url: relayUrl, token: relayToken, socketPath, expiresAt: relayExpiresAt },
      instructions: text(params.baseInstructions, "Complete only the supplied Paperclip task. Use Paperclip tools and finish with paperclip_finish or paperclip_block."), runtimeContext,
      dynamicTools: Array.isArray(params.dynamicTools) ? params.dynamicTools.map(value => cursorCloudRecord(value)) : [],
      dynamicToolHandler: async call => requestController({ ...call }), environment: env,
      runnerInstanceId: env.PAPERCLIP_RUNNER_INSTANCE_ID ?? "cursor-cloud-sidecar" });
    if (resume) {
      const threadId = text(params.threadId);
      const snapshot: PersistedHarnessSession = { driverKind: CURSOR_CLOUD_DRIVER_KIND, driverSessionId: threadId, normalizedSessionId: binding.normalizedSessionId, runId, workingDirectory: cwd };
      const restored = await driver.recoverSession(snapshot);
      if (!restored.recovered || !restored.session) throw new Error(restored.reason ?? "Cursor Cloud recovery failed");
      session = restored.session;
    } else session = await driver.openSession({ runId, normalizedSessionId: binding.normalizedSessionId, workingDirectory: cwd });
    void pump(session).catch(() => shutdown());
    return { thread: { id: session.ids().driverSessionId, sessionId: session.ids().driverSessionId, cwd }, submittedModel: model, effectiveModelAcknowledged: false, instructionsAcknowledged: false };
  }
  async function pump(opened: HarnessSession): Promise<void> {
    for await (const event of opened.events()) {
      const payload = event.payload;
      const threadId = opened.ids().driverSessionId;
      const turnId = event.turnId;
      if (event.eventType === "turn.started") send({ method: "turn/started", params: { threadId, turnId, turn: { id: turnId, status: "inProgress" } } });
      else if (["item.started", "item.delta", "item.completed"].includes(event.eventType)) {
        const assistant = payload.kind === "agentMessage";
        const nativeItem = object(payload.item);
        const item = payload.kind === "tool" ? { ...nativeItem, type: "builtinToolCall", tool: nativeItem.name,
          ...(nativeItem.result === undefined ? {} : { output: typeof nativeItem.result === "string" ? nativeItem.result : JSON.stringify(nativeItem.result) }) }
          : payload.item ?? { id: event.itemId, type: assistant ? "agentMessage" : payload.kind, text: payload.text };
        send({ method: event.eventType === "item.delta" && assistant ? "item/agentMessage/delta" : event.eventType.replace(".", "/"), params: {
          threadId, turnId, itemId: event.itemId, ...payload, item,
          ...(event.eventType === "item.delta" && assistant ? { delta: payload.text } : {}),
        } });
      } else if (["turn.completed", "turn.failed", "turn.interrupted"].includes(event.eventType)) send({ method: event.eventType.replace(".", "/"), params: { threadId, turnId, ...(payload.cursorCloudTerminalDelivery ? { cursorCloudTerminalDelivery: payload.cursorCloudTerminalDelivery } : {}), turn: { id: turnId, status: event.eventType.slice(5), ...(payload.error ? { error: payload.error } : {}) } } });
      else if (event.eventType === "harness.diagnostic") send({ method: "warning", params: { threadId, turnId, code: payload.code, message: payload.message ?? payload.code } });
    }
  }
  async function stopReceipt(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!session) return { remoteStopped: true, remoteRunId: null };
    await session.interrupt?.({});
    const state = await session.read?.() ?? {};
    const expectedTurnId = typeof params.turnId === "string" ? params.turnId : null;
    if (expectedTurnId !== null && expectedTurnId !== state.turnId) throw new Error("Cursor Cloud shutdown turn identity changed");
    const stoppedTurnId = state.pendingTerminalDelivery ? state.turnId : expectedTurnId;
    if (state.runId && state.phase !== "terminal") throw new Error("Cursor Cloud remote Stop is unconfirmed");
    if (!state.runId && state.phase !== "idle") throw new Error("Cursor Cloud pending remote create is unconfirmed");
    return { remoteStopped: true, threadId: session.ids().driverSessionId, turnId: stoppedTurnId ?? null, remoteAgentId: state.agentId ?? null, remoteRunId: state.runId ?? null, ...(state.pendingTerminalDelivery ? { cursorCloudTerminalDelivery: state.pendingTerminalDelivery } : {}), ...(state.providerStatus ? { status: state.providerStatus } : {}) };
  }
  async function handle(message: Rpc): Promise<void> {
    if (message.method === undefined && message.id !== undefined) {
      const waiter = pending.get(String(message.id)); if (!waiter) return;
      pending.delete(String(message.id));
      if (message.error !== undefined) waiter.reject(new Error("Cursor Cloud controller rejected its tool request")); else waiter.resolve(message.result);
      return;
    }
    if (!message.method || message.id === undefined) return;
    const params = object(message.params);
    let result: unknown;
    switch (message.method) {
      case "initialize": result = { user: { sessionId: "cursor-cloud" }, serverInfo: { name: "cursor-cloud", version: CURSOR_CLOUD_DRIVER_VERSION } }; break;
      case "thread/start": result = await openSession(params, false); break;
      case "thread/resume": result = await openSession(params, true); break;
      case "collaborationMode/list": result = { data: [{ name: "Default", mode: "default", model, reasoningEffort: null }] }; break;
      case "turn/start": {
        if (!session) throw new Error("Cursor Cloud thread is not open");
        if (object(params.collaborationMode).mode === "plan" || params.reasoningMode !== undefined) throw new Error("Cursor Cloud native plan/reasoning override is unsupported");
        const items = Array.isArray(params.input) ? params.input.map(object) : [];
        if (items.some(item => item.type !== "text" && item.type !== "inputText")) throw new Error("Cursor Cloud supports text turn input only");
        const turn = await session.startTurn({ message: { role: "user", text: items.map(item => text(item.text)).join("\n") } });
        result = { turn: { id: turn.turnId, status: "inProgress" } }; break;
      }
      case "turn/interrupt":
        if (!session?.interrupt) throw new Error("Cursor Cloud thread is not open");
        await session.interrupt({ ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}) }); result = true; break;
      case "thread/read": {
        if (!session) throw new Error("Cursor Cloud thread is not open");
        const state = await session.read();
        const activeTurnId = ["creating", "running", "stopping"].includes(String(state.phase)) && typeof state.turnId === "string" ? state.turnId : null;
        await session.snapshot();
        result = { cursorCloudTerminalDelivery: state.pendingTerminalDelivery, thread: { id: session.ids().driverSessionId, cwd, turns: activeTurnId ? [{ id: activeTurnId, status: "inProgress" }] : [] }, transcript: state }; break;
      }
      case "paperclip/ackTerminal":
        if (!session || typeof params.turnId !== "string" || typeof params.receiptId !== "string") throw new Error("Cursor Cloud terminal receipt is missing");
        await session.acknowledgeTerminalDelivery({ turnId: params.turnId, receiptId: params.receiptId });
        result = { turnId: params.turnId, receiptId: params.receiptId, acknowledged: true }; break;
      case "paperclip/shutdown": result = await stopReceipt(params); break;
      default: throw new Error("Unsupported Cursor Cloud proxy method");
    }
    send({ id: message.id, result });
  }
  async function shutdown(): Promise<void> {
    shuttingDown ??= (async () => {
      closed = true;
      for (const waiter of pending.values()) waiter.reject(new Error("Cursor Cloud controller closed")); pending.clear();
      try { await session?.close({ reason: "proxy_shutdown", force: true }); }
      catch { diagnostic.write("[cursor-cloud] Remote termination is unconfirmed; checkpoint retained.\n"); process.exitCode = 1; }
      finish();
    })();
    return shuttingDown;
  }
  function receive(message: Rpc): void {
    if (closed) return;
    if (message.method === undefined && message.id !== undefined) { void handle(message); return; }
    commandQueue = enqueueSerialInput(commandQueue, async () => {
      if (bootstrapFailed && message.method !== "paperclip/shutdown") throw new Error("Cursor Cloud bootstrap previously failed");
      await handle(message);
    }, error => {
      if (["initialize", "thread/start", "thread/resume"].includes(message.method ?? "")) bootstrapFailed = true;
      const reason = error instanceof Error ? error.message : "Cursor Cloud request failed";
      send({ id: message.id, error: { code: -32000, message: reason.slice(0, 2_000) } });
    });
  }
  input.on("data", (chunk: Buffer | string) => {
    if (closed) return;
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (true) {
      const index = buffer.indexOf(10);
      if (index < 0) break;
      const line = buffer.subarray(0, index); buffer = buffer.subarray(index + 1);
      if (line.length > MAX_FRAME_BYTES) { void shutdown(); return; }
      if (!line.toString().trim()) continue;
      try { const message = JSON.parse(line.toString()) as Rpc; receive(message); }
      catch { send({ id: null, error: { code: -32700, message: "Invalid Cursor Cloud JSON-RPC input" } }); }
    }
    if (buffer.length > MAX_FRAME_BYTES) void shutdown();
  });
  input.on("end", () => { void commandQueue.then(shutdown); });
  input.on("error", () => { void shutdown(); });
  return { done, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const proxy = startCursorCloudAppServerProxy();
  process.once("SIGTERM", () => { void proxy.shutdown(); });
  process.once("SIGINT", () => { void proxy.shutdown(); });
  void proxy.done.then(() => process.exit(process.exitCode ?? 0));
}
