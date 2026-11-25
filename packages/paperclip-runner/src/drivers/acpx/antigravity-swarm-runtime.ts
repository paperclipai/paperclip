import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, open as openFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { AcpRuntimeEvent, AcpRuntimeTurnResult } from "acpx/runtime";
import { userInfo } from "node:os";
import { AntigravitySavedStateIncompatibleError } from "./antigravity-admission.js";
import { retireAntigravityProcess } from "./antigravity-process.js";
import { trackAntigravityProcessLineage, type ProcessTableRead } from "./antigravity-process-lineage.js";
import { antigravityOutsideChange } from "./antigravity-swarm-paths.js";
import { antigravityAccountDigest, antigravitySwarmChannelLabel, antigravitySwarmLogFile } from "./antigravity-swarm-route.js";
import {
  ANTIGRAVITY_CLI_SESSION_MODE, ANTIGRAVITY_SWARM_MCP_SERVER, ANTIGRAVITY_SWARM_MODE, AntigravitySwarmError,
  antigravitySwarmWorkspaceEscape, classifyAntigravityRefusalText, createAntigravitySwarmGuard,
  type AntigravitySwarmReceipt,
} from "./antigravity-swarm-guard.js";
import { GENERATED_ANTIGRAVITY_SWARM_DEFAULT_CHANNEL, GENERATED_ANTIGRAVITY_SWARM_ENVELOPE_SCHEMA, GENERATED_ANTIGRAVITY_SWARM_REQUEST_FIELD, GENERATED_ANTIGRAVITY_SWARM_REQUEST_MAX_CHARS } from "./generated-sidecar-contract.js";
import { antigravitySwarmEvent, createAntigravityTerminalHintFilter } from "./antigravity-swarm-presentation.js";
import { acpRuntimeEventFromValidatedSessionUpdate } from "./acp-session-update-event.js";
import { awaitVerifiedAcpxProviderOwnership } from "./installation-integrity.js";
import { canonicalRunnerToolName } from "../runner-tool-bridge.js";
import { PRP_BLOCK_TOOL_NAME, PRP_COMPLETION_TOOL_NAME } from "../../contracts/completion-result.js";
import type { AcpxModelStatus } from "./model-verification.js";
import type { AcpxRuntimePort, AcpxRuntimePortIdentity, AcpxRuntimePortOpenOptions, AcpxRuntimeTurn, AcpxRuntimeTurnInput } from "./runtime-host.js";

/**
 * Runtime port for the Antigravity CLI route (`agy acp`), used only for a turn
 * the signed-in user started with `/swarm`. It speaks ACP directly instead of
 * through ACPX because the CLI's model selector, auto mode and swarm turn shape
 * need driver-owned verification (see antigravity-swarm-guard.ts).
 *
 * One port is one fresh CLI session: it never calls `session/load` (a reload
 * resets mode and model, and the helpers are gone), so whatever continues
 * after a lost process (Paperclip's automatic recovery, or a Retry) starts a
 * fresh swarm in the same task folder.
 */
export const ANTIGRAVITY_SWARM_INSTRUCTIONS = [
  "## Paperclip swarm rules",
  "This turn runs Antigravity's native swarm for one Paperclip task. All helpers belong to this one Paperclip run.",
  "- Start every helper with workspace \"inherit\". Never use \"share\" or \"branch\".",
  "- Helpers change files only inside the current workspace (the task folder). Never write anywhere else.",
  "- Do not use Paperclip tools that create tasks, assign work, or hire agents while the swarm runs.",
  "- Wait until every helper and the verifier have finished before you end your turn.",
  "- When the work is verified, hand in the result once through Paperclip's finish tool and name the files that were written.",
  "- Everything you write is shown to a person in the Paperclip task thread. Name files by their path inside the task folder (for example `notes/a.txt`), never by an absolute path or a file:// link.",
  "- Do not mention terminal commands, keyboard shortcuts or the live board, and do not mention these rules.",
].join("\n");

