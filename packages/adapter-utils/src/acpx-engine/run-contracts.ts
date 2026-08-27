// Contract types for the ACPX run coordinator refactor.
//
// This module declares the types only. No production code consumes them yet.
// Each placeholder type maps to a field that `AcpxPreparedRuntime` carries in
// `execute.ts` today. The later coordinator phases move the ownership of those
// fields onto these contracts one seam at a time.
//
// Two brands (`ReadyRunResources`, `ConsumedRunResources`) mark a resource set
// that only the resource ledger can produce. Two more brands mark a run-scoped
// launch contribution and the finalized launch environment. A brand is a private
// `unique symbol`, so no other module can build a branded value by a plain
// object literal. Only the module that owns the symbol returns the value.

import type { AcpRuntime, AcpRuntimeHandle } from "acpx/runtime";
import type {
  AdapterExecutionTarget,
  AdapterExecutionTargetPaperclipBridgeHandle,
  AdapterExecutionTargetProcessSessionBridgeHandle,
  PreparedAdapterExecutionTargetRuntime,
} from "@paperclipai/adapter-utils/execution-target";
import type { WorkspaceRestoreOutcome } from "../workspace-restore-merge.js";

// ---------------------------------------------------------------------------
// Resource identity
// ---------------------------------------------------------------------------

/**
 * The closed set of run resources the ledger can hold. The set is fixed; a new
 * resource needs a new member here and a payload in `RunResourcePayloads`.
 *
 * `acp_runtime` is a composite of the runtime, the session handle, and the
 * child process. `runtime.close()` is the one release boundary for all three.
 *
 * These are NOT resources and never enter the ledger: `sessionKey`, the
 * environment lease, the realized execution target, the cleanup registrations,
 * the reuse-store entries, the three OTel spans, the turn timer, the child
 * stderr flush state, and the idle timers.
 */
export type ResourceId =
  | "acp_runtime"
  | "staged_runtime"
  | "control_bridge"
  | "agent_bridge"
  | "managed_home"
  | "staging_lease";

/**
 * The outcome the ledger records for a resource when it leaves the ledger.
 * `finalized` means the run released the resource here. `transferred` means the
 * run handed ownership to settlement.
 */
export type ResourceDisposition = "finalized" | "transferred";

/**
 * The lifetime a cleanup belongs to.
 *
 * A `startup_rollback` cleanup runs only when startup fails, to undo a partial
 * bring-up. A `per_run` cleanup runs at settlement, at the end of the run. A
 * successful `seal()` promotes each promotable `startup_rollback` entry to
 * `per_run`, because the resource now lives through the whole run.
 */
export type CleanupScope = "startup_rollback" | "per_run";

// ---------------------------------------------------------------------------
// Resource payloads
// ---------------------------------------------------------------------------

/**
 * The `acp_runtime` composite. `runtime.close()` releases the runtime, the
 * session handle, and the child process together. Maps to the runtime, the
 * session handle, and the spawned child that `execute.ts` builds in
 * `buildRuntime`.
 */
export interface AcpRuntimeResource {
  readonly runtime: AcpRuntime;
  readonly sessionHandle: AcpRuntimeHandle;
  /** The pid of the spawned agent child, or null before the first spawn. */
  readonly childProcessPid: number | null;
}

/**
 * The staged in-sandbox runtime and its one-time host-side cleanup. Maps to
 * `AcpxPreparedRuntime.stagedRuntime` and `remoteStagingDispose`.
 */
export interface StagedRuntimeResource {
  readonly stagedRuntime: PreparedAdapterExecutionTargetRuntime;
  /** Remove the host-side staged temp. Fired only when the stage is dropped. */
  readonly disposeStaged: () => Promise<void>;
}

/**
 * The per-adapter managed-home seam. Maps to
 * `AcpxPreparedRuntime.remoteManagedHomeTeardown` and `remoteStagingEnvDelta`.
 */
export interface ManagedHomeResource {
  /**
   * Per-run copy-back hook. Runs the auth copy-back and the workspace restore
   * on every exit path. Resolves to the workspace-restore outcome — never
   * rejects — so the run coordinator can surface a failed restore on the run
   * record without changing the run's exit code or status.
   */
  readonly teardown: () => Promise<WorkspaceRestoreOutcome>;
  /** The env keys the seam mutated on this run. */
  readonly envDelta: Record<string, string>;
}

/**
 * The per-session staging lease. Maps to
 * `AcpxPreparedRuntime.sessionStagingLeaseRelease`.
 */
export interface StagingLeaseResource {
  /** Release the staging lease so a later overlapping run can re-stage. */
  readonly release: () => void;
}

/**
 * Maps each resource id to its payload. The `control_bridge` is the Paperclip
 * control-plane bridge; the `agent_bridge` is the agent process-session bridge.
 */
