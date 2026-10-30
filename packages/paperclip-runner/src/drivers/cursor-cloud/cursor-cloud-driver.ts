import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HarnessDriver, HarnessDriverDescriptor, HarnessSession, HarnessSessionRecoveryOptions, OpenHarnessSessionInput, PersistedHarnessSession } from "../../contracts/harness-driver.js";
import { HarnessCapabilityUnavailableError, HarnessReconciliationError, HarnessStaleTurnError } from "../../contracts/harness-driver.js";
import type { NativeRuntimeContextSnapshot } from "../../contracts/runtime-context.js";
import type { NativeUserMessage } from "../../contracts/types.js";
import { CURSOR_CLOUD_CANCEL_TIMEOUT_MS, CURSOR_CLOUD_DEFAULT_TIMEOUT_MS } from "../../contracts/cursor-cloud.js";
import { PRP_BLOCK_TOOL_NAME, PRP_COMPLETION_TOOL_NAME } from "../../contracts/completion-result.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { RUNNER_TOOL_SCOPE_TOKEN_HEADER, startRunnerToolBridge, type RunnerToolBridge, type RunnerToolCall } from "../runner-tool-bridge.js";
import { semanticCanonicalJson } from "../semantic-tool-receipt.js";
import { CursorCloudClient, CursorCloudClientError, isCursorCloudUnsentRequestError, isCursorCloudRunActive, type CursorCloudModelRef, type CursorCloudRun, type CursorCloudSseEvent } from "./cloud-client.js";
import { CURSOR_CLOUD_MCP_SERVER_NAME, parseNativeCursorCloudConfig, parseCursorCloudBinding, type NativeCursorCloudConfig, type CursorCloudBinding } from "./config.js";
import { CursorCloudCheckpointStore, cursorCloudDigest, type CursorCloudCheckpoint, type CursorCloudTerminalDelivery } from "./checkpoint.js";
import { cursorCloudInlineInstructions } from "./inline-assets.js";
import { stageCursorCloudArtifact } from "./artifact-delivery.js";
import { releaseCursorCloudStaleSocket } from "./stale-socket.js";

export const CURSOR_CLOUD_DRIVER_KIND = "cursor_cloud_api" as const;
export const CURSOR_CLOUD_DRIVER_VERSION = "cursor-cloud-v1" as const;
const CURSOR_CLOUD_CONTROL_INSTRUCTIONS = [
  "You are executing in native Paperclip Runner, not a legacy REST adapter.",
  `Paperclip control tools are provided by the injected MCP server "${CURSOR_CLOUD_MCP_SERVER_NAME}" with controller-managed MCP authentication; you do not need Paperclip REST credentials in the Cloud VM.`,
  `At the start of each run, call get_mcp_tools({server:"${CURSOR_CLOUD_MCP_SERVER_NAME}"}) to discover its tools, then use the returned tool schemas for Paperclip task context and control.`,
  "For Paperclip control, do not search unrelated inherited dashboard MCP namespaces or wait for their authentication.",
  `When you need a human answer, use this server's offered request_human_input tool. Report completion with its offered ${PRP_COMPLETION_TOOL_NAME} tool, or a blocker with its offered ${PRP_BLOCK_TOOL_NAME} tool, following their schemas. Text alone does not submit a question, completion, or blocker.`,
].join("\n");
type TurnAuthority = { generation: number; ownerRunId: string; turnId: string | null };
type RemoteAuthority = TurnAuthority & { agentId: string; runId: string };
type PendingAuthority = TurnAuthority & Pick<CursorCloudCheckpoint, "pendingOperation" | "requestedAgentId" | "idempotencyKey" | "agentId">;
type CloudClient = Pick<CursorCloudClient, "createAgent" | "createRun" | "getAgent" | "getRun" | "cancelRun" | "streamRun" | "getUsage" | "listArtifacts" | "downloadArtifact">;

export interface CursorCloudSessionHandle extends HarnessSession {
  read(): Promise<Record<string, unknown>>;
  acknowledgeTerminalDelivery(input: { turnId: string; receiptId: string }): Promise<void>;
}

export interface CursorCloudDriverOptions {
  model: string;
  modelParams?: CursorCloudModelRef["params"];
  config: NativeCursorCloudConfig;
  binding: CursorCloudBinding;
  runtimeDirectory: string;
  artifactRoot?: string;
  relay: { url: string; token: string; socketPath: string; expiresAt: number };
  instructions: string;
  runtimeContext?: NativeRuntimeContextSnapshot | null;
  dynamicTools?: readonly Readonly<Record<string, unknown>>[];
  dynamicToolHandler(call: { tool: string; callId: string; threadId: string; turnId: string; arguments: unknown }): Promise<unknown>;
  environment?: NodeJS.ProcessEnv;
  client?: CloudClient;
  runnerInstanceId?: string;
  cancelTimeoutMs?: number;
  reconnectDelayMs?: number;
}