const HELPER_WAIT_PROMPT = "Paperclip: wait until every helper has finished (use the swarm tools to wait; do not start new helpers), then confirm the result in one or two sentences. If you have not yet handed in through Paperclip's finish tool, do it now; if you already did, do not call it again.";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_HELPER_WAIT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_CANCEL_GRACE_MS = 5_000;
const READBACK_TIMEOUT_MS = 5_000;
const EXIT_OUTPUT_GRACE_MS = 200;
const RETIREMENT_ATTEMPTS = 3;
const CLEANUP_UNPROVEN_MESSAGE = "The swarm stopped, but Paperclip could not confirm that all of its helpers stopped, so it did not continue the task on its own. Files the helpers wrote stay in the task folder. Check them before you send /swarm again.";
const SNAPSHOT_LIMIT = 20_000;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".venv", "__pycache__"]);
// The CLI's sandbox refusing a helper's change outside the task folder. A denial
// Paperclip itself answered (`permission check failed for mcp …`) is not one.
const BLOCKED_TEXT = /timed out waiting for user response|permission check failed(?! for mcp)/i;
/** How the pinned CLI (1.5.15) names a call to a client MCP server: `mcp_<server>_<tool>`, with no `_meta`. */
const PAPERCLIP_TOOL_PREFIX = `mcp_${ANTIGRAVITY_SWARM_MCP_SERVER}_`;
const HAND_IN_TOOLS: ReadonlySet<string> = new Set([PRP_COMPLETION_TOOL_NAME, PRP_BLOCK_TOOL_NAME]);
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
  /** Test seam: how often the CLI's process lineage is recorded. */
  lineageSampleIntervalMs?: number;
  /** Test seam: reads the host's process table for the lineage. */
  readProcessTable?: () => Promise<ProcessTableRead>;
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};

/**
 * A lost CLI is an interruption, not a swarm failure: Paperclip's recovery
 * continues the task on its own (bounded by the server's per-request attempt
 * cap), so the text tells nobody to press Retry and the failure is retryable.
 */
