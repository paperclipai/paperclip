import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { AcpRuntimeEvent, AcpRuntimeTurnResult } from "acpx/runtime";
import { userInfo } from "node:os";
import { AntigravitySavedStateIncompatibleError } from "./antigravity-admission.js";
import { retireAntigravityProcess } from "./antigravity-process.js";
import { antigravityOutsideChange } from "./antigravity-swarm-paths.js";
import {
  ANTIGRAVITY_CLI_SESSION_MODE, ANTIGRAVITY_SWARM_MCP_SERVER, ANTIGRAVITY_SWARM_MODE, AntigravitySwarmError,
  antigravitySwarmWorkspaceEscape, classifyAntigravityRefusalText, createAntigravitySwarmGuard,
  type AntigravitySwarmReceipt,
} from "./antigravity-swarm-guard.js";
import { antigravitySwarmEvent } from "./antigravity-swarm-presentation.js";
import { awaitVerifiedAcpxProviderOwnership } from "./installation-integrity.js";
import type { AcpxModelStatus } from "./model-verification.js";
import type { AcpxRuntimePort, AcpxRuntimePortIdentity, AcpxRuntimePortOpenOptions, AcpxRuntimeTurn, AcpxRuntimeTurnInput } from "./runtime-host.js";

/**
 * Runtime port for the Antigravity CLI route (`agy acp`), used only for a turn
 * the signed-in user started with `/swarm`. It speaks ACP directly instead of
 * through ACPX because the CLI's model selector, auto mode and swarm turn shape
 * need driver-owned verification (see antigravity-swarm-guard.ts).
 *
 * One port is one fresh CLI session: it never calls `session/load` (a reload
 * resets mode and model, and the helpers are gone), so Retry after a lost
 * process always starts a fresh swarm in the same task folder.
 */
export const ANTIGRAVITY_SWARM_INSTRUCTIONS = [
  "## Paperclip swarm rules",
  "This turn runs Antigravity's native swarm for one Paperclip task. All helpers belong to this one Paperclip run.",
  "- Start every helper with workspace \"inherit\". Never use \"share\" or \"branch\".",
  "- Helpers change files only inside the current workspace (the task folder). Never write anywhere else.",
  "- Do not use Paperclip tools that create tasks, assign work, or hire agents while the swarm runs.",
  "- Wait until every helper and the verifier have finished before you end your turn.",
  "- When the work is verified, hand in the result once through Paperclip's finish tool and name the files that were written.",
].join("\n");

const HELPER_WAIT_PROMPT = "Paperclip: wait until every helper has finished (use the swarm tools to wait; do not start new helpers), then confirm the result in one or two sentences. If you have not yet handed in through Paperclip's finish tool, do it now; if you already did, do not call it again.";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_HELPER_WAIT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_CANCEL_GRACE_MS = 5_000;
const READBACK_TIMEOUT_MS = 5_000;
const SNAPSHOT_LIMIT = 20_000;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".venv", "__pycache__"]);
const BLOCKED_TEXT = /timed out waiting for user response|permission check failed/i;
export const ANTIGRAVITY_SWARM_PROCESS_LOST = "ACPX_PROVIDER_PROCESS_LOST";

export type AntigravitySwarmStage = "spawned" | "initialized" | "session" | "mode" | "model" | "snapshot" | "helpers";

export interface AntigravitySwarmRuntimeDependencies {
  helperWaitTimeoutMs?: number;
  requestTimeoutMs?: number;
  cancelGraceMs?: number;
  readbackTimeoutMs?: number;
  /** Test seam: runs at every await point between launch and settle. */
  onStage?: (stage: AntigravitySwarmStage) => void | Promise<void>;
  awaitProviderOwnership?: (child: ChildProcess) => Promise<void>;
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};

class ProcessLostError extends Error {
  readonly code = ANTIGRAVITY_SWARM_PROCESS_LOST;
  constructor() { super("The swarm stopped unexpectedly because the Antigravity CLI exited. Retry starts a fresh swarm in the same task folder."); }
}