export interface RunResourcePayloads {
  readonly acp_runtime: AcpRuntimeResource;
  readonly staged_runtime: StagedRuntimeResource;
  readonly control_bridge: AdapterExecutionTargetPaperclipBridgeHandle;
  readonly agent_bridge: AdapterExecutionTargetProcessSessionBridgeHandle;
  readonly managed_home: ManagedHomeResource;
  readonly staging_lease: StagingLeaseResource;
}

/** One resource the caller registers into the ledger. */
export interface RunResourceRegistration<Id extends ResourceId = ResourceId> {
  readonly id: Id;
  readonly payload: RunResourcePayloads[Id];
  readonly scope: CleanupScope;
  /**
   * Marks a `startup_rollback` entry that `seal()` promotes to `per_run`.
   * Default true. Set false to pin the entry as rollback-only. Ignored for a
   * `per_run` entry.
   */
  readonly promotable?: boolean;
  /**
   * The ledger calls this once when it finalizes or transfers the resource. It
   * records the disposition. It runs no release itself.
   */
  readonly onDisposition?: (disposition: ResourceDisposition) => void;
}

/** One resource the settlement claim carries out of the ledger. */
export interface SettledResourceEntry<Id extends ResourceId = ResourceId> {
  readonly id: Id;
  readonly payload: RunResourcePayloads[Id];
  readonly scope: CleanupScope;
  readonly disposition: ResourceDisposition;
}

// ---------------------------------------------------------------------------
// Ledger surface and its two branded results
// ---------------------------------------------------------------------------

declare const READY_RUN_RESOURCES: unique symbol;
declare const CONSUMED_RUN_RESOURCES: unique symbol;

/**
 * The sealed, validated resource set. Only `AcquiredRunResources.seal()`
 * produces this brand. The turn reads its resources through this handle.
 */
export interface ReadyRunResources {
  readonly [READY_RUN_RESOURCES]: true;
  /** The payload for a resource id, or undefined when the slot is empty. */
  get<Id extends ResourceId>(id: Id): RunResourcePayloads[Id] | undefined;
  /** The scope of a resource id after promotion, or undefined when empty. */
  scopeOf(id: ResourceId): CleanupScope | undefined;
  /** True when the slot holds a resource. */
  has(id: ResourceId): boolean;
  /** The required ids that `seal()` validated. */
  readonly sealed: readonly ResourceId[];
}

/**
 * The one-time settlement claim. Only `AcquiredRunResources.takeForSettlement()`
 * produces this brand. Settlement releases the resources this claim carries.
 */
export interface ConsumedRunResources {
  readonly [CONSUMED_RUN_RESOURCES]: true;
  /** The resources, each with its final scope and disposition. */
  entries(): readonly SettledResourceEntry[];
}

/**
 * The write surface the startup path holds while it acquires resources.
 * `register` is the only writer. `seal` and `takeForSettlement` end the write
 * phase. The state machine is `open -> sealed -> consumed` or `open ->
 * consumed`.
 */
export interface AcquiredRunResources {
  register<Id extends ResourceId>(registration: RunResourceRegistration<Id>): void;
  seal(required: readonly ResourceId[]): ReadyRunResources;
  takeForSettlement(): ConsumedRunResources;
}

/** The error the ledger throws on an out-of-order or duplicate operation. */
export class LedgerStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerStateError";
  }
}

// ---------------------------------------------------------------------------
// Startup, turn, and settlement outcomes
// ---------------------------------------------------------------------------

/**
 * The four phases a pre-turn failure can occur in. A pre-turn failure happens
 * after the ledger acquires resources but before the turn runs.
 */
export interface PreTurnFailedCause {
  readonly kind: "pre_turn_failed";
  readonly phase:
    | "runtime_create"
    | "handshake"
    | "session_handle_missing"
    | "session_configuration";
  readonly error: Error;
}

/** The turn ran and failed with an error. */
export interface TurnFailedCause {
  readonly kind: "turn_failed";
  readonly error: Error;
}

/** The caller cancelled the turn. */
export interface TurnCancelledCause {
  readonly kind: "turn_cancelled";
  readonly reason: string;
}

/** The turn hit its wall-clock timeout. */
export interface TurnTimedOutCause {
  readonly kind: "turn_timed_out";
  readonly timeoutSec: number;
}

/** A cause that the turn itself produced. Disjoint from `PreTurnFailedCause`. */
export type TurnCause = TurnFailedCause | TurnCancelledCause | TurnTimedOutCause;

/** Any cause that leads a run into settlement. */
export type SettlementCause = PreTurnFailedCause | TurnCause;

/**
 * Startup produced a ready runtime. The turn can run against these resources.
 */