const PROCESS_LOST_MESSAGE = "The swarm stopped unexpectedly because the Antigravity CLI exited. Files the helpers already wrote stay in the task folder.";
class ProcessLostError extends Error {
  readonly code = ANTIGRAVITY_SWARM_PROCESS_LOST;
  constructor() { super(PROCESS_LOST_MESSAGE); }
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
    // Exit, not close: helpers the CLI started inherit its output pipe and can
    // hold it open long after the CLI died. Output already written is read for
    // a short moment after exit; the lost CLI cannot answer anything later.
    this.exited = new Promise(resolve => child.once("exit", () => {
      if (child.stdout.readableEnded || child.stdout.destroyed) { resolve(); return; }
      const timer = setTimeout(resolve, EXIT_OUTPUT_GRACE_MS);
      child.stdout.once("close", () => { clearTimeout(timer); resolve(); });
    }));
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

/** Per counter, the larger of two usage readings. */
function largerUsage(total: Json, reading: Json): Json {
  const next: Json = { ...total };
  for (const [key, value] of Object.entries(reading)) {
    if (typeof value === "number") next[key] = Math.max(typeof next[key] === "number" ? next[key] as number : 0, value);
  }
  return next;
}

/**
 * The swarm's only instruction is the user's recorded request, which Paperclip
 * carries in the model envelope's own `swarmRequest` field (from the execution
 * input's `provider.swarmRequest`). It is never read back out of `task.prompt`:
 * that field holds rendered wake comments, task context and text the Runner
 * adds, none of which may reach the auto-approved coordinator as the request.
 * The text is sent verbatim.
 */
export function antigravitySwarmRequestText(turnText: string): string | null {
  let envelope: Json;
  try { envelope = record(JSON.parse(turnText)); } catch { return null; }
  if (envelope.schema !== GENERATED_ANTIGRAVITY_SWARM_ENVELOPE_SCHEMA) return null;
  const request = envelope[GENERATED_ANTIGRAVITY_SWARM_REQUEST_FIELD];
  return typeof request === "string" && request.trim() && request.length <= GENERATED_ANTIGRAVITY_SWARM_REQUEST_MAX_CHARS ? request : null;
}

/**
 * The Paperclip tool a CLI permission request or tool update names, when it is
 * one the run's Paperclip bridge admits (its served catalog for a swarm turn plus
 * the reserved finish and block tools). The swarm session has no other MCP
 * server (admission refuses one), so the `mcp_paperclip_` prefix can only mean
 * Paperclip's bridge; anything else, or a tool outside the admitted set, is null.
 */
export function antigravitySwarmPaperclipTool(toolCall: unknown, admitted: ReadonlySet<string>): string | null {
  const name = record(toolCall).name;
  if (typeof name !== "string" || !name.startsWith(PAPERCLIP_TOOL_PREFIX)) return null;
  const tool = canonicalRunnerToolName(name.slice(PAPERCLIP_TOOL_PREFIX.length));
  return tool && admitted.has(tool) ? tool : null;
}

export type AntigravityCliAccountReason = "no_connection_account" | "cli_sign_in_not_found";

/** One line for the run's history: whether the CLI's own Google sign-in is the agent's connection account. */
function accountLine(match: AntigravityCliAccountMatch, reason: AntigravityCliAccountReason | null): string {
  if (match === "matches") return "This swarm runs on the Google account of this agent's Google connection.";
  if (match === "does_not_match") return "This swarm runs on the Google account signed in to this computer, which is different from this agent's Google connection.";
  return reason === "no_connection_account"
    ? "Paperclip could not confirm which Google account this swarm runs on: this agent's Google connection names no account."
    : "Paperclip could not confirm which Google account this swarm runs on: the Antigravity CLI did not record its sign-in.";
}

function failed(code: string, message: string): AcpRuntimeTurnResult {
  return { status: "failed", error: { code, message, retryable: false } };
}

const line = (id: string, title: string): AcpRuntimeEvent =>
  ({ type: "tool_call", tag: "tool_call", toolCallId: `paperclip-swarm-${id}`, text: title, title, kind: "other", status: "completed" });

export type AntigravityCliAccountMatch = "matches" | "does_not_match" | "unknown";
const CLI_LOG_TAIL_BYTES = 512 * 1024;

/**
 * Whether the Google account the CLI signed in with is the agent's connection
 * account. The CLI exposes its sign-in only in its own log (`applyAuthResult:
 * email=…`; ACP `initialize` carries no account). Both sides are compared as
 * digests inside the Runner; neither account is returned, logged or stored.
 */
export async function antigravityCliAccountMatch(logFile: string, connectionDigest: string | null): Promise<AntigravityCliAccountMatch> {
  if (!connectionDigest) return "unknown";
  let text = "";
  try {
    const file = await openFile(logFile, "r");
    try {
      const { size } = await file.stat();
      const length = Math.min(size, CLI_LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, size - length);
      text = buffer.toString("utf8");
    } finally { await file.close(); }
  } catch { return "unknown"; }
  const signedIn = [...text.matchAll(/applyAuthResult: email=([^\s,]+@[^\s,]+),/g)].at(-1)?.[1];
  if (!signedIn) return "unknown";
  return antigravityAccountDigest(signedIn) === connectionDigest ? "matches" : "does_not_match";
}

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
  const channel = options.antigravitySwarm?.channel ?? GENERATED_ANTIGRAVITY_SWARM_DEFAULT_CHANNEL;
  const guard = createAntigravitySwarmGuard({ model, instructions, workspace: options.cwd, channel });

