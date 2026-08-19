import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CodexAppServerTransport,
  CodexRpcNotification,
  CodexRpcServerRequest,
  CodexServerRequestHandler,
} from "../drivers/codex/app-server-transport.js";
import type { CapabilityIssueThreadSnapshot, CapabilityThreadItem } from "../issue-thread/types.js";
import type { CapabilityLiveTransportFactory } from "./live-session.js";
import {
  createCapabilityTurnStreamDecoder,
  readCapabilityTurnStream,
  type CapabilityTurnStreamFrame,
} from "./turn-stream.js";

/**
 * Clean-room chat, driven through the same HTTP routes the browser uses.
 *
 * The provider is a stand-in — a real Codex turn is proved by the live smoke
 * script, not by a unit test — but everything below the provider is real: the
 * middleware, the live session, the semantic dispatcher, the authorization
 * engine, and the mock `ControlPlanePort`. That is the layer these criteria
 * actually live in: what a tool call mutates, what a denial does *not* mutate,
 * and what `New chat` retires.
 */

interface FakeProviderState {
  threadId: string;
  providerSessionId: string;
  nextTurn: number;
  transports: FakeCleanRoomTransport[];
  /** Releases one step of a gated streaming turn (`stream` messages). */
  gate: Gate;
  /** Lets the canary turn raise a provider diagnostic the way runnerd does. */
  diagnostic: ((message: string) => void) | null;
}

/**
 * Values a provider or tool could realistically carry that must never reach a
 * browser. Each one is planted somewhere the rejected build republished it.
 */
const CANARIES = {
  prompt: "CANARY-PROMPT-8f2a41d0",
  credential: "CANARY-CREDENTIAL-sk-live-4b19c7ee",
  environment: "CANARY-ENV-VALUE-3d77aa10",
  diagnostic: "CANARY-DIAGNOSTIC-6c0be913",
  providerEvent: "CANARY-PROVIDER-EVENT-91a4f2bd",
  toolResult: "CANARY-TOOL-RESULT-c58d7e04",
} as const;

/** Single-slot signal, so a streamed turn advances only when the test says so. */
class Gate {
  #waiters: Array<() => void> = [];
  #ready = 0;

  wait(): Promise<void> {
    if (this.#ready > 0) {
      this.#ready -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  release(): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#ready += 1;
    else waiter();
  }
}

/** Assistant deltas the gated turn emits, one release at a time. */
const STREAM_DELTAS = ["Reading ", "the clean-room ", "issue."] as const;

class AsyncNotifications implements AsyncIterable<CodexRpcNotification> {
  #values: CodexRpcNotification[] = [];
  #waiters: Array<(value: IteratorResult<CodexRpcNotification>) => void> = [];
  #closed = false;

  push(value: CodexRpcNotification): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<CodexRpcNotification> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value) return { value, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class FakeCleanRoomTransport implements CodexAppServerTransport {
  readonly queue = new AsyncNotifications();
  readonly exposedTools: string[] = [];
  #callCounter = 0;
  #handler: CodexServerRequestHandler = async () => ({});
  #closed = false;

  constructor(
    readonly state: FakeProviderState,
    readonly onClose: () => void,
  ) {
    state.transports.push(this);
  }

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === "initialize") return { user: { sessionId: this.state.providerSessionId } };
    if (method === "thread/start") {
      for (const tool of (params.dynamicTools ?? []) as Array<{ name: string }>) {
        this.exposedTools.push(tool.name);
      }
      return { thread: { id: this.state.threadId, sessionId: this.state.providerSessionId } };
    }
    if (method === "thread/read" || method === "thread/resume") {
      return { thread: { id: this.state.threadId, sessionId: this.state.providerSessionId } };
    }
    if (method === "turn/start") {
      const turnId = `turn-${++this.state.nextTurn}`;
      const input = Array.isArray(params.input) ? (params.input[0] as Record<string, unknown>) : {};
      void this.#runTurn(turnId, String(input.text ?? ""));
      return { turn: { id: turnId, status: "inProgress" } };
    }
    if (method === "turn/interrupt") {
      this.queue.push({
        method: "turn/completed",
        params: {
          threadId: this.state.threadId,
          turn: { id: String(params.turnId), status: "interrupted" },
        },
      });
      return {};
    }
    throw new Error(`unsupported fake Codex method ${method}`);
  }

  notify(): void {}

  notifications(): AsyncIterable<CodexRpcNotification> {
    return this.queue;
  }

  setServerRequestHandler(handler: CodexServerRequestHandler): void {
    this.#handler = handler;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.queue.close();
    this.onClose();
  }