class EventQueue {
  #events: PrpEvent[] = [];
  #waiter: ((result: IteratorResult<PrpEvent>) => void) | null = null;
  #closed = false;
  push(event: PrpEvent): void {
    if (this.#closed) return;
    if (this.#waiter) { const waiter = this.#waiter; this.#waiter = null; waiter({ value: event, done: false }); return; }
    if (this.#events.length >= 2_048) throw new Error("Cursor Cloud event consumer exceeded its bounded queue");
    this.#events.push(event);
  }
  close(): void { this.#closed = true; this.#waiter?.({ value: undefined, done: true }); this.#waiter = null; }
  async *stream(): AsyncGenerator<PrpEvent> {
    while (true) {
      if (this.#events.length) { yield this.#events.shift()!; continue; }
      if (this.#closed) return;
      const result = await new Promise<IteratorResult<PrpEvent>>(resolveValue => { this.#waiter = resolveValue; });
      if (result.done) return;
      yield result.value;
    }
  }
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function active(cp: CursorCloudCheckpoint): boolean { return cp.phase === "creating" || cp.phase === "running" || cp.phase === "stopping"; }
function boundedPositive(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 120_000) throw new Error("Cursor Cloud lifecycle timeout exceeds its bound");
  return result;
}
async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancelled!: () => void;
  const cancellation = new Promise<never>((_resolve, reject) => { cancelled = () => reject(new Error("Cursor Cloud lifecycle deadline expired")); signal.addEventListener("abort", cancelled, { once: true }); });
  try { return await Promise.race([operation, cancellation]); }
  finally { signal.removeEventListener("abort", cancelled); }
}

export function cursorCloudDriverDescriptor(): HarnessDriverDescriptor {
  return { kind: CURSOR_CLOUD_DRIVER_KIND, displayName: "Cursor Cloud (experimental)", version: CURSOR_CLOUD_DRIVER_VERSION, protocolVersion: "http+sse/v1",
    runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" },
    capabilities: { resume: true, typedEvents: true, steering: false, queuedFollowUp: false, interruption: true, structuredResult: true, read: true, reconciliation: true, usage: false, dynamicTools: true, toolRefreshOnResume: true, runtimeRequestResolution: false, runtimeRequestHandoff: false, goals: false, threadLineage: false,
      unsupported: ["native_permissions", "native_questions", "native_plan_decisions", "preprompt_model_acknowledgment", "preprompt_instruction_acknowledgment", "per_run_dollar_limit", "production_usage_accounting", "persistent_agent_directory", "binary_skill_assets", "steering", "goals", "threadLineage"] } };
}

export class CursorCloudDriver implements HarnessDriver {
  readonly #options: CursorCloudDriverOptions;
  constructor(options: CursorCloudDriverOptions) {
    const model = options.model.trim();
    if (!model || model.length > 512 || /[\x00-\x1f\x7f]/.test(model)) throw new Error("Cursor Cloud requires an explicit model ID");
    const relay = new URL(options.relay.url);
    if (relay.protocol !== "https:" || relay.username || relay.password || relay.search || relay.hash) throw new Error("Cursor Cloud semantic relay requires a public credential-free HTTPS URL");
    if (!options.relay.token || /[\r\n\0]/.test(options.relay.token)) throw new Error("Cursor Cloud semantic relay token is required");
    if (!Number.isSafeInteger(options.relay.expiresAt) || options.relay.expiresAt <= 0) throw new Error("Cursor Cloud semantic relay expiry is required");
    if (!isAbsolute(options.runtimeDirectory) || !isAbsolute(options.relay.socketPath)) throw new Error("Cursor Cloud relay socket and runtime directory must be absolute controller bindings");
    this.#options = { ...options, model, config: parseNativeCursorCloudConfig(options.config), binding: parseCursorCloudBinding(options.binding) };
  }
  async descriptor(): Promise<HarnessDriverDescriptor> {
    return cursorCloudDriverDescriptor();
  }
  async openSession(input: OpenHarnessSessionInput): Promise<CursorCloudSessionHandle> { return this.#open(input, false); }
  async recoverSession(snapshot: PersistedHarnessSession, options?: HarnessSessionRecoveryOptions) {
    if (snapshot.driverKind !== CURSOR_CLOUD_DRIVER_KIND) return { recovered: false, reason: "Cursor Cloud recovery driver mismatch" };
    const session = await this.#open({ runId: snapshot.runId ?? "", normalizedSessionId: snapshot.normalizedSessionId ?? snapshot.driverSessionId, workingDirectory: snapshot.workingDirectory ?? this.#options.runtimeDirectory, signal: options?.signal }, true, snapshot.driverSessionId);
    return { recovered: true, session };
  }
  async #open(input: OpenHarnessSessionInput, recovering: boolean, sessionId = input.normalizedSessionId): Promise<CursorCloudSession> {
    input.signal?.throwIfAborted();
    if (!input.runId || input.normalizedSessionId !== this.#options.binding.normalizedSessionId) throw new Error("Cursor Cloud session binding mismatch");
    const instructions = `${await cursorCloudInlineInstructions(this.#options.instructions, this.#options.runtimeContext)}\n\n${CURSOR_CLOUD_CONTROL_INSTRUCTIONS}`;
    input.signal?.throwIfAborted();
    const store = new CursorCloudCheckpointStore(this.#options.runtimeDirectory, sessionId);
    await store.acquire();
    let opened: CursorCloudSession | null = null;
    try {
      const existing = await store.read();
      if (recovering !== Boolean(existing)) throw new Error(recovering ? "Cursor Cloud checkpoint is missing; refusing a replacement remote create" : "Cursor Cloud checkpoint already exists; resume it explicitly");
      const bindingDigest = cursorCloudDigest(semanticCanonicalJson(this.#options.binding));
      const configDigest = cursorCloudDigest(semanticCanonicalJson(this.#options.config));
      const modelDigest = cursorCloudDigest(semanticCanonicalJson({ id: this.#options.model, params: this.#options.modelParams ?? [] }));
      const instructionsDigest = cursorCloudDigest(instructions);
      if (existing && (existing.driverSessionId !== sessionId || existing.normalizedSessionId !== input.normalizedSessionId || existing.bindingDigest !== bindingDigest || existing.configDigest !== configDigest || existing.modelDigest !== modelDigest || (active(existing) && (existing.instructionsDigest !== instructionsDigest || existing.ownerRunId !== input.runId)))) throw new Error("Cursor Cloud recovery identity/configuration/instructions changed");
      const checkpoint: CursorCloudCheckpoint = existing ?? { schema: "paperclip.cursor-cloud.checkpoint.v1", driverSessionId: sessionId, normalizedSessionId: input.normalizedSessionId, bindingDigest, configDigest, modelDigest, instructionsDigest, instructionsRevisionPending: false, ownerRunId: input.runId, agentId: null, runId: null, turnId: null, phase: "idle", pendingOperation: null, idempotencyKey: null, requestedAgentId: null, requestDigest: null, lastEventId: null, lastEventFingerprints: [], sourceSequence: 0, terminalStatus: null, deadlineAt: null, pendingTerminalDelivery: null, acceptedCompletion: null };
      if (checkpoint.instructionsDigest !== instructionsDigest) { checkpoint.instructionsDigest = instructionsDigest; checkpoint.instructionsRevisionPending = true; }
      checkpoint.ownerRunId = input.runId;
      await store.write(checkpoint);
      opened = new CursorCloudSession(this.#options, input, instructions, checkpoint, store);
      await opened.initialize();
      input.signal?.throwIfAborted();
      opened.startRecovery();
      return opened;
    } catch (error) {
      if (opened) await opened.detachControllerForRestart().catch(() => store.release());
      else await store.release();
      throw error;
    }
  }
}

class CursorCloudSession implements CursorCloudSessionHandle {
  readonly #options: CursorCloudDriverOptions;
  readonly #input: OpenHarnessSessionInput;
  readonly #instructions: string;
  readonly #cp: CursorCloudCheckpoint;
  readonly #store: CursorCloudCheckpointStore;
  readonly #client: CloudClient;
  readonly #events = new EventQueue();
  readonly #transcript: PrpEvent[] = [];
  readonly #cancelTimeoutMs: number;
  #bridge: RunnerToolBridge | null = null;
  #closed = false;
  #generation = 0;
  #stopping = false;
  #streamAbort: AbortController | null = null;
  #launch: Promise<void> | null = null;
  #work: Promise<void> | null = null;
  #stop: Promise<void> | null = null;
  #stopCheckpoint: Promise<void> | null = null;
  #rejectionSettlement: Promise<void> | null = null;
  #turnDeadline: ReturnType<typeof setTimeout> | null = null;

  constructor(options: CursorCloudDriverOptions, input: OpenHarnessSessionInput, instructions: string, checkpoint: CursorCloudCheckpoint, store: CursorCloudCheckpointStore) {
    this.#options = options; this.#input = input; this.#instructions = instructions; this.#cp = checkpoint; this.#store = store;
    this.#client = options.client ?? new CursorCloudClient({ apiKey: options.environment?.CURSOR_API_KEY ?? "" });
    this.#cancelTimeoutMs = boundedPositive(options.cancelTimeoutMs, CURSOR_CLOUD_CANCEL_TIMEOUT_MS);
  }
  async initialize(): Promise<void> {
    const socketDirectory = await lstat(dirname(this.#options.relay.socketPath));
    if (!socketDirectory.isDirectory() || socketDirectory.isSymbolicLink() || (socketDirectory.mode & 0o077) !== 0 || (process.getuid && socketDirectory.uid !== process.getuid())) throw new Error("Cursor Cloud relay socket directory must be owned and private (0700)");
    await releaseCursorCloudStaleSocket(this.#options.relay.socketPath, this.#store.recoveredDeadOwner);
    const tools = [...(this.#options.dynamicTools ?? []).filter(tool => tool.name !== PRP_COMPLETION_TOOL_NAME && tool.name !== PRP_BLOCK_TOOL_NAME && tool.name !== "list_cursor_cloud_artifacts").map(tool => tool.name === "register_deliverable"
      ? { ...tool, description: `${tool.description ?? "Register an inspectable file result."} Cursor Cloud: create the file in the provider artifacts directory, discover its exact path with list_cursor_cloud_artifacts, then use contentRef cursor-artifact:<exact listed relative artifact path>. Supply the actual filename, byteSize and lowercase SHA-256; these are independently verified before registration. Cloud filesystem paths and host paths are not accepted.` }
      : tool), { name: "list_cursor_cloud_artifacts", description: "List files exposed by the current Cursor Cloud Agent artifact API. Use the exact returned relative path in register_deliverable contentRef cursor-artifact:<path>. This read-only provider helper does not register a deliverable.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }];
    this.#bridge = await startRunnerToolBridge({ socketPath: this.#options.relay.socketPath, secret: this.#options.relay.token, tools, preserveToolNames: true, timeoutMs: null,
      sessionScope: () => this.#closed || this.#stopping || !active(this.#cp) ? null : this.#cp.turnId,
      scopeToken: () => this.#closed || this.#stopping || !active(this.#cp) ? null : this.#cp.relayTurnToken ?? null,
      handler: call => this.#dispatch(call) });
    const socket = await lstat(this.#options.relay.socketPath);
    if (!socket.isSocket() || socket.isSymbolicLink() || (process.getuid && socket.uid !== process.getuid())) throw new Error("Cursor Cloud bound relay socket ownership is unsafe");
    await chmod(this.#options.relay.socketPath, 0o600);
    const secured = await lstat(this.#options.relay.socketPath);
    if (!secured.isSocket() || secured.isSymbolicLink() || secured.ino !== socket.ino || secured.dev !== socket.dev || (secured.mode & 0o777) !== 0o600 || (process.getuid && secured.uid !== process.getuid())) throw new Error("Cursor Cloud bound relay socket changed while securing it");
  }
  #authority(): TurnAuthority { return { generation: this.#generation, ownerRunId: this.#cp.ownerRunId, turnId: this.#cp.turnId }; }
  #current(authority: TurnAuthority): boolean { return !this.#closed && authority.generation === this.#generation && authority.ownerRunId === this.#cp.ownerRunId && authority.turnId === this.#cp.turnId; }
  #remote(authority: TurnAuthority): RemoteAuthority | null { return this.#current(authority) && this.#cp.agentId && this.#cp.runId ? { ...authority, agentId: this.#cp.agentId, runId: this.#cp.runId } : null; }
  #pending(authority: TurnAuthority): PendingAuthority { return { ...authority, pendingOperation: this.#cp.pendingOperation, requestedAgentId: this.#cp.requestedAgentId, idempotencyKey: this.#cp.idempotencyKey, agentId: this.#cp.agentId }; }
  #currentPending(authority: PendingAuthority): boolean { return this.#current(authority) && active(this.#cp) && authority.pendingOperation === this.#cp.pendingOperation && authority.requestedAgentId === this.#cp.requestedAgentId && authority.idempotencyKey === this.#cp.idempotencyKey && authority.agentId === this.#cp.agentId; }
  #currentRemote(authority: RemoteAuthority): boolean { return this.#current(authority) && active(this.#cp) && authority.agentId === this.#cp.agentId && authority.runId === this.#cp.runId; }
  #acceptRun(authority: RemoteAuthority, run: CursorCloudRun): boolean {
    if (!this.#currentRemote(authority)) return false;
    if (run.agentId !== authority.agentId || run.id !== authority.runId) throw new HarnessReconciliationError("Cursor Cloud response changed the confirmed Agent/Run identity");
    return true;
  }
  startRecovery(): void { if (active(this.#cp)) { const authority = this.#authority(); this.#armDeadline(); this.#work = this.#recoverActive(authority).catch(error => this.#unresolved(error, authority)); } }
  ids() { return { driverSessionId: this.#cp.driverSessionId, providerSessionId: this.#cp.agentId, displayId: this.#cp.agentId ?? this.#cp.driverSessionId }; }
  events(): AsyncIterable<PrpEvent> { return this.#events.stream(); }
  turnControlCapabilities() { return { steering: false, queuedFollowUp: false }; }
  async attachRun(input: { runId: string }): Promise<void> {
    if (active(this.#cp) || this.#closed) throw new Error("Cursor Cloud cannot replace an active run binding");
    this.#generation += 1; this.#cp.ownerRunId = input.runId; await this.#store.write(this.#cp);
  }
  async startTurn(input: { message: NativeUserMessage; requestedCollaborationMode?: "default" | "plan" }): Promise<{ turnId: string; effectiveCollaborationMode: "default" }> {
    if (input.requestedCollaborationMode === "plan") throw new HarnessCapabilityUnavailableError("plan", "native Cloud plan decisions are unsupported");
    if (this.#closed || active(this.#cp)) throw new Error("Cursor Cloud session is closed or has unresolved remote work");
    if (this.#cp.pendingTerminalDelivery) throw new Error("Cursor Cloud terminal delivery must be acknowledged before new work");
    if (this.#options.relay.expiresAt <= Date.now()) throw new Error("Cursor Cloud semantic relay capability expired; only recovery cleanup is permitted");
    if (!input.message.text.trim() || Buffer.byteLength(input.message.text) > 1_048_576) throw new Error("Cursor Cloud turn text is empty or exceeds its bound");
    const previous = structuredClone(this.#cp);
    const turnId = `turn-${randomUUID()}`;
    const relayTurnToken = randomBytes(32).toString("base64url");
    const first = this.#cp.agentId === null;
    const prompt = `${first || this.#cp.instructionsRevisionPending ? this.#instructions : CURSOR_CLOUD_CONTROL_INSTRUCTIONS}\n\nPaperclip task:\n${input.message.text}`;
    const request = { prompt: { text: prompt }, model: { id: this.#options.model, ...(this.#options.modelParams ? { params: this.#options.modelParams } : {}) }, mode: "agent" as const,
      mcpServers: [{ name: CURSOR_CLOUD_MCP_SERVER_NAME, type: "http" as const, url: this.#options.relay.url, headers: { Authorization: `Bearer ${this.#options.relay.token}`, [RUNNER_TOOL_SCOPE_TOKEN_HEADER]: `Bearer ${relayTurnToken}` } }] };
    this.#cp.turnId = turnId; this.#cp.relayTurnToken = relayTurnToken; this.#cp.runId = null; this.#cp.phase = "creating"; this.#cp.pendingOperation = first ? "create_agent" : "create_run";
    this.#cp.requestedAgentId = first ? `bc-${randomUUID()}` : null; this.#cp.idempotencyKey = `paperclip-${randomUUID()}`;
    this.#cp.requestDigest = cursorCloudDigest(semanticCanonicalJson(request)); this.#cp.lastEventId = null; this.#cp.lastEventFingerprints = []; this.#cp.terminalStatus = null; this.#cp.acceptedCompletion = null; this.#cp.pendingTerminalDelivery = null;
    this.#cp.deadlineAt = Date.now() + (this.#options.config.timeoutMs ?? CURSOR_CLOUD_DEFAULT_TIMEOUT_MS);
    this.#generation += 1;
    const authority = this.#pending(this.#authority());
    this.#stopping = false; this.#stop = null; this.#stopCheckpoint = null;
    const streamAbort = new AbortController(); this.#streamAbort = streamAbort;
    const persisted = this.#store.write(this.#cp).catch(async error => {
      if (this.#current(authority)) {
        this.#generation += 1;
        Object.assign(this.#cp, previous);
        if (previous.relayTurnToken === undefined) delete this.#cp.relayTurnToken;
        this.#stopping = false; this.#clearDeadline(); streamAbort.abort();
        if (this.#streamAbort === streamAbort) this.#streamAbort = null;
        await this.#store.write(this.#cp);
      }
      throw error;
    });
    const launch = (async () => {
      await persisted;
      if (!this.#currentPending(authority)) return;
      const options = { signal: streamAbort.signal, idempotencyKey: authority.idempotencyKey! };
      const { schema: _schema, timeoutMs: _timeoutMs, ...cloudConfiguration } = this.#options.config;
      let response;
      try {
        response = first
          ? await this.#client.createAgent({ ...cloudConfiguration, ...request, agentId: authority.requestedAgentId! }, options)
          : await this.#client.createRun(authority.agentId!, request, options);
      } catch (error) {
        if (!this.#currentPending(authority) || !(error instanceof CursorCloudClientError)
          || (!isCursorCloudUnsentRequestError(error)
            && (error.status === undefined || ![400, 401, 403, 404, 422].includes(error.status)))) throw error;
        const settlement = this.#rejectCreate(error, authority);
        this.#rejectionSettlement = settlement;
        try { await settlement; return; }
        finally { if (this.#rejectionSettlement === settlement) this.#rejectionSettlement = null; }
      }
      if (!this.#currentPending(authority)) return;
      if (response.run.agentId !== (first ? authority.requestedAgentId : authority.agentId)) throw new HarnessReconciliationError("Cursor Cloud create response changed the requested Agent identity");
      this.#cp.agentId = response.run.agentId; this.#cp.runId = response.run.id; this.#cp.pendingOperation = null; this.#cp.instructionsRevisionPending = false;
      if (!this.#stopping) this.#cp.phase = "running";
      await this.#store.write(this.#cp);
      if (this.#current(authority)) this.#publishRemoteIdentity();
    })();
    this.#launch = launch;
    this.#work = launch.then(async () => { const remote = this.#remote(authority); if (remote && !this.#stopping && active(this.#cp)) await this.#observe(remote); }).catch(error => this.#unresolved(error, authority));
    await persisted;
    if (this.#current(authority) && active(this.#cp)) {
      this.#emit("turn.started", { provider: "cursor_cloud", submittedModel: this.#options.model, effectiveModelAcknowledged: false, instructionsAcknowledged: false });
      this.#publishRemoteIdentity(); this.#armDeadline();
    }
    return { turnId, effectiveCollaborationMode: "default" };
  }
  async interrupt(input: { turnId?: string; signal?: AbortSignal } = {}): Promise<void> {
    if (input.turnId && input.turnId !== this.#cp.turnId) throw new HarnessStaleTurnError(input.turnId);
    if (!active(this.#cp)) return;
    if (!this.#stop) {
      const stop = this.#interrupt(this.#authority(), input.signal).finally(() => { if (this.#stop === stop) this.#stop = null; });
      this.#stop = stop;
    }
    return this.#stop;
  }
  async #interrupt(authority: TurnAuthority, signal?: AbortSignal): Promise<void> {
    const launch = this.#launch, streamAbort = this.#streamAbort;
    this.#stopping = true; this.#cp.phase = "stopping";
    await (this.#stopCheckpoint = this.#store.write(this.#cp));
    if (!this.#current(authority) || !active(this.#cp)) return;
    streamAbort?.abort();
    const abort = new AbortController();
    const cancelled = () => abort.abort();
    signal?.addEventListener("abort", cancelled, { once: true }); if (signal?.aborted) abort.abort();
    const timer = setTimeout(() => abort.abort(), this.#cancelTimeoutMs);
    try {
      if (launch) await withAbort(launch.catch(() => {}), abort.signal);
      if (!this.#current(authority) || !active(this.#cp)) return;
      await this.#resolvePending(authority, abort.signal);
      if (!this.#current(authority) || !active(this.#cp)) return;
      const remote = this.#remote(authority);
      if (!remote) throw new HarnessReconciliationError("Cursor Cloud pending create has no confirmed run");
      let run = await this.#client.getRun(remote.agentId, remote.runId, { signal: abort.signal });
      if (!this.#acceptRun(remote, run)) return;
      if (isCursorCloudRunActive(run.status)) {
        try { await this.#client.cancelRun(remote.agentId, remote.runId, { signal: abort.signal }); }
        catch (error) { if (!(error instanceof CursorCloudClientError && error.providerCode === "run_not_cancellable")) throw error; }
        if (!this.#currentRemote(remote)) return;
        do {
          run = await this.#client.getRun(remote.agentId, remote.runId, { signal: abort.signal });
          if (!this.#acceptRun(remote, run)) return;
          if (!isCursorCloudRunActive(run.status)) break;
          await delay(100, undefined, { signal: abort.signal });
          if (!this.#currentRemote(remote)) return;
        } while (!abort.signal.aborted);
      }
      if (isCursorCloudRunActive(run.status)) throw new Error("Remote work remains active");
      await this.#settle(remote, run, true);
    } catch { if (this.#current(authority) && active(this.#cp)) throw new HarnessReconciliationError("Cursor Cloud Stop did not confirm remote terminal state; the run remains fenced"); }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", cancelled); }
  }
  async #resolvePending(authority: TurnAuthority, signal?: AbortSignal): Promise<void> {
    if (!this.#current(authority) || !active(this.#cp)) return;
    const pending = this.#pending(authority);
    if (pending.pendingOperation === "create_agent") {
      const agent = await this.#client.getAgent(pending.requestedAgentId!, { signal });
      if (!this.#currentPending(pending)) return;
      if (agent.id !== pending.requestedAgentId || !agent.latestRunId) throw new HarnessReconciliationError("Cursor Cloud pending create has no matching observable run");
      this.#cp.agentId = agent.id; this.#cp.runId = agent.latestRunId; this.#cp.pendingOperation = null; this.#cp.instructionsRevisionPending = false; await this.#store.write(this.#cp);
    } else if (pending.pendingOperation === "create_run") {
      throw new HarnessReconciliationError("Cursor Cloud follow-up outcome is unknown; refusing duplicate create or unbound cancellation");
    }
  }
  async #recoverActive(authority: TurnAuthority): Promise<void> {
    const streamAbort = new AbortController(); this.#streamAbort = streamAbort;
    const signal = streamAbort.signal;
    let run: CursorCloudRun | undefined;
    let remote: RemoteAuthority | null = null;
    for (let attempt = 0; this.#current(authority) && !this.#stopping && active(this.#cp); attempt += 1) {
      try {
        await this.#resolvePending(authority, signal);
        if (!this.#current(authority) || this.#stopping || signal.aborted || !active(this.#cp)) return;
        remote = this.#remote(authority);
        if (!remote) throw new HarnessReconciliationError("Cursor Cloud recovery is missing remote identity");
        run = await this.#client.getRun(remote.agentId, remote.runId, { signal });
        if (!this.#acceptRun(remote, run)) return;
        break;
      } catch (error) {
        if (!this.#current(authority) || this.#stopping || signal.aborted || !active(this.#cp)) return;
        if (!(error instanceof CursorCloudClientError && error.retryable)) throw error;
        await this.#unresolved(error, authority);
        await delay(boundedPositive(this.#options.reconnectDelayMs, Math.min(250 * 2 ** attempt, 2_000)), undefined, { signal })
          .catch(error => { if (!signal.aborted) throw error; });
      }
    }
    if (!run || !remote || !this.#currentRemote(remote) || this.#stopping || signal.aborted) return;
    this.#emit("turn.started", { recovered: true, submittedModel: this.#options.model, effectiveModelAcknowledged: false, instructionsAcknowledged: false });
    this.#publishRemoteIdentity();
    if (!isCursorCloudRunActive(run.status)) { await this.#settle(remote, run, this.#cp.phase === "stopping"); return; }
    if (this.#cp.phase === "stopping" || this.#cp.deadlineAt === null || this.#cp.deadlineAt <= Date.now()) { await this.interrupt({ turnId: remote.turnId! }); return; }
    await this.#observe(remote);
  }
  async #readObservedRun(authority: RemoteAuthority, signal: AbortSignal): Promise<CursorCloudRun | null> {
    for (let attempt = 0; this.#currentRemote(authority) && !this.#stopping && !signal.aborted; attempt += 1) {
      if (this.#cp.deadlineAt === null || this.#cp.deadlineAt <= Date.now()) return null;
      try {
        const run = await withAbort(this.#client.getRun(authority.agentId, authority.runId, { signal }), signal);
        return this.#currentRemote(authority) && !this.#stopping && !signal.aborted ? run : null;
      } catch (error) {
        if (!this.#currentRemote(authority) || this.#stopping || signal.aborted) return null;
        if (!(error instanceof CursorCloudClientError && error.retryable)) throw error;
        if (attempt === 0) this.#emit("harness.diagnostic", { code: "cursor_cloud_observation_retry", message: "Cursor Cloud observation is temporarily unavailable; retrying the saved run within its original deadline." });
        const remaining = (this.#cp.deadlineAt ?? 0) - Date.now();
        if (remaining <= 0) return null;
        const backoff = boundedPositive(this.#options.reconnectDelayMs, Math.min(250 * 2 ** Math.min(attempt, 4), 2_000));
        await delay(Math.min(remaining, Math.max(backoff, error.retryAfterMs ?? 0)), undefined, { signal })
          .catch(error => { if (!signal.aborted) throw error; });
      }
    }
    return null;
  }
  async #observe(authority: RemoteAuthority): Promise<void> {
    for (let attempt = 0; this.#currentRemote(authority) && !this.#stopping; attempt += 1) {
      if (this.#cp.deadlineAt === null || this.#cp.deadlineAt <= Date.now()) return;
      const streamAbort = new AbortController(); this.#streamAbort = streamAbort;
      try {
        for await (const event of this.#client.streamRun(authority.agentId, authority.runId, { signal: streamAbort.signal, ...(this.#cp.lastEventId ? { lastEventId: this.#cp.lastEventId } : {}) })) {
          if (!this.#currentRemote(authority) || this.#stopping || streamAbort.signal.aborted) return;
          await this.#consume(event);
          if (event.event === "result" || event.event === "done") break;
        }
      } catch (error) {
        if (!this.#currentRemote(authority) || this.#stopping || streamAbort.signal.aborted) return;
        if (error instanceof CursorCloudClientError && error.status === 410) this.#emit("harness.diagnostic", { code: "cursor_cloud_stream_expired", message: "Cursor Cloud stream retention expired; reconciling saved run state." });
        else if (!(error instanceof CursorCloudClientError && error.retryable)) throw error;
      }
      if (!this.#currentRemote(authority) || this.#stopping || streamAbort.signal.aborted) return;
      const run = await this.#readObservedRun(authority, streamAbort.signal);
      if (!run || !this.#acceptRun(authority, run) || this.#stopping || streamAbort.signal.aborted) return;
      if (!isCursorCloudRunActive(run.status)) { await this.#settle(authority, run); return; }
      const remaining = (this.#cp.deadlineAt ?? 0) - Date.now();
      if (remaining <= 0) return;
      await delay(Math.min(remaining, boundedPositive(this.#options.reconnectDelayMs, Math.min(250 * 2 ** Math.min(attempt, 4), 2_000))), undefined, { signal: streamAbort.signal });
    }
  }
  async #consume(event: CursorCloudSseEvent): Promise<void> {
    const fingerprint = cursorCloudDigest(semanticCanonicalJson(event));
    if (event.id && event.id === this.#cp.lastEventId && this.#cp.lastEventFingerprints.includes(fingerprint)) return;
    const data = record(event.data);
    if (event.event === "status" || event.event === "result") {
      if (data.runId !== this.#cp.runId || !["CREATING", "RUNNING", "WAITING_FOR_BACKGROUND_WORK", "FINISHED", "ERROR", "CANCELLED", "EXPIRED"].includes(String(data.status))) throw new Error("Cursor Cloud stream lifecycle event has an invalid run identity/status");
    }
    if (event.event === "assistant" && typeof data.text === "string") this.#emit("item.delta", { kind: "agentMessage", text: this.#redact(data.text) }, "assistant");
    else if (event.event === "thinking" && typeof data.text === "string") this.#emit("item.delta", { kind: "reasoning", text: this.#redact(data.text) }, "reasoning");
    else if (event.event === "tool_call") {
      if (typeof data.callId !== "string" || !data.callId || data.callId.length > 512 || typeof data.name !== "string" || data.name.length > 512 || !["running", "completed", "error"].includes(String(data.status))) throw new Error("Cursor Cloud tool event omitted identity or status");
      this.#emit(data.status === "running" ? "item.started" : "item.completed", { kind: "tool", item: { id: data.callId, type: "mcpToolCall", name: data.name, status: data.status, ...(data.args === undefined ? {} : { arguments: this.#redactJson(data.args) }), ...(data.result === undefined ? {} : { result: this.#redactJson(data.result) }), ...(data.truncated ? { truncated: data.truncated } : {}) } }, data.callId);
    } else if (event.event === "error") this.#emit("harness.diagnostic", { code: "cursor_cloud_stream_error", message: "Cursor Cloud stream reported an error; checking the saved run." });
    if (event.id) {
      if (event.id !== this.#cp.lastEventId) this.#cp.lastEventFingerprints = [];
      if (this.#cp.lastEventFingerprints.length >= 32) throw new Error("Cursor Cloud event cursor has too many variants");
      this.#cp.lastEventId = event.id; this.#cp.lastEventFingerprints.push(fingerprint);
    }
    await this.#store.write(this.#cp);
  }
  async #settle(authority: RemoteAuthority, run: CursorCloudRun, interrupted = false): Promise<void> {
    if (this.#acceptRun(authority, run) && !isCursorCloudRunActive(run.status)) {
      const turnId = this.#cp.turnId!;
      this.#cp.phase = "terminal"; this.#cp.terminalStatus = run.status; this.#cp.pendingOperation = null; this.#cp.deadlineAt = null; this.#clearDeadline();
      const delivery: CursorCloudTerminalDelivery = { schema: "paperclip.cursor-cloud.terminal-delivery.v1", threadId: this.#cp.driverSessionId, turnId, providerRunId: run.id, receiptId: randomUUID(), status: run.status as CursorCloudTerminalDelivery["status"], interrupted: interrupted || run.status === "CANCELLED", result: run.result ? this.#redact(run.result) : null };
      this.#cp.pendingTerminalDelivery = delivery;
      const events: PrpEvent[] = [];
      if (delivery.result) events.push(this.#event("item.completed", { kind: "agentMessage", text: delivery.result, channel: "final" }, "final", turnId));
      events.push(this.#event(delivery.interrupted ? "turn.interrupted" : run.status === "FINISHED" ? "turn.completed" : "turn.failed", { cursorCloudTerminalDelivery: delivery, providerStatus: run.status, remoteTerminalConfirmed: true, semanticCompletionAccepted: this.#cp.acceptedCompletion !== null, ...(run.status === "ERROR" || run.status === "EXPIRED" ? { error: { code: `cursor_cloud_${run.status.toLowerCase()}`, message: "Cursor Cloud run ended without successful provider completion." } } : {}) }, undefined, turnId));
      await this.#store.write(this.#cp);
      if (this.#current(authority)) for (const event of events) this.#publish(event);
    }
  }
  async #dispatch(call: RunnerToolCall): Promise<unknown> {
    const turnId = this.#cp.turnId;
    if (this.#closed || this.#stopping || !turnId || !active(this.#cp) || this.#cp.acceptedCompletion || call.signal.aborted) throw new Error("Cursor Cloud tool call has no current run authority");
    if (call.tool === "list_cursor_cloud_artifacts") {
      if (!this.#cp.agentId) throw new Error("Cursor Cloud Agent artifact identity is not confirmed");
      const listed = await this.#client.listArtifacts(this.#cp.agentId, { signal: call.signal });
      if (listed.items.length > 256) throw new Error("Cursor Cloud artifact catalog exceeds its 256-file bound");
      const result = { items: listed.items.map(item => ({ path: item.path, sizeBytes: item.sizeBytes })) };
      if (Buffer.byteLength(JSON.stringify(result)) > 65_536) throw new Error("Cursor Cloud artifact catalog exceeds its byte bound");
      if (this.#closed || this.#stopping || call.signal.aborted || this.#cp.turnId !== turnId || !active(this.#cp)) throw new Error("Cursor Cloud artifact list arrived after run authority ended");
      return result;
    }
    const callId = `${turnId}:${call.callId}`;
    let args = call.arguments;
    let normalized: (() => void) | undefined;
    if (call.tool === "register_deliverable") {
      if (!this.#options.artifactRoot || !this.#cp.agentId) throw new Error("Cursor Cloud artifact registration is not bound to an admitted run/root");
      args = await stageCursorCloudArtifact({ arguments: args, agentId: this.#cp.agentId, runtimeDirectory: this.#options.runtimeDirectory, artifactRoot: this.#options.artifactRoot, client: this.#client, signal: call.signal });
      normalized = call.captureNormalizedInput?.(args);
    }
    if (this.#stopping || this.#closed || call.signal.aborted || this.#cp.turnId !== turnId) throw new Error("Cursor Cloud run stopped before tool forwarding");
    const response = this.#options.dynamicToolHandler({ tool: call.tool, callId, threadId: this.#cp.driverSessionId, turnId, arguments: args });
    normalized?.();
    const result = await response;
    if (this.#closed || this.#stopping || this.#cp.turnId !== turnId || !active(this.#cp) || call.signal.aborted) throw new Error("Cursor Cloud tool result arrived after its run authority ended");
    if ((call.tool === PRP_COMPLETION_TOOL_NAME || call.tool === PRP_BLOCK_TOOL_NAME) && record(result).success === true) {
      this.#cp.acceptedCompletion = { callIdDigest: cursorCloudDigest(callId), inputDigest: cursorCloudDigest(semanticCanonicalJson(call.arguments)), resultDigest: cursorCloudDigest(semanticCanonicalJson(result)), turnId };
      await this.#store.write(this.#cp);
    }
    return result;
  }
  #armDeadline(): void {
    this.#clearDeadline();
    const authority = this.#authority();
    this.#turnDeadline = setTimeout(() => { if (this.#current(authority) && active(this.#cp)) void this.interrupt({ turnId: authority.turnId! }).catch(error => this.#unresolved(error, authority)); }, Math.max(0, (this.#cp.deadlineAt ?? 0) - Date.now()));
    this.#turnDeadline.unref?.();
  }
  #clearDeadline(): void { if (this.#turnDeadline) clearTimeout(this.#turnDeadline); this.#turnDeadline = null; }
  #publishRemoteIdentity(): void {
    const agentId = this.#cp.agentId ?? this.#cp.requestedAgentId;
    if (!agentId) return;
    this.#emit("harness.diagnostic", { code: "cursor_cloud_remote_identity", message: JSON.stringify({ schema: "paperclip.cursor-cloud.remote-identity.v1", provider: "cursor_cloud", agentId, runId: this.#cp.runId, ownerRunId: this.#cp.ownerRunId, normalizedSessionId: this.#cp.normalizedSessionId, phase: this.#cp.phase }) });
  }
  async #rejectCreate(error: CursorCloudClientError, authority: PendingAuthority): Promise<void> {
    const rejected = { phase: "idle", pendingOperation: null, requestedAgentId: null, terminalStatus: "REJECTED", deadlineAt: null } as const;
    // Keep admission fenced until the definite rejection is durable. Stop awaits
    // this launch promise, and its checkpoint must not overwrite the settlement.
    let stopCheckpoint = this.#stopCheckpoint;
    for (;;) {
      if (stopCheckpoint) await stopCheckpoint;
      if (!this.#currentPending(authority)) return;
      await this.#store.write({ ...this.#cp, ...rejected });
      if (!this.#currentPending(authority)) return;
      if (this.#stopCheckpoint !== stopCheckpoint) {
        stopCheckpoint = this.#stopCheckpoint;
        continue;
      }
      Object.assign(this.#cp, rejected); this.#clearDeadline();
      const unsent = isCursorCloudUnsentRequestError(error);
      this.#emit("turn.failed", { error: { code: unsent ? error.code : error.providerCode ?? "cursor_cloud_launch_rejected", message: unsent
        ? "The encoded Cursor Cloud request exceeds the client limit. Reduce the task or instructions before retrying; no provider request was sent."
        : "Cursor Cloud rejected the run before accepting provider work. Check the configured account, repository access and explicit model." }, remoteWorkAccepted: false });
      return;
    }
  }
  async #unresolved(_error: unknown, authority: TurnAuthority): Promise<void> {
    if (!this.#current(authority) || !active(this.#cp)) return;
    this.#emit("harness.diagnostic", { code: "cursor_cloud_remote_state_unknown", message: "Cursor Cloud work could not be reconciled. Saved identity is retained; no replacement work was created. Stop or reconnect to reconcile it." });
  }
  #redact(text: string): string {
    return this.#redactUnbounded(text).slice(0, 65_536);
  }
  #redactUnbounded(text: string): string {
    for (const secret of [this.#options.environment?.CURSOR_API_KEY, this.#options.relay.token, this.#cp.relayTurnToken]) if (secret) text = text.replaceAll(secret, "[redacted]");
    return text;
  }
  #redactJson(value: unknown): unknown {
    const text = this.#redactUnbounded(JSON.stringify(value));
    return Buffer.byteLength(text) > 65_536 ? { omitted: true, reason: "payload_limit" } : JSON.parse(text);
  }
  #event(eventType: PrpEvent["eventType"], payload: Record<string, unknown>, itemId?: string, turnId = this.#cp.turnId ?? undefined): PrpEvent {
    const seq = ++this.#cp.sourceSequence;
    return { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceEventId: `cursor-cloud:${this.#cp.ownerRunId}:${seq}`, sourceSeq: seq, sourceInstanceId: this.#options.runnerInstanceId ?? "cursor-cloud-sidecar", sourceKind: "runner", runId: this.#cp.ownerRunId, normalizedSessionId: this.#cp.normalizedSessionId, ...(turnId ? { turnId } : {}), ...(itemId ? { itemId } : {}), eventType, priority: 1, emittedAt: new Date().toISOString(), payload };
  }
  #publish(event: PrpEvent): void {
    if (this.#closed) return;
    this.#transcript.push(event); if (this.#transcript.length > 1_024) this.#transcript.shift(); this.#events.push(event);
  }
  #emit(eventType: PrpEvent["eventType"], payload: Record<string, unknown>, itemId?: string, turnId = this.#cp.turnId ?? undefined): void {
    if (!this.#closed) this.#publish(this.#event(eventType, payload, itemId, turnId));
  }
  async acknowledgeTerminalDelivery(input: { turnId: string; receiptId: string }): Promise<void> {
    const pending = this.#cp.pendingTerminalDelivery;
    if (!pending || pending.turnId !== input.turnId || pending.receiptId !== input.receiptId) throw new Error("Cursor Cloud terminal delivery receipt does not match");
    await this.#store.write({ ...this.#cp, pendingTerminalDelivery: null });
    this.#cp.pendingTerminalDelivery = null;
  }
  async read(): Promise<Record<string, unknown>> { return { provider: "cursor_cloud", agentId: this.#cp.agentId, runId: this.#cp.runId, turnId: this.#cp.turnId, phase: this.#cp.phase, providerStatus: this.#cp.terminalStatus, submittedModel: this.#options.model, effectiveModelAcknowledged: false, instructionsDigest: this.#cp.instructionsDigest, instructionsAcknowledged: false, semanticCompletionReceipt: this.#cp.acceptedCompletion, pendingTerminalDelivery: structuredClone(this.#cp.pendingTerminalDelivery) }; }
  async reconcile(): Promise<Record<string, unknown>> {
    if (this.#rejectionSettlement) await this.#rejectionSettlement;
    const authority = this.#authority();
    await this.#resolvePending(authority);
    const remote = this.#remote(authority);
    if (remote && active(this.#cp)) { const run = await this.#client.getRun(remote.agentId, remote.runId); await this.#settle(remote, run); }
    return this.read();
  }
  async usage(): Promise<Record<string, unknown> | null> { return this.#cp.agentId ? { ...(await this.#client.getUsage(this.#cp.agentId, this.#cp.runId ? { runId: this.#cp.runId } : {})), cost: null, costUnavailable: true } : null; }
  async transcript() { return { schema: "paperclip-runner/harness-transcript/v1" as const, complete: this.#transcript.length < 1_024, eventCount: this.#transcript.length, events: structuredClone(this.#transcript), omissionReason: this.#transcript.length >= 1_024 ? "bounded_history" : null }; }
  async snapshot(): Promise<PersistedHarnessSession> { if (this.#rejectionSettlement) await this.#rejectionSettlement; await this.#store.write(this.#cp); return { driverKind: CURSOR_CLOUD_DRIVER_KIND, driverSessionId: this.#cp.driverSessionId, providerSessionId: this.#cp.agentId, workingDirectory: this.#input.workingDirectory, runId: this.#cp.ownerRunId, normalizedSessionId: this.#cp.normalizedSessionId, activeTurnId: active(this.#cp) ? this.#cp.turnId : null, lastSourceSequence: this.#cp.sourceSequence }; }
  async detachControllerForRestart(): Promise<void> { if (this.#rejectionSettlement) await this.#rejectionSettlement; this.#closed = true; this.#streamAbort?.abort(); this.#clearDeadline(); await this.#bridge?.close(); this.#events.close(); await this.#store.write(this.#cp); await this.#store.release(); }
  async close(_input: { reason: string; force?: boolean }): Promise<void> {
    if (this.#closed) return;
    let failure: unknown;
    try { if (active(this.#cp)) await this.interrupt(); } catch (error) { failure = error; }
    this.#closed = true; this.#streamAbort?.abort(); this.#clearDeadline();
    await this.#bridge?.close(); this.#events.close(); await this.#store.write(this.#cp); await this.#store.release();
    if (failure) throw failure;
  }
}