class RpcError extends Error {
  constructor(readonly method: string, readonly error: Json) {
    super(`${method} failed: ${typeof error.message === "string" ? error.message.slice(0, 500) : "provider error"}`);
  }
}

/** Newline-delimited JSON-RPC over the CLI's stdio. Lines are handled one per macrotask
 * so a response's awaiting caller observes it before the updates that follow it. */
class Connection {
  #next = 1;
  #pending = new Map<number, { method: string; resolve: (value: Json) => void; reject: (error: Error) => void }>();
  #buffer = "";
  #queue: Promise<void> = Promise.resolve();
  #lost: Error | null = null;
  readonly exited: Promise<void>;
  onNotification: (method: string, params: Json) => void = () => {};
  onRequest: (method: string, params: Json) => Promise<unknown> = async () => { throw new Error("unsupported"); };
  onLost: () => void = () => {};

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise(resolve => child.once("close", () => resolve()));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      if (this.#buffer.length > 16 * 1024 * 1024) { this.#fail(new Error("Antigravity CLI output exceeded its bound")); return; }
      for (let index = this.#buffer.indexOf("\n"); index >= 0; index = this.#buffer.indexOf("\n")) {
        const line = this.#buffer.slice(0, index); this.#buffer = this.#buffer.slice(index + 1);
        if (line.trim()) this.#queue = this.#queue.then(() => new Promise<void>(resolve => setImmediate(() => {
          // A handler failure must never escape into the event loop and end the sidecar.
          try { this.#line(line); } catch (error) { this.#fail(error instanceof Error ? error : new Error("Antigravity CLI message could not be handled")); }
          resolve();
        })));
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () => undefined);
    void this.exited.then(() => { void this.#queue.then(() => this.#fail(new ProcessLostError())); });
  }

  get lost(): Error | null { return this.#lost; }

  /** Settle every message already received from the CLI. */
  async drain(): Promise<void> {
    await new Promise(resolve => setImmediate(resolve));
    await this.#queue;
  }

  #fail(error: Error): void {
    if (this.#lost) return;
    this.#lost = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.onLost();
  }

  #line(line: string): void {
    let message: Json;
    try { message = record(JSON.parse(line)); } catch { return; }
    const { id, method } = message;
    if (typeof method === "string") {
      if (id === undefined) { this.onNotification(method, record(message.params)); return; }
      void this.onRequest(method, record(message.params)).then(
        result => this.#write({ jsonrpc: "2.0", id, result }),
        () => this.#write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Not supported by Paperclip" } }),
      );
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (message.error !== undefined) pending.reject(new RpcError(pending.method, record(message.error)));
    else pending.resolve(record(message.result));
  }

  #write(message: Json): void {
    if (this.#lost || this.child.stdin.destroyed) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: Json, timeoutMs: number | null): Promise<Json> {
    if (this.#lost) return Promise.reject(this.#lost);
    const id = this.#next++;
    return new Promise<Json>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = <T>(fn: (value: T) => void) => (value: T) => { if (timer) clearTimeout(timer); fn(value); };
      this.#pending.set(id, { method, resolve: settle(resolve), reject: settle(reject) });
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new AntigravitySwarmError("ANTIGRAVITY_SWARM_RECEIPT_MISMATCH", `The Antigravity CLI did not answer ${method} in time.`));
        }, timeoutMs);
      }
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Json): void { this.#write({ jsonrpc: "2.0", method, params }); }
}