  processInfo() {
    return { pid: 7100, processGroupId: 7100, startedAt: "2026-08-01T00:00:00.000Z", exited: this.#closed, exitCode: null, signal: null };
  }

  async #runTurn(turnId: string, message: string): Promise<void> {
    await Promise.resolve();
    this.queue.push({
      method: "turn/started",
      params: { threadId: this.state.threadId, turn: { id: turnId, status: "inProgress" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    let assistantText = `Nothing to do for "${message}".`;
    if (message.includes("hang")) return;
    if (message.includes("stream")) {
      for (const delta of STREAM_DELTAS) {
        await this.state.gate.wait();
        this.queue.push({
          method: "item/agentMessage/delta",
          params: { threadId: this.state.threadId, turnId, delta },
        });
      }
      await this.state.gate.wait();
      assistantText = STREAM_DELTAS.join("");
      this.queue.push({
        method: "item/completed",
        params: {
          threadId: this.state.threadId,
          turnId,
          item: { id: `message-${turnId}`, type: "agentMessage", text: assistantText },
        },
      });
      this.queue.push({
        method: "turn/completed",
        params: { threadId: this.state.threadId, turn: { id: turnId, status: "completed" } },
      });
      return;
    }
    if (message.includes("canary")) {
      await this.#runCanaryTurn(turnId, message);
      return;
    }
    // The resumed turn carries the typed interaction result as its input, so it
    // is matched before the keyword branches it would otherwise trip.
    if (message.includes("semantic-interaction-result")) {
      assistantText = `Continuing with the typed interaction result: ${message}`;
    } else if (message.includes("progress")) {
      assistantText = await this.#call(turnId, "report_progress", {
        idempotencyKey: `progress-${turnId}`,
        body: "Read the blank clean-room issue and recorded a first status.",
      });
    } else if (message.includes("decide")) {
      assistantText = await this.#call(turnId, "decide_approval", {
        idempotencyKey: `decide-${turnId}`,
        approvalId: "approval-1",
        decision: "approved",
        note: "trying an operation this chat was never granted",
      });
    } else if (message.includes("question")) {
      assistantText = await this.#call(turnId, "request_human_input", {
        idempotencyKey: `question-${turnId}`,
        interactionKind: "questions",
        title: "Which way should I take this?",
        prompt: "Pick a direction for the clean-room issue.",
        payload: { questions: [{ id: "path", prompt: "Which path?", options: ["a", "b"] }] },
        continuationPolicy: "wake_assignee",
      });
    }
    this.queue.push({
      method: "item/completed",
      params: {
        threadId: this.state.threadId,
        turnId,
        item: { id: `message-${turnId}`, type: "agentMessage", text: assistantText },
      },
    });
    this.queue.push({
      method: "turn/completed",
      params: { threadId: this.state.threadId, turn: { id: turnId, status: "completed" } },
    });
  }

  /**
   * One turn that carries every forbidden record class: provider protocol
   * traffic that echoes the prompt and quotes model/token metadata, a
   * diagnostic that quotes an environment value, and a tool call with an
   * undeclared argument. The rejected build republished all of it.
   */
  async #runCanaryTurn(turnId: string, message: string): Promise<void> {
    this.queue.push({
      method: "item/started",
      params: {
        threadId: this.state.threadId,
        turnId,
        sessionId: this.state.providerSessionId,
        item: {
          id: `item_${CANARIES.providerEvent}`,
          type: "reasoning",
          text: `Working on: ${message}`,
        },
        model: "codex-internal-preview",
        usage: { inputTokens: 4211, outputTokens: 77, cachedTokens: 1024 },
        requestHeaders: { authorization: `Bearer ${CANARIES.credential}` },
        rawPrompt: `${CANARIES.prompt} — verbatim provider prompt echo`,
      },
    });
    this.state.diagnostic?.(
      `codex app-server: PAPERCLIP_API_KEY=${CANARIES.environment} ${CANARIES.diagnostic}`,
    );
    const reply = await this.#call(turnId, "report_progress", {
      idempotencyKey: `canary-${turnId}`,
      body: "Recorded a mock status for the canary turn.",
    });
    // A second call carrying an argument no catalog schema declares. The mock
    // control plane refuses it, and the refusal is itself recorded — which is
    // how the rejected build republished the argument name and value.
    await this.#call(turnId, "report_progress", {
      idempotencyKey: `canary-undeclared-${turnId}`,
      body: "Second status.",
      internalProviderDetail: `${CANARIES.toolResult} ${CANARIES.credential}`,
    });
    this.queue.push({
      method: "item/completed",
      params: {
        threadId: this.state.threadId,
        turnId,
        item: { id: `message-${turnId}`, type: "agentMessage", text: reply },
      },
    });
    this.queue.push({
      method: "turn/completed",
      params: { threadId: this.state.threadId, turn: { id: turnId, status: "completed" } },
    });
  }

  async #call(turnId: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const request: CodexRpcServerRequest = {
      id: `request-${turnId}`,
      method: "item/tool/call",
      params: {
        threadId: this.state.threadId,
        turnId,
        callId: `call-${turnId}-${++this.#callCounter}`,
        tool,
        arguments: args,
      },
    };
    const result = await this.#handler(request);
    const items = result.contentItems as Array<Record<string, unknown>>;
    return `The typed result drove this reply: ${String(items[0]?.text)}`;
  }
}

function fakeTransportFactory(state: FakeProviderState): CapabilityLiveTransportFactory {
  return (options) => {
    const evidence = {
      runnerPid: 7100,
      runnerProcessGroupId: 7100,
      codexPid: 7200,
      runnerExited: false,
      runnerExitCode: null,
      runnerSignal: null,
      childEnvironmentKeys: ["CODEX_HOME", "HOME", "PATH"],
      diagnostics: [],
    };
    state.diagnostic = (message) => options.onDiagnostic?.(message);
    const transport = new FakeCleanRoomTransport(state, () => {
      evidence.runnerExited = true;
      options.onEvidence?.(evidence);
    });
    options.onEvidence?.(evidence);
    return { transport, evidence: () => ({ ...evidence }) };
  };
}