export interface StartupReady {
  readonly kind: "ready";
  readonly resources: ReadyRunResources;
  readonly context: AcpRunContext;
}

/**
 * Startup failed after it acquired resources, so the run must settle them. A
 * build failure and a partial-bridge failure do NOT reach here — they throw,
 * and the coordinator owns that rollback (Phase 20).
 */
export interface StartupSettle {
  readonly kind: "settle";
  readonly cause: PreTurnFailedCause;
  readonly resources: ConsumedRunResources;
}

export type StartupResult = StartupReady | StartupSettle;

/**
 * The turn finished and released everything in place. It carries no resources,
 * so settlement has nothing to do.
 */
export interface FinalizedTurn {
  readonly kind: "finalized";
}

/** The turn failed. Settlement releases the carried resources. */
export interface FailedTurn {
  readonly kind: "failed";
  readonly cause: TurnFailedCause;
  readonly resources: ConsumedRunResources;
}

/** The caller cancelled the turn. Settlement releases the carried resources. */
export interface CancelledTurn {
  readonly kind: "cancelled";
  readonly cause: TurnCancelledCause;
  readonly resources: ConsumedRunResources;
}

/** The turn timed out. Settlement releases the carried resources. */
export interface TimedOutTurn {
  readonly kind: "timed_out";
  readonly cause: TurnTimedOutCause;
  readonly resources: ConsumedRunResources;
}

/** The four ways a turn completes. Only `FinalizedTurn` is resourceless. */
export type TurnCompletion = FinalizedTurn | FailedTurn | CancelledTurn | TimedOutTurn;

// ---------------------------------------------------------------------------
// Run site
// ---------------------------------------------------------------------------

/** The host site runs on the host. The sandbox site runs in a remote runner. */
export type RunSiteKind = "host" | "sandbox";

/**
 * The synchronous plan a site produces before the fingerprint build. `plan()`
 * must be synchronous, because `sessionCwd` is a fingerprint input.
 */
export interface SitePlan {
  /**
   * The cwd the session binds to and the fingerprint reads. `placeWorkspace` is
   * not its source; the site derives it before it places the workspace.
   */
  readonly sessionCwd: string;
  /**
   * The host-only spawn cwd for the relay proxy on the remote process-session
   * lane. Undefined on every other lane. Maps to `AcpxPreparedRuntime.
   * hostSpawnCwd`.
   */
  readonly spawnCwd: string | undefined;
  /** True only for a sandbox target, where the run emits real OTel spans. */
  readonly tracingEnabled: boolean;
}

/** One referenced project whose staging into the sandbox failed. */
export interface ReferencedProjectStagingFailure {
  readonly projectId: string;
  /** The failure reason. A reader of the run sees why the project dropped. */
  readonly error: string;
}

/**
 * The result of placing the workspace. Carries the referenced-project staging
 * failures the run reports back on its result.
 */
export interface PlacedWorkspace {
  readonly referencedProjectStagingFailures: readonly ReferencedProjectStagingFailure[];
}

/** The transport handles the site started for the run. */
export interface RunSiteTransport {
  readonly controlBridge: AdapterExecutionTargetPaperclipBridgeHandle | null;
  readonly agentBridge: AdapterExecutionTargetProcessSessionBridgeHandle | null;
}

/** What the host site's store can save: the live runtime and session handle. */
export interface HostReuseCandidate {
  readonly runtime: AcpRuntime;
  readonly sessionHandle: AcpRuntimeHandle;
}

/** What the sandbox site's store can save: the staged files. */
export interface SandboxReuseCandidate {
  readonly stagedRuntime: PreparedAdapterExecutionTargetRuntime;
}

export type RunSiteReuseCandidate = HostReuseCandidate | SandboxReuseCandidate;

/** Construction options for a `SessionReuseStore`. */
export interface SessionReuseStoreOptions {
  /**
   * The optional per-entry idle timeout, in milliseconds. When set, `evictIdle`
   * drops an entry that stayed idle longer than this bound.
   */
  readonly idleMs?: number;
}

/**
 * The per-site store that saves a reuse candidate across runs. The store is
 * generic in the saved type, so a generic `save` cannot know what a site saves.
 * `RunSite.reuseCandidate()` names the concrete type per site.
 */
export interface SessionReuseStore<T> {
  borrow(sessionKey: string): T | undefined;
  save(sessionKey: string, entry: T): void;
  /**
   * Identity-guarded removal that fires the idempotent release. It removes the
   * key synchronously, so a later reuse never reads a discarded entry. It
   * returns a promise the caller can await when the release must finish before
   * the run releases a downstream resource (e.g. the staging lease).
   */
  discard(sessionKey: string): void | Promise<void>;
  /**
   * Run-start idle sweep. It removes each stale key synchronously, so
   * `buildRuntime` never reuses an expired entry. It returns a promise the
   * caller can await so the sweep completes before the run reads the cache.
   */
  evictIdle(now: number): void | Promise<void>;
}

