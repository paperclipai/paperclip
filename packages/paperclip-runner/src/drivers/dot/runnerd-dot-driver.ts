import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { HarnessDriver, HarnessDriverDescriptor, HarnessSession, OpenHarnessSessionInput, PersistedHarnessSession } from "../../contracts/harness-driver.js";
import type { NativeExecutionInputV6 } from "../../contracts/native-execution.js";
import type { ExternalProviderPort } from "../../contracts/external-provider.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { validatePrpStructuredRunResult } from "../../protocol/replay-contract.js";
import { DurablePrpControlPlane, spawnRunner, type RunnerProcessHandle } from "../../control-plane/durable-prp-control-plane.js";
import type { DurableRecoveryIdentity } from "../../contracts/durable-recovery.js";
import { authorizedToolSetForProvider, defaultCapabilityRunnerdBinary, readRunnerdArtifactBinding, type CapabilityRunnerdCodexTransportOptions } from "../../live/runnerd-codex-transport.js";
import { codexSemanticToolSpecs } from "../codex/codex-driver-values.js";
import { nativeSystemInstructions } from "../../backends/runtime-context.js";
import type { CodexNativeSessionBackendOptions } from "../../backends/codex-native-backend.js";

export interface RunnerdDotDriverOptions {
  execution: NativeExecutionInputV6;
  stateDirectory: string;
  identity: DurableRecoveryIdentity;
  port: ExternalProviderPort;
  runnerBinary?: string;
  runnerStateDirectory?: string;
  runnerProcessLauncher?: CapabilityRunnerdCodexTransportOptions["runnerProcessLauncher"];
  /** Reads the checkpoint from the execution target. Missing state cannot authorize replay. */
  readProviderState?: () => Promise<Record<string, unknown> | null>;
  controlPlaneRegistration?: CapabilityRunnerdCodexTransportOptions["controlPlaneRegistration"];
  onSpawn?: CodexNativeSessionBackendOptions["onSpawn"];
  dynamicTools?: CodexNativeSessionBackendOptions["dynamicTools"];
  dynamicToolHandler?: CodexNativeSessionBackendOptions["dynamicToolHandler"];
  completionFeedback?: CodexNativeSessionBackendOptions["completionFeedback"];
  adoptExistingRunner?: CapabilityRunnerdCodexTransportOptions["adoptExistingRunner"];
}

const capabilities = {
  resume: false, typedEvents: true, steering: false, interruption: false,
  structuredResult: true, read: true, reconciliation: true, usage: false,
  dynamicTools: true, unsupported: ["resume", "steering", "interruption", "usage", "goals", "runtimeRequestResolution", "threadLineage"],
};