interface CleanRoomPayload {
  sessionId: string;
  surface: string;
  identity: { token: string; companyId: string; actorId: string; taskId: string; identifier: string };
  limits: { maxTurns: number; maxMessageBytes: number };
  view: CapabilityIssueThreadSnapshot;
}

function items(view: CapabilityIssueThreadSnapshot): CapabilityThreadItem[] {
  return view.turns.flatMap((turn) => turn.items);
}

/** Assistant text a reader would see in the projected thread. */
function assistantText(view: CapabilityIssueThreadSnapshot): string {
  return items(view)
    .map((item) => (item.kind === "agent_message" ? item.body : ""))
    .join("");
}

/** Polls until `ready` holds, so nothing in the suite waits on a fixed delay. */
async function settle(ready: () => boolean | Promise<boolean>, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the clean-room stream never reached the expected state");
}

type CleanRoomFrame = CapabilityTurnStreamFrame<CapabilityIssueThreadSnapshot, CleanRoomPayload>;

/**
 * Pulls frames off an open turn response one at a time. Reading incrementally
 * — rather than awaiting the whole body — is the point: it is what proves the
 * server answers before the turn is released.
 */
class FrameReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = createCapabilityTurnStreamDecoder<CapabilityIssueThreadSnapshot, CleanRoomPayload>();
  readonly #text = new TextDecoder();
  #queue: CleanRoomFrame[] = [];

  constructor(response: Response) {
    if (response.body === null) throw new Error("the turn response had no body");
    this.#reader = response.body.getReader();
  }

  async next(): Promise<CleanRoomFrame> {
    while (this.#queue.length === 0) {
      const chunk = await this.#reader.read();
      if (chunk.done) {
        this.#queue.push(...this.#decoder.flush());
        break;
      }
      this.#queue.push(...this.#decoder.push(this.#text.decode(chunk.value, { stream: true })));
    }
    const frame = this.#queue.shift();
    if (frame === undefined) throw new Error("the turn stream ended without another frame");
    return frame;
  }

  async nextMatching(predicate: (frame: CleanRoomFrame) => boolean): Promise<CleanRoomFrame> {
    for (;;) {
      const frame = await this.next();
      if (predicate(frame)) return frame;
    }
  }

  async end(): Promise<void> {
    await this.#reader.cancel().catch(() => undefined);
  }
}

/**
 * Minimal cookie jar.
 *
 * Every session-scoped route is bound to a per-browser capability cookie, so a
 * test that shares one `fetch` shares one browser. Two jars are two browsers,
 * which is exactly what the cross-session denial criteria need.
 */
class Jar {
  #cookies = new Map<string, string>();