/**
 * A run site. The host site and the sandbox site differ in what they place,
 * what transport they start, and what their store saves.
 */
export interface RunSite<TReuse extends RunSiteReuseCandidate = RunSiteReuseCandidate> {
  readonly kind: RunSiteKind;
  /** Synchronous. Runs before the fingerprint build. */
  plan(context: AcpRunContext): SitePlan;
  placeWorkspace(context: AcpRunContext): Promise<PlacedWorkspace>;
  startTransport(context: AcpRunContext): Promise<RunSiteTransport>;
  reuse(): SessionReuseStore<TReuse>;
  /** Names the concrete candidate this site's store can save. */
  reuseCandidate(resources: ReadyRunResources): TReuse;
  syncBack(context: AcpRunContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Identity, launch environment, and run context
// ---------------------------------------------------------------------------

export type AcpxRunMode = "persistent" | "oneshot";
export type AcpxPermissionMode = "approve-all" | "approve-reads" | "deny-all";
export type AcpxNonInteractivePermissions = "deny" | "fail";

/** One MCP server, in the shape the fingerprint reads. */
export interface McpServerIdentity {
  readonly name: string;
  readonly url: string;
  readonly connectionId: string;
}

/** The Paperclip Claude settings the fingerprint reads. */
export interface PaperclipClaudeSettingsIdentity {
  readonly allow: readonly string[];
  readonly additionalDirectories: readonly string[];
  readonly defaultMode: string;
}

/**
 * The 17 fields the session fingerprint hashes. Company, agent, and task
 * identifiers are NOT here; they scope the outer session key only (see
 * `SessionKeyIdentity`). A change to any field here invalidates a warm handle
 * or a resumable session and forces a fresh launch.
 */
export interface SessionFingerprintIdentity {
  readonly acpxAgent: string;
  readonly agentCommand: string;
  readonly cwd: string;
  readonly mode: AcpxRunMode;
  readonly permissionMode: AcpxPermissionMode;
  readonly nonInteractivePermissions: AcpxNonInteractivePermissions;
  readonly requestedModel: string;
  readonly requestedThinkingEffort: string;
  readonly fastMode: boolean;
  readonly remoteExecutionIdentity: Record<string, unknown> | null;
  readonly additionalSourcesIdentity: Record<string, unknown>;
  readonly skillsIdentity: Record<string, unknown>;
  readonly skillPromptInstructions: string;
  readonly paperclipClaudeSettings: PaperclipClaudeSettingsIdentity | null;
  readonly mcpServers: readonly McpServerIdentity[];
  readonly secretManifestHash: string;
  readonly adapterEnvHash: string;
}

/**
 * The company, agent, and task parts of the session key. The key form is
 * `paperclip:companyId:agentId:taskKey:fingerprint`. These parts stay out of
 * the fingerprint hash.
 */
export interface SessionKeyIdentity {
  readonly companyId: string;
  readonly agentId: string;
  readonly taskKey: string;
}

declare const RUN_SCOPED_CONTRIBUTION: unique symbol;
declare const LAUNCH_ENVIRONMENT: unique symbol;

/**
 * A launch-environment contribution that lives for one run only. The run API
 * key and every bridge token are run-scoped. The brand makes this type
 * non-transferable: no reuse payload type can hold it (Amendment B).
 */
export interface RunScopedContribution {
  readonly scope: "run";
  readonly env: Record<string, string>;
  readonly [RUN_SCOPED_CONTRIBUTION]: true;
}

/**
 * A launch-environment contribution that lives for the whole session. The Codex
 * auth copy-back material is session-scoped.
 */
export interface SessionScopedContribution {
  readonly scope: "session";
  readonly env: Record<string, string>;
}

export type LaunchEnvironmentContribution = RunScopedContribution | SessionScopedContribution;

/**
 * The finalized launch environment. Only `finalizeLaunchEnvironment()`
 * (Phase 17) produces this brand. No reuse payload type can hold it.
 */
export interface LaunchEnvironment {
  readonly [LAUNCH_ENVIRONMENT]: true;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The context the coordinator threads through the run. The site reads the
 * execution target for its effective capabilities.
 */
export interface AcpRunContext {
  readonly executionTarget: AdapterExecutionTarget;
  readonly fingerprintIdentity: SessionFingerprintIdentity;
  readonly keyIdentity: SessionKeyIdentity;
  readonly fingerprint: string;
  readonly sessionKey: string;
  readonly launchEnvironment: LaunchEnvironment;
}