class EventQueue implements AsyncIterable<AcpRuntimeEvent> {
  #items: AcpRuntimeEvent[] = [];
  #waiter: (() => void) | null = null;
  #ended = false;
  push(event: AcpRuntimeEvent): void { if (this.#ended) return; this.#items.push(event); this.#waiter?.(); }
  end(): void { this.#ended = true; this.#waiter?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<AcpRuntimeEvent> {
    for (;;) {
      const item = this.#items.shift();
      if (item) { yield item; continue; }
      if (this.#ended) return;
      await new Promise<void>(resolve => { this.#waiter = resolve; });
      this.#waiter = null;
    }
  }
}

type Snapshot = { files: Map<string, string>; complete: boolean };
/**
 * Bounded, asynchronous listing of the task folder. The limit counts every
 * visited entry, and the walk yields between directories and stops when the
 * turn is stopped, so a large workspace never blocks Stop or provider messages.
 */
async function snapshotWorkspace(root: string, signal: AbortSignal): Promise<Snapshot> {
  const files = new Map<string, string>();
  let visited = 0;
  const pending = [root];
  while (pending.length > 0) {
    if (signal.aborted) return { files, complete: false };
    const directory = pending.pop()!;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++visited > SNAPSHOT_LIMIT) return { files, complete: false };
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path); continue; }
      try {
        const stat = await lstat(path);
        files.set(relative(root, path).split(sep).join("/"), `${stat.size}:${stat.mtimeMs}`);
      } catch { /* removed while listing */ }
    }
  }
  return { files, complete: true };
}

function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = [...after].filter(([path, identity]) => before.get(path) !== identity).map(([path]) => path);
  const removed = [...before.keys()].filter(path => !after.has(path)).map(path => `${path} (removed)`);
  return [...changed, ...removed].sort();
}

function addUsage(total: Json | null, usage: unknown): Json | null {
  const value = record(usage);
  if (Object.keys(value).length === 0) return total;
  const next: Json = { ...(total ?? {}) };
  for (const key of ["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens", "totalTokens"]) {
    if (typeof value[key] === "number") next[key] = (typeof next[key] === "number" ? next[key] as number : 0) + (value[key] as number);
  }
  return next;
}

function failed(code: string, message: string): AcpRuntimeTurnResult {
  return { status: "failed", error: { code, message, retryable: false } };
}

const line = (id: string, title: string): AcpRuntimeEvent =>
  ({ type: "tool_call", tag: "tool_call", toolCallId: `paperclip-swarm-${id}`, text: title, title, kind: "other", status: "completed" });