  headers(): Record<string, string> {
    if (this.#cookies.size === 0) return {};
    return {
      cookie: [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    };
  }

  capture(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      this.#cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }

  value(name: string): string | undefined {
    return this.#cookies.get(name);
  }
}

/** Sends one request through a jar, capturing whatever capability it is given. */
async function send(
  jar: Jar,
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<Response> {
  const { json, headers, ...rest } = init;
  const response = await fetch(`${origin}${path}`, {
    ...rest,
    ...(json === undefined
      ? {}
      : { method: rest.method ?? "POST", body: JSON.stringify(json) }),
    headers: {
      ...(json === undefined ? {} : { "content-type": "application/json" }),
      ...(headers as Record<string, string> | undefined),
      ...jar.headers(),
    },
  });
  jar.capture(response);
  return response;
}

let jar: Jar;
let server: Server;
let origin: string;
let middleware: Awaited<ReturnType<typeof createMiddleware>>;
let providerState: FakeProviderState;
let scratchParent: string;
let scratchRoot: string;
const requestedUrls: string[] = [];

const sourceRunnerModuleLoaders: Record<string, () => Promise<unknown>> = {
  "live/clean-room.js": async () => await import("./clean-room.js"),
  "live/live-session.js": async () => await import("./live-session.js"),
  "live/turn-stream.js": async () => await import("./turn-stream.js"),
  "issue-thread/index.js": async () => await import("../issue-thread/index.js"),
  "mock-core/capability-control-plane-types.js": async () =>
    await import("../mock-core/capability-control-plane-types.js"),
  "mock-core/live-console-demo-server.js": async () =>
    await import("../mock-core/live-console-demo-server.js"),
};

async function loadSourceRunnerModule(relativePath: string): Promise<unknown> {
  const load = sourceRunnerModuleLoaders[relativePath];
  if (load === undefined) throw new Error(`Unexpected runner module: ${relativePath}`);
  return await load();
}

async function createMiddleware(state: FakeProviderState, root: string) {
  const module = await import("../../scripts/capability-issue-thread-server.mjs");
  return module.createCapabilityIssueThreadMiddleware({
    bindHost: "127.0.0.1",
    loadRunner: async () =>
      await module.loadCapabilityIssueThreadRunner(loadSourceRunnerModule),
    scratchRoot: root,
    transportFactory: fakeTransportFactory(state),
  });
}

/**
 * Reads a turn response. `/message` answers with the NDJSON turn stream, so the
 * helper collects every interim view and returns the settled payload — the same
 * value the route used to answer with in one shot.
 */
async function readTurn(
  response: Response,
  frames: CapabilityIssueThreadSnapshot[] = [],
): Promise<CleanRoomPayload> {
  return await readCapabilityTurnStream<CapabilityIssueThreadSnapshot, CleanRoomPayload>(
    response,
    (frame) => {
      frames.push(frame.view);
    },
  );
}

async function call(
  path: string,
  body?: unknown,
  frames?: CapabilityIssueThreadSnapshot[],
  browser: Jar = jar,
): Promise<CleanRoomPayload> {
  requestedUrls.push(`${origin}${path}`);
  const response = await send(browser, path, body === undefined ? {} : { json: body });
  if (response.headers.get("content-type")?.includes("x-ndjson") === true) {
    return await readTurn(response, frames);
  }
  const payload = (await response.json()) as CleanRoomPayload & { error?: string };
  if (!response.ok) throw new Error(`${path} → ${response.status} ${payload.error ?? ""}`);
  return payload;
}

async function status(path: string, body?: unknown, browser: Jar = jar): Promise<number> {
  const response = await send(browser, path, body === undefined ? {} : { json: body });
  await response.text();
  return response.status;
}

beforeEach(async () => {
  requestedUrls.length = 0;
  scratchParent = await mkdtemp(resolve(tmpdir(), "capability-clean-room-server-test-"));
  // Start with a missing child so the normal open path also proves that the
  // middleware creates its configured scratch root.
  scratchRoot = resolve(scratchParent, "run-scratch");
  jar = new Jar();
  providerState = {
    threadId: "codex-thread-clean-room",
    providerSessionId: "codex-provider-clean-room",
    nextTurn: 0,
    transports: [],
    gate: new Gate(),
    diagnostic: null,
  };
  middleware = await createMiddleware(providerState, scratchRoot);
  server = createServer((request, response) => {
    void middleware(request, response, () => {
      response.statusCode = 404;
      response.end("not found");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await middleware.close();
  server.close();
  await once(server, "close");
  await rm(scratchParent, { recursive: true, force: true });
});

describe("Capability clean-room chat server", () => {
  it("opens a blank live thread with fresh mock identities and no canned evidence", async () => {
    const opened = await call("/api/capability/ui/cleanroom/session");

    expect(opened.surface).toBe("cleanroom");
    expect(opened.view.turns).toEqual([]);
    expect(opened.view.mode).toBe("live");
    expect(opened.view.identity.agentLabel).toBe("Real Codex");
    expect(opened.view.identity.runnerLabel).toBe("Real runnerd");
    expect(opened.view.identity.controlPlaneLabel).toBe("Mock Paperclip");
    expect(opened.view.identity.replaySource).toBeNull();
    expect(opened.view.replay).toBeNull();
    expect(opened.view.composer.state).toBe("ready");
    expect(opened.view.issue.identifier).toBe(opened.identity.identifier);
    expect(opened.view.issue.identifier.startsWith("MCK-")).toBe(true);
    // The run checked the mock issue out, which is the only mutation an
    // open performs.
    expect(opened.view.issue.status).toBe("in_progress");
    expect(opened.view.evidence.calls).toEqual([]);
    expect(opened.view.evidence.parity).toEqual([]);
    expect(opened.view.evidence.traceability).toEqual([]);
  });

  it("recreates a removed run scratch root before starting a later chat", async () => {
    const opened = await call("/api/capability/ui/cleanroom/session");

    // Managed services survive the heartbeat that launched them, while the
    // harness removes this run-owned parent as soon as that heartbeat exits.
    await rm(scratchRoot, { recursive: true, force: true });

    const fresh = await call("/api/capability/ui/cleanroom/session", {
      sessionId: opened.sessionId,
    });
    expect(fresh.sessionId).not.toBe(opened.sessionId);
    expect(fresh.identity.token).not.toBe(opened.identity.token);
    expect(fresh.view.composer.state).toBe("ready");
  });

  it("publishes the real-API block as an inspectable record", async () => {
    const opened = await call("/api/capability/ui/cleanroom/session");
    const guard = opened.view.evidence.control_plane.find((record) =>
      record.id.startsWith("network-guard-"),
    );

    expect(guard?.outcome).toBe("no_real_paperclip_request");
    expect(guard?.reason).toContain("Real Paperclip API requests: 0");
    expect(guard?.reason).toContain("Child PAPERCLIP_* environment keys: none");
    // Every request this test made went to its own loopback server.
    expect(requestedUrls.every((url) => url.startsWith(origin))).toBe(true);
  });

  it("keeps credentials out of the projected clean-room view", async () => {
    const opened = await call("/api/capability/ui/cleanroom/session");
    const after = await call("/api/capability/ui/message", {
      sessionId: opened.sessionId,
      message: "Read the issue and report progress.",
    });
    const serialized = JSON.stringify(after.view);

    for (const pattern of [
      /bearer\s+[a-z0-9._-]+/i,
      // Anchored: the clean room's own `task-cleanroom-<token>` ids embed
      // `sk-`, and an unanchored probe reads that as a provider key.
      /(?<![A-Za-z0-9])sk-[a-z0-9]{8,}/i,
      /"api[_-]?key"\s*:/i,
      /PAPERCLIP_API_KEY/,
      /OPENAI_API_KEY/,
    ]) {
      expect(pattern.test(serialized), String(pattern)).toBe(false);
    }
  });

  it("runs an allowed semantic call that mutates only the mock control plane", async () => {
    const opened = await call("/api/capability/ui/cleanroom/session");
    const after = await call("/api/capability/ui/message", {
      sessionId: opened.sessionId,
      message: "Read the issue and report progress.",
    });

    const rendered = items(after.view);
    expect(rendered.some((item) => item.kind === "user_message")).toBe(true);
    expect(rendered.some((item) => item.kind === "agent_message")).toBe(true);
    const call0 = rendered.find((item) => item.kind === "tool_activity");
    expect(call0?.kind).toBe("tool_activity");
    if (call0?.kind === "tool_activity") expect(call0.operationId).toBe("report_progress");

    const durable = rendered.find((item) => item.kind === "durable_comment");
    expect(durable?.kind).toBe("durable_comment");
    if (durable?.kind === "durable_comment") {
      expect(durable.body).toBe("Read the blank clean-room issue and recorded a first status.");
    }
    expect(after.view.evidence.calls[0]?.outcome).toBe("ok");
    expect(after.view.evidence.state.length).toBeGreaterThan(0);
  });

  it("returns a typed denial for an ungranted call and changes no mock state", async () => {
    const opened = await call("/api/capability/ui/cleanroom/session");
    const before = await call("/api/capability/ui/message", {
      sessionId: opened.sessionId,
      message: "Read the issue and report progress.",
    });
    const revisionBefore = before.view.evidence.state.at(-1)?.toRevision ?? 0;

    const after = await call("/api/capability/ui/message", {
      sessionId: opened.sessionId,
      message: "Now decide the approval yourself.",
    });

    const denial = items(after.view).find((item) => item.kind === "denial");
    expect(denial?.kind).toBe("denial");
    if (denial?.kind !== "denial") return;
    expect(denial.operationId).toBe("decide_approval");
    expect(denial.reason.length).toBeGreaterThan(0);

    const record = after.view.evidence.calls.find((entry) => entry.operationId === "decide_approval");
    expect(record?.outcome).toBe("denied");
    expect(record?.dispatchedCommand).toBe("rejected before dispatch");
    // The denial produced no state diff, so the last revision is unchanged.
    expect(after.view.evidence.state.at(-1)?.toRevision ?? 0).toBe(revisionBefore);
    expect(
      after.view.evidence.authorization.some(
        (entry) => entry.operationId === "decide_approval" && !entry.allowed,
      ),
    ).toBe(true);
  });

  it("keeps one durable session across turns, an inline answer, reconnect, and stop", async () => {
    const opened = await call("/api/capability/ui/cleanroom/session");

    const asked = await call("/api/capability/ui/message", {
      sessionId: opened.sessionId,
      message: "Ask me a question before you continue.",
    });
    const card = items(asked.view).find((item) => item.kind === "interaction");
    expect(card?.kind).toBe("interaction");
    if (card?.kind !== "interaction") return;
    expect(card.state).toBe("pending");
    expect(asked.view.composer.state).toBe("waiting");

    const answered = await call("/api/capability/ui/interaction", {
      sessionId: opened.sessionId,
      interactionId: card.interactionId,
      outcome: "answered",
      result: { path: "a" },
    });
    expect(answered.view.composer.state).toBe("ready");
    const resolved = items(answered.view).find(
      (item) => item.kind === "interaction" && item.interactionId === card.interactionId,
    );
    expect(resolved?.kind === "interaction" && resolved.state).toBe("answered");

    // Refresh: the same session id resumes the same durable chat.
    const refreshed = await call(
      `/api/capability/ui/cleanroom/session?sessionId=${opened.sessionId}`,
    );
    expect(refreshed.sessionId).toBe(opened.sessionId);
    expect(refreshed.view.turns.length).toBe(answered.view.turns.length);

    const reconnected = await call("/api/capability/ui/reconnect", { sessionId: opened.sessionId });
    expect(reconnected.sessionId).toBe(opened.sessionId);
    expect(items(reconnected.view).some((item) => item.kind === "user_message")).toBe(true);

    const hanging = call("/api/capability/ui/message", {
      sessionId: opened.sessionId,
      message: "Now hang on this turn until I stop you.",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await call("/api/capability/ui/interrupt", { sessionId: opened.sessionId });
    const stopped = await hanging;
    expect(stopped.view.turns.at(-1)?.stoppedByUser).toBe(true);

    // Retry after the stop stays in the same session rather than opening one.
    const retried = await call("/api/capability/ui/message", {
      sessionId: opened.sessionId,
      message: "Read the issue and report progress.",
    });
    expect(retried.sessionId).toBe(opened.sessionId);
  });

  it("reset and new chat both rotate identities and retire the prior authority", async () => {
    const opened = await call("/api/capability/ui/cleanroom/session");
    await call("/api/capability/ui/message", {
      sessionId: opened.sessionId,
      message: "Read the issue and report progress.",
    });

    const reset = await call("/api/capability/ui/reset", { sessionId: opened.sessionId });
    expect(reset.sessionId).not.toBe(opened.sessionId);
    expect(reset.identity.companyId).not.toBe(opened.identity.companyId);
    expect(reset.identity.actorId).not.toBe(opened.identity.actorId);
    expect(reset.identity.taskId).not.toBe(opened.identity.taskId);
    expect(reset.view.turns).toEqual([]);
    expect(await status("/api/capability/ui/message", {
      sessionId: opened.sessionId,
      message: "still there?",
    })).toBe(404);

    const fresh = await call("/api/capability/ui/cleanroom/session", { sessionId: reset.sessionId });
    expect(fresh.sessionId).not.toBe(reset.sessionId);
    expect(fresh.identity.token).not.toBe(reset.identity.token);
    expect(fresh.view.turns).toEqual([]);
    expect(await status("/api/capability/ui/message", {
      sessionId: reset.sessionId,
      message: "still there?",
    })).toBe(404);
  });

  it("bounds turns per chat with a named reason instead of an opaque failure", async () => {
    const opened = await call("/api/capability/ui/cleanroom/session");
    for (let turn = 0; turn < opened.limits.maxTurns; turn += 1) {
      await call("/api/capability/ui/message", { sessionId: opened.sessionId, message: `turn ${turn}` });
    }
    const response = await send(jar, "/api/capability/ui/message", {
      json: { sessionId: opened.sessionId, message: "one more" },
    });
    const body = (await response.json()) as { error: string; message: string };
    expect(response.status).toBe(429);
    expect(body.error).toBe("turn_limit");
    expect(body.message).toContain("Start a new chat");
  });

  it("streams the turn as frames while the POST is still open", async () => {
    const opened = await call("/api/capability/ui/cleanroom/session");
    const response = await send(jar, "/api/capability/ui/message", {
      headers: { accept: "application/x-ndjson" },
      json: { sessionId: opened.sessionId, message: "stream your answer" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    // A cache or proxy directive that permitted transformation could coalesce
    // the frames back into one body, which is the failure being fixed.
    expect(response.headers.get("cache-control")).toContain("no-transform");
    expect(response.headers.get("content-length")).toBeNull();

    const reader = new FrameReader(response);
    // The body is readable before the gated turn produces anything at all.
    const open = await reader.next();
    expect(open.type).toBe("frame");
    if (open.type !== "frame") return;
    expect(open.reason).toBe("open");
    expect(assistantText(open.view)).toBe("");
    expect(open.view.turns.at(-1)?.items.some((item) => item.kind === "user_message")).toBe(true);

    const streamed: string[] = [];
    for (let index = 0; index < STREAM_DELTAS.length; index += 1) {
      providerState.gate.release();
      const frame = await reader.nextMatching(
        (candidate) =>
          candidate.type !== "frame" || assistantText(candidate.view) === STREAM_DELTAS.slice(0, index + 1).join(""),
      );
      expect(frame.type).toBe("frame");
      if (frame.type !== "frame") return;
      streamed.push(assistantText(frame.view));
      expect(frame.view.composer.state).toBe("streaming");
    }

    expect(streamed).toEqual([
      STREAM_DELTAS[0],
      STREAM_DELTAS.slice(0, 2).join(""),
      STREAM_DELTAS.join(""),
    ]);

    providerState.gate.release();
    const settled = await reader.nextMatching((candidate) => candidate.type === "settled");
    expect(settled.type).toBe("settled");
    if (settled.type !== "settled") return;
    // The terminal payload is the authority and is the same shape the route
    // used to answer with in one JSON response.
    expect(settled.payload.sessionId).toBe(opened.sessionId);
    expect(settled.payload.surface).toBe("cleanroom");
    expect(assistantText(settled.payload.view)).toBe(STREAM_DELTAS.join(""));
    expect(settled.payload.view.composer.state).toBe("ready");
    const messages = items(settled.payload.view).filter((item) => item.kind === "agent_message");
    expect(messages).toHaveLength(1);
    await reader.end();

    // The stream left the session usable rather than wedged mid-turn.
    const next = await call("/api/capability/ui/cleanroom/session", { sessionId: opened.sessionId });
    expect(next.sessionId).not.toBe(opened.sessionId);
  });

  it("interrupts the provider turn when the client abandons the stream", async () => {
    const opened = await call("/api/capability/ui/cleanroom/session");
    const controller = new AbortController();
    const response = await send(jar, "/api/capability/ui/message", {
      headers: { accept: "application/x-ndjson" },
      json: { sessionId: opened.sessionId, message: "stream your answer" },
      signal: controller.signal,
    });
    const reader = new FrameReader(response);
    await reader.next();
    providerState.gate.release();
    await reader.nextMatching(
      (candidate) => candidate.type === "frame" && assistantText(candidate.view).length > 0,
    );

    controller.abort();
    // The abandoned turn is interrupted rather than left running: the session
    // returns to `ready`, which a still-active turn would never do.
    await settle(async () => {
      const probe = await call(`/api/capability/ui/cleanroom/session?sessionId=${opened.sessionId}`);
      return probe.sessionId === opened.sessionId && probe.view.composer.state === "ready";
    });
    const after = await call("/api/capability/ui/message", {
      sessionId: opened.sessionId,
      message: "Read the issue and report progress.",
    });
    expect(after.sessionId).toBe(opened.sessionId);
    expect(items(after.view).some((item) => item.kind === "durable_comment")).toBe(true);
  });

  it("keeps the preset scenario surface working and isolated from the clean room", async () => {
    const scenario = await call("/api/capability/ui/session?scenario=hb-baseline");
    const cleanRoom = await call("/api/capability/ui/cleanroom/session");

    expect(scenario.view.issue.identifier).toBe("MCK-31");
    expect(scenario.view.issue.fixtureProfile).toBe("hb-baseline");
    expect(cleanRoom.sessionId).not.toBe(scenario.sessionId);
    expect(cleanRoom.view.issue.identifier).not.toBe("MCK-31");

    await call("/api/capability/ui/message", {
      sessionId: cleanRoom.sessionId,
      message: "Read the issue and report progress.",
    });
    const scenarioAgain = await call(
      `/api/capability/ui/session?sessionId=${scenario.sessionId}`,
    );
    expect(scenarioAgain.view.turns).toEqual([]);
  });

  /**
   * Track 7U, finding 1. The rejected build projected `provider_event` records
   * and unredacted tool results into `view.evidence`, so one ordinary turn
   * handed the browser provider protocol traffic, the echoed prompt, provider
   * thread/turn/item ids, model and token metadata, and complete tool payloads.
   * Every canary below was observable in that build's NDJSON response.
   */
  it("keeps provider traffic, diagnostics, and tool payloads out of every streamed surface", async () => {
    const logs: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      logs.push(String(chunk));
      return stdout(chunk as string, ...(rest as []));
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      logs.push(String(chunk));
      return stderr(chunk as string, ...(rest as []));
    }) as typeof process.stderr.write;

    let opened: CleanRoomPayload;
    let settled: CleanRoomPayload;
    let reconnected: CleanRoomPayload;
    let replayed: CleanRoomPayload;
    const frames: CapabilityIssueThreadSnapshot[] = [];
    try {
      opened = await call("/api/capability/ui/cleanroom/session");
      settled = await call(
        "/api/capability/ui/message",
        { sessionId: opened.sessionId, message: `canary turn: ${CANARIES.prompt}` },
        frames,
      );
      reconnected = await call("/api/capability/ui/reconnect", { sessionId: opened.sessionId });
      replayed = await call(`/api/capability/ui/cleanroom/session?sessionId=${opened.sessionId}`);
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }

    const capability = jar.value("paperclip_capability_chat");
    expect(capability).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    // The turn really did run: without a settled reply the sweep below would
    // pass on an empty transcript.
    expect(frames.length).toBeGreaterThan(0);
    expect(items(settled.view).some((item) => item.kind === "durable_comment")).toBe(true);

    // The prompt is legitimately echoed once per turn as the user's own card;
    // it must appear nowhere else, so user bodies are removed before scanning
    // rather than exempted wholesale.
    const withoutUserMessages = (view: CapabilityIssueThreadSnapshot): string =>
      JSON.stringify({
        ...view,
        turns: view.turns.map((turn) => ({
          ...turn,
          items: turn.items.filter((item) => item.kind !== "user_message"),
        })),
      });

    const surfaces: Array<[string, string]> = [
      ...frames.map((view, index) => [`frame ${index}`, withoutUserMessages(view)] as [string, string]),
      ["settled payload", withoutUserMessages(settled.view)],
      ["reconnect payload", withoutUserMessages(reconnected.view)],
      ["replay payload", withoutUserMessages(replayed.view)],
      ["persisted evidence", JSON.stringify(replayed.view.evidence)],
      ["server log", logs.join("")],
    ];

    for (const [label, encoded] of surfaces) {
      for (const [name, canary] of Object.entries(CANARIES)) {
        expect(`${label}:${name}:${encoded.includes(canary)}`).toBe(`${label}:${name}:false`);
      }
      // Provider thread identity and the browser's own capability are equally
      // off-limits, and the undeclared argument name must not be echoed either.
      expect(encoded).not.toContain(providerState.threadId);
      expect(encoded).not.toContain(providerState.providerSessionId);
      expect(encoded).not.toContain(capability);
      expect(encoded).not.toContain("internalProviderDetail");
      expect(encoded).not.toContain("inputTokens");
    }

    // The evidence panel still says what happened — the fix is a summary, not a
    // blank section.
    const runner = replayed.view.evidence.runner;
    expect(runner.some((record) => record.kind === "provider_event")).toBe(true);
    expect(runner.filter((record) => record.kind === "provider_event").every((record) =>
      /^provider event · [a-z_]+$/.test(record.detail),
    )).toBe(true);
    expect(runner.some((record) => record.detail.includes("diagnostic · withheld"))).toBe(true);
    expect(replayed.view.evidence.calls.every((record) =>
      record.providerRequest.startsWith("tools/call ") && !record.providerRequest.includes("{"),
    )).toBe(true);
  });

  /**
   * Track 7U, finding 2. The rejected build authorized any route on possession
   * of a session id, because the only capability was minted once per gateway
   * process and shared by every browser.
   */
  it("denies every session-scoped route to a second browser and after rotation", async () => {
    const alice = new Jar();
    const mallory = new Jar();

    const aliceRoom = await call("/api/capability/ui/cleanroom/session", undefined, undefined, alice);
    const malloryRoom = await call("/api/capability/ui/cleanroom/session", undefined, undefined, mallory);
    const aliceIssue = await call("/api/capability/ui/session?scenario=hb-baseline", undefined, undefined, alice);

    expect(aliceRoom.sessionId).not.toBe(malloryRoom.sessionId);
    expect(alice.value("paperclip_capability_chat")).not.toBe(mallory.value("paperclip_capability_chat"));

    // Reciprocal read denial: neither browser can name the other's session.
    for (const [reader, target] of [
      [mallory, aliceRoom.sessionId],
      [alice, malloryRoom.sessionId],
    ] as Array<[Jar, string]>) {
      expect(
        await status(`/api/capability/ui/cleanroom/session?sessionId=${target}`, undefined, reader),
      ).toBe(404);
    }

    // Every mutation route, not only the ones that create sessions.
    const mutations = ["message", "interrupt", "reconnect", "reset", "interaction"];
    for (const route of mutations) {
      expect(
        await status(`/api/capability/ui/${route}`, { sessionId: aliceRoom.sessionId, message: "hi" }, mallory),
      ).toBe(404);
      expect(
        await status(`/api/capability/ui/${route}`, { sessionId: aliceIssue.sessionId, message: "hi" }, mallory),
      ).toBe(404);
    }

    // A cookie-less caller is refused too: the capability is required, not
    // merely preferred when present.
    expect(
      await status("/api/capability/ui/message", { sessionId: aliceRoom.sessionId, message: "hi" }, new Jar()),
    ).toBe(404);

    // Alice still owns her own sessions throughout.
    expect(
      await status(`/api/capability/ui/cleanroom/session?sessionId=${aliceRoom.sessionId}`, undefined, alice),
    ).toBe(200);
    expect(await status(`/api/capability/ui/session?sessionId=${aliceIssue.sessionId}`, undefined, alice)).toBe(200);
  });

  it("rotates the capability on reset and new chat and revokes the old one", async () => {
    const alice = new Jar();
    const opened = await call("/api/capability/ui/cleanroom/session", undefined, undefined, alice);
    const first = alice.value("paperclip_capability_chat");

    const stale = new Jar();
    stale.capture(new Response(null, {
      headers: { "set-cookie": `paperclip_capability_chat=${first}` },
    }));

    const afterReset = await call("/api/capability/ui/reset", { sessionId: opened.sessionId }, undefined, alice);
    const second = alice.value("paperclip_capability_chat");
    expect(second).not.toBe(first);
    expect(afterReset.sessionId).not.toBe(opened.sessionId);
    // The old cookie is dead against the replacement session as well as the
    // retired one, so a stolen cookie does not survive a reset.
    expect(await status(`/api/capability/ui/cleanroom/session?sessionId=${afterReset.sessionId}`, undefined, stale)).toBe(404);
    expect(await status("/api/capability/ui/message", { sessionId: afterReset.sessionId, message: "hi" }, stale)).toBe(404);

    const afterNewChat = await call("/api/capability/ui/cleanroom/session", { sessionId: afterReset.sessionId }, undefined, alice);
    const third = alice.value("paperclip_capability_chat");
    expect(third).not.toBe(second);
    const previous = new Jar();
    previous.capture(new Response(null, {
      headers: { "set-cookie": `paperclip_capability_chat=${second}` },
    }));
    expect(await status(`/api/capability/ui/cleanroom/session?sessionId=${afterNewChat.sessionId}`, undefined, previous)).toBe(404);
    expect(await status("/api/capability/ui/reset", { sessionId: afterNewChat.sessionId }, previous)).toBe(404);
    expect(await status(`/api/capability/ui/cleanroom/session?sessionId=${afterNewChat.sessionId}`, undefined, alice)).toBe(200);
  });

  it("lets two tabs of one browser hold their own sessions without revoking each other", async () => {
    // One jar is one browser. Reloading a page whose stored id is gone must not
    // rotate the capability, or two tabs would revoke each other on every load.
    const browser = new Jar();
    const tabA = await call("/api/capability/ui/cleanroom/session", undefined, undefined, browser);
    const capability = browser.value("paperclip_capability_chat");
    const tabB = await call("/api/capability/ui/cleanroom/session", undefined, undefined, browser);

    expect(tabB.sessionId).not.toBe(tabA.sessionId);
    expect(browser.value("paperclip_capability_chat")).toBe(capability);
    for (const sessionId of [tabA.sessionId, tabB.sessionId]) {
      expect(
        await status(`/api/capability/ui/cleanroom/session?sessionId=${sessionId}`, undefined, browser),
      ).toBe(200);
    }
    // A different browser still reaches neither of them.
    const stranger = new Jar();
    for (const sessionId of [tabA.sessionId, tabB.sessionId]) {
      expect(
        await status(`/api/capability/ui/cleanroom/session?sessionId=${sessionId}`, undefined, stranger),
      ).toBe(404);
    }
  });

  it("rotates the issue-surface capability on reset", async () => {
    const alice = new Jar();
    const opened = await call("/api/capability/ui/session?scenario=hb-baseline", undefined, undefined, alice);
    const first = alice.value("paperclip_capability_issue");
    const stale = new Jar();
    stale.capture(new Response(null, {
      headers: { "set-cookie": `paperclip_capability_issue=${first}` },
    }));

    const reset = await call("/api/capability/ui/reset", { sessionId: opened.sessionId }, undefined, alice);
    expect(alice.value("paperclip_capability_issue")).not.toBe(first);
    expect(await status(`/api/capability/ui/session?sessionId=${reset.sessionId}`, undefined, stale)).toBe(404);
    expect(await status(`/api/capability/ui/session?sessionId=${reset.sessionId}`, undefined, alice)).toBe(200);
  });
});