/** The admission path can inspect Dot without allocating a broker port or Runner. */
export function describeRunnerdDotDriver(): HarnessDriverDescriptor {
  return { kind: "openai_dot_mcp", displayName: "OpenAI Dot", version: "dot-mcp-v1", protocolVersion: "prp.v3",
    capabilities: structuredClone(capabilities), runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
}

/** Thin SDK projection. Rust owns every lifecycle decision and durable receipt. */
export class RunnerdDotDriver implements HarnessDriver {
  constructor(readonly options: RunnerdDotDriverOptions) {}
  async descriptor() {
    return describeRunnerdDotDriver();
  }
  async openSession(input: OpenHarnessSessionInput): Promise<HarnessSession> {
    if (input.runId !== this.options.identity.runId || input.normalizedSessionId !== this.options.identity.normalizedSessionId) {
      throw new Error("dot_runner_identity_mismatch");
    }
    input.signal?.throwIfAborted();
    const session = new RunnerdDotSession(this.options);
    try { await session.open(input.signal); return session; }
    catch (error) { await session.detachControllerForRestart().catch(() => {}); throw error; }
  }
  async recoverSession(snapshot: PersistedHarnessSession, options: { signal: AbortSignal }) {
    if (snapshot.driverKind !== "openai_dot_mcp" || snapshot.runId !== this.options.identity.runId
        || snapshot.driverSessionId !== this.options.identity.normalizedSessionId || snapshot.providerSessionId != null) {
      return { recovered: false, reason: "Dot bridge checkpoint identity mismatch" };
    }
    let saved: Record<string, unknown> | null;
    try { saved = await readProviderCheckpoint(this.options); }
    catch { return { recovered: false, reason: "Dot bridge checkpoint invalid; external work requires reconciliation" }; }
    if (!saved) return { recovered: false, reason: "Dot bridge checkpoint missing; external work requires reconciliation" };
    if (saved.schema !== "paperclip.runner.dot-provider-state.v1" || saved.runId !== snapshot.runId || saved.sessionId !== snapshot.driverSessionId || saved.turnId !== this.options.identity.turnId) {
      return { recovered: false, reason: "Dot bridge checkpoint authority mismatch" };
    }
    return { recovered: true, session: await this.openSession({ runId: snapshot.runId,
      normalizedSessionId: snapshot.driverSessionId, workingDirectory: this.options.stateDirectory, signal: options.signal }) };
  }
}

async function readProviderCheckpoint(options: RunnerdDotDriverOptions): Promise<Record<string, unknown> | null> {
  if (options.readProviderState) return options.readProviderState();
  const path = resolve(options.runnerStateDirectory ?? resolve(options.stateDirectory, "runner"), "dot-provider-state.json");
  if (!existsSync(path)) return null;
  if (statSync(path).size > 32 * 1024 * 1024) throw new Error("dot_provider_checkpoint_too_large");
  return JSON.parse(readFileSync(path, "utf8"));
}

class RunnerdDotSession implements HarnessSession {
  #core: DurablePrpControlPlane | null = null;
  #process: RunnerProcessHandle | null = null;
  #events: PrpEvent[] = [];
  #waiters = new Set<() => void>();
  #release: (() => Promise<void> | void) | null = null;
  #detachPort: (() => Promise<void>) | null = null;
  #closed = false;
  #failure: Error | null = null;
  constructor(readonly options: RunnerdDotDriverOptions) {}
  ids() { return { driverSessionId: this.options.identity.normalizedSessionId, providerSessionId: null, displayId: "OpenAI Dot" }; }

  async open(signal?: AbortSignal) {
    const o = this.options;
    mkdirSync(o.stateDirectory, { recursive: true, mode: 0o700 });
    const runnerState = o.runnerStateDirectory ?? resolve(o.stateDirectory, "runner");
    if (!o.runnerProcessLauncher) mkdirSync(runnerState, { recursive: true, mode: 0o700 });
    const binary = o.runnerBinary ?? defaultCapabilityRunnerdBinary();
    const artifact = readRunnerdArtifactBinding(binary);
    const core = this.#core = new DurablePrpControlPlane({
      identity: o.identity, stateDirectory: resolve(o.stateDirectory, "control-plane"),
      expectedRunnerVersion: artifact.version, expectedRunnerDigest: artifact.digest,
      connectionLeaseTtlMs: Math.min(7_200_000, Math.max(60_000, o.execution.provider.binding.expiresAtUnixMs - Date.now())),
      onProtocolIntegrityError: error => { this.#failure = error; this.#wake(); },
      onCommittedEvent: async event => {
        if (event.eventType === "external_provider.dispatch_requested") await o.port.dispatch(event);
        if (event.eventType === "external_provider.operation_settled") await o.port.settle(event);
        if (!this.#events.some(e => e.sourceEventId === event.sourceEventId)) this.#events.push(event);
        this.#wake();
      },
      onSemanticToolInput: async call => {
        if (call.operationId === "paperclip_finish" || call.operationId === "paperclip_block") {
          const result = validatePrpStructuredRunResult(call.input);
          if (!result.ok || (call.operationId === "paperclip_block") !== (result.ok && result.result.reportedWorkDisposition === "blocked")) {
            return { result: { error: "Invalid completion report. Use the admitted completion contract and the correct completion tool." }, isError: true };
          }
          try { return { result: { accepted: true, completionReport: result.result, feedback: await o.completionFeedback?.(result.result) ?? "Completion accepted; finish the external turn." } }; }
          catch (error) { return { result: { error: error instanceof Error ? error.message : "Completion rejected" }, isError: true }; }
        }
        if (!o.dynamicToolHandler) throw new Error("dot_semantic_authority_unavailable");
        const result = await o.dynamicToolHandler({ tool: call.operationId, callId: call.callId,
          threadId: o.identity.normalizedSessionId, turnId: o.identity.turnId, arguments: call.input });
        const outcome = result && typeof result === "object" ? (result as Record<string, unknown>).outcome : undefined;
        return { result, isError: typeof outcome === "string" && !["completed", "succeeded", "success"].includes(outcome) };
      },
    });
    // Rehydrate the projection from the authenticated transport journal. Broker
    // persistence happens before ACK, so these events have durable projections.
    this.#events = core.store.state.committedEvents.map(e => e.envelope.payload as unknown as PrpEvent);
    const registration = o.controlPlaneRegistration ? await o.controlPlaneRegistration(core, o.identity) : null;
    this.#release = registration?.release ?? null;
    if (!registration) await core.start();
    signal?.throwIfAborted();
    if (!o.adoptExistingRunner) {
      this.#process = spawnRunner({
        processLauncher: o.runnerProcessLauncher, connectUrl: registration?.connectUrl ?? core.connectUrl,
        connection: registration?.connection, stateDirectory: runnerState, identity: o.identity,
        ticket: core.issueBootstrapTicket(60_000), runnerBinaryPath: binary,
        runnerVersion: artifact.version, runnerDigest: artifact.digest,
        maxOutboxBytes: 16 * 1024 * 1024, p0ReserveBytes: 1024 * 1024,
        maxRuntimeMs: 0, reconnectGraceMs: 60_000,
        // No agent, OAuth, ChatGPT or provider API credentials are inherited.
        environment: { PATH: process.env.PATH },
      });
      const pid = this.#process.child.pid;
      if (pid && !o.runnerProcessLauncher) await o.onSpawn?.({ pid, processGroupId: this.#process.processGroupId ?? null,
        startedAt: this.#process.startedAt ?? new Date().toISOString() });
      void this.#process.completion.then(result => {
        if (this.#closed) return;
        // Rust exits after the authenticated shutdown receipt is committed and
        // ACKed. That exit can precede the SDK's next command poll.
        if (result.code === 0 && core.getCommand("dot_shutdown")?.status === "completed") return;
        this.#failure ??= new Error(`dot_runner_process_exited_recovery_required: code=${result.code} signal=${result.signal}`);
        this.#wake();
      }, () => {
        if (this.#closed) return;
        this.#failure ??= new Error("dot_runner_process_exited_recovery_required");
        this.#wake();
      });
    } else if (!await o.adoptExistingRunner.isAlive()) { throw new Error("dot_runner_adoption_failed"); }
    await registration?.activate?.();
    await registration?.ready?.();
    if (registration?.failure) void registration.failure.catch(error => {
      if (!this.#closed) { this.#failure = error instanceof Error ? error : new Error("dot_runner_transport_failed"); this.#wake(); }
    });
    const checkpoint = await readProviderCheckpoint(o);
    if (checkpoint && (checkpoint.schema !== "paperclip.runner.dot-provider-state.v1"
      || checkpoint.runId !== o.identity.runId || checkpoint.sessionId !== o.identity.normalizedSessionId
      || checkpoint.turnId !== o.identity.turnId)) throw new Error("dot_runner_checkpoint_authority_mismatch");
    this.#detachPort = await o.port.attach(async operation => {
      await this.#command("external_provider.operation", { ...operation }, `dot_operation_${operation.requestId}`);
    }, () => this.interrupt(), !!checkpoint);
    await this.#command("run.prepare", {
      provider: { kind: "openai_dot", ...o.execution.provider.binding,
        instructions: `${nativeSystemInstructions(o.execution)}\n\nAccept the assignment before calling tools. Invoke paperclip_finish or paperclip_block, then submit the same structured result with paperclip_dot_finish. Keep request IDs stable across retries.` },
      authorizedTools: authorizedToolSetForProvider(undefined, [...o.dynamicTools ?? [], ...codexSemanticToolSpecs()]),
      completionContract: { revision: o.execution.completionContract.contract.revision,
        criterionIds: o.execution.completionContract.contract.criteria.map(c => c.id) },
    }, "dot_prepare");
    await this.#command("session.open", {}, "dot_open");
    signal?.throwIfAborted();
  }

  async #command(type: string, payload: Record<string, unknown>, id: string) {
    if (!this.#core || this.#closed) throw new Error("dot_runner_unavailable");
    this.#core.queueCommand(type, payload, id, true);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (this.#failure) throw this.#failure;
      const command = this.#core.getCommand(id);
      if (command?.status === "completed") return (command.result?.result ?? {}) as Record<string, unknown>;
      if (command && ["failed", "rejected"].includes(command.status)) {
        const error = new Error("dot_runner_operation_rejected");
        Object.assign(error, { dotOperationRejected: true });
        throw error;
      }
      if (command?.status === "indeterminate") throw new Error("dot_runner_operation_unknown_reconcile_required");
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error("dot_runner_command_pending_reconcile_with_same_request_id");
  }
  async startTurn(input: { message: { text: string } }) {
    await this.#command("turn.start", { text: input.message.text }, "dot_start");
    return { turnId: this.options.identity.turnId };
  }
  #wake() { for (const wake of this.#waiters) wake(); this.#waiters.clear(); }
  async *events(): AsyncIterable<PrpEvent> {
    let index = 0;
    while (!this.#closed) {
      while (index < this.#events.length) { const event = this.#events[index++]!; yield event; if (event.eventType === "run.terminal") return; }
      if (this.#failure) throw this.#failure;
      await new Promise<void>(resolve => this.#waiters.add(resolve));
    }
  }
  async read() { return await this.#command("session.snapshot", {}, `dot_snapshot_${randomUUID()}`); }
  async reconcile() { return { ...await this.read(), externalStopConfirmed: false, usage: null, cost: null }; }
  async usage() { return null; }
  async interrupt() { await this.#command("run.cancel", {}, "dot_cancel"); }
  async snapshot(): Promise<PersistedHarnessSession> {
    const state = await this.read();
    const proposed = this.#events.findLast(event => event.eventType === "run.result.proposed");
    const result = proposed ? validatePrpStructuredRunResult(proposed.payload) : null;
    const terminal = this.#events.findLast(event => event.eventType === "run.terminal");
    return { driverKind: "openai_dot_mcp", driverSessionId: this.ids().driverSessionId,
      providerSessionId: null, runId: this.options.identity.runId,
      normalizedSessionId: this.options.identity.normalizedSessionId,
      activeTurnId: typeof state.activeProviderTurnId === "string" ? state.activeProviderTurnId : null,
      semanticResult: result?.ok ? { result: result.result, turnId: this.options.identity.turnId, fingerprint: JSON.stringify(result.result) } : null,
      terminalTurns: terminal ? [{ turnId: this.options.identity.turnId, fingerprint: JSON.stringify(terminal.payload) }] : [],
      providerRecoveryPolicy: "same_session_only",
      lastSourceSequence: this.#events.at(-1)?.sourceSeq ?? 0 };
  }
  async detachControllerForRestart() {
    this.#closed = true; this.#wake();
    await this.#detachPort?.(); await this.#release?.(); await this.#core?.stop();
    await this.#core?.drainPendingConnectionProcessing();
    this.#core?.retireSemanticToolCallbacks();
  }
  async close(input: { reason: string; force?: boolean }) {
    if (this.#closed) return;
    if (input.force) await this.interrupt();
    await this.#command("session.close", {}, "dot_close");
    await this.#command("runner.shutdown", {}, "dot_shutdown");
    await this.detachControllerForRestart();
  }
}