export async function openAntigravitySwarmRuntime(
  options: AcpxRuntimePortOpenOptions,
  dependencies: AntigravitySwarmRuntimeDependencies = {},
): Promise<AcpxRuntimePort> {
  if (options.mode !== ANTIGRAVITY_SWARM_MODE || options.profile.agent !== "antigravity") {
    throw new Error("The Antigravity CLI route serves only trusted swarm turns");
  }
  options.signal?.throwIfAborted();
  // Host policy the registry route honours and this route cannot: refuse, never drop.
  if (options.readOnly === true) {
    throw new AntigravitySwarmError("ANTIGRAVITY_SWARM_UNAVAILABLE", "Swarm is not available while planning: helpers change files, and a planning run must not. Approve the plan first, then send /swarm.");
  }
  if (options.restoringSession === true) {
    // Typed so the server starts a fresh conversation instead of showing Retry:
    // a swarm's helpers are gone after an interruption and reload resets mode and model.
    throw new AntigravitySavedStateIncompatibleError("a swarm always starts in a fresh session");
  }
  if (options.mcpServers.some(server => !(server.runnerOwned && server.name === ANTIGRAVITY_SWARM_MCP_SERVER))) {
    throw new AntigravitySwarmError("ANTIGRAVITY_SWARM_UNAVAILABLE", "Swarm is not available for this agent: it has other tool servers assigned, and a swarm uses only Paperclip's own tools.");
  }
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const model = options.profile.reportedModelId;
  const bridge = options.mcpServers.find((server): server is Extract<typeof server, { url: string }> =>
    "url" in server && server.runnerOwned && server.name === ANTIGRAVITY_SWARM_MCP_SERVER);
  if (!bridge) throw new AntigravitySwarmError("ANTIGRAVITY_SWARM_UNAVAILABLE", "Swarm needs Paperclip's own tools, which are not available for this run.");
  const home = options.launchEnvironment.HOME ?? userInfo().homedir;
  const instructions = [options.systemInstructions, ANTIGRAVITY_SWARM_INSTRUCTIONS].filter(Boolean).join("\n\n");
  const guard = createAntigravitySwarmGuard({ model, instructions, workspace: options.cwd });

  options.assertWorkspaceHeld?.();
  const lifetime = options.credentialFenceFds && options.activateCredentialFenceOwner
    ? { credentialFenceFds: options.credentialFenceFds, activateCredentialFenceOwner: options.activateCredentialFenceOwner } : undefined;
  const child = options.command.spawn([], { cwd: options.cwd, env: { ...options.launchEnvironment } }, lifetime) as ChildProcessWithoutNullStreams;
  const connection = new Connection(child);
  let retirement: Promise<void> | null = null;
  const retire = () => retirement ??= retireAntigravityProcess(child, connection.exited);

  let updateListener: ((params: Json) => void) | null = null;
  let readback: (() => void) | null = null;
  // A protocol failure outside a turn (for example a changed confirmed mode)
  // is owned here: it fails admission or the next turn, and stops the CLI.
  let protocolFailure: AntigravitySwarmError | null = null;
  connection.onNotification = (method, params) => {
    if (method !== "session/update") return;
    try {
      if (updateListener) updateListener(params);
      else guard.observe(params);
    } catch (error) {
      protocolFailure ??= error instanceof AntigravitySwarmError ? error
        : new AntigravitySwarmError("ANTIGRAVITY_SWARM_RECEIPT_MISMATCH", "The swarm settings changed. Nothing more was run.");
      void retire().catch(() => undefined);
    }
    readback?.();
  };
  const waitForReadback = async (check: () => void): Promise<void> => {
    const deadline = Date.now() + (dependencies.readbackTimeoutMs ?? READBACK_TIMEOUT_MS);
    for (;;) {
      if (protocolFailure) throw protocolFailure;
      try { check(); return; } catch (error) {
        if (Date.now() >= deadline || connection.lost) throw error;
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
          readback = () => { clearTimeout(timer); resolve(); };
        });
        readback = null;
      }
    }
  };

  let sessionId: string;
  let receipt: AntigravitySwarmReceipt;
  // A Stop during admission retires the CLI at once; every await re-checks it.
  const abortAdmission = () => { void retire().catch(() => undefined); };
  options.signal?.addEventListener("abort", abortAdmission, { once: true });
  const stage = async (name: AntigravitySwarmStage) => {
    await dependencies.onStage?.(name);
    options.signal?.throwIfAborted();
  };
  try {
    await (dependencies.awaitProviderOwnership ?? awaitVerifiedAcpxProviderOwnership)(child);
    await stage("spawned");
    const initialized = await connection.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "paperclip-runner", version: "1" },
    }, requestTimeoutMs);
    await stage("initialized");
    guard.initialize(initialized);
    const sessionParams: Json = {
      cwd: options.cwd,
      mcpServers: [{ type: "http", name: ANTIGRAVITY_SWARM_MCP_SERVER, url: bridge.url, headers: [{ name: "Authorization", value: `Bearer ${bridge.bearerToken}` }] }],
      _meta: { antigravity: { systemPrompt: { append: instructions } } },
    };
    guard.sessionRequest(sessionParams);
    let opened: Json;
    try { opened = await connection.request("session/new", sessionParams, requestTimeoutMs); } catch (error) {
      if (error instanceof RpcError && (error.error.code === -32000 || /auth/i.test(String(error.error.message)))) {
        throw new AntigravitySwarmError("ANTIGRAVITY_SWARM_SIGN_IN_REQUIRED",
          "The Antigravity CLI on this computer is not signed in to Google. Sign in to the CLI once, then retry.");
      }
      throw error;
    }
    await stage("session");
    sessionId = guard.sessionResult(opened);
    await connection.request("session/set_mode", { sessionId, modeId: ANTIGRAVITY_CLI_SESSION_MODE }, requestTimeoutMs);
    await waitForReadback(() => guard.bindMode());
    await stage("mode");
    await connection.request("session/set_model", { sessionId, modelId: model }, requestTimeoutMs);
    await waitForReadback(() => guard.bindModel());
    await stage("model");
    await connection.drain();
    guard.assertSwarmCommand();
    receipt = guard.receipt();
    if (protocolFailure) throw protocolFailure;
    options.signal?.throwIfAborted();
  } catch (error) {
    options.signal?.removeEventListener("abort", abortAdmission);
    const cleanup = retire();
    options.retainFailedAdmissionCleanup(cleanup);
    await cleanup.catch(() => undefined);
    throw error;
  }

  options.signal?.removeEventListener("abort", abortAdmission);
  const status: Json = { antigravitySwarmReceipt: receipt };
  let turns = 0;
  let active: { cancel(reason?: string): Promise<void>; result: Promise<AcpRuntimeTurnResult> } | null = null;
  let closed = false;

  const runTurn = async (input: AcpxRuntimeTurnInput, events: EventQueue, started: () => void): Promise<AcpRuntimeTurnResult> => {
    // Stop is installed before the first await, so no later await can miss it.
    const listing = new AbortController();
    let cancelled = false;
    let wake: (() => void) | null = null;
    active!.cancel = async () => { cancelled = true; listing.abort(); connection.notify("session/cancel", { sessionId }); wake?.(); };
    const stopped = (): AcpRuntimeTurnResult => ({ status: "cancelled", stopReason: "cancelled" });
    if (protocolFailure) { started(); return failed(protocolFailure.code, protocolFailure.message); }
    if (turns++ > 0) {
      started();
      return failed("ANTIGRAVITY_SWARM_UNAVAILABLE", "At most one swarm runs per task run. Send another /swarm message to start a new one.");
    }
    const workspace = options.cwd;
    const before = await snapshotWorkspace(workspace, listing.signal);
    await dependencies.onStage?.("snapshot");
    if (cancelled) { started(); return stopped(); }
    const helpers = new Map<string, string>();
    let blocked = 0;
    let waitedAfterLastAdd = false;
    let transcript = "";
    let stop: AntigravitySwarmError | null = null;
    const halt = (error: AntigravitySwarmError) => { stop ??= error; connection.notify("session/cancel", { sessionId }); wake?.(); };
    events.push(line("setup", `Swarm started in the task folder with ${receipt.model}. Helper changes inside the task folder are approved automatically; anything else is blocked.`));

    updateListener = params => {
      try { guard.observe(params); } catch (error) {
        halt(error instanceof AntigravitySwarmError ? error : new AntigravitySwarmError("ANTIGRAVITY_SWARM_RECEIPT_MISMATCH", "The swarm settings changed."));
        return;
      }
      if (params.sessionId !== sessionId) return;
      const update = record(params.update);
      const escaped = antigravitySwarmWorkspaceEscape(update);
      if (escaped) {
        halt(new AntigravitySwarmError("ANTIGRAVITY_SWARM_WORKSPACE_ESCAPE",
          `Swarm stopped: helper ${escaped} was asked to work on its own copy of the task folder, which Paperclip does not allow.`));
        return;
      }
      const outside = antigravityOutsideChange(update, workspace, home);
      if (outside) {
        halt(new AntigravitySwarmError("ANTIGRAVITY_SWARM_WORKSPACE_ESCAPE",
          `Swarm stopped: it tried to change ${outside}, which is outside the task folder.`));
        return;
      }
      const args = { ...record(update.rawInput), ...record(update.args) };
      if (update.sessionUpdate === "tool_call" && update.name === "swarm" && args.action === "add" && typeof args.name === "string") {
        helpers.set(args.name, typeof args.brief === "string" ? args.brief : "");
        waitedAfterLastAdd = false;
      }
      if (update.sessionUpdate === "tool_call_update" && update.status === "completed" && (update.name === "read_board" || update.name === "swarm_wait")) {
        waitedAfterLastAdd = true;
      }
      const content = record(update.content);
      const text = typeof content.text === "string" ? content.text : JSON.stringify(update.rawOutput ?? "");
      if (update.sessionUpdate === "agent_message_chunk" && typeof content.text === "string") transcript += content.text;
      if (BLOCKED_TEXT.test(text)) {
        blocked += 1;
        events.push(line(`blocked-${blocked}`, "A helper was blocked from changing something outside the task folder"));
      }
      const event = antigravitySwarmEvent(update, workspace);
      if (event) events.push(event);
    };
    connection.onRequest = async (method, params) => {
      if (method !== "session/request_permission" || params.sessionId !== sessionId) throw new Error("unsupported");
      const toolCall = record(params.toolCall);
      const meta = record(record(toolCall._meta).mcp);
      const choices = Array.isArray(params.options) ? params.options.map(record) : [];
      // Only Paperclip's own tool server is approved here; auto mode already
      // allows the task folder, so anything else that asks is outside it.
      const paperclip = meta.server === ANTIGRAVITY_SWARM_MCP_SERVER;
      const choice = choices.find(option => option.kind === (paperclip ? "allow_once" : "reject_once"));
      if (!paperclip) {
        blocked += 1;
        const title = typeof toolCall.title === "string" ? toolCall.title.split(workspace).join(".") : "an action outside the task folder";
        events.push(line(`blocked-${blocked}`, `Blocked: ${title.slice(0, 160)}`));
      }
      return choice ? { outcome: { outcome: "selected", optionId: choice.optionId } } : { outcome: { outcome: "cancelled" } };
    };

    let usage: Json | null = null;
    const prompt = async (text: string, timeoutMs: number | null): Promise<string> => {
      if (cancelled || stop) return "cancelled";
      const response = connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, null);
      started();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const interrupted = new Promise<"interrupted">(resolve => {
        wake = () => resolve("interrupted");
        if (timeoutMs !== null) timer = setTimeout(() => resolve("interrupted"), timeoutMs);
      });
      try {
        const outcome = await Promise.race([response, interrupted]);
        if (outcome === "interrupted") {
          if (!stop && !cancelled) halt(new AntigravitySwarmError("ANTIGRAVITY_SWARM_HELPERS_TIMEOUT",
            "The helpers did not finish in time, so Paperclip stopped the swarm. Files they already wrote stay in the task folder."));
          const grace = dependencies.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
          const settled = await Promise.race([response.then(() => true, () => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), grace))]);
          if (!settled) await retire().catch(() => undefined);
          return "cancelled";
        }
        usage = addUsage(usage, outcome.usage);
        if (usage) {
          // Billable usage is kept whatever the turn's outcome turns out to be.
          status.lastRequestId = input.requestId;
          status.terminalPromptUsage = { requestId: input.requestId, promptId: `${input.requestId}:swarm`,
            event: { type: "status", tag: "usage_update", text: "terminal prompt usage", breakdown: usage } };
        }
        return typeof outcome.stopReason === "string" ? outcome.stopReason : "end_turn";
      } finally {
        if (timer) clearTimeout(timer);
        wake = null;
      }
    };
    const dispatch = input.dispatchJournal?.markReceived() ? input.dispatchJournal : null;
    try {
      dispatch?.markDispatched();
      let stopReason = await prompt(`/swarm ${input.text}`, null);
      if (stopReason === "end_turn" && !stop && !cancelled && helpers.size > 0 && !waitedAfterLastAdd && !classifyAntigravityRefusalText(transcript)) {
        events.push(line("wait", "Waiting for the helpers to finish"));
        transcript += "\n";
        await dependencies.onStage?.("helpers");
        stopReason = await prompt(HELPER_WAIT_PROMPT, dependencies.helperWaitTimeoutMs ?? DEFAULT_HELPER_WAIT_TIMEOUT_MS);
      }
      const halted = stop as AntigravitySwarmError | null;
      if (halted) return failed(halted.code, halted.message);
      if (cancelled || stopReason === "cancelled") return stopped();
      const refusal = classifyAntigravityRefusalText(transcript);
      if (refusal) {
        input.onTerminalSessionFailure?.({ category: refusal.kind === "authentication" ? "access" : "limit", title: refusal.message,
          provider: { kind: refusal.kind, ...(refusal.httpStatus ? { httpStatus: refusal.httpStatus } : {}), ...(refusal.status ? { status: refusal.status } : {}) } });
        return failed(refusal.kind === "authentication" ? "ANTIGRAVITY_SWARM_SIGN_IN_REQUIRED" : "ANTIGRAVITY_SWARM_PROVIDER_REFUSED", refusal.message);
      }
      // What the swarm changed is recorded from the task folder itself, never
      // from what the coordinator or helpers say (helpers can misreport).
      // Done still requires the hand-in through Paperclip's finish tool.
      const after = await snapshotWorkspace(workspace, listing.signal);
      const changed = changedFiles(before.files, after.files);
      events.push(line("files", !before.complete || !after.complete ? "The task folder is too large to list every change"
        : changed.length ? `Files changed in the task folder: ${changed.slice(0, 20).join(", ")}${changed.length > 20 ? ", …" : ""}` : "No files changed in the task folder"));
      return { status: "completed", stopReason: "end_turn" };
    } catch (error) {
      if (connection.lost instanceof ProcessLostError || error instanceof ProcessLostError) {
        return cancelled ? { status: "cancelled", stopReason: "cancelled" } : failed(ANTIGRAVITY_SWARM_PROCESS_LOST, new ProcessLostError().message);
      }
      return failed(error instanceof AntigravitySwarmError ? error.code : "ANTIGRAVITY_SWARM_FAILED",
        error instanceof Error ? error.message.slice(0, 1_000) : "The swarm failed.");
    } finally {
      updateListener = null;
      if (usage) events.push(line("usage", "Token usage is the coordinator's total and includes the helpers; Google does not report it per helper"));
    }
  };

  const port: AcpxRuntimePort = {
    async identity(): Promise<AcpxRuntimePortIdentity> {
      // The record is stable per provider session key; the CLI session id is per run and never reloaded.
      return { mode: ANTIGRAVITY_SWARM_MODE, acpxRecordId: `antigravity-cli:${options.providerSessionKey}`, backendSessionId: sessionId, agentSessionId: sessionId };
    },
    async getStatus(): Promise<AcpxModelStatus> {
      return { ...structuredClone(status), models: { currentModelId: model, availableModelIds: [model] } };
    },
    startTurn(input: AcpxRuntimeTurnInput): AcpxRuntimeTurn {
      if (closed) throw new Error("The Antigravity swarm session is closed");
      if (active) throw new Error("A swarm turn is already running");
      const events = new EventQueue();
      let markStarted!: () => void;
      const promptStarted = new Promise<void>(resolve => { markStarted = resolve; });
      const turn = { cancel: async (_reason?: string) => {}, result: Promise.resolve() as unknown as Promise<AcpRuntimeTurnResult> };
      active = turn;
      const onAbort = () => { void turn.cancel(); };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      turn.result = runTurn(input, events, markStarted).finally(() => {
        markStarted();
        events.end();
        input.signal?.removeEventListener("abort", onAbort);
        if (active === turn) active = null;
      });
      return {
        requestId: input.requestId, promptStarted, events, result: turn.result,
        cancel: async () => { await turn.cancel(); },
        closeStream: async () => { events.end(); },
      };
    },
    async close(): Promise<void> {
      closed = true;
      const turn = active;
      if (turn) { await turn.cancel(); await Promise.race([turn.result, new Promise(resolve => setTimeout(resolve, dependencies.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS))]); }
      await retire();
    },
  };
  return port;
}