  options.assertWorkspaceHeld?.();
  const lifetime = options.credentialFenceFds && options.activateCredentialFenceOwner
    ? { credentialFenceFds: options.credentialFenceFds, activateCredentialFenceOwner: options.activateCredentialFenceOwner } : undefined;
  const child = options.command.spawn([], { cwd: options.cwd, env: { ...options.launchEnvironment } }, lifetime) as ChildProcessWithoutNullStreams;
  const connection = new Connection(child);
  // Helpers lead their own process groups, so stopping the launcher's group is
  // not enough: everything the CLI started is recorded while it runs and is
  // stopped with it (see antigravity-process-lineage.ts).
  const lineage = trackAntigravityProcessLineage(child.pid, { sampleIntervalMs: dependencies.lineageSampleIntervalMs, readTable: dependencies.readProcessTable });
  let retirement: Promise<void> | null = null;
  // Only a proven retirement is kept: after a failure, the next call tries again.
  const retire = () => retirement ??= retireAntigravityProcess(child, connection.exited)
    .finally(() => lineage.terminate())
    .catch((error: unknown) => { retirement = null; throw error; });

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
  let cliAccount: AntigravityCliAccountMatch = "unknown";
  const accountDigest = options.antigravitySwarm?.accountDigest ?? null;
  const paperclipTools: ReadonlySet<string> = new Set(options.paperclipTools ?? []);
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
    cliAccount = options.antigravityStateDirectory
      ? await antigravityCliAccountMatch(antigravitySwarmLogFile(options.antigravityStateDirectory), accountDigest)
      : "unknown";
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
  // Diagnostics only: the channel and whether the CLI's own sign-in is the agent's connection account (never the account itself).
  const accountReason: AntigravityCliAccountReason | null = cliAccount !== "unknown" ? null
    : accountDigest ? "cli_sign_in_not_found" : "no_connection_account";
  const status: Json = { antigravitySwarmReceipt: { ...receipt, channel, cliAccountMatchesConnection: cliAccount,
    ...(accountReason ? { cliAccountUnknownReason: accountReason } : {}) } };
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
    const request = antigravitySwarmRequestText(input.text);
    if (!request) {
      started();
      return failed("ANTIGRAVITY_SWARM_UNAVAILABLE", "This swarm has no request to run. Send /swarm with what the swarm should do.");
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
    events.push(line("setup", `Swarm started in the task folder with ${receipt.modelName} on ${antigravitySwarmChannelLabel(channel)} (Antigravity CLI ${receipt.agentVersion}). Helper changes inside the task folder are approved automatically; anything else is blocked.`));
    // Always recorded in the run's history, including when it cannot be told.
    events.push(line("account", accountLine(cliAccount, accountReason)));
    // Binds this turn's receipt notice and usage to its request (usage-accounting.ts, antigravity-activity.ts).
    status.lastRequestId = input.requestId;
    // Calls Paperclip's own handler refused (each already reported once), and whether the swarm handed in.
    const deniedCalls = new Set<string>();
    let handedIn = false;
    // Coordinator text passes the terminal-hint filter; any other step first releases the text it holds, so order is kept.
    const hints = createAntigravityTerminalHintFilter();
    const releaseText = () => {
      const held = hints.flush();
      if (held) events.push({ type: "text_delta", text: held, stream: "output", tag: "agent_message_chunk" });
    };
    const show = (event: AcpRuntimeEvent) => {
      if (event.type === "text_delta" && event.stream === "output") {
        const text = hints.push(event.text);
        if (text) events.push({ ...event, text });
        return;
      }
      releaseText();
      events.push(event);
    };
    // The token counts the CLI last streamed during the current prompt, kept only when that prompt's own answer never arrives.
    let streamedUsage: Json | null = null;

    updateListener = params => {
      try { guard.observe(params); } catch (error) {
        halt(error instanceof AntigravitySwarmError ? error : new AntigravitySwarmError("ANTIGRAVITY_SWARM_RECEIPT_MISMATCH", "The swarm settings changed."));
        return;
      }
      if (params.sessionId !== sessionId) return;
      const update = record(params.update);
      if (update.sessionUpdate === "usage_update") {
        const breakdown = record(record(acpRuntimeEventFromValidatedSessionUpdate({ method: "session/update", params })).breakdown);
        if (Object.keys(breakdown).length > 0) streamedUsage = breakdown;
      }
      const escaped = antigravitySwarmWorkspaceEscape(update);
      if (escaped) {
        halt(new AntigravitySwarmError("ANTIGRAVITY_SWARM_WORKSPACE_ESCAPE",
          `Swarm stopped: helper ${escaped} was asked to work on its own copy of the task folder, which Paperclip does not allow.`));
        return;
      }
      const outside = antigravityOutsideChange(update, workspace, home, options.antigravityStateDirectory);
      if (outside) {
        halt(new AntigravitySwarmError("ANTIGRAVITY_SWARM_WORKSPACE_ESCAPE",
          `Swarm stopped: it tried to change ${outside}, which is outside the task folder.`));
        return;
      }
      if (update.sessionUpdate === "tool_call_update" && update.status === "completed") {
        const tool = antigravitySwarmPaperclipTool(update, paperclipTools);
        if (tool && HAND_IN_TOOLS.has(tool)) handedIn = true;
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
      if (BLOCKED_TEXT.test(text) && !(typeof update.toolCallId === "string" && deniedCalls.has(update.toolCallId))) {
        blocked += 1;
        show(line(`blocked-${blocked}`, "A helper was blocked from changing something outside the task folder"));
      }
      const event = antigravitySwarmEvent(update, workspace);
      if (event) show(event);
    };
    connection.onRequest = async (method, params) => {
      if (method !== "session/request_permission" || params.sessionId !== sessionId) throw new Error("unsupported");
      const toolCall = record(params.toolCall);
      const choices = Array.isArray(params.options) ? params.options.map(record) : [];
      // Only the run's own Paperclip tools are approved here (the CLI asks before
      // every client MCP call); auto mode already allows the task folder, so
      // anything else that asks is outside it. The CLI ends the whole turn on a
      // denial, so a refused call is reported once and ends the swarm plainly.
      const paperclip = antigravitySwarmPaperclipTool(toolCall, paperclipTools) !== null;
      const choice = choices.find(option => option.kind === (paperclip ? "allow_once" : "reject_once"));
      if (!paperclip) {
        blocked += 1;
        if (typeof toolCall.toolCallId === "string") deniedCalls.add(toolCall.toolCallId);
        const requested = typeof toolCall.name === "string" && toolCall.name.startsWith(PAPERCLIP_TOOL_PREFIX)
          ? `Paperclip does not allow ${toolCall.name.slice(PAPERCLIP_TOOL_PREFIX.length).slice(0, 80)} during a swarm`
          : `Blocked: ${(typeof toolCall.title === "string" ? toolCall.title.split(workspace).join(".") : "an action outside the task folder").slice(0, 160)}`;
        show(line(`blocked-${blocked}`, requested));
      }
      return choice ? { outcome: { outcome: "selected", optionId: choice.optionId } } : { outcome: { outcome: "cancelled" } };
    };

    let usage: Json | null = null;
    /**
     * Billable usage is kept whatever the turn's outcome: the prompt's own answer
     * (the CLI answers a stopped prompt too), or, when that answer never arrives
     * (the CLI exited, or did not answer within the grace), what it streamed.
     */
    const keepUsage = (reported: unknown) => {
      const answered = record(reported);
      if (Object.keys(answered).length > 0) usage = addUsage(usage, answered);
      // Whether a streamed count covers this prompt or the whole session is not known, so
      // after an answered prompt it can raise a counter but never adds to it (no double count).
      else if (streamedUsage) usage = usage ? largerUsage(usage, streamedUsage) : addUsage(null, streamedUsage);
      streamedUsage = null;
      if (usage) {
        status.terminalPromptUsage = { requestId: input.requestId, promptId: `${input.requestId}:swarm`,
          event: { type: "status", tag: "usage_update", text: "terminal prompt usage", breakdown: usage } };
      }
    };
    const prompt = async (text: string, timeoutMs: number | null): Promise<string> => {
      if (cancelled || stop) return "cancelled";
      streamedUsage = null;
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
          const settled = await Promise.race([response.then(reply => ({ reply }), () => ({ reply: null })),
            new Promise<null>(resolve => setTimeout(() => resolve(null), grace))]);
          keepUsage(settled?.reply?.usage);
          if (!settled) await retire().catch(() => undefined);
          return "cancelled";
        }
        keepUsage(outcome.usage);
        return typeof outcome.stopReason === "string" ? outcome.stopReason : "end_turn";
      } catch (error) {
        // The CLI exited mid-prompt: its answer is lost, so what it streamed is what can be kept.
        keepUsage(undefined);
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        wake = null;
      }
    };
    const dispatch = input.dispatchJournal?.markReceived() ? input.dispatchJournal : null;
    try {
      dispatch?.markDispatched();
      let stopReason = await prompt(`/swarm ${request}`, null);
      if (stopReason === "end_turn" && !stop && !cancelled && helpers.size > 0 && !waitedAfterLastAdd && !classifyAntigravityRefusalText(transcript)) {
        show(line("wait", "Waiting for the helpers to finish"));
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
      // The CLI reports its own failures (for example a toolbox it could not build)
      // as text and ends the turn normally. The detail is internal; say it plainly.
      if (/⚠\s*agent executor error:/i.test(transcript.slice(0, 8_000))) {
        return failed("ANTIGRAVITY_SWARM_FAILED", "The Antigravity CLI stopped with an internal error, so the swarm did not finish. Send /swarm again to retry.");
      }
      // What the swarm changed is recorded from the task folder itself, never
      // from what the coordinator or helpers say (helpers can misreport).
      // Done still requires the hand-in through Paperclip's finish tool.
      const after = await snapshotWorkspace(workspace, listing.signal);
      const changed = changedFiles(before.files, after.files);
      show(line("files", !before.complete || !after.complete ? "The task folder is too large to list every change"
        : changed.length ? `Files changed in the task folder: ${changed.slice(0, 20).join(", ")}${changed.length > 20 ? ", …" : ""}` : "No files changed in the task folder"));
      // A swarm that ended without handing in is a typed swarm failure the person
      // retries, never an interruption Paperclip resumes or retries on its own
      // (each attempt is a full, billed swarm).
      // The reason comes from what happened, including the task folder itself, so
      // nobody repeats the request without knowing changes are already there.
      if (!handedIn) {
        const listed = before.complete && after.complete;
        const why = deniedCalls.size > 0
          ? "The swarm stopped because Paperclip blocked an action it may not take during a swarm, so nothing was handed in."
          : "The swarm ended without handing in a result.";
        const message = !listed
          ? `${why} Paperclip could not check every file in the task folder, so changes may remain there. Check them before you send /swarm again.`
          : changed.length > 0
            ? `${why} ${changed.length === 1 ? "1 file change it made stays" : `${changed.length} file changes it made stay`} in the task folder. Check them before you send /swarm again.`
            : deniedCalls.size > 0 ? `${why} No files changed. Send /swarm again to retry.`
              : helpers.size === 0 ? "The swarm ended without doing any work. Send /swarm again to retry."
                : "The swarm ended without handing in a result, and no files changed. Send /swarm again to retry.";
        return failed("ANTIGRAVITY_SWARM_NO_RESULT" satisfies AntigravitySwarmError["code"], message);
      }
      return { status: "completed", stopReason: "end_turn" };
    } catch (error) {
      if (connection.lost instanceof ProcessLostError || error instanceof ProcessLostError) {
        return cancelled ? { status: "cancelled", stopReason: "cancelled" }
          : { status: "failed", error: { code: ANTIGRAVITY_SWARM_PROCESS_LOST, message: PROCESS_LOST_MESSAGE, retryable: true } };
      }
      return failed(error instanceof AntigravitySwarmError ? error.code : "ANTIGRAVITY_SWARM_FAILED",
        error instanceof Error ? error.message.slice(0, 1_000) : "The swarm failed.");
    } finally {
      updateListener = null;
      releaseText();
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
      // A swarm turn is the port's only turn. Unless it completed, the CLI and
      // every process it started are stopped before the outcome is reported, so
      // nothing keeps writing in the task folder and recovery never races them.
      turn.result = runTurn(input, events, markStarted).then(async result => {
        if (result.status === "completed") return result;
        for (let attempt = 1; ; attempt++) {
          try { await retire(); return result; } catch {
            // Without proof that every helper stopped, Paperclip must not continue
            // the task on its own in the same folder: report a failure it does not recover.
            if (attempt >= RETIREMENT_ATTEMPTS) return failed("ANTIGRAVITY_SWARM_FAILED", CLEANUP_UNPROVEN_MESSAGE);
          }
        }
      }).finally(() => {
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
