import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, companySecretVersions, environmentLeases } from "@paperclipai/db";
import type {
  Environment,
  EnvironmentLease,
  EnvironmentLeaseStatus,
  ExecutionWorkspace,
  InstanceExperimentalSettings,
  IssueExecutionWorkspaceSettings,
  PluginEnvironmentConfig,
  SandboxEnvironmentConfig,
  SandboxProviderCapabilities,
} from "@paperclipai/shared";
import { resolveDeclaredSandboxCapabilities } from "@paperclipai/shared";
import type { EffectiveSandboxCapabilities } from "@paperclipai/adapter-utils/execution-target";
import type {
  CommandManagedDuplexChannel,
} from "@paperclipai/adapter-utils/command-managed-runtime";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentSyncResult,
  PluginSyncOperation,
} from "@paperclipai/plugin-sdk";
import { ensureSshWorkspaceReady } from "@paperclipai/adapter-utils/ssh";
import {
  getActiveStepContext,
  runWithRuntimeParent,
  type StartupSpanContext,
} from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import { environmentService } from "./environments.js";
import { instanceSettingsService } from "./instance-settings.js";
import {
  collectEnvironmentSecretRefs,
  parseEnvironmentDriverConfig,
  resolveEnvironmentDriverConfigForRuntime,
  resolveSandboxCleanupConfigSecrets,
  stripSandboxProviderEnvelope,
} from "./environment-config.js";
import {
  createEffectiveRunConfigFingerprints,
  type EffectiveRunConfigFingerprint,
  type EffectiveRunConfigSecretVersionMetadata,
} from "./effective-run-config-fingerprints.js";
import {
  acquireSandboxProviderLease,
  destroySandboxProviderLease,
  findReusableSandboxProviderLeaseId,
  getSandboxProvider as getBuiltinSandboxProvider,
  isBuiltinSandboxProvider,
  releaseSandboxProviderLease,
  sandboxConfigFromLeaseMetadata,
  sandboxConfigFromLeaseMetadataLoose,
} from "./sandbox-provider-runtime.js";
import { pluginRegistryService } from "./plugin-registry.js";
import type {
  ExecuteLogSink,
  PluginWorkerManager,
  DuplexChannelHostSession,
  DuplexChannelOpenInput as WorkerManagerDuplexChannelOpenInput,
} from "./plugin-worker-manager.js";
import {
  REUSABLE_LEASE_WORKER_METHODS,
  destroyPluginEnvironmentLease,
  executePluginEnvironmentCommand,
  realizePluginEnvironmentWorkspace,
  resolvePluginSandboxProviderDriverByKey,
  resolvePluginSandboxProviderDriverById,
  resolvePluginExecuteRpcTimeoutMs,
  resumePluginEnvironmentLease,
} from "./plugin-environment-driver.js";
import { collectSecretRefPaths } from "./json-schema-secret-refs.js";
import { buildWorkspaceRealizationRecordFromDriverInput } from "./workspace-realization.js";
import {
  createSandboxOrphanCleanupSpool,
  type DeferredOrphanCleanupRecord,
  type SandboxOrphanCleanupSpool,
} from "./sandbox-orphan-cleanup-spool.js";
import { logger } from "../middleware/logger.js";

// The constant error kind for the durable orphan-cleanup-write-failed log. The
// log never reads the caught exception, because the exception can carry a
// credential in its name, code, message, cause, or stack. So the log records
// this constant and the plain provider identifiers only.
const SANDBOX_ORPHAN_CLEANUP_WRITE_ERROR_KIND = "sandbox_orphan_cleanup_write_failed";

// The fixed non-secret refusal a duplex channel open returns when the lease does
// not grant the opt-in `duplexCommandStream` capability. The service resolves the
// exact lease capability snapshot and throws this before it reaches any driver.
const DUPLEX_CHANNEL_CAPABILITY_DENIED =
  "Sandbox lease does not grant the duplex command stream capability.";

// ---------------------------------------------------------------------------
// Sandbox capability contract — one normalizer for both branches
// ---------------------------------------------------------------------------

export const SANDBOX_CAPABILITY_KEYS = [
  "reusableLeases",
  "nativeSyncIn",
  "nativeSyncOut",
  "persistentProcessSessions",
  "independentControlCommands",
  "incrementalSessionOutput",
  "concurrentSyncOperations",
  "duplexCommandStream",
] as const;

export type SandboxCapabilityKey = (typeof SANDBOX_CAPABILITY_KEYS)[number];

/**
 * Opt-in capability keys. Most capabilities are a worker property: an absent
 * declaration defers to the verified baseline and allows the capability. An
 * opt-in capability is a behavioral guarantee that only some providers make, so
 * an absent declaration denies it. A generic one-shot provider must not get an
 * opt-in capability just because its worker verifies a shared verb such as
 * `environmentExecute`. Only a provider that declares the key `true` (and still
 * verifies the prerequisites and passes narrowing) gets the capability.
 */
const SANDBOX_CAPABILITY_OPT_IN_KEYS: ReadonlySet<SandboxCapabilityKey> = new Set([
  "incrementalSessionOutput",
  "concurrentSyncOperations",
  "duplexCommandStream",
]);

/**
 * Verified prerequisite mapping: the worker methods each capability requires.
 *
 * Each capability maps to a list of requirement groups. A group holds one or
 * more verbs; the group is met when the runtime verified AT LEAST ONE verb in
 * it. A capability verifies only when EVERY group is met.
 *
 * The verbs are the worker method names from the worker discovery list (the
 * plugin worker reports them from `handleInitialize`). A built-in provider maps
 * its own methods to the same verb names through
 * {@link builtinSandboxProviderVerifiedMethods}, so both branches share this
 * mapping and the one normalizer below.
 *
 * The mapping was audited against the worker discovery list and the runtime
 * execution guards:
 * - `nativeSyncIn`/`nativeSyncOut` require the matching sync verb; the native
 *   sync guard checks both verbs before it routes a lease to the native hook.
 * - `reusableLeases` requires `environmentResumeLease` (reattach),
 *   `environmentReleaseLease` (end-of-run release), and `environmentDestroyLease`
 *   (stale-lease teardown). All three run on the reuse path: the runtime resumes
 *   or releases the lease, and it destroys the stale lease when a resume fails
 *   before it acquires a fresh lease.
 * - `persistentProcessSessions` and `independentControlCommands` require
 *   `environmentExecute`; both run commands through it.
 * - `incrementalSessionOutput` requires `environmentExecute` too, because the
 *   provider tails the session log through it. The verified verb is necessary
 *   but not sufficient: this key is opt-in, so the declaration is the real gate
 *   (see {@link SANDBOX_CAPABILITY_OPT_IN_KEYS}).
 * - `concurrentSyncOperations` requires BOTH sync verbs, because parallel
 *   bidirectional transfer runs an inbound and an outbound transfer at the same
 *   time. The two verbs are separate required groups, so a provider that
 *   verifies only one direction cannot get the capability. The verbs are
 *   necessary but not sufficient: this key is opt-in, so the declaration is the
 *   real gate (see {@link SANDBOX_CAPABILITY_OPT_IN_KEYS}).
 * - `duplexCommandStream` requires `duplexChannelOpen`, the worker verb that
 *   opens the persistent duplex channel. The verified verb is necessary but not
 *   sufficient: this key is opt-in, so the declaration is the real gate. A
 *   provider that does not implement the duplex open verb resolves `false` and
 *   keeps the file bridge.
 */
const SANDBOX_CAPABILITY_PREREQUISITE_METHODS: Record<SandboxCapabilityKey, readonly (readonly string[])[]> = {
  // Reusable leases require ALL reuse verbs. Each verb is its own required
  // group, so every one must be verified. The list function that publishes
  // provider-level reusable support checks the same verbs; both read from
  // `REUSABLE_LEASE_WORKER_METHODS`, so the runtime guard and the published
  // value cannot drift.
  reusableLeases: REUSABLE_LEASE_WORKER_METHODS.map((method) => [method]),
  nativeSyncIn: [["environmentSyncIn"]],
  nativeSyncOut: [["environmentSyncOut"]],
  persistentProcessSessions: [["environmentExecute"]],
  independentControlCommands: [["environmentExecute"]],
  incrementalSessionOutput: [["environmentExecute"]],
  concurrentSyncOperations: [["environmentSyncIn"], ["environmentSyncOut"]],
  duplexCommandStream: [["duplexChannelOpen"]],
};

function capabilityIsVerified(
  key: SandboxCapabilityKey,
  verifiedMethods: ReadonlySet<string>,
): boolean {
  return SANDBOX_CAPABILITY_PREREQUISITE_METHODS[key].every((group) =>
    group.some((verb) => verifiedMethods.has(verb)),
  );
}

/**
 * Map a built-in sandbox provider's own methods to the worker verb names the
 * prerequisite mapping uses, so the built-in branch and the plug-in branch feed
 * the SAME normalizer. A built-in provider has no native sync hooks, so it never
 * verifies a sync verb. It verifies `environmentExecute` when it implements
 * `execute`, and the reuse verbs only when it declares `supportsReusableLeases`.
 * A built-in reusable provider destroys its own leases in-process, so it
 * verifies `environmentDestroyLease` with the two reuse verbs.
 */
export function builtinSandboxProviderVerifiedMethods(
  provider: { supportsReusableLeases?: boolean; execute?: unknown } | null | undefined,
): string[] {
  if (!provider) return [];
  const methods: string[] = [];
  if (typeof provider.execute === "function") {
    methods.push("environmentExecute");
  }
  if (provider.supportsReusableLeases === true) {
    methods.push(
      "environmentResumeLease",
      "environmentReleaseLease",
      "environmentDestroyLease",
    );
  }
  return methods;
}

/**
 * The one normalizer for the sandbox capability contract. It resolves the
 * effective capability as verified ∩ declared ∩ narrowing.
 *
 * - `verifiedMethods` is the runtime's verified worker verb list (the plug-in
 *   worker's `supportedMethods`, or a built-in provider mapped through
 *   {@link builtinSandboxProviderVerifiedMethods}). A missing or empty list
 *   verifies nothing, so every capability resolves `false` (fail closed).
 * - `declared` is the provider's declaration. An absent flag defers to the
 *   verified discovery baseline; it never grants a capability. A present flag
 *   can only remove a verified capability, never add one.
 * - `narrowing` is the per-target restriction from the config or lease. An
 *   absent key applies no restriction; a `false` value removes the capability.
 *
 * A declaration never grants a capability the runtime did not verify, so a
 * declared capability whose worker lacks a prerequisite verb resolves `false`.
 */
export function resolveEffectiveSandboxCapabilities(input: {
  verifiedMethods?: readonly string[] | null;
  declared?: Partial<SandboxProviderCapabilities> | null;
  narrowing?: Partial<Record<SandboxCapabilityKey, boolean>> | null;
}): EffectiveSandboxCapabilities {
  const verifiedMethods = new Set(input.verifiedMethods ?? []);
  const declared = input.declared ?? {};
  const narrowing = input.narrowing ?? {};

  const resolve = (key: SandboxCapabilityKey): boolean => {
    const verified = capabilityIsVerified(key, verifiedMethods);
    // An absent declaration defers to the verified baseline for a worker-property
    // capability (true = no extra restriction), but denies an opt-in capability
    // (false). A present declaration can only narrow.
    const declaredDefault = SANDBOX_CAPABILITY_OPT_IN_KEYS.has(key) ? false : true;
    const declaredAllows = declared[key] ?? declaredDefault;
    // An absent narrowing applies no restriction.
    const narrowingAllows = narrowing[key] ?? true;
    return verified && declaredAllows && narrowingAllows;
  };

  return {
    reusableLeases: resolve("reusableLeases"),
    nativeSyncIn: resolve("nativeSyncIn"),
    nativeSyncOut: resolve("nativeSyncOut"),
    persistentProcessSessions: resolve("persistentProcessSessions"),
    independentControlCommands: resolve("independentControlCommands"),
    incrementalSessionOutput: resolve("incrementalSessionOutput"),
    concurrentSyncOperations: resolve("concurrentSyncOperations"),
    duplexCommandStream: resolve("duplexCommandStream"),
  };
}

/**
 * Build the per-target narrowing for a sandbox lease. Narrowing removes a
 * capability that the provider verified and declared but that this specific
 * lease or config cannot use. Each source is grounded in existing runtime
 * behavior:
 * - `reusableLeases` follows this lease's resolved policy (an ephemeral lease
 *   never reuses).
 * - a Kubernetes Job lease disables native sync (mirrors the native sync guard,
 *   which falls back for a `job` backend or a `nativeFileSyncUnsupported` lease).
 * - `configResolutionFailed` marks that the runtime could not resolve the
 *   provider config. A provider whose config cannot be resolved is untrusted, so
 *   the runtime fails closed and narrows `persistentProcessSessions`,
 *   `incrementalSessionOutput`, and `duplexCommandStream` to false. An empty
 *   config alone does not fail closed; only a resolution error does.
 */
export function buildSandboxCapabilityNarrowing(input: {
  leasePolicy?: EnvironmentLease["leasePolicy"] | null;
  leaseMetadata?: Record<string, unknown> | null;
  configResolutionFailed?: boolean;
}): Partial<Record<SandboxCapabilityKey, boolean>> {
  const narrowing: Partial<Record<SandboxCapabilityKey, boolean>> = {};
  const metadata = input.leaseMetadata ?? {};

  narrowing.reusableLeases = input.leasePolicy === "reuse_by_environment";

  if (metadata.backend === "job" || metadata.nativeFileSyncUnsupported === true) {
    narrowing.nativeSyncIn = false;
    narrowing.nativeSyncOut = false;
  }

  if (input.configResolutionFailed === true) {
    // The runtime could not resolve the provider config, so it fails closed and
    // denies persistent process sessions, incremental session output, and the
    // duplex command stream. The session-output streaming gate reads
    // `incrementalSessionOutput`, so it must narrow with the persistent-session
    // gate to keep the fail-closed behavior. The duplex command stream opens a
    // host-owned bidirectional channel, so an untrusted provider must not keep
    // it either.
    narrowing.persistentProcessSessions = false;
    narrowing.incrementalSessionOutput = false;
    narrowing.duplexCommandStream = false;
  }

  return narrowing;
}

export function buildEnvironmentLeaseContext(input: {
  persistedExecutionWorkspace: Pick<ExecutionWorkspace, "id" | "mode"> | null;
}) {
  return {
    executionWorkspaceId: input.persistedExecutionWorkspace?.id ?? null,
    executionWorkspaceMode: input.persistedExecutionWorkspace?.mode ?? null,
  };
}

/**
 * The per-run duplex bridge input. The host resolves it for each new run before
 * it selects the sandbox callback bridge transport. When `enableDuplexBridge` is
 * false the host keeps the file bridge with no manifest change and no redeploy.
 * The transport selection reads this input in a later phase; this phase only
 * delivers the setting and the per-run read.
 */
export interface ResolvedSandboxDuplexBridgeInput {
  /** True only when the instance opts in to the sandbox duplex command stream. */
  enableDuplexBridge: boolean;
}

/**
 * Map the experimental instance setting `enableSandboxDuplexBridge` into the
 * per-run duplex bridge input. The setting is the kill switch. It defaults off,
 * so an absent or false setting keeps the file bridge.
 */
export function resolveSandboxDuplexBridgeInput(
  experimental: Pick<InstanceExperimentalSettings, "enableSandboxDuplexBridge">,
): ResolvedSandboxDuplexBridgeInput {
  return { enableDuplexBridge: experimental.enableSandboxDuplexBridge === true };
}

function stripSecretRefValuesFromPluginLeaseMetadata(input: {
  metadata: Record<string, unknown> | null | undefined;
  schema: Record<string, unknown> | null | undefined;
}): Record<string, unknown> {
  const sanitized = structuredClone(input.metadata ?? {}) as Record<string, unknown>;

  for (const path of collectSecretRefPaths(input.schema)) {
    const keys = path.split(".");
    const parents: Array<{ container: Record<string, unknown>; key: string }> = [];
    let cursor: Record<string, unknown> | null = sanitized;

    for (let index = 0; index < keys.length - 1; index += 1) {
      const key = keys[index]!;
      const next = cursor?.[key];
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        cursor = null;
        break;
      }
      parents.push({ container: cursor, key });
      cursor = next as Record<string, unknown>;
    }

    if (!cursor) continue;

    const leafKey = keys[keys.length - 1]!;
    if (!Object.prototype.hasOwnProperty.call(cursor, leafKey)) continue;
    delete cursor[leafKey];

    for (let index = parents.length - 1; index >= 0; index -= 1) {
      const { container, key } = parents[index]!;
      const value = container[key];
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value as Record<string, unknown>).length === 0
      ) {
        delete container[key];
      } else {
        break;
      }
    }
  }

  return sanitized;
}

export interface EnvironmentDriverAcquireInput {
  companyId: string;
  environment: Environment;
  issueId: string | null;
  agentId: string | null;
  /**
   * UUID of the owning heartbeat run, or null for ad-hoc invocations
   * (e.g. operator-initiated `Test` probes) that are not tied to a run.
   * Null leases must be released by id via `getDriver(...).releaseRunLease`
   * since `releaseRunLeases(heartbeatRunId)` cannot find them.
   */
  heartbeatRunId: string | null;
  executionWorkspaceId: string | null;
  executionWorkspaceMode: ExecutionWorkspace["mode"] | null;
  executionWorkspaceSettings: IssueExecutionWorkspaceSettings | null;
  /**
   * The harness/adapter type for this run (the agent's adapter). Drivers that
   * materialize a per-run sandbox use it to select the runtime image so a single
   * environment can serve mixed harnesses; null falls back to the environment's
   * configured default adapter.
   */
  adapterType: string | null;
  /**
   * Force applying the active custom-image template even when issueId and
   * heartbeatRunId are null. Operator-initiated `Test` probes set this so the
   * probe uses the operator-prepared custom image for the runtime lease instead
   * of the base image, matching what real agent runs do.
   */
  applyCustomImageTemplate?: boolean;
  /**
   * The latest time the acquired lease may stay active. A caller with an
   * independent deadline (for example the setup-token login session) sets it,
   * so the driver bounds the persisted lease expiry to this time. The driver
   * records the earlier of this time and the provider expiry. Null or undefined
   * keeps the provider expiry only, so all other callers keep the current
   * behavior.
   */
  requestedExpiresAt?: Date | null;
  /**
   * Re-check the environment company binding inside the lease insert
   * transaction. The login acquire paths set this so a managed reconciliation
   * that binds the sandbox to another company between the route guard and this
   * acquire cannot let the login run in a foreign-company sandbox. The lease
   * insert then rejects a foreign-company environment with the 403
   * `environment_company_mismatch` and holds no lease. An unbound
   * (instance-global) environment stays open. Other callers keep the current
   * behavior.
   */
  assertCompanyBinding?: boolean;
}

export interface EnvironmentDriverReleaseInput {
  environment: Environment;
  lease: EnvironmentLease;
  status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed">;
}

function resolvePluginSandboxRpcTimeoutMs(config: Record<string, unknown>): number | undefined {
  const timeoutCandidates = [
    typeof config.timeoutMs === "number" ? config.timeoutMs : undefined,
    typeof config.bridgeRequestTimeoutMs === "number" ? config.bridgeRequestTimeoutMs : undefined,
  ]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
    .map((value) => Math.trunc(value));

  if (timeoutCandidates.length === 0) {
    return undefined;
  }

  return resolvePluginExecuteRpcTimeoutMs({
    requestedTimeoutMs: Math.max(...timeoutCandidates),
    config,
  });
}

export interface EnvironmentDriverLeaseInput {
  environment: Environment;
  lease: EnvironmentLease;
  failureReason?: string;
}

export interface EnvironmentDriverRealizeWorkspaceInput extends EnvironmentDriverLeaseInput {
  workspace: {
    localPath?: string;
    remotePath?: string;
    mode?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface EnvironmentDriverExecuteInput extends EnvironmentDriverLeaseInput {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  /**
   * Run this command outside the lease's persistent session. The run
   * orchestrator sets this on the workspace provision command, which runs before
   * the run opens its trace root. A sandbox provider that opens a persistent
   * session on the first command must run this command one-shot and keep the
   * session closed, so the session first opens on an in-run command whose setup
   * span parents to the run trace. The default keeps the session path.
   */
  bypassSession?: boolean;
  /**
   * Force the command onto the lease's persistent session even when no run step
   * is active. The ACP process session bridge sets this so the long-lived agent
   * command opens the session and streams its output through the session log
   * stream. `bypassSession: true` still wins, so an explicit bypass is never
   * overridden. The default keeps the context-based session selection.
   */
  forceSession?: boolean;
  /**
   * Incremental log sink for one execute call. When set, the plugin worker
   * delivers each `stdout` and `stderr` chunk to this sink through the
   * `execute.log` notification while the command runs, before the final result.
   * The runtime forwards it to the plugin worker manager, which routes each
   * chunk to this sink by the host-issued invocation id. A driver that does not
   * stream ignores it and returns only the final result.
   */
  onLog?: ExecuteLogSink;
}

export interface EnvironmentDriverSyncInput extends EnvironmentDriverLeaseInput {
  operations: PluginSyncOperation[];
}

export interface EnvironmentDriverOpenDuplexChannelInput extends EnvironmentDriverLeaseInput {
  /**
   * The command argument vector the sandbox runs as the duplex channel child
   * process. Element 0 is the program. The worker runs the vector with no
   * shell, so a shell metacharacter in an element cannot inject a command.
   */
  command: readonly string[];
}

export interface EnvironmentRuntimeDriver {
  readonly driver: string;
  acquireRunLease(input: EnvironmentDriverAcquireInput): Promise<EnvironmentLease>;
  releaseRunLease(input: EnvironmentDriverReleaseInput): Promise<EnvironmentLease | null>;
  resumeRunLease?(input: EnvironmentDriverLeaseInput): Promise<PluginEnvironmentLease | EnvironmentLease | null>;
  destroyRunLease?(input: EnvironmentDriverLeaseInput): Promise<EnvironmentLease | null>;
  realizeWorkspace?(input: EnvironmentDriverRealizeWorkspaceInput): Promise<PluginEnvironmentRealizeWorkspaceResult>;
  execute?(input: EnvironmentDriverExecuteInput): Promise<PluginEnvironmentExecuteResult>;
  /**
   * Optional native inbound/outbound file transfer, delegated to the plugin
   * worker's `environmentSyncIn`/`environmentSyncOut` verbs. Only present for
   * plugin-backed sandbox drivers whose worker advertises both verbs; callers
   * gate on {@link EnvironmentRuntimeDriver.supportsSync}.
   */
  syncIn?(input: EnvironmentDriverSyncInput): Promise<PluginEnvironmentSyncResult>;
  syncOut?(input: EnvironmentDriverSyncInput): Promise<PluginEnvironmentSyncResult>;
  /**
   * Optional persistent duplex channel. Present only for a plugin-backed sandbox
   * driver whose lease grants the `duplexCommandStream` capability. The driver
   * opens the host-owned duplex route on the plugin worker and adapts it to the
   * cross-layer {@link CommandManagedDuplexChannel}. Other drivers omit it.
   */
  openDuplexChannel?(
    input: EnvironmentDriverOpenDuplexChannelInput,
  ): Promise<CommandManagedDuplexChannel>;
  /** True when the lease's plugin worker advertises both sync verbs. */
  supportsSync?(input: EnvironmentDriverLeaseInput): boolean;
  /**
   * Resolve the read-only effective sandbox capability snapshot for a lease.
   * Only the sandbox driver implements it; other drivers omit it.
   */
  effectiveSandboxCapabilities?(input: EnvironmentDriverLeaseInput): Promise<EffectiveSandboxCapabilities>;
  /**
   * Retry the provider teardown for an orphan sandbox that an earlier acquire
   * provisioned but could not tear down. The pending-cleanup lease row carries
   * the provider, the provider lease id, and the immutable config metadata, so
   * the retry resolves the teardown from the row alone. It never reads the
   * current environment provider, so a provider change or an environment delete
   * cannot strand the teardown. `environment` is null when a delete already
   * removed the environment row. The method throws when the teardown fails, so
   * the cleanup sweep keeps the row for a later retry.
   */
  retryPendingSandboxTeardown?(input: { environment: Environment | null; lease: EnvironmentLease }): Promise<void>;
  /**
   * Report whether the provider worker can run an orphan teardown now. A plugin
   * sandbox provider worker can be briefly down during its own restart window.
   * A teardown in that window throws, and the cleanup sweep would count that
   * throw against the finite retry cap. So the sweep probes this method before
   * it claims a retry attempt, and skips the lease when the worker is not ready.
   * A later sweep retries after the worker recovers. The method reports `true`
   * for every persistent condition (a built-in provider, a missing plugin, or an
   * absent worker manager), so the teardown still runs, throws, and counts
   * toward the cap. It reports `false` only for the transient worker-down window.
   */
  isPendingCleanupWorkerReady?(input: { environment: Environment | null; lease: EnvironmentLease }): Promise<boolean>;
  /**
   * Flush the in-process buffer of orphan pending-cleanup records that every
   * synchronous database write could not land. The acquire buffers an orphan
   * here when the database is down after a failed teardown, so no durable row
   * exists yet. The cleanup sweep calls this method each tick. The method
   * re-inserts each buffered record. A record whose write now succeeds leaves the
   * buffer and becomes a normal `pending_cleanup` row that the sweep tears down.
   * A record whose write still fails stays in the buffer for a later flush. The
   * method reports how many records it recovered and how many still wait.
   */
  flushDeferredOrphanCleanups?(): Promise<{ recovered: number; pending: number }>;
}

/**
 * The acquire provisioned a remote sandbox, the lease insert rejected it, the
 * compensating teardown failed, and every retry of the durable pending-cleanup
 * write also failed. A live sandbox now has no lease row and no cleanup record,
 * so no sweep can find it. The acquire throws this error so the failure stays visible
 * and never resolves to a clean rejection. The `cause` field holds the original
 * lease insert rejection. The `cleanupWriteError` field holds the write failure.
 */
export class SandboxOrphanCleanupWriteError extends Error {
  readonly provider: string;
  readonly providerLeaseId: string | null;
  readonly cleanupWriteError: unknown;

  constructor(input: {
    provider: string;
    providerLeaseId: string | null;
    cause: unknown;
    cleanupWriteError: unknown;
  }) {
    super(
      `Sandbox provider "${input.provider}" leaked lease ` +
        `"${input.providerLeaseId ?? "unknown"}": the acquire could not tear it down ` +
        "and could not record a durable pending-cleanup row. The live sandbox has no " +
        "durable cleanup state and needs a manual teardown.",
      { cause: input.cause },
    );
    this.name = "SandboxOrphanCleanupWriteError";
    this.provider = input.provider;
    this.providerLeaseId = input.providerLeaseId;
    this.cleanupWriteError = input.cleanupWriteError;
  }
}

export interface EnvironmentRuntimeLeaseRecord {
  environment: Environment;
  lease: EnvironmentLease;
  leaseContext: ReturnType<typeof buildEnvironmentLeaseContext>;
}

const DEFAULT_PLUGIN_SANDBOX_WORKER_READY_TIMEOUT_MS = 5_000;
const DEFAULT_PLUGIN_SANDBOX_WORKER_READY_POLL_MS = 100;

// The durable pending-cleanup write is the only automated way to find a leaked
// sandbox. A single insert can lose to a transient database fault (a dropped
// connection, a lock timeout, a serialization conflict). So the acquire retries
// the write a few times with a short backoff before it gives up. A later
// attempt can still land the durable row that a sweep finds.
const DEFAULT_SANDBOX_ORPHAN_CLEANUP_WRITE_ATTEMPTS = 3;
const DEFAULT_SANDBOX_ORPHAN_CLEANUP_WRITE_BACKOFF_MS = 100;

// A prolonged database outage after a failed teardown can buffer many orphan
// records in-process. The bound stops that buffer from growing without limit. A
// full buffer keeps the error log as the last durable handle for a new orphan.
const DEFAULT_DEFERRED_ORPHAN_CLEANUP_BUFFER_LIMIT = 256;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLeaseDriverKey(
  lease: Pick<EnvironmentLease, "metadata">,
  environment: Pick<Environment, "driver"> | null,
): string {
  const leaseDriver = typeof lease.metadata?.driver === "string" ? lease.metadata.driver : null;
  // An orphan `pending_cleanup` row whose environment a delete removed keeps its
  // driver in the metadata, so the sweep still finds the sandbox driver. Fall
  // back to "sandbox" because only sandbox leases record orphan cleanup.
  return leaseDriver ?? environment?.driver ?? "sandbox";
}

function toEnvironmentLeaseSnapshot(row: typeof environmentLeases.$inferSelect): EnvironmentLease {
  return {
    id: row.id,
    companyId: row.companyId,
    environmentId: row.environmentId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    issueId: row.issueId ?? null,
    heartbeatRunId: row.heartbeatRunId ?? null,
    status: row.status as EnvironmentLease["status"],
    leasePolicy: row.leasePolicy as EnvironmentLease["leasePolicy"],
    provider: row.provider ?? null,
    providerLeaseId: row.providerLeaseId ?? null,
    acquiredAt: row.acquiredAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt ?? null,
    releasedAt: row.releasedAt ?? null,
    failureReason: row.failureReason ?? null,
    cleanupStatus: row.cleanupStatus as EnvironmentLease["cleanupStatus"],
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function reusableRuntimeFingerprint(input: {
  provider: string;
  adapterType: string | null;
  config: Record<string, unknown>;
}): string {
  return createHash("sha256")
    .update(stableStringify(input))
    .digest("hex");
}

function serializeLeaseFingerprint(
  fingerprint: EffectiveRunConfigFingerprint | null | undefined,
): Record<string, unknown> | null {
  if (!fingerprint) return null;
  return {
    version: fingerprint.version,
    category: fingerprint.category,
    algorithm: fingerprint.algorithm,
    fingerprint: fingerprint.fingerprint,
  };
}

function readLeaseFingerprint(value: unknown): string | null {
  return isRecord(value) ? readString(value.fingerprint) : null;
}

async function buildEnvironmentSecretMetadataForLeaseFingerprint(input: {
  db: Db;
  companyId: string;
  environment: Environment;
}): Promise<EffectiveRunConfigSecretVersionMetadata[]> {
  const refs = await collectEnvironmentSecretRefs({
    db: input.db,
    environment: input.environment,
  });
  if (refs.length === 0) return [];

  const secretIds = [...new Set(refs.map((ref) => ref.secretId))];
  const secretRows = await input.db
    .select()
    .from(companySecrets)
    .where(inArray(companySecrets.id, secretIds));
  const secretsById = new Map(
    secretRows
      .filter((secret) => secret.companyId === input.companyId)
      .map((secret) => [secret.id, secret]),
  );

  const versionRequests = refs.flatMap((ref) => {
    const secret = secretsById.get(ref.secretId);
    if (!secret) return [];
    const resolvedVersion = ref.versionSelector === "latest" || ref.versionSelector === undefined
      ? secret.latestVersion
      : ref.versionSelector;
    return typeof resolvedVersion === "number"
      ? [{ secretId: secret.id, version: resolvedVersion }]
      : [];
  });
  const versionSecretIds = [...new Set(versionRequests.map((request) => request.secretId))];
  const versions = [...new Set(versionRequests.map((request) => request.version))];
  const versionRows = versionSecretIds.length > 0 && versions.length > 0
    ? await input.db
        .select()
        .from(companySecretVersions)
        .where(
          and(
            inArray(companySecretVersions.secretId, versionSecretIds),
            inArray(companySecretVersions.version, versions),
          ),
        )
    : [];
  const versionsBySecretAndNumber = new Map(
    versionRows.map((row) => [`${row.secretId}:${row.version}`, row]),
  );

  const metadata: EffectiveRunConfigSecretVersionMetadata[] = [];
  for (const ref of refs) {
    const secret = secretsById.get(ref.secretId);
    if (!secret) {
      metadata.push({
        configPath: ref.configPath,
        envKey: null,
        secretId: ref.secretId,
        version: typeof ref.versionSelector === "number" ? ref.versionSelector : "unresolved",
        outcome: "failure",
      });
      continue;
    }

    const resolvedVersion = ref.versionSelector === "latest" || ref.versionSelector === undefined
      ? secret.latestVersion
      : ref.versionSelector;
    const versionRow = typeof resolvedVersion === "number"
      ? versionsBySecretAndNumber.get(`${secret.id}:${resolvedVersion}`) ?? null
      : null;

    metadata.push({
      configPath: ref.configPath,
      envKey: null,
      secretId: secret.id,
      version: resolvedVersion,
      provider: secret.provider,
      providerVersionRef: versionRow?.providerVersionRef ?? null,
      outcome: versionRow ? "success" : "failure",
    });
  }

  return metadata;
}

async function buildReusableSandboxLeaseFingerprint(input: {
  db: Db;
  companyId: string;
  environment: Environment;
  executionWorkspaceId: string | null;
  agentId: string | null;
  adapterType: string | null;
  provider: string;
  providerConfig: Record<string, unknown>;
  providerPlugin?: {
    id: string;
    pluginKey: string;
    packageName: string;
    version: string;
  } | null;
}): Promise<EffectiveRunConfigFingerprint> {
  const secretMetadata = await buildEnvironmentSecretMetadataForLeaseFingerprint({
    db: input.db,
    companyId: input.companyId,
    environment: input.environment,
  });
  return createEffectiveRunConfigFingerprints({
    lease: {
      companyId: input.companyId,
      environment: {
        id: input.environment.id,
        driver: input.environment.driver,
      },
      executionWorkspaceId: input.executionWorkspaceId,
      agentId: input.agentId,
      adapterType: input.adapterType,
      provider: input.provider,
      providerPlugin: input.providerPlugin ?? null,
      providerConfig: input.providerConfig,
      secrets: secretMetadata,
    },
    secretManifest: secretMetadata,
  }).leaseFingerprint;
}

function buildReusableSandboxLeaseScope(input: {
  companyId: string;
  environmentId: string;
  executionWorkspaceId: string | null;
  agentId: string | null;
  adapterType: string | null;
  provider: string;
  config: Record<string, unknown>;
  leaseFingerprint?: EffectiveRunConfigFingerprint | null;
  providerMetadata?: Record<string, unknown> | null;
}): Record<string, unknown> | null {
  if (!input.executionWorkspaceId || !input.agentId) return null;
  const providerMetadata = input.providerMetadata ?? {};
  const adapterType = input.adapterType ?? null;
  const remoteCwd = readString(providerMetadata.remoteCwd);
  const workspaceSentinel = isRecord(providerMetadata.workspaceSentinel)
    ? { ...providerMetadata.workspaceSentinel }
    : null;
  return {
    version: 1,
    companyId: input.companyId,
    environmentId: input.environmentId,
    executionWorkspaceId: input.executionWorkspaceId,
    agentId: input.agentId,
    adapterType,
    provider: input.provider,
    runtimeFingerprint: reusableRuntimeFingerprint({
      provider: input.provider,
      adapterType,
      config: input.config,
    }),
    ...(input.leaseFingerprint
      ? { leaseFingerprint: serializeLeaseFingerprint(input.leaseFingerprint) }
      : {}),
    ...(remoteCwd ? { remoteCwd } : {}),
    ...(workspaceSentinel ? { workspaceSentinel } : {}),
  };
}

function reusableSandboxLeaseScopeMatches(input: {
  lease: Pick<EnvironmentLease, "metadata">;
  companyId: string;
  environmentId: string;
  executionWorkspaceId: string | null;
  agentId: string | null;
  adapterType: string | null;
  provider: string;
  config: Record<string, unknown>;
  leaseFingerprint?: EffectiveRunConfigFingerprint | null;
  allowLegacyRuntimeFingerprint?: boolean;
}): boolean {
  if (!input.executionWorkspaceId || !input.agentId) return false;
  const scope = input.lease.metadata?.reusableSandboxLease;
  if (!isRecord(scope)) return false;
  const adapterType = input.adapterType ?? null;
  const baseScopeMatches =
    scope.companyId === input.companyId &&
    scope.environmentId === input.environmentId &&
    scope.executionWorkspaceId === input.executionWorkspaceId &&
    scope.agentId === input.agentId &&
    scope.adapterType === adapterType &&
    scope.provider === input.provider;
  if (!baseScopeMatches) return false;

  const expectedLeaseFingerprint = input.leaseFingerprint?.fingerprint ?? null;
  if (expectedLeaseFingerprint) {
    const storedLeaseFingerprint = readLeaseFingerprint(scope.leaseFingerprint);
    if (storedLeaseFingerprint) {
      return storedLeaseFingerprint === expectedLeaseFingerprint;
    }
    if (!input.allowLegacyRuntimeFingerprint) return false;
  }

  return scope.runtimeFingerprint === reusableRuntimeFingerprint({
    provider: input.provider,
    adapterType,
    config: input.config,
  });
}

function reusableLeaseCanBeResumed(input: {
  lease: Pick<EnvironmentLease, "status" | "heartbeatRunId">;
  heartbeatRunId: string | null;
}): boolean {
  if (input.lease.status === "released" || input.lease.status === "retained") return true;
  return input.lease.status === "active" && input.heartbeatRunId !== null && input.lease.heartbeatRunId === input.heartbeatRunId;
}

function reusableLeaseCanBeCleanedUp(lease: Pick<EnvironmentLease, "status">): boolean {
  return lease.status === "released" || lease.status === "retained";
}

export function findReusableSandboxLeaseId(input: {
  config: SandboxEnvironmentConfig;
  leases: Array<Pick<EnvironmentLease, "providerLeaseId" | "metadata">>;
}): string | null {
  return findReusableSandboxProviderLeaseId(input);
}

function createLocalEnvironmentDriver(db: Db): EnvironmentRuntimeDriver {
  const environmentsSvc = environmentService(db);

  return {
    driver: "local",

    async acquireRunLease(input) {
      return await environmentsSvc.acquireLease({
        companyId: input.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: input.executionWorkspaceId,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        leasePolicy: "ephemeral",
        provider: "local",
        metadata: {
          ...(input.agentId ? { agentId: input.agentId } : {}),
          driver: input.environment.driver,
          executionWorkspaceMode: input.executionWorkspaceMode,
        },
      });
    },

    async releaseRunLease(input) {
      return await environmentsSvc.releaseLease(input.lease.id, input.status);
    },

    async realizeWorkspace(input) {
      const record = buildWorkspaceRealizationRecordFromDriverInput({
        environment: input.environment,
        lease: input.lease,
        workspace: input.workspace,
        cwd: input.workspace.localPath ?? input.workspace.remotePath ?? null,
      });
      return {
        cwd: input.workspace.localPath ?? input.workspace.remotePath ?? "/",
        metadata: {
          workspaceRealization: record,
        },
      };
    },
  };
}

function createSshEnvironmentDriver(db: Db): EnvironmentRuntimeDriver {
  const environmentsSvc = environmentService(db);

  return {
    driver: "ssh",

    async acquireRunLease(input) {
      const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.companyId, input.environment, {
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        applyCustomImageTemplate: input.applyCustomImageTemplate ?? false,
      });
      if (parsed.driver !== "ssh") {
        throw new Error(`Expected SSH environment config for driver "${input.environment.driver}".`);
      }

      const { remoteCwd } = await ensureSshWorkspaceReady(parsed.config);
      return await environmentsSvc.acquireLease({
        companyId: input.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: input.executionWorkspaceId,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        leasePolicy: "ephemeral",
        provider: "ssh",
        providerLeaseId: `ssh://${parsed.config.username}@${parsed.config.host}:${parsed.config.port}${remoteCwd}`,
        metadata: {
          ...(input.agentId ? { agentId: input.agentId } : {}),
          driver: input.environment.driver,
          executionWorkspaceMode: input.executionWorkspaceMode,
          host: parsed.config.host,
          port: parsed.config.port,
          username: parsed.config.username,
          remoteWorkspacePath: parsed.config.remoteWorkspacePath,
          remoteCwd,
        },
      });
    },

    async releaseRunLease(input) {
      return await environmentsSvc.releaseLease(input.lease.id, input.status);
    },

    async realizeWorkspace(input) {
      const record = buildWorkspaceRealizationRecordFromDriverInput({
        environment: input.environment,
        lease: input.lease,
        workspace: input.workspace,
        cwd:
          typeof input.lease.metadata?.remoteCwd === "string" && input.lease.metadata.remoteCwd.trim().length > 0
            ? input.lease.metadata.remoteCwd.trim()
            : input.workspace.remotePath ?? input.workspace.localPath ?? null,
      });
      return {
        cwd: record.remote.path ?? record.local.path,
        metadata: {
          workspaceRealization: record,
        },
      };
    },
  };
}

/**
 * Adapt the worker manager's duplex host session to the cross-layer channel. The
 * two shapes differ in the exit and stop members: the host session resolves the
 * exit one time from `wait()`, so the channel bridges it to a one-time `onExit`
 * listener; `kill()` maps to `stop()`. The `write`, `onData`, and `close`
 * members map one to one.
 */
function adaptDuplexChannelHostSession(
  session: DuplexChannelHostSession,
): CommandManagedDuplexChannel {
  return {
    write(data: string): void {
      session.write(data);
    },
    onData(listener: (chunk: string) => void): void {
      session.onData(listener);
    },
    onExit(listener: (exit: { exitCode: number | null; transportClosed?: boolean }) => void): void {
      // `wait()` resolves one time with the exit and never rejects, so a single
      // `then` bridges it to the one-time exit listener. The exit carries
      // `transportClosed`, so the broker tells a real exit from a transport close.
      void session.wait().then((exit) => {
        listener(exit);
      });
    },
    stop(): void {
      session.kill();
    },
    close(): Promise<void> {
      return session.close();
    },
  };
}

function createSandboxEnvironmentDriver(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    pluginWorkerReadyTimeoutMs?: number;
    pluginWorkerReadyPollMs?: number;
    pendingCleanupWriteAttempts?: number;
    pendingCleanupWriteBackoffMs?: number;
    deferredOrphanCleanupBufferLimit?: number;
    orphanCleanupSpool?: SandboxOrphanCleanupSpool;
    orphanCleanupSpoolDir?: string;
  } = {},
): EnvironmentRuntimeDriver {
  const pluginWorkerManager = options.pluginWorkerManager;
  const pluginWorkerReadyTimeoutMs = options.pluginWorkerReadyTimeoutMs ?? DEFAULT_PLUGIN_SANDBOX_WORKER_READY_TIMEOUT_MS;
  const pluginWorkerReadyPollMs = options.pluginWorkerReadyPollMs ?? DEFAULT_PLUGIN_SANDBOX_WORKER_READY_POLL_MS;
  // The retry count is at least one attempt, so a zero or negative override
  // never skips the durable write. The backoff is at least zero milliseconds.
  const pendingCleanupWriteAttempts = Math.max(
    1,
    options.pendingCleanupWriteAttempts ?? DEFAULT_SANDBOX_ORPHAN_CLEANUP_WRITE_ATTEMPTS,
  );
  const pendingCleanupWriteBackoffMs = Math.max(
    0,
    options.pendingCleanupWriteBackoffMs ?? DEFAULT_SANDBOX_ORPHAN_CLEANUP_WRITE_BACKOFF_MS,
  );
  // The buffer holds at least one orphan, so a zero or negative override never
  // drops every buffered record.
  const deferredOrphanCleanupBufferLimit = Math.max(
    1,
    options.deferredOrphanCleanupBufferLimit ?? DEFAULT_DEFERRED_ORPHAN_CLEANUP_BUFFER_LIMIT,
  );
  const environmentsSvc = environmentService(db);

  // A live sandbox whose teardown failed needs a durable `pending_cleanup` row,
  // so a sweep can find and release it. When every synchronous write attempt
  // fails, the database is down but the process still runs. So the driver keeps
  // the orphan record in this in-process buffer, and a later cleanup sweep
  // flushes it back to the database. The buffer closes the common window where
  // the database recovers after the synchronous attempts but while the process
  // still runs. The `pending_cleanup` failure reason matches the synchronous
  // write, so a flushed row and a synchronous row are indistinguishable to the
  // sweep.
  const deferredOrphanCleanups: DeferredOrphanCleanupRecord[] = [];
  const DEFERRED_ORPHAN_CLEANUP_FAILURE_REASON = "acquire_rejected_teardown_failed";

  // The in-process buffer alone loses an orphan on a restart. So the driver also
  // persists each buffered orphan to this durable local spool. The spool keeps
  // the record on the local disk, next to the other durable server state, so a
  // restart still finds it. The first flush after a restart loads the spool back
  // into the buffer, so the sweep re-inserts the durable row. The spool holds no
  // secret value: it persists the same sanitized metadata the database row
  // holds, so a restart-recovered record still authorizes the teardown but never
  // exposes a credential. Only a crash during the outage before the durable
  // spool write lands loses the record; the error log stays the last handle for
  // that narrow case.
  const orphanCleanupSpool =
    options.orphanCleanupSpool ?? createSandboxOrphanCleanupSpool(options.orphanCleanupSpoolDir);

  // Add one orphan record to the in-process buffer. Report `false` only when the
  // buffer is full, so the caller keeps the error log as the last durable handle.
  const enqueueDeferredOrphanCleanup = (record: DeferredOrphanCleanupRecord): boolean => {
    // Dedup by the provider lease id, so a repeated failure for the same orphan
    // never buffers it twice. Each acquire mints a unique provider lease id, so
    // two distinct orphans never collide. Skip the dedup for a null lease id,
    // because a null value carries no identity.
    const alreadyBuffered =
      record.providerLeaseId !== null &&
      deferredOrphanCleanups.some((entry) => entry.providerLeaseId === record.providerLeaseId);
    if (alreadyBuffered) return true;
    if (deferredOrphanCleanups.length >= deferredOrphanCleanupBufferLimit) return false;
    deferredOrphanCleanups.push(record);
    return true;
  };

  // Load the durable spool into the in-process buffer exactly once. The first
  // flush after a restart runs this load, so the records a previous process
  // could not land re-enter the flush path. A later flush sees the resolved
  // promise and never reloads, so a record this process already buffered never
  // doubles. The load runs before the flush splices the buffer, so a
  // restart-recovered record flushes on the same tick.
  let spoolLoadPromise: Promise<void> | null = null;
  const ensureSpoolLoaded = (): Promise<void> => {
    if (!spoolLoadPromise) {
      spoolLoadPromise = (async () => {
        const persisted = await orphanCleanupSpool.load();
        for (const record of persisted) {
          enqueueDeferredOrphanCleanup(record);
        }
      })();
    }
    return spoolLoadPromise;
  };

  const flushDeferredOrphanCleanups = async (): Promise<{ recovered: number; pending: number }> => {
    // Load the durable spool into the buffer first, so a restart-recovered record
    // flushes on this tick. The load runs once, then a resolved promise returns.
    await ensureSpoolLoaded();
    if (deferredOrphanCleanups.length === 0) {
      return { recovered: 0, pending: 0 };
    }
    // Take the whole batch synchronously before the first await, so a second
    // concurrent flush sees an empty buffer and never re-inserts the same record.
    const batch = deferredOrphanCleanups.splice(0, deferredOrphanCleanups.length);
    let recovered = 0;
    for (const record of batch) {
      try {
        await environmentsSvc.insertPendingCleanupLease({
          companyId: record.companyId,
          environmentId: record.environmentId,
          executionWorkspaceId: record.executionWorkspaceId,
          issueId: record.issueId,
          heartbeatRunId: record.heartbeatRunId,
          provider: record.provider,
          providerLeaseId: record.providerLeaseId,
          metadata: record.metadata,
          failureReason: DEFERRED_ORPHAN_CLEANUP_FAILURE_REASON,
        });
        // The durable row exists now, so the sweep finds and releases the orphan.
        // Drop the spooled copy only after the row lands. A crash between the two
        // leaves the spooled copy for a later flush, which re-inserts a duplicate
        // the idempotent teardown handles. This order never loses the orphan.
        await orphanCleanupSpool.remove(record);
        recovered += 1;
      } catch {
        // The database is still down. Re-queue the record for a later flush,
        // unless the buffer filled again. The identifiers carry no secret; the
        // caught write exception never enters the log, because it can hold a
        // credential in its message, code, cause, or stack.
        const requeued = enqueueDeferredOrphanCleanup(record);
        logger.warn(
          {
            errorKind: SANDBOX_ORPHAN_CLEANUP_WRITE_ERROR_KIND,
            provider: record.provider,
            providerLeaseId: record.providerLeaseId,
            companyId: record.companyId,
            environmentId: record.environmentId,
            requeued,
          },
          requeued
            ? "deferred sandbox orphan cleanup flush failed; kept the orphan buffered for a later flush"
            : "deferred sandbox orphan cleanup flush failed and the in-process buffer is full; live sandbox needs a manual teardown",
        );
      }
    }
    return { recovered, pending: deferredOrphanCleanups.length };
  };

  // Build the safe diagnostic fields for an orphan record. The provider
  // identifiers are the only fields any diagnostic log emits, and they carry no
  // secret. A caught write exception never enters a log: it can carry a
  // credential in its name, code, message, cause, or stack.
  const orphanDiagnosticFields = (record: DeferredOrphanCleanupRecord) => ({
    errorKind: SANDBOX_ORPHAN_CLEANUP_WRITE_ERROR_KIND,
    provider: record.provider,
    providerLeaseId: record.providerLeaseId,
    companyId: record.companyId,
    environmentId: record.environmentId,
    executionWorkspaceId: record.executionWorkspaceId,
    issueId: record.issueId,
    heartbeatRunId: record.heartbeatRunId,
  });

  // Try to write the durable `pending_cleanup` row for an orphan sandbox, with a
  // few retries. Report the new lease id on success, or a null lease id and the
  // last write error on total failure. This function never buffers, never logs
  // at error level, and never throws. The caller decides whether a total failure
  // is fatal, because a later successful teardown removes the orphan and needs
  // no durable row.
  //
  // The row carries the provider lease id and the same resolution metadata a
  // normal lease holds, so a later cleanup sweep finds and releases the orphan.
  // One atomic insert writes the row directly in the terminal `pending_cleanup`
  // state, and the insert skips the company-binding assertion, so it records the
  // orphan even for a foreign-bound environment. A transient database fault (a
  // dropped connection, a lock timeout, a serialization conflict) can reject one
  // insert but clear on the next, so the write retries a few times with a short
  // backoff.
  const tryWriteDurablePendingCleanup = async (
    record: DeferredOrphanCleanupRecord,
  ): Promise<{ leaseId: string | null; lastError: unknown }> => {
    const diagnosticFields = orphanDiagnosticFields(record);
    let lastCleanupWriteError: unknown;
    for (let attempt = 1; attempt <= pendingCleanupWriteAttempts; attempt += 1) {
      try {
        const lease = await environmentsSvc.insertPendingCleanupLease({
          companyId: record.companyId,
          environmentId: record.environmentId,
          executionWorkspaceId: record.executionWorkspaceId,
          issueId: record.issueId,
          heartbeatRunId: record.heartbeatRunId,
          provider: record.provider,
          providerLeaseId: record.providerLeaseId,
          metadata: record.metadata,
          failureReason: DEFERRED_ORPHAN_CLEANUP_FAILURE_REASON,
        });
        // The durable row exists now, so a sweep can find and release the orphan.
        return { leaseId: lease.id, lastError: undefined };
      } catch (cleanupWriteError) {
        lastCleanupWriteError = cleanupWriteError;
        if (attempt < pendingCleanupWriteAttempts) {
          // The write failed, but attempts remain. Log the retry at warn level
          // and back off, then try again. A later attempt can still land the
          // durable row.
          logger.warn(
            { ...diagnosticFields, attempt, maxAttempts: pendingCleanupWriteAttempts },
            "sandbox orphan cleanup write failed; retrying the durable pending-cleanup write",
          );
          await delay(pendingCleanupWriteBackoffMs * attempt);
        }
      }
    }
    return { leaseId: null, lastError: lastCleanupWriteError };
  };

  // Release the durable `pending_cleanup` row after a successful inline teardown.
  // The teardown removed the orphan sandbox, so the row is no longer needed. The
  // release moves the row to the terminal `expired` state with a `success`
  // cleanup status, the same state the sweep records for a successful teardown.
  //
  // The release is best-effort. If it fails, the row stays `pending_cleanup`, so
  // a later sweep runs the idempotent teardown on the already-gone sandbox and
  // releases the row itself. A failed release never loses or leaks the orphan.
  const releaseCleanedUpOrphanRow = async (
    leaseId: string,
    diagnosticFields: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await environmentsSvc.releaseLease(leaseId, "expired", {
        cleanupStatus: "success",
        failureReason: "acquire_rejected_teardown_succeeded",
      });
    } catch {
      // The caught release exception never enters a log: it can carry a
      // credential in its name, code, message, cause, or stack.
      logger.warn(
        diagnosticFields,
        "could not release the pending-cleanup row after a successful orphan teardown; a later sweep reconciles the released row",
      );
    }
  };

  // Neither the durable write nor the inline teardown worked, so the orphan
  // sandbox is live with no durable row. Persist the orphan to the durable spool
  // and buffer it in-process, so a later cleanup-sweep flush lands the durable
  // row. The spool survives a restart, so the flush recovers the orphan even
  // after a crash. Then log the plain provider identifiers at error level, so an
  // operator keeps a handle to tear the sandbox down by hand. Only a crash before
  // the spool write lands loses the record, so the error log is the last handle
  // for that narrow case. Throw `SandboxOrphanCleanupWriteError`, which the
  // caller propagates. The error keeps the original insert rejection as its
  // `cause`, so the real reason the acquire failed stays visible in the error
  // chain.
  const escalateUnwrittenOrphan = async (
    record: DeferredOrphanCleanupRecord,
    cause: unknown,
    cleanupWriteError: unknown,
  ): Promise<never> => {
    const persisted = await orphanCleanupSpool.append(record);
    const buffered = enqueueDeferredOrphanCleanup(record);
    logger.error(
      {
        ...orphanDiagnosticFields(record),
        persisted,
        buffered,
        deferredBufferSize: deferredOrphanCleanups.length,
      },
      persisted
        ? "sandbox orphan cleanup write failed; persisted the orphan to the durable spool for a later cleanup-sweep flush"
        : buffered
          ? "sandbox orphan cleanup write failed and the durable spool write failed; buffered the orphan in-process only for a later cleanup-sweep flush"
          : "sandbox orphan cleanup write failed and neither the durable spool nor the in-process buffer kept the orphan; live sandbox needs a manual teardown",
    );
    throw new SandboxOrphanCleanupWriteError({
      provider: record.provider,
      providerLeaseId: record.providerLeaseId,
      cause,
      cleanupWriteError,
    });
  };

  // Clean up an orphan sandbox after the conditional lease insert rejected it.
  // The acquire provisioned a remote sandbox, then the insert rejected (a
  // foreign-company binding), so no lease row tracks the live sandbox. This
  // handler records the durable `pending_cleanup` row FIRST, before the inline
  // teardown, then tears the sandbox down.
  //
  // The write goes first on purpose. The conditional insert just returned a
  // definitive rejection, so the database is reachable at this instant. An
  // inline teardown can run long, and the database can drop during it. So a
  // write after the teardown can fail and leave the orphan only in memory, which
  // a restart loses. With the write first, the durable row lands while the
  // database is proven up, so a crash after it still leaves a row that a sweep
  // finds and releases.
  //
  // The teardown then runs. On success the orphan is gone, so the handler
  // releases the durable row. On a failed teardown the row stays for the sweep.
  // If the durable write itself failed and the teardown also failed, the handler
  // buffers the orphan and throws `SandboxOrphanCleanupWriteError`. A successful
  // teardown after a failed write leaves no orphan, so it needs no error.
  const cleanUpRejectedOrphanSandbox = async (input: {
    record: DeferredOrphanCleanupRecord;
    cause: unknown;
    canTeardown: boolean;
    teardown: () => Promise<void>;
  }): Promise<void> => {
    const durable = await tryWriteDurablePendingCleanup(input.record);
    let teardownFailed = !input.canTeardown;
    if (!teardownFailed) {
      try {
        await input.teardown();
      } catch {
        teardownFailed = true;
      }
    }
    if (!teardownFailed) {
      // The teardown removed the orphan, so drop the durable row if we wrote one.
      if (durable.leaseId !== null) {
        await releaseCleanedUpOrphanRow(durable.leaseId, orphanDiagnosticFields(input.record));
      }
      return;
    }
    // The teardown failed, so the orphan sandbox is still live.
    if (durable.leaseId !== null) {
      // The durable row already tracks the orphan, so a sweep finds and releases
      // it. The caller rethrows the original insert rejection.
      return;
    }
    await escalateUnwrittenOrphan(input.record, input.cause, durable.lastError);
  };

  // The run-time exec parent context, held per lease id. A plugin sandbox
  // provider can open a persistent session on the first command and delete it
  // on lease release. The session open runs inside `execute`, under the run
  // parent (the same context the `sandbox.exec` span reads). The session delete
  // runs inside the lease-release RPC, which the run orchestrator calls after
  // the run, outside that scope. Without a parent the host mints no
  // `traceparent` and drops the provider `session.teardown` span. So `execute`
  // records the exec parent here, and the release paths replay it around the
  // release RPC. The host still mints and validates the `traceparent` itself;
  // the value only widens which host calls carry a run parent. An entry is
  // removed on release, so the map holds at most one context per live lease.
  const runExecParentByLeaseId = new Map<string, StartupSpanContext>();

  // Run a lease-release RPC under the lease's recorded exec parent context, and
  // then drop the entry — the lease is gone. Under the parent the host mints a
  // `traceparent`, so a provider `session.teardown` span reaches the span
  // backend in the run trace. With no recorded context (no command ran, or a
  // local target with no trace context) the call runs unwrapped, exactly as
  // before, so the change never fails a release.
  function runLeaseReleaseWithRunParent<T>(leaseId: string, call: () => Promise<T>): Promise<T> {
    const runParent = runExecParentByLeaseId.get(leaseId);
    runExecParentByLeaseId.delete(leaseId);
    return runParent !== undefined ? runWithRuntimeParent(runParent, call) : call();
  }

  async function resolveSandboxProviderPlugin(input: { provider: string }) {
    const running = await resolvePluginSandboxProviderDriverByKey({
      db,
      driverKey: input.provider,
      workerManager: pluginWorkerManager,
      requireRunning: true,
    });
    if (running) {
      return { state: "running" as const, resolved: running };
    }

    const installed = await resolvePluginSandboxProviderDriverByKey({
      db,
      driverKey: input.provider,
      workerManager: pluginWorkerManager,
      requireRunning: false,
    });
    if (!installed) {
      return { state: "missing" as const, resolved: null };
    }

    if (installed.plugin.status !== "ready") {
      return { state: "not_ready" as const, resolved: installed };
    }

    if (!pluginWorkerManager) {
      return { state: "worker_unavailable" as const, resolved: installed };
    }

    const deadline = Date.now() + Math.max(0, pluginWorkerReadyTimeoutMs);
    while (Date.now() < deadline) {
      const retried = await resolvePluginSandboxProviderDriverByKey({
        db,
        driverKey: input.provider,
        workerManager: pluginWorkerManager,
        requireRunning: true,
      });
      if (retried) {
        return { state: "running" as const, resolved: retried };
      }
      await delay(Math.max(1, pluginWorkerReadyPollMs));
    }

    return { state: "worker_unavailable" as const, resolved: installed };
  }

  async function resolvePluginSandboxRuntimeConfig(input: {
    environment: Pick<Environment, "id" | "driver" | "config">;
    lease: EnvironmentLease;
    provider: string;
  }): Promise<Record<string, unknown>> {
    const metadataConfig = sandboxConfigFromLeaseMetadataLoose(input.lease);
    if (metadataConfig && metadataConfig.provider === input.provider) {
      const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.lease.companyId, {
        id: input.environment.id,
        driver: "sandbox",
        config: sandboxConfigForLeaseMetadata(metadataConfig),
      });
      if (parsed.driver === "sandbox") {
        return dropInternalPluginSandboxConfigKeys(parsed.config as unknown as Record<string, unknown>);
      }
    }

    if (input.environment.driver === "sandbox") {
      try {
        const parsed = await resolveEnvironmentDriverConfigForRuntime(
          db,
          input.lease.companyId,
          input.environment,
        );
        if (parsed.driver === "sandbox" && parsed.config.provider === input.provider) {
          return dropInternalPluginSandboxConfigKeys(parsed.config as unknown as Record<string, unknown>);
        }
      } catch {
        // Lease metadata below is intentionally kept sufficient for cleanup
        // after the environment config changes or becomes invalid.
      }
    }

    return {
      provider: input.provider,
      ...dropInternalPluginSandboxConfigKeys(input.lease.metadata),
    };
  }

  async function cleanupObsoleteReusableSandboxLeases(input: {
    environment: Environment;
    leases: EnvironmentLease[];
    reusableLeases: EnvironmentLease[];
  }) {
    const reusableIds = new Set(input.reusableLeases.map((lease) => lease.id));
    for (const lease of input.leases) {
      if (reusableIds.has(lease.id)) continue;
      if (!reusableLeaseCanBeCleanedUp(lease)) continue;
      await destroyReusableSandboxLease({
        environment: input.environment,
        lease,
        failureReason: "lease_fingerprint_mismatch",
      });
    }
  }

  async function callPluginEnvironmentSync(
    method: "environmentSyncIn" | "environmentSyncOut",
    input: EnvironmentDriverSyncInput,
  ): Promise<PluginEnvironmentSyncResult> {
    if (!input.lease.metadata?.sandboxProviderPlugin || !pluginWorkerManager) {
      throw new Error("Sandbox driver does not support native file sync for this lease.");
    }
    const pluginId = readString(input.lease.metadata?.pluginId);
    const providerKey = readString(input.lease.metadata?.provider);
    if (!pluginId || !providerKey) {
      throw new Error("Sandbox lease is missing plugin/provider metadata for native file sync.");
    }
    const config = await resolvePluginSandboxRuntimeConfig({
      environment: input.environment,
      lease: input.lease,
      provider: providerKey,
    });
    const sanitizedConfig = stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig);
    return await pluginWorkerManager.call(pluginId, method, {
      driverKey: providerKey,
      companyId: input.lease.companyId,
      environmentId: input.environment.id,
      issueId: input.lease.issueId,
      config: sanitizedConfig,
      lease: {
        providerLeaseId: input.lease.providerLeaseId,
        metadata: input.lease.metadata ?? undefined,
        expiresAt: input.lease.expiresAt?.toISOString() ?? null,
      },
      operations: input.operations,
    }, resolvePluginSandboxRpcTimeoutMs(sanitizedConfig));
  }

  return {
    driver: "sandbox",

    async acquireRunLease(input) {
      const storedParsed = parseEnvironmentDriverConfig(input.environment);
      const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.companyId, input.environment, {
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        applyCustomImageTemplate: input.applyCustomImageTemplate ?? false,
      });
      if (parsed.driver !== "sandbox" || storedParsed.driver !== "sandbox") {
        throw new Error(`Expected sandbox environment config for driver "${input.environment.driver}".`);
      }

      // Check if this provider should be handled by a plugin.
      if (!isBuiltinSandboxProvider(parsed.config.provider)) {
        const pluginProvider = await resolveSandboxProviderPlugin({
          provider: parsed.config.provider,
        });
        if (pluginProvider.state === "missing") {
          throw new Error(
            `Sandbox provider "${parsed.config.provider}" is not registered as a built-in provider and no matching plugin is available.`,
          );
        }
        if (pluginProvider.state === "not_ready") {
          throw new Error(
            `Sandbox provider "${parsed.config.provider}" is installed via plugin "${pluginProvider.resolved.plugin.pluginKey}", but that plugin is currently ${pluginProvider.resolved.plugin.status}.`,
          );
        }
        if (pluginProvider.state === "worker_unavailable") {
          throw new Error(
            `Sandbox provider "${parsed.config.provider}" is installed via plugin "${pluginProvider.resolved.plugin.pluginKey}", but its worker is not running.`,
          );
        }
        if (!pluginWorkerManager) {
          throw new Error(
            `Sandbox provider "${parsed.config.provider}" is installed, but sandbox plugin workers are unavailable in this server process.`,
          );
        }

        const workerConfig = stripSandboxProviderEnvelope(parsed.config);
        const storedConfig = storedParsed.config;
        const providerConfigForLease = sandboxConfigForLeaseMetadata(storedConfig);
        // Require the reusable-lease capability AND a worker that verifies the
        // reuse methods. The provider must first opt in through the declaration:
        // the nested `sandboxCapabilities.reusableLeases` wins over the legacy
        // `supportsReusableLeases` flag. The worker must also verify
        // `environmentResumeLease`, `environmentReleaseLease`, and
        // `environmentDestroyLease` (the reuse prerequisite verbs) before the
        // runtime resumes, releases, or tears down a reusable lease. A provider
        // that declares `reusableLeases` true but whose worker does not verify
        // all three methods fails closed and uses an ephemeral lease, so the
        // runtime never dispatches a resume, a release, or a destroy the worker
        // cannot serve, and it never strands a stale lease it cannot destroy.
        const declaredReusableLeases =
          resolveDeclaredSandboxCapabilities(pluginProvider.resolved.driver).reusableLeases === true;
        const pluginVerifiedMethods = new Set(
          pluginWorkerManager.getWorker(pluginProvider.resolved.plugin.id)?.supportedMethods ?? [],
        );
        const supportsReusableLeases =
          declaredReusableLeases && capabilityIsVerified("reusableLeases", pluginVerifiedMethods);
        const leaseFingerprint =
          supportsReusableLeases &&
          parsed.config.reuseLease &&
          input.heartbeatRunId !== null &&
          input.executionWorkspaceId !== null &&
          input.agentId !== null
            ? await buildReusableSandboxLeaseFingerprint({
                db,
                companyId: input.companyId,
                environment: input.environment,
                executionWorkspaceId: input.executionWorkspaceId,
                agentId: input.agentId,
                adapterType: input.adapterType,
                provider: parsed.config.provider,
                providerConfig: providerConfigForLease,
                providerPlugin: {
                  id: pluginProvider.resolved.plugin.id,
                  pluginKey: pluginProvider.resolved.plugin.pluginKey,
                  packageName: pluginProvider.resolved.plugin.packageName,
                  version: pluginProvider.resolved.plugin.version,
                },
              })
            : null;
        // Ad-hoc tests (heartbeatRunId === null) must never resume an existing
        // provider lease. If they did, releasing the test lease at the end of
        // the probe would tear down the live heartbeat run that owns it.
        // We also filter out leases whose policy is not reuse_by_environment
        // and whose status is not reusable so non-reusable, cleanup-pending,
        // or terminal rows cannot be matched.
        const reusableCandidateLeases =
          supportsReusableLeases &&
          parsed.config.reuseLease &&
          input.heartbeatRunId !== null &&
          input.executionWorkspaceId !== null &&
          input.agentId !== null
          ? (await environmentsSvc.listLeases(input.environment.id))
              .filter((lease) =>
                lease.leasePolicy === "reuse_by_environment" &&
                reusableLeaseCanBeResumed({ lease, heartbeatRunId: input.heartbeatRunId }) &&
                lease.executionWorkspaceId === input.executionWorkspaceId &&
                lease.metadata?.agentId === input.agentId,
              )
          : [];
        const reusableExistingLeases = reusableCandidateLeases.filter((lease) =>
          reusableSandboxLeaseScopeMatches({
            lease,
            companyId: input.companyId,
            environmentId: input.environment.id,
            executionWorkspaceId: input.executionWorkspaceId,
            agentId: input.agentId,
            adapterType: input.adapterType,
            provider: parsed.config.provider,
            config: providerConfigForLease,
            leaseFingerprint,
            allowLegacyRuntimeFingerprint:
              lease.status === "active" &&
              input.heartbeatRunId !== null &&
              lease.heartbeatRunId === input.heartbeatRunId,
          }),
        );
        if (reusableCandidateLeases.length > reusableExistingLeases.length) {
          await cleanupObsoleteReusableSandboxLeases({
            environment: input.environment,
            leases: reusableCandidateLeases,
            reusableLeases: reusableExistingLeases,
          });
        }
        const reusableProviderLeaseId =
          supportsReusableLeases &&
          parsed.config.reuseLease &&
          input.heartbeatRunId !== null &&
          input.executionWorkspaceId !== null &&
          input.agentId !== null
          ? findReusableSandboxLeaseId({ config: storedConfig, leases: reusableExistingLeases })
          : null;
        const reusableLease = reusableProviderLeaseId
          ? reusableExistingLeases.find((lease) => lease.providerLeaseId === reusableProviderLeaseId)
          : null;

        let providerLease: PluginEnvironmentLease | null = null;
        if (reusableLease?.providerLeaseId) {
          // The `supportsReusableLeases` check above reads a snapshot of the
          // worker methods. The runtime then does asynchronous database work
          // (list, fingerprint, obsolete-lease cleanup) before this dispatch. A
          // worker restart in that window can drop `environmentResumeLease`
          // while the snapshot still marks the method verified. Re-check the
          // live worker here and fail closed when the method is absent: skip the
          // resume, destroy the stale reusable lease, and acquire a fresh lease
          // below. The runtime never dispatches a resume the live worker cannot
          // serve.
          const workerVerifiesResume = pluginWorkerVerifiesLifecycleMethod(
            pluginProvider.resolved.plugin.id,
            "environmentResumeLease",
          );
          if (workerVerifiesResume) {
            try {
              const resumed = await pluginWorkerManager.call(
                  pluginProvider.resolved.plugin.id,
                  "environmentResumeLease",
                  {
                    driverKey: parsed.config.provider,
                    companyId: input.companyId,
                    environmentId: input.environment.id,
                    issueId: input.issueId,
                    config: workerConfig,
                    providerLeaseId: reusableLease.providerLeaseId,
                    leaseMetadata: reusableLease.metadata ?? undefined,
                  },
                  resolvePluginSandboxRpcTimeoutMs(workerConfig),
                );
              providerLease =
                typeof resumed.providerLeaseId === "string" && resumed.providerLeaseId.length > 0
                  ? resumed
                  : null;
            } catch {
              providerLease = null;
            }
          }
          if (!providerLease) {
            await destroyReusableSandboxLease({
              environment: input.environment,
              lease: reusableLease,
              failureReason: workerVerifiesResume ? "resume_failed" : "resume_capability_lost",
            });
          }
        }
        const acquiredLease = providerLease ?? await pluginWorkerManager.call(
          pluginProvider.resolved.plugin.id,
          "environmentAcquireLease",
          {
            driverKey: parsed.config.provider,
            companyId: input.companyId,
            environmentId: input.environment.id,
            issueId: input.issueId,
            config: workerConfig,
            // Plugin SDK requires a string; ad-hoc test leases use a fresh
            // UUID so providers that validate or persist the runId still see
            // a well-formed identifier.
            runId: input.heartbeatRunId ?? randomUUID(),
            workspaceMode: input.executionWorkspaceMode ?? undefined,
            agentId: input.agentId ?? undefined,
            executionWorkspaceId: input.executionWorkspaceId ?? undefined,
            // The agent's harness for THIS run, so the plugin picks the matching
            // runtime image (per-run adapter, mixed-harness environments).
            // NOTE: environment-runtime.ts has TWO drivers calling
            // environmentAcquireLease; this plugin-sandbox one is the HEARTBEAT
            // path. Omitting adapterType here silently falls back to the
            // environment's default adapter image (a pi agent then runs in the
            // opencode image and the harness binary is missing at exec time).
            adapterType: input.adapterType ?? undefined,
            // Forward a caller deadline so the provider configures a provider-side
            // expiry at or before it and returns the real provider expiry.
            ...(requestedExpiresAtParam(input.requestedExpiresAt) !== undefined
              ? { requestedExpiresAt: requestedExpiresAtParam(input.requestedExpiresAt) }
              : {}),
          },
          resolvePluginSandboxRpcTimeoutMs(workerConfig),
        );

        // Ad-hoc test leases are never publishable for reuse: storing them
        // as `reuse_by_environment` would let a concurrent heartbeat resume
        // the test's provider lease and lose its sandbox when the test ends.
        const resolvedLeasePolicy = supportsReusableLeases && parsed.config.reuseLease && input.heartbeatRunId !== null
          ? "reuse_by_environment"
          : "ephemeral";
        const sanitizedProviderMetadata = stripSecretRefValuesFromPluginLeaseMetadata({
          metadata: acquiredLease.metadata,
          schema: pluginProvider.resolved.driver.configSchema as Record<string, unknown> | null | undefined,
        });
        const reusableScope = resolvedLeasePolicy === "reuse_by_environment"
          ? buildReusableSandboxLeaseScope({
              companyId: input.companyId,
              environmentId: input.environment.id,
              executionWorkspaceId: input.executionWorkspaceId,
              agentId: input.agentId,
              adapterType: input.adapterType,
              provider: parsed.config.provider,
              config: providerConfigForLease,
              leaseFingerprint,
              providerMetadata: sanitizedProviderMetadata,
            })
          : null;

        const pluginLeaseMetadata = {
          ...(input.agentId ? { agentId: input.agentId } : {}),
          driver: input.environment.driver,
          executionWorkspaceMode: input.executionWorkspaceMode,
          pluginId: pluginProvider.resolved.plugin.id,
          pluginKey: pluginProvider.resolved.plugin.pluginKey,
          sandboxProviderPlugin: true,
          ...sandboxConfigForLeaseMetadata(storedConfig),
          ...sanitizedProviderMetadata,
          ...(reusableScope ? { reusableSandboxLease: reusableScope } : {}),
        };
        try {
          return await environmentsSvc.acquireLease({
            companyId: input.companyId,
            environmentId: input.environment.id,
            executionWorkspaceId: input.executionWorkspaceId,
            issueId: input.issueId,
            heartbeatRunId: input.heartbeatRunId,
            assertCompanyBinding: input.assertCompanyBinding,
            leasePolicy: resolvedLeasePolicy,
            provider: parsed.config.provider,
            providerLeaseId: acquiredLease.providerLeaseId,
            expiresAt: providerAttestedLeaseExpiry(
              input.requestedExpiresAt,
              acquiredLease.expiresAt ? new Date(acquiredLease.expiresAt) : undefined,
            ),
            metadata: pluginLeaseMetadata,
          });
        } catch (error) {
          // The conditional lease insert rejected, so no lease row exists. A
          // managed reconciliation can bind the environment to another company
          // between the route guard and this insert, so the insert fails closed
          // with `environment_company_mismatch`. This call already provisioned the
          // remote plugin sandbox above, so tear it down now. Without this step
          // the rejected insert leaks a live sandbox that no lease row tracks. The
          // Claude login runs on a plugin-backed sandbox, so this path is the one
          // the login uses. Do not tear down a reused sandbox that an earlier
          // lease still owns.
          if (!reusableLease || acquiredLease.providerLeaseId !== reusableLease.providerLeaseId) {
            // Record the durable pending-cleanup row before the teardown, then
            // tear the sandbox down. On a successful teardown the handler releases
            // the row. If the durable write and the teardown both fail, the
            // handler throws a `SandboxOrphanCleanupWriteError` that carries the
            // original rejection as its cause.
            await cleanUpRejectedOrphanSandbox({
              record: {
                companyId: input.companyId,
                environmentId: input.environment.id,
                executionWorkspaceId: input.executionWorkspaceId ?? null,
                issueId: input.issueId ?? null,
                heartbeatRunId: input.heartbeatRunId ?? null,
                provider: parsed.config.provider,
                providerLeaseId: acquiredLease.providerLeaseId,
                metadata: pluginLeaseMetadata,
              },
              cause: error,
              canTeardown: pluginWorkerManager.isRunning(pluginProvider.resolved.plugin.id),
              teardown: async () => {
                await pluginWorkerManager.call(
                  pluginProvider.resolved.plugin.id,
                  "environmentDestroyLease",
                  {
                    driverKey: parsed.config.provider,
                    companyId: input.companyId,
                    environmentId: input.environment.id,
                    issueId: input.issueId,
                    config: workerConfig,
                    providerLeaseId: acquiredLease.providerLeaseId,
                    leaseMetadata: acquiredLease.metadata ?? undefined,
                  },
                  resolvePluginSandboxRpcTimeoutMs(workerConfig),
                );
              },
            });
          }
          throw error;
        }
      }

      // Built-in sandbox provider path. Same guard as the plugin-backed path:
      // ad-hoc tests (heartbeatRunId === null) must never resume an existing
      // provider lease, or releasing the test lease will terminate the live
      // heartbeat run that shares it. Filter to reusable policies and statuses
      // so non-reusable, cleanup-pending, or terminal rows can never be matched.
      const builtinSandboxProvider = getBuiltinSandboxProvider(parsed.config.provider);
      // Resolve the DECLARED reusable-lease capability through the same contract
      // as the plugin path, so the nested capability wins over the legacy flag.
      const supportsReusableLeases =
        resolveDeclaredSandboxCapabilities({
          supportsReusableLeases: builtinSandboxProvider?.supportsReusableLeases,
        }).reusableLeases === true;
      const providerConfigForLease = sandboxConfigForLeaseMetadata(parsed.config);
      const leaseFingerprint =
        supportsReusableLeases &&
        parsed.config.reuseLease &&
        input.heartbeatRunId !== null &&
        input.executionWorkspaceId !== null &&
        input.agentId !== null
          ? await buildReusableSandboxLeaseFingerprint({
              db,
              companyId: input.companyId,
              environment: input.environment,
              executionWorkspaceId: input.executionWorkspaceId,
              agentId: input.agentId,
              adapterType: input.adapterType,
              provider: parsed.config.provider,
              providerConfig: providerConfigForLease,
            })
          : null;
      const reusableCandidateLeases =
        supportsReusableLeases &&
        parsed.config.reuseLease &&
        input.heartbeatRunId !== null &&
        input.executionWorkspaceId !== null &&
        input.agentId !== null
          ? (await environmentsSvc.listLeases(input.environment.id))
              .filter((lease) =>
                lease.leasePolicy === "reuse_by_environment" &&
                reusableLeaseCanBeResumed({ lease, heartbeatRunId: input.heartbeatRunId }) &&
                lease.executionWorkspaceId === input.executionWorkspaceId &&
                lease.metadata?.agentId === input.agentId,
              )
          : [];
      const reusableExistingLeases = reusableCandidateLeases.filter((lease) =>
        reusableSandboxLeaseScopeMatches({
          lease,
          companyId: input.companyId,
          environmentId: input.environment.id,
          executionWorkspaceId: input.executionWorkspaceId,
          agentId: input.agentId,
          adapterType: input.adapterType,
          provider: parsed.config.provider,
          config: providerConfigForLease,
          leaseFingerprint,
          allowLegacyRuntimeFingerprint:
            lease.status === "active" &&
            input.heartbeatRunId !== null &&
            lease.heartbeatRunId === input.heartbeatRunId,
        }),
      );
      if (reusableCandidateLeases.length > reusableExistingLeases.length) {
        await cleanupObsoleteReusableSandboxLeases({
          environment: input.environment,
          leases: reusableCandidateLeases,
          reusableLeases: reusableExistingLeases,
        });
      }
      const reusableProviderLeaseId =
        supportsReusableLeases &&
        parsed.config.reuseLease &&
        input.heartbeatRunId !== null &&
        input.executionWorkspaceId !== null &&
        input.agentId !== null
          ? findReusableSandboxLeaseId({ config: parsed.config, leases: reusableExistingLeases })
        : null;
      const reusableLease = reusableProviderLeaseId
        ? reusableExistingLeases.find((lease) => lease.providerLeaseId === reusableProviderLeaseId)
        : null;

      let providerLease;
      try {
        providerLease = await acquireSandboxProviderLease({
          config: parsed.config,
          environmentId: input.environment.id,
          heartbeatRunId: input.heartbeatRunId ?? randomUUID(),
          issueId: input.issueId,
          agentId: input.agentId,
          executionWorkspaceId: input.executionWorkspaceId,
          reusableProviderLeaseId,
          // Forward a caller deadline so the provider configures a provider-side
          // expiry at or before it and returns the real provider expiry.
          requestedExpiresAt: requestedExpiresAtParam(input.requestedExpiresAt),
        });
      } catch (error) {
        if (reusableLease) {
          await destroyReusableSandboxLease({
            environment: input.environment,
            lease: reusableLease,
            failureReason: "resume_failed",
          });
        }
        throw error;
      }
      if (reusableLease && providerLease.providerLeaseId !== reusableLease.providerLeaseId) {
        await destroyReusableSandboxLease({
          environment: input.environment,
          lease: reusableLease,
          failureReason: "resume_failed",
        });
      }

      // Same ephemeral-policy-for-tests guard as the plugin-backed path:
      // ad-hoc test leases must not be publishable for reuse.
      const resolvedLeasePolicy = supportsReusableLeases && parsed.config.reuseLease && input.heartbeatRunId !== null
        ? "reuse_by_environment"
        : "ephemeral";
      const reusableScope = resolvedLeasePolicy === "reuse_by_environment"
        ? buildReusableSandboxLeaseScope({
            companyId: input.companyId,
            environmentId: input.environment.id,
            executionWorkspaceId: input.executionWorkspaceId,
            agentId: input.agentId,
            adapterType: input.adapterType,
            provider: parsed.config.provider,
            config: providerConfigForLease,
            leaseFingerprint,
            providerMetadata: providerLease.metadata,
          })
        : null;

      const builtinLeaseMetadata = {
        ...(input.agentId ? { agentId: input.agentId } : {}),
        driver: input.environment.driver,
        executionWorkspaceMode: input.executionWorkspaceMode,
        ...providerLease.metadata,
        ...(reusableScope ? { reusableSandboxLease: reusableScope } : {}),
      };
      try {
        return await environmentsSvc.acquireLease({
          companyId: input.companyId,
          environmentId: input.environment.id,
          executionWorkspaceId: input.executionWorkspaceId,
          issueId: input.issueId,
          heartbeatRunId: input.heartbeatRunId,
          assertCompanyBinding: input.assertCompanyBinding,
          leasePolicy: resolvedLeasePolicy,
          provider: parsed.config.provider,
          providerLeaseId: providerLease.providerLeaseId,
          expiresAt: providerAttestedLeaseExpiry(
            input.requestedExpiresAt,
            providerLease.expiresAt ? new Date(providerLease.expiresAt) : undefined,
          ),
          metadata: builtinLeaseMetadata,
        });
      } catch (error) {
        // The conditional lease insert rejected, so no lease row exists. A managed
        // reconciliation can bind the environment to another company between the
        // route guard and this insert, so the insert fails closed with
        // `environment_company_mismatch`. This call already provisioned the remote
        // sandbox above, so release it now. Without this teardown the rejected
        // insert leaks a live sandbox that no lease row tracks. Do not tear down a
        // reused sandbox that an earlier lease still owns.
        if (!reusableLease || providerLease.providerLeaseId !== reusableLease.providerLeaseId) {
          // Record the durable pending-cleanup row before the teardown, then
          // release the remote sandbox. On a successful teardown the handler
          // releases the row. If the durable write and the teardown both fail,
          // the handler throws a `SandboxOrphanCleanupWriteError` that carries the
          // original rejection as its cause.
          await cleanUpRejectedOrphanSandbox({
            record: {
              companyId: input.companyId,
              environmentId: input.environment.id,
              executionWorkspaceId: input.executionWorkspaceId ?? null,
              issueId: input.issueId ?? null,
              heartbeatRunId: input.heartbeatRunId ?? null,
              provider: parsed.config.provider,
              providerLeaseId: providerLease.providerLeaseId,
              metadata: builtinLeaseMetadata,
            },
            cause: error,
            canTeardown: true,
            teardown: async () => {
              await destroySandboxProviderLease({
                config: parsed.config,
                providerLeaseId: providerLease.providerLeaseId,
              });
            },
          });
        }
        throw error;
      }
    },

    async releaseRunLease(input) {
      if (input.status === "expired" && input.lease.leasePolicy === "reuse_by_environment") {
        return await destroyReusableSandboxLease({
          environment: input.environment,
          lease: input.lease,
          failureReason: "lease_expired",
        });
      }

      // Check if this lease was acquired through a plugin.
      if (input.lease.metadata?.sandboxProviderPlugin) {
        return await releasePluginBackedSandboxLease(input);
      }

      const metadataConfig = sandboxConfigFromLeaseMetadata(input.lease);

      // If no built-in provider handles this metadata, try plugin path.
      if (!metadataConfig) {
        const looseConfig = sandboxConfigFromLeaseMetadataLoose(input.lease);
        if (looseConfig && !isBuiltinSandboxProvider(looseConfig.provider)) {
          return await releasePluginBackedSandboxLease(input);
        }
      }

      const parsed = metadataConfig
        ? await resolveEnvironmentDriverConfigForRuntime(db, input.lease.companyId, {
            id: input.environment.id,
            driver: "sandbox",
            config: metadataConfig as unknown as Record<string, unknown>,
          })
        : await resolveEnvironmentDriverConfigForRuntime(db, input.lease.companyId, input.environment);
      if (parsed.driver !== "sandbox") {
        throw new Error(`Expected sandbox environment config for lease "${input.lease.id}".`);
      }

      let cleanupStatus: "success" | "failed" = "success";
      try {
        await releaseSandboxProviderLease({
          config: parsed.config,
          providerLeaseId: input.lease.providerLeaseId,
          status: input.status,
        });
      } catch {
        cleanupStatus = "failed";
      }
      const releaseStatus = input.lease.leasePolicy === "retain_on_failure" && input.status === "failed"
        ? "retained" as const
        : input.status;
      return await environmentsSvc.releaseLease(input.lease.id, releaseStatus, {
        failureReason: input.status === "failed" ? "adapter_or_run_failure" : undefined,
        cleanupStatus,
      });
    },

    async retryPendingSandboxTeardown(input) {
      // Resolve the teardown from the immutable orphan lease row, not from the
      // current environment. The row keeps the provider, the provider lease id,
      // and the sandbox config in its metadata. A provider change re-points the
      // environment, and an environment delete removes it, but neither must
      // strand this teardown. So the retry reads the recorded provider and the
      // recorded config, and never the current environment provider.
      const recordedProvider =
        input.lease.provider ??
        (typeof input.lease.metadata?.provider === "string" ? input.lease.metadata.provider : null);
      if (!recordedProvider) {
        throw new Error(`Pending-cleanup lease "${input.lease.id}" has no recorded provider for teardown.`);
      }

      // Build the config from the lease metadata under the orphan's company
      // scope, so the retry resolves the same connection secrets the failed
      // acquire used. The recorded config is the sole source of truth here: a
      // delete removed the environment, and a provider change re-points it, so
      // the retry never reads the current environment config.
      const metadataConfig = sandboxConfigFromLeaseMetadataLoose(input.lease);
      if (!metadataConfig || metadataConfig.provider !== recordedProvider) {
        throw new Error(
          `Pending-cleanup lease "${input.lease.id}" has no recorded config for provider "${recordedProvider}".`,
        );
      }

      // Plugin-backed provider path. The Claude login runs on a plugin-backed
      // sandbox, so this path tears down the login orphan.
      if (!isBuiltinSandboxProvider(recordedProvider)) {
        if (!pluginWorkerManager) {
          throw new Error(
            `Sandbox provider "${recordedProvider}" needs a plugin worker manager for cleanup, but none is available.`,
          );
        }
        const pluginProvider = await resolveSandboxProviderPlugin({ provider: recordedProvider });
        if (pluginProvider.state !== "running") {
          throw new Error(
            `Sandbox provider plugin for "${recordedProvider}" is ${pluginProvider.state}, so the cleanup teardown cannot run yet.`,
          );
        }
        // Resolve the recorded secret refs through the durable orphan record,
        // not the environment binding. A delete removed the binding, or a
        // provider change replaced it, so environment-bound resolution would
        // reject the recorded API-key ref and strand the teardown forever.
        const config = await resolveSandboxCleanupConfigSecrets(
          db,
          input.lease.companyId,
          metadataConfig,
          { issueId: input.lease.issueId, heartbeatRunId: input.lease.heartbeatRunId },
        );
        const workerConfig = stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig);
        await pluginWorkerManager.call(
          pluginProvider.resolved.plugin.id,
          "environmentDestroyLease",
          {
            driverKey: recordedProvider,
            companyId: input.lease.companyId,
            // The provider teardown keys on the provider lease id. The
            // environment id is only context, and it is empty when a delete
            // removed the environment before this orphan was recorded.
            environmentId: input.lease.environmentId ?? input.environment?.id ?? "",
            issueId: input.lease.issueId,
            config: workerConfig,
            providerLeaseId: input.lease.providerLeaseId,
            leaseMetadata: input.lease.metadata ?? undefined,
          },
          resolvePluginSandboxRpcTimeoutMs(workerConfig),
        );
        return;
      }

      // Built-in provider path. Resolve the recorded config secrets through the
      // durable orphan record, not the environment binding, for the same reason
      // as the plugin path above. The teardown targets the recorded provider,
      // never the current environment provider.
      const cleanupConfig = await resolveSandboxCleanupConfigSecrets(
        db,
        input.lease.companyId,
        metadataConfig,
        { issueId: input.lease.issueId, heartbeatRunId: input.lease.heartbeatRunId },
      );
      await destroySandboxProviderLease({
        config: cleanupConfig,
        providerLeaseId: input.lease.providerLeaseId,
      });
    },

    async isPendingCleanupWorkerReady(input) {
      // Resolve the recorded provider the same way `retryPendingSandboxTeardown`
      // does, so the probe reads the same target the teardown uses.
      const recordedProvider =
        input.lease.provider ??
        (typeof input.lease.metadata?.provider === "string" ? input.lease.metadata.provider : null);
      // A missing provider is a permanent misconfiguration. Report ready, so the
      // teardown runs, throws, and counts toward the cap.
      if (!recordedProvider) return true;
      // A built-in provider has no plugin worker, so it is always ready.
      if (isBuiltinSandboxProvider(recordedProvider)) return true;
      // No worker manager is a permanent condition here. Report ready, so the
      // teardown runs, throws its own "no worker manager" error, and counts
      // toward the cap.
      if (!pluginWorkerManager) return true;
      // Resolve the installed plugin without a wait. A plugin reload or a plugin
      // reinstall can remove the plugin row for a short window, so a missing
      // plugin is a transient condition, not a permanent one. Report not ready,
      // so the sweep skips the lease without a claim, and a later sweep retries
      // after the plugin returns. A teardown while the plugin is missing only
      // throws and burns a finite attempt, so a long reload could exhaust the
      // retries and strand the sandbox. A permanent uninstall also cannot tear
      // the sandbox down, because there is no worker to call, so the preserved
      // pending_cleanup row still holds the durable cleanup state for later.
      const installed = await resolvePluginSandboxProviderDriverByKey({
        db,
        driverKey: recordedProvider,
        workerManager: pluginWorkerManager,
        requireRunning: false,
      });
      if (!installed) return false;
      // The plugin is installed but not ready yet. A plugin reload or a plugin
      // reinstall moves the plugin through this state, so it is a transient
      // window, not a permanent condition. Report not ready, so the sweep skips
      // the lease without a claim, and a later sweep retries after the plugin
      // becomes ready. A teardown here only throws "is not_ready" and burns a
      // finite attempt, so a long reload could exhaust the retries and strand the
      // sandbox.
      if (installed.plugin.status !== "ready") return false;
      // The plugin is installed and ready, so gate on the live worker. A running
      // worker is ready. A down worker is the transient restart window, so report
      // not ready and let a later sweep retry after the worker recovers.
      return pluginWorkerManager.isRunning(installed.plugin.id);
    },

    flushDeferredOrphanCleanups,

    async realizeWorkspace(input) {
      // Resolve the realized cwd and any provider metadata first, then build ONE
      // workspace-realization record and wrap it the SAME way for every driver. A
      // plugin-backed sandbox provider realizes the workspace remotely and returns its
      // own cwd and metadata. A built-in driver has no plugin call; it uses the lease
      // `remoteCwd`. Both paths must produce the record through the single build below,
      // so the record can never drift between two exits.
      let pluginRealizedCwd: string | null = null;
      let providerMetadata: Record<string, unknown> | null = null;
      if (input.lease.metadata?.sandboxProviderPlugin && pluginWorkerManager) {
        const pluginId = readString(input.lease.metadata?.pluginId);
        const providerKey =
          readString(input.lease.metadata?.provider) ??
          (input.environment.driver === "sandbox"
            ? (parseEnvironmentDriverConfig(input.environment).config as SandboxEnvironmentConfig).provider
            : null);
        if (pluginId && providerKey) {
          const config = await resolvePluginSandboxRuntimeConfig({
            environment: input.environment,
            lease: input.lease,
            provider: providerKey,
          });
          const pluginResult = await pluginWorkerManager.call(pluginId, "environmentRealizeWorkspace", {
            driverKey: providerKey,
            companyId: input.lease.companyId,
            environmentId: input.environment.id,
            issueId: input.lease.issueId,
            config: stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig),
            lease: {
              providerLeaseId: input.lease.providerLeaseId,
              metadata: input.lease.metadata ?? undefined,
              expiresAt: input.lease.expiresAt?.toISOString() ?? null,
            },
            workspace: input.workspace,
          }, resolvePluginSandboxRpcTimeoutMs(stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig)));
          pluginRealizedCwd =
            typeof pluginResult.cwd === "string" && pluginResult.cwd.trim().length > 0
              ? pluginResult.cwd.trim()
              : null;
          providerMetadata = pluginResult.metadata ?? null;
        }
      }

      // A plugin realize handler returns only its realized cwd and provider metadata; it
      // does not build the full workspace-realization record. The server builds that record
      // from the run request, so the referenced (mentioned) project sources reach the adapter
      // through `realization.additional`. The adapter reads that field to stage each referenced
      // tree into the sandbox; without the record the sandbox agent never receives the mentioned
      // projects. The provider cwd and metadata still drive the remote path when a plugin realizes
      // the workspace.
      const record = buildWorkspaceRealizationRecordFromDriverInput({
        environment: input.environment,
        lease: input.lease,
        workspace: input.workspace,
        cwd:
          pluginRealizedCwd ??
          (typeof input.lease.metadata?.remoteCwd === "string" && input.lease.metadata.remoteCwd.trim().length > 0
            ? input.lease.metadata.remoteCwd.trim()
            : input.workspace.remotePath ?? input.workspace.localPath ?? null),
        providerMetadata,
      });
      return {
        cwd: pluginRealizedCwd ?? record.remote.path ?? record.local.path,
        metadata: {
          ...(providerMetadata ?? {}),
          workspaceRealization: record,
        },
      };
    },

    async execute(input) {
      // Plugin-backed sandbox providers: delegate command execution.
      if (input.lease.metadata?.sandboxProviderPlugin && pluginWorkerManager) {
        // Read the active run-parent context once. The host mints the plugin
        // RPC `traceparent` from this same context, so a provider `session.setup`
        // span parents to the run trace only when this context is present.
        const activeStep = getActiveStepContext();
        // Record the run-time exec parent context for this lease, so a later
        // lease-release RPC that emits the provider `session.teardown` span can
        // parent to the same run trace. This is the same context the
        // `sandbox.exec` span reads. Keep only a defined context; a local or SSH
        // target with no host trace context yields undefined and stores nothing.
        const execParentContext = activeStep?.parentContext;
        if (execParentContext !== undefined) {
          runExecParentByLeaseId.set(input.lease.id, execParentContext);
        }
        // Bypass the persistent session for any command that runs with no active
        // run-parent context. Such a command runs before the run trace is active:
        // the workspace provision command, the CLI install command, the
        // resolvability probe, and the agent process launch all run at the top of
        // the adapter execute, outside a measured step and outside the run
        // trace. A session opened on such a command emits a `session.setup` span
        // with no host-minted parent, and the span backend drops it. So run the
        // command one-shot and keep the session closed; the session then opens on
        // the first in-run command that carries a run parent (an agent tool
        // command runs under the run trace), whose setup span parents to the run
        // trace. A command that sets `bypassSession` explicitly always bypasses.
        // A command that sets `forceSession` keeps the session even with no
        // active step: the ACP process session bridge runs the long-lived agent
        // command this way, so the session opens and streams its output through
        // the session log stream. An explicit `bypassSession` still wins.
        const bypassSession =
          input.bypassSession === true || (activeStep === null && input.forceSession !== true);
        const pluginId = readString(input.lease.metadata?.pluginId);
        const providerKey = readString(input.lease.metadata?.provider);
        if (pluginId && providerKey) {
          const config = await resolvePluginSandboxRuntimeConfig({
            environment: input.environment,
            lease: input.lease,
            provider: providerKey,
          });
          const sanitizedConfig = stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig);
          return await pluginWorkerManager.call(pluginId, "environmentExecute", {
            driverKey: providerKey,
            companyId: input.lease.companyId,
            environmentId: input.environment.id,
            issueId: input.lease.issueId,
            config: sanitizedConfig,
            lease: {
              providerLeaseId: input.lease.providerLeaseId,
              metadata: input.lease.metadata ?? undefined,
              expiresAt: input.lease.expiresAt?.toISOString() ?? null,
            },
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            env: input.env,
            stdin: input.stdin,
            timeoutMs: input.timeoutMs,
            // Forward the effective session-bypass flag so a provider that opens
            // a persistent session skips it for a pre-run or context-less command
            // (the workspace provision command, the CLI install command, the
            // resolvability probe, the agent process launch). The session then
            // opens on the first in-run command that carries a run parent, whose
            // setup span parents to the run trace.
            bypassSession,
          }, resolvePluginExecuteRpcTimeoutMs({
            requestedTimeoutMs: input.timeoutMs,
            config: sanitizedConfig,
          }), input.onLog);
        }
      }
      throw new Error("Sandbox driver does not support direct command execution for built-in providers.");
    },

    supportsSync(input) {
      if (!input.lease.metadata?.sandboxProviderPlugin || !pluginWorkerManager) return false;
      const pluginId = readString(input.lease.metadata?.pluginId);
      if (!pluginId) return false;
      const advertised = pluginWorkerManager.getWorker(pluginId)?.supportedMethods ?? [];
      if (!advertised.includes("environmentSyncIn") || !advertised.includes("environmentSyncOut")) {
        return false;
      }
      // A worker advertises the sync verbs process-wide, but an individual lease
      // may run on a backend that has no data channel for the native transport
      // (e.g. a batch/job backend whose sync hook rejects immediately). The
      // provider flags such leases so they keep the byte-identical base64
      // fallback instead of being routed to a hook that would only error.
      //
      // Also fall back for any lease persisted with `backend: "job"` directly:
      // job leases created before `nativeFileSyncUnsupported` existed carry the
      // backend field but not the flag, and the `job` backend has no pod-exec
      // channel, so routing them to the native hook would only reject.
      if (
        input.lease.metadata?.nativeFileSyncUnsupported === true ||
        input.lease.metadata?.backend === "job"
      ) {
        return false;
      }
      return true;
    },

    async syncIn(input) {
      return await callPluginEnvironmentSync("environmentSyncIn", input);
    },

    async syncOut(input) {
      return await callPluginEnvironmentSync("environmentSyncOut", input);
    },

    async openDuplexChannel(input) {
      // Plugin-backed sandbox providers only: open the host-owned duplex route on
      // the plugin worker. The lease scope mirrors the sandbox execute path — the
      // provider driver key, the company, the environment, and the provider lease
      // id — so the route binds to the same worker session the runner streams.
      if (!input.lease.metadata?.sandboxProviderPlugin || !pluginWorkerManager) {
        throw new Error("Sandbox driver does not support duplex channels for this lease.");
      }
      const pluginId = readString(input.lease.metadata?.pluginId);
      const providerKey = readString(input.lease.metadata?.provider);
      const providerLeaseId = readString(input.lease.providerLeaseId);
      if (!pluginId || !providerKey || !providerLeaseId) {
        throw new Error(
          "Sandbox duplex channel needs a plugin id, a provider key, and a provider lease id on the lease.",
        );
      }
      const worker = pluginWorkerManager.getWorker(pluginId);
      if (!worker) {
        throw new Error(`Plugin worker "${pluginId}" is not running for the duplex channel.`);
      }
      const managerInput: WorkerManagerDuplexChannelOpenInput = {
        driverKey: providerKey,
        companyId: input.lease.companyId,
        environmentId: input.environment.id,
        providerLeaseId,
        command: input.command,
      };
      const session = await worker.openDuplexChannel(managerInput);
      return adaptDuplexChannelHostSession(session);
    },

    async effectiveSandboxCapabilities(input) {
      const metadata = input.lease.metadata ?? {};
      const providerKey =
        readString(metadata.provider) ??
        (input.environment.driver === "sandbox"
          ? readString((parseEnvironmentDriverConfig(input.environment).config as SandboxEnvironmentConfig).provider)
          : null);
      if (!providerKey) {
        return resolveEffectiveSandboxCapabilities({ verifiedMethods: [], declared: null, narrowing: null });
      }

      let declared: SandboxProviderCapabilities | null = null;
      let verifiedMethods: readonly string[] = [];
      let configResolutionFailed = false;

      if (metadata.sandboxProviderPlugin) {
        const pluginId = readString(metadata.pluginId);
        // Read the declaration from the exact plugin that acquired the lease,
        // not the first installed plugin with this driver key. A driver key is
        // only unique inside one manifest, so two plugins can share it. The
        // by-key resolver could intersect this lease's verified methods with a
        // different plugin's declaration. This resolver fails closed: it returns
        // null when the pinned plugin id is absent, or when that exact plugin no
        // longer declares this provider key with the `sandbox_provider` kind.
        const resolvedDriver = pluginId
          ? await resolvePluginSandboxProviderDriverById({
              db,
              pluginId,
              driverKey: providerKey,
            })
          : null;
        if (!pluginId || !resolvedDriver) {
          // Exact-plugin identity failure. The lease pins a plugin id, but the
          // id is missing, that plugin is absent, or it no longer declares this
          // provider key. Fail closed: resolve every effective capability to
          // false, no matter what methods a stale or running worker still
          // advertises. Do not read the worker methods here; passing them would
          // let an identity-less lease keep a verified baseline. This differs
          // from a valid plugin whose manifest merely omits
          // `sandboxCapabilities`: that case keeps `declared` null below and
          // defers to verified worker discovery.
          return resolveEffectiveSandboxCapabilities({
            verifiedMethods: [],
            declared: null,
            narrowing: null,
          });
        }
        verifiedMethods = pluginWorkerManager?.getWorker(pluginId)?.supportedMethods ?? [];
        declared = resolveDeclaredSandboxCapabilities(resolvedDriver.driver);
        try {
          // Resolve the provider config to confirm it is readable. A provider
          // whose config cannot be resolved is untrusted, so a resolution error
          // fails closed on persistent process sessions below. The resolved
          // value itself is no longer read for the narrowing decision.
          await resolvePluginSandboxRuntimeConfig({
            environment: input.environment,
            lease: input.lease,
            provider: providerKey,
          });
        } catch {
          configResolutionFailed = true;
        }
      } else {
        const builtin = getBuiltinSandboxProvider(providerKey);
        verifiedMethods = builtinSandboxProviderVerifiedMethods(builtin);
        declared = resolveDeclaredSandboxCapabilities({
          supportsReusableLeases: builtin?.supportsReusableLeases,
        });
      }

      const narrowing = buildSandboxCapabilityNarrowing({
        leasePolicy: input.lease.leasePolicy,
        leaseMetadata: metadata,
        configResolutionFailed,
      });

      return resolveEffectiveSandboxCapabilities({ verifiedMethods, declared, narrowing });
    },

    async destroyRunLease(input) {
      return await destroyReusableSandboxLease({
        environment: input.environment,
        lease: input.lease,
        failureReason: input.failureReason ?? "lease_destroyed",
      });
    },
  };

  /**
   * Verify that the live plugin worker still advertises a reusable-lease
   * lifecycle method before the runtime dispatches that RPC. The worker reports
   * `supportedMethods` from its discovery list on every start. A worker restart
   * can drop a lifecycle method a reusable lease was created under. The runtime
   * must not dispatch a lifecycle RPC the live worker does not advertise. It
   * fails closed when the worker is absent or the method is stale, so a lease
   * that a worker can no longer clean up goes to the cleanup reaper instead of
   * a doomed RPC.
   */
  function pluginWorkerVerifiesLifecycleMethod(pluginId: string, method: string): boolean {
    const advertised = pluginWorkerManager?.getWorker(pluginId)?.supportedMethods ?? [];
    return advertised.includes(method);
  }

  async function releasePluginBackedSandboxLease(
    input: EnvironmentDriverReleaseInput,
  ): Promise<EnvironmentLease | null> {
    const metadata = input.lease.metadata ?? {};
    const pluginId = readString(metadata.pluginId);
    const providerKey = readString(metadata.provider);

    let cleanupStatus: "success" | "failed" = "success";
    if (
      pluginId &&
      providerKey &&
      pluginWorkerManager?.isRunning(pluginId) &&
      pluginWorkerVerifiesLifecycleMethod(pluginId, "environmentReleaseLease")
    ) {
      try {
        const config = await resolvePluginSandboxRuntimeConfig({
          environment: input.environment,
          lease: input.lease,
          provider: providerKey,
        });
        await runLeaseReleaseWithRunParent(input.lease.id, () =>
          pluginWorkerManager.call(pluginId, "environmentReleaseLease", {
            driverKey: providerKey,
            companyId: input.lease.companyId,
            environmentId: input.environment.id,
            issueId: input.lease.issueId,
            config: stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig),
            providerLeaseId: input.lease.providerLeaseId,
            leaseMetadata: metadata,
          }, resolvePluginSandboxRpcTimeoutMs(stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig))),
        );
      } catch {
        cleanupStatus = "failed";
      }
    } else {
      cleanupStatus = "failed";
    }

    // A failed release verification leaves the provider resource active. The
    // cleanup reaper retries only `pending_cleanup` leases, so route a failed
    // release into that retry flow. A `retain_on_failure` lease keeps the
    // resource on purpose for reuse, so it stays `retained` and never enters the
    // reaper, which would destroy the resource the retain policy wants to keep.
    const retained =
      input.lease.leasePolicy === "retain_on_failure" && input.status === "failed";
    const releaseStatus = retained
      ? ("retained" as const)
      : cleanupStatus === "failed"
        ? ("pending_cleanup" as const)
        : input.status;
    const failureReason =
      input.status === "failed"
        ? "adapter_or_run_failure"
        : cleanupStatus === "failed"
          ? "release_cleanup_failed"
          : undefined;
    return await environmentsSvc.releaseLease(input.lease.id, releaseStatus, {
      failureReason,
      cleanupStatus,
    });
  }

  async function destroyReusableSandboxLease(input: {
    environment: Environment;
    lease: EnvironmentLease;
    failureReason: string;
  }): Promise<EnvironmentLease | null> {
    let cleanupStatus: "success" | "failed" = "success";
    const metadata = input.lease.metadata ?? {};

    try {
      if (metadata.sandboxProviderPlugin) {
        const pluginId = readString(metadata.pluginId);
        const providerKey = readString(metadata.provider);
        if (
          !pluginId ||
          !providerKey ||
          !pluginWorkerManager?.isRunning(pluginId) ||
          !pluginWorkerVerifiesLifecycleMethod(pluginId, "environmentDestroyLease")
        ) {
          cleanupStatus = "failed";
        } else {
          const config = await resolvePluginSandboxRuntimeConfig({
            environment: input.environment,
            lease: input.lease,
            provider: providerKey,
          });
          await runLeaseReleaseWithRunParent(input.lease.id, () =>
            pluginWorkerManager.call(pluginId, "environmentDestroyLease", {
              driverKey: providerKey,
              companyId: input.lease.companyId,
              environmentId: input.environment.id,
              issueId: input.lease.issueId,
              config: stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig),
              providerLeaseId: input.lease.providerLeaseId,
              leaseMetadata: metadata,
            }, resolvePluginSandboxRpcTimeoutMs(stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig))),
          );
        }
      } else {
        const metadataConfig = sandboxConfigFromLeaseMetadata(input.lease);
        const parsed = metadataConfig
          ? await resolveEnvironmentDriverConfigForRuntime(db, input.lease.companyId, {
              id: input.environment.id,
              driver: "sandbox",
              config: metadataConfig as unknown as Record<string, unknown>,
            })
          : await resolveEnvironmentDriverConfigForRuntime(db, input.lease.companyId, input.environment);
        if (parsed.driver !== "sandbox") {
          cleanupStatus = "failed";
        } else {
          await destroySandboxProviderLease({
            config: parsed.config,
            providerLeaseId: input.lease.providerLeaseId,
          });
        }
      }
    } catch {
      cleanupStatus = "failed";
    }

    return await environmentsSvc.releaseLease(
      input.lease.id,
      cleanupStatus === "success" ? "expired" : "pending_cleanup",
      {
        failureReason: input.failureReason,
        cleanupStatus,
      },
    );
  }
}

function parseExpiresAt(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Resolves the persisted lease expiry for a caller-requested deadline. It records
 * ONLY a provider-attested expiry as evidence of provider enforcement. It never
 * synthesizes the requested deadline onto the lease row: a database-only expiry
 * does not stop a remote sandbox after a server crash, so it must not stand in for
 * a provider-side bound. It returns the real provider expiry when the caller sets
 * a deadline (the caller then verifies the expiry bounds the deadline and fails
 * closed when it does not). It returns null when the caller sets a deadline and the
 * provider grants no expiry. It returns the provider expiry unchanged when the
 * caller requests no deadline, so all other callers keep the current behavior. It
 * ignores an invalid requested deadline.
 */
function providerAttestedLeaseExpiry(
  requestedExpiresAt: Date | null | undefined,
  providerExpiresAt: Date | null | undefined,
): Date | null | undefined {
  const requested =
    requestedExpiresAt instanceof Date && !Number.isNaN(requestedExpiresAt.getTime())
      ? requestedExpiresAt
      : null;
  if (!requested) return providerExpiresAt;
  return providerExpiresAt ?? null;
}

/**
 * Converts a caller-requested deadline to the ISO 8601 string a provider acquire
 * RPC carries. It returns undefined for an absent or invalid deadline, so a
 * generic caller without a deadline sends no requested expiry and keeps the
 * current provider behavior.
 */
function requestedExpiresAtParam(
  requestedExpiresAt: Date | null | undefined,
): string | undefined {
  return requestedExpiresAt instanceof Date && !Number.isNaN(requestedExpiresAt.getTime())
    ? requestedExpiresAt.toISOString()
    : undefined;
}

function pluginDriverProviderKey(config: PluginEnvironmentConfig): string {
  return `${config.pluginKey}:${config.driverKey}`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Keys the runtime stores in the lease metadata that are not part of the
// provider driver config. Some are host-internal control fields. `remoteCwd` is
// a per-lease runtime value. The host reads `remoteCwd` from the lease metadata
// directly, so the worker never needs it as config. Drop every key here before
// the runtime sends a config to a lifecycle RPC.
const INTERNAL_PLUGIN_SANDBOX_CONFIG_KEYS = new Set([
  "driver",
  "executionWorkspaceMode",
  "pluginId",
  "pluginKey",
  "providerMetadata",
  "remoteCwd",
  "shellCommand",
  "sandboxProviderPlugin",
]);

// Drop the host-internal and per-lease runtime keys from a sandbox config
// record. The runtime stores these keys in the lease metadata and in some
// resolved configs, but the plugin worker must receive only the provider driver
// config. Use this on every config the runtime sends to a lifecycle RPC, so no
// host-internal field reaches the worker.
function dropInternalPluginSandboxConfigKeys(
  config: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (INTERNAL_PLUGIN_SANDBOX_CONFIG_KEYS.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function sandboxConfigForLeaseMetadata(config: SandboxEnvironmentConfig): Record<string, unknown> {
  return { ...config };
}

function tryParseCurrentPluginConfig(environment: Environment): PluginEnvironmentConfig | null {
  if (environment.driver !== "plugin") {
    return null;
  }
  try {
    const parsed = parseEnvironmentDriverConfig(environment);
    return parsed.driver === "plugin" ? parsed.config : null;
  } catch {
    return null;
  }
}

function createPluginEnvironmentDriver(
  db: Db,
  workerManager: PluginWorkerManager,
): EnvironmentRuntimeDriver {
  const environmentsSvc = environmentService(db);
  const pluginRegistry = pluginRegistryService(db);

  async function resolvePluginDriver(config: PluginEnvironmentConfig) {
    const plugin = await pluginRegistry.getByKey(config.pluginKey);
    if (!plugin || plugin.status !== "ready") {
      throw new Error(`Plugin environment driver "${pluginDriverProviderKey(config)}" is not ready.`);
    }
    const driver = plugin.manifestJson.environmentDrivers?.find(
      (candidate) => candidate.driverKey === config.driverKey,
    );
    if (!driver) {
      throw new Error(`Plugin "${config.pluginKey}" does not declare environment driver "${config.driverKey}".`);
    }
    if (!workerManager.isRunning(plugin.id)) {
      throw new Error(`Plugin environment driver "${pluginDriverProviderKey(config)}" has no running worker.`);
    }
    return { plugin };
  }

  async function resolvePluginDriverForRelease(input: EnvironmentDriverReleaseInput) {
    const metadata = input.lease.metadata ?? {};
    const metadataPluginId = readString(metadata.pluginId);
    const metadataPluginKey = readString(metadata.pluginKey);
    const metadataDriverKey = readString(metadata.driverKey);
    const currentConfig = tryParseCurrentPluginConfig(input.environment);

    if (!metadataPluginId && !metadataPluginKey && !metadataDriverKey) {
      if (!currentConfig) {
        throw new Error(`Expected plugin environment config for driver "${input.environment.driver}".`);
      }
      const { plugin } = await resolvePluginDriver(currentConfig);
      return {
        plugin,
        pluginKey: currentConfig.pluginKey,
        driverKey: currentConfig.driverKey,
        driverConfig: currentConfig.driverConfig,
      };
    }

    const plugin = metadataPluginId
      ? await pluginRegistry.getById(metadataPluginId)
      : metadataPluginKey
        ? await pluginRegistry.getByKey(metadataPluginKey)
        : currentConfig
          ? await pluginRegistry.getByKey(currentConfig.pluginKey)
          : null;
    const driverKey = metadataDriverKey ?? currentConfig?.driverKey;
    const pluginKey = metadataPluginKey ?? plugin?.pluginKey ?? currentConfig?.pluginKey ?? "unknown";

    if (!driverKey) {
      throw new Error(`Plugin environment driver "${pluginKey}:unknown" is missing a driver key.`);
    }

    if (!plugin || plugin.status !== "ready") {
      throw new Error(`Plugin environment driver "${pluginKey}:${driverKey}" is not ready.`);
    }
    const declaredDriver = plugin.manifestJson.environmentDrivers?.find(
      (candidate) => candidate.driverKey === driverKey,
    );
    if (!declaredDriver) {
      throw new Error(`Plugin "${plugin.pluginKey}" does not declare environment driver "${driverKey}".`);
    }
    if (!workerManager.isRunning(plugin.id)) {
      throw new Error(`Plugin environment driver "${plugin.pluginKey}:${driverKey}" has no running worker.`);
    }

    const currentConfigStillMatches =
      currentConfig?.pluginKey === plugin.pluginKey && currentConfig.driverKey === driverKey;

    return {
      plugin,
      pluginKey: plugin.pluginKey,
      driverKey,
      driverConfig: currentConfigStillMatches ? currentConfig.driverConfig : {},
    };
  }

  return {
    driver: "plugin",

    async acquireRunLease(input) {
      const parsed = parseEnvironmentDriverConfig(input.environment);
      if (parsed.driver !== "plugin") {
        throw new Error(`Expected plugin environment config for driver "${input.environment.driver}".`);
      }
      const { plugin } = await resolvePluginDriver(parsed.config);
      const providerLease = await workerManager.call(plugin.id, "environmentAcquireLease", {
        driverKey: parsed.config.driverKey,
        companyId: input.companyId,
        environmentId: input.environment.id,
        issueId: input.issueId,
        config: parsed.config.driverConfig,
        runId: input.heartbeatRunId ?? randomUUID(),
        workspaceMode: input.executionWorkspaceMode ?? undefined,
        agentId: input.agentId ?? undefined,
        executionWorkspaceId: input.executionWorkspaceId ?? undefined,
        adapterType: input.adapterType ?? undefined,
        executionWorkspaceSettings: input.executionWorkspaceSettings,
        // Forward a caller deadline so the provider configures a provider-side
        // expiry at or before it and returns the real provider expiry.
        ...(requestedExpiresAtParam(input.requestedExpiresAt) !== undefined
          ? { requestedExpiresAt: requestedExpiresAtParam(input.requestedExpiresAt) }
          : {}),
      } as PluginEnvironmentAcquireLeaseParams);

      return await environmentsSvc.acquireLease({
        companyId: input.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: input.executionWorkspaceId,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        leasePolicy: "ephemeral",
        provider: `plugin:${parsed.config.pluginKey}:${parsed.config.driverKey}`,
        providerLeaseId: providerLease.providerLeaseId,
        expiresAt: providerAttestedLeaseExpiry(input.requestedExpiresAt, parseExpiresAt(providerLease.expiresAt)),
        metadata: {
          ...(input.agentId ? { agentId: input.agentId } : {}),
          providerMetadata: providerLease.metadata ?? {},
          driver: input.environment.driver,
          executionWorkspaceMode: input.executionWorkspaceMode,
          pluginId: plugin.id,
          pluginKey: parsed.config.pluginKey,
          driverKey: parsed.config.driverKey,
        },
      });
    },

    async releaseRunLease(input) {
      const { plugin, driverKey, driverConfig } = await resolvePluginDriverForRelease(input);
      await workerManager.call(plugin.id, "environmentReleaseLease", {
        driverKey,
        companyId: input.lease.companyId,
        environmentId: input.environment.id,
        issueId: input.lease.issueId,
        config: driverConfig,
        providerLeaseId: input.lease.providerLeaseId,
        leaseMetadata: input.lease.metadata ?? undefined,
      });
      return await environmentsSvc.releaseLease(input.lease.id, input.status);
    },

    async resumeRunLease(input) {
      if (!input.lease.providerLeaseId) {
        throw new Error(`Plugin environment lease "${input.lease.id}" does not have a provider lease id to resume.`);
      }
      const { pluginKey, driverKey, driverConfig } = await resolvePluginDriverForRelease({
        ...input,
        status: "released",
      });
      return await resumePluginEnvironmentLease({
        db,
        workerManager,
        companyId: input.lease.companyId,
        environmentId: input.environment.id,
        issueId: input.lease.issueId,
        config: {
          pluginKey,
          driverKey,
          driverConfig,
        },
        providerLeaseId: input.lease.providerLeaseId,
        leaseMetadata: input.lease.metadata ?? undefined,
      });
    },

    async destroyRunLease(input) {
      const { pluginKey, driverKey, driverConfig } = await resolvePluginDriverForRelease({
        ...input,
        status: "failed",
      });
      await destroyPluginEnvironmentLease({
        db,
        workerManager,
        companyId: input.lease.companyId,
        environmentId: input.environment.id,
        issueId: input.lease.issueId,
        config: {
          pluginKey,
          driverKey,
          driverConfig,
        },
        providerLeaseId: input.lease.providerLeaseId,
        leaseMetadata: input.lease.metadata ?? undefined,
      });
      return await environmentsSvc.releaseLease(input.lease.id, "failed", {
        failureReason: input.failureReason ?? "lease_destroyed",
      });
    },

    async realizeWorkspace(input) {
      const { plugin, pluginKey, driverKey, driverConfig } = await resolvePluginDriverForRelease({
        environment: input.environment,
        lease: input.lease,
        status: "released",
      });
      return await realizePluginEnvironmentWorkspace({
        db,
        workerManager,
        pluginId: plugin.id,
        config: {
          pluginKey,
          driverKey,
          driverConfig,
        },
        params: {
          driverKey,
          companyId: input.lease.companyId,
          environmentId: input.environment.id,
          issueId: input.lease.issueId,
          config: driverConfig,
          lease: {
            providerLeaseId: input.lease.providerLeaseId,
            metadata: input.lease.metadata ?? undefined,
            expiresAt: input.lease.expiresAt?.toISOString() ?? null,
          },
          workspace: input.workspace,
        },
      });
    },

    async execute(input) {
      const { plugin, pluginKey, driverKey, driverConfig } = await resolvePluginDriverForRelease({
        environment: input.environment,
        lease: input.lease,
        status: "released",
      });
      return await executePluginEnvironmentCommand({
        db,
        workerManager,
        pluginId: plugin.id,
        config: {
          pluginKey,
          driverKey,
          driverConfig,
        },
        params: {
          driverKey,
          companyId: input.lease.companyId,
          environmentId: input.environment.id,
          issueId: input.lease.issueId,
          config: driverConfig,
          lease: {
            providerLeaseId: input.lease.providerLeaseId,
            metadata: input.lease.metadata ?? undefined,
            expiresAt: input.lease.expiresAt?.toISOString() ?? null,
          },
          command: input.command,
          args: input.args,
          cwd: input.cwd,
          env: input.env,
          stdin: input.stdin,
          timeoutMs: input.timeoutMs,
        },
      });
    },
  };
}

export function environmentRuntimeService(
  db: Db,
  options: {
    drivers?: EnvironmentRuntimeDriver[];
    pluginWorkerManager?: PluginWorkerManager;
    pluginWorkerReadyTimeoutMs?: number;
    pluginWorkerReadyPollMs?: number;
    pendingCleanupWriteAttempts?: number;
    pendingCleanupWriteBackoffMs?: number;
    deferredOrphanCleanupBufferLimit?: number;
    orphanCleanupSpool?: SandboxOrphanCleanupSpool;
    orphanCleanupSpoolDir?: string;
  } = {},
) {
  const environmentsSvc = environmentService(db);
  const drivers = new Map<string, EnvironmentRuntimeDriver>();

  const defaultDrivers = [
    createLocalEnvironmentDriver(db),
    createSshEnvironmentDriver(db),
    createSandboxEnvironmentDriver(db, {
      pluginWorkerManager: options.pluginWorkerManager,
      pluginWorkerReadyTimeoutMs: options.pluginWorkerReadyTimeoutMs,
      pluginWorkerReadyPollMs: options.pluginWorkerReadyPollMs,
      pendingCleanupWriteAttempts: options.pendingCleanupWriteAttempts,
      pendingCleanupWriteBackoffMs: options.pendingCleanupWriteBackoffMs,
      deferredOrphanCleanupBufferLimit: options.deferredOrphanCleanupBufferLimit,
      orphanCleanupSpool: options.orphanCleanupSpool,
      orphanCleanupSpoolDir: options.orphanCleanupSpoolDir,
    }),
    ...(options.pluginWorkerManager
      ? [createPluginEnvironmentDriver(db, options.pluginWorkerManager)]
      : []),
  ];

  for (const driver of options.drivers ?? defaultDrivers) {
    drivers.set(driver.driver, driver);
  }

  function getDriver(driverKey: string): EnvironmentRuntimeDriver | null {
    return drivers.get(driverKey) ?? null;
  }

  function requireDriver(environment: Pick<Environment, "driver">): EnvironmentRuntimeDriver {
    const driver = getDriver(environment.driver);
    if (!driver) {
      throw new Error(
        `Environment driver "${environment.driver}" is not registered in the environment runtime yet.`,
      );
    }
    return driver;
  }

  function requireDriverKey(driverKey: string): EnvironmentRuntimeDriver {
    const driver = getDriver(driverKey);
    if (!driver) {
      throw new Error(
        `Environment driver "${driverKey}" is not registered in the environment runtime yet.`,
      );
    }
    return driver;
  }

  return {
    getDriver,

    /**
     * Read the sandbox duplex bridge kill switch for a new run. The host calls it
     * per run before it selects the callback bridge transport. It reads the
     * experimental instance setting `enableSandboxDuplexBridge` and maps it into
     * the resolved bridge input. The default-off setting keeps the file bridge.
     */
    async readSandboxDuplexBridgeInput(): Promise<ResolvedSandboxDuplexBridgeInput> {
      const experimental = await instanceSettingsService(db).getExperimental();
      return resolveSandboxDuplexBridgeInput(experimental);
    },

    async acquireRunLease(input: {
      companyId: string;
      environment: Environment;
      issueId: string | null;
      agentId?: string | null;
      /** Null for ad-hoc invocations (e.g. operator-initiated `Test` probes). */
      heartbeatRunId: string | null;
      persistedExecutionWorkspace: Pick<ExecutionWorkspace, "id" | "mode"> | null;
      executionWorkspaceSettings?: IssueExecutionWorkspaceSettings | null;
      /** The agent's adapter type for this run (mixed-harness environments). */
      adapterType?: string | null;
      /**
       * Force applying the active custom-image template even for ad-hoc (no
       * issue/run) invocations. Operator `Test` probes set this so the runtime
       * lease uses the operator-prepared custom image.
       */
      applyCustomImageTemplate?: boolean;
      /**
       * The latest time the acquired lease may stay active. The driver bounds
       * the persisted lease expiry to this time. Null or undefined keeps the
       * provider expiry only.
       */
      requestedExpiresAt?: Date | null;
      /**
       * Re-check the environment company binding inside the lease insert
       * transaction. The login acquire paths set this to reject a foreign-company
       * environment with the 403 `environment_company_mismatch`.
       */
      assertCompanyBinding?: boolean;
    }): Promise<EnvironmentRuntimeLeaseRecord> {
      if (input.environment.status !== "active") {
        throw new Error(`Environment "${input.environment.name}" is not active.`);
      }

      const leaseContext = buildEnvironmentLeaseContext({
        persistedExecutionWorkspace: input.persistedExecutionWorkspace,
      });
      const driver = requireDriver(input.environment);
      const lease = await driver.acquireRunLease({
        companyId: input.companyId,
        environment: input.environment,
        issueId: input.issueId,
        agentId: input.agentId ?? null,
        heartbeatRunId: input.heartbeatRunId,
        executionWorkspaceId: leaseContext.executionWorkspaceId,
        executionWorkspaceMode: leaseContext.executionWorkspaceMode,
        executionWorkspaceSettings: input.executionWorkspaceSettings ?? null,
        adapterType: input.adapterType ?? null,
        applyCustomImageTemplate: input.applyCustomImageTemplate ?? false,
        requestedExpiresAt: input.requestedExpiresAt ?? null,
        assertCompanyBinding: input.assertCompanyBinding,
      });

      return {
        environment: input.environment,
        lease,
        leaseContext,
      };
    },

    async releaseRunLeases(
      heartbeatRunId: string,
      status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed"> = "released",
      onLeaseReleaseError?: (leaseId: string, error: unknown) => void,
    ): Promise<EnvironmentRuntimeLeaseRecord[]> {
      const leaseRows = await db
        .select()
        .from(environmentLeases)
        .where(
          and(
            eq(environmentLeases.heartbeatRunId, heartbeatRunId),
            inArray(environmentLeases.status, ["active"]),
          ),
        );
      if (leaseRows.length === 0) {
        return [];
      }

      // Release each lease in its own try/catch. One driver error must not stop
      // the release of the later leases. The caller records each lease-specific
      // error through `onLeaseReleaseError` for its log path. Keep the order
      // serial.
      const released: EnvironmentRuntimeLeaseRecord[] = [];
      for (const leaseRow of leaseRows) {
        try {
          const environment = leaseRow.environmentId
            ? await environmentsSvc.getById(leaseRow.environmentId)
            : null;
          if (!environment) continue;

          const leaseSnapshot = toEnvironmentLeaseSnapshot(leaseRow);
          const driver = getDriver(getLeaseDriverKey(leaseSnapshot, environment));
          const lease = driver
            ? await driver.releaseRunLease({
                environment,
                lease: leaseSnapshot,
                status,
              })
            : await environmentsSvc.releaseLease(leaseRow.id, status);
          if (!lease) continue;

          released.push({
            environment,
            lease,
            leaseContext: {
              executionWorkspaceId: lease.executionWorkspaceId,
              executionWorkspaceMode:
                (lease.metadata?.executionWorkspaceMode as ExecutionWorkspace["mode"] | null | undefined) ?? null,
            },
          });
        } catch (error) {
          onLeaseReleaseError?.(leaseRow.id, error);
        }
      }

      return released;
    },

    // Tear an orphan ephemeral sandbox down from its recorded provider config.
    // A failed acquire records the orphan as a `pending_cleanup` lease. The row
    // keeps the provider, the provider lease id, and the sandbox config, so this
    // teardown runs without the environment row and accepts a null environment.
    // The teardown resolves the recorded secret refs through the durable orphan
    // record, so a deleted or foreign-bound environment never strands it. The
    // caller owns the lease release; this dispatcher only runs the provider
    // teardown and throws when the driver teardown throws.
    async retryPendingSandboxTeardown(input: {
      environment: Environment | null;
      lease: EnvironmentLease;
    }): Promise<void> {
      const driver = requireDriverKey(getLeaseDriverKey(input.lease, input.environment));
      if (!driver.retryPendingSandboxTeardown) {
        throw new Error(
          `Environment driver "${driver.driver}" does not support orphan sandbox teardown.`,
        );
      }
      await driver.retryPendingSandboxTeardown(input);
    },

    // Report whether the provider worker can run an orphan teardown now. The
    // cleanup sweep calls this before it claims a finite retry attempt, so a
    // briefly-down plugin worker never burns an attempt. This dispatcher never
    // throws: an unregistered driver, or a driver with no probe, reports ready,
    // so the teardown still runs and its own failure counts toward the cap.
    async isPendingCleanupWorkerReady(input: {
      environment: Environment | null;
      lease: EnvironmentLease;
    }): Promise<boolean> {
      const driver = getDriver(getLeaseDriverKey(input.lease, input.environment));
      if (!driver?.isPendingCleanupWorkerReady) return true;
      return driver.isPendingCleanupWorkerReady(input);
    },

    // Flush the in-process orphan-cleanup buffers of every driver that keeps one.
    // The cleanup sweep calls this each tick, so a buffered orphan lands a durable
    // `pending_cleanup` row once the database recovers, and the same sweep tears
    // it down. The dispatcher sums the recovered and pending counts across all
    // drivers. A driver with no buffer contributes nothing.
    async flushDeferredOrphanCleanups(): Promise<{ recovered: number; pending: number }> {
      let recovered = 0;
      let pending = 0;
      for (const driver of drivers.values()) {
        if (!driver.flushDeferredOrphanCleanups) continue;
        const result = await driver.flushDeferredOrphanCleanups();
        recovered += result.recovered;
        pending += result.pending;
      }
      return { recovered, pending };
    },

    async destroyReusableSandboxLeases(input: {
      companyId: string;
      issueId?: string | null;
      executionWorkspaceId?: string | null;
      failureReason?: string;
    }): Promise<EnvironmentRuntimeLeaseRecord[]> {
      const scopeConditions = [
        input.issueId ? eq(environmentLeases.issueId, input.issueId) : undefined,
        input.executionWorkspaceId ? eq(environmentLeases.executionWorkspaceId, input.executionWorkspaceId) : undefined,
      ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
      if (scopeConditions.length === 0) return [];

      const leaseRows = await db
        .select()
        .from(environmentLeases)
        .where(
          and(
            eq(environmentLeases.companyId, input.companyId),
            eq(environmentLeases.leasePolicy, "reuse_by_environment"),
            inArray(environmentLeases.status, ["active", "released", "retained", "pending_cleanup"]),
            ...scopeConditions,
          ),
        );

      const destroyed: EnvironmentRuntimeLeaseRecord[] = [];
      for (const leaseRow of leaseRows) {
        const environment = leaseRow.environmentId
          ? await environmentsSvc.getById(leaseRow.environmentId)
          : null;
        if (!environment) continue;
        const leaseSnapshot = toEnvironmentLeaseSnapshot(leaseRow);
        const driver = getDriver(getLeaseDriverKey(leaseSnapshot, environment));
        const lease = driver?.destroyRunLease
          ? await driver.destroyRunLease({
              environment,
              lease: leaseSnapshot,
              failureReason: input.failureReason ?? "reusable_lease_destroyed",
            })
          : await environmentsSvc.releaseLease(leaseSnapshot.id, "pending_cleanup", {
              failureReason: input.failureReason ?? "reusable_lease_destroyed",
              cleanupStatus: "failed",
            });
        if (!lease) continue;
        destroyed.push({
          environment,
          lease,
          leaseContext: {
            executionWorkspaceId: lease.executionWorkspaceId,
            executionWorkspaceMode:
              (lease.metadata?.executionWorkspaceMode as ExecutionWorkspace["mode"] | null | undefined) ?? null,
          },
        });
      }
      return destroyed;
    },

    async resumeRunLease(input: EnvironmentDriverLeaseInput): Promise<PluginEnvironmentLease | EnvironmentLease | null> {
      const driver = requireDriverKey(getLeaseDriverKey(input.lease, input.environment));
      if (!driver.resumeRunLease) {
        throw new Error(`Environment driver "${driver.driver}" does not support lease resume.`);
      }
      return await driver.resumeRunLease(input);
    },

    async destroyRunLease(input: EnvironmentDriverLeaseInput): Promise<EnvironmentLease | null> {
      const driver = requireDriverKey(getLeaseDriverKey(input.lease, input.environment));
      if (!driver.destroyRunLease) {
        throw new Error(`Environment driver "${driver.driver}" does not support lease destroy.`);
      }
      return await driver.destroyRunLease(input);
    },

    async realizeWorkspace(
      input: EnvironmentDriverRealizeWorkspaceInput,
    ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
      const driver = requireDriverKey(getLeaseDriverKey(input.lease, input.environment));
      if (!driver.realizeWorkspace) {
        throw new Error(`Environment driver "${driver.driver}" does not support workspace realization.`);
      }
      return await driver.realizeWorkspace(input);
    },

    async execute(input: EnvironmentDriverExecuteInput): Promise<PluginEnvironmentExecuteResult> {
      const driver = requireDriverKey(getLeaseDriverKey(input.lease, input.environment));
      if (!driver.execute) {
        throw new Error(`Environment driver "${driver.driver}" does not support command execution.`);
      }
      return await driver.execute(input);
    },

    supportsSync(input: EnvironmentDriverLeaseInput): boolean {
      const driver = getDriver(getLeaseDriverKey(input.lease, input.environment));
      return driver?.supportsSync?.(input) ?? false;
    },

    async effectiveSandboxCapabilities(
      input: EnvironmentDriverLeaseInput,
    ): Promise<EffectiveSandboxCapabilities | null> {
      const driver = getDriver(getLeaseDriverKey(input.lease, input.environment));
      return (await driver?.effectiveSandboxCapabilities?.(input)) ?? null;
    },

    async syncIn(input: EnvironmentDriverSyncInput): Promise<PluginEnvironmentSyncResult> {
      const driver = requireDriverKey(getLeaseDriverKey(input.lease, input.environment));
      if (!driver.syncIn) {
        throw new Error(`Environment driver "${driver.driver}" does not support native file sync.`);
      }
      return await driver.syncIn(input);
    },

    async syncOut(input: EnvironmentDriverSyncInput): Promise<PluginEnvironmentSyncResult> {
      const driver = requireDriverKey(getLeaseDriverKey(input.lease, input.environment));
      if (!driver.syncOut) {
        throw new Error(`Environment driver "${driver.driver}" does not support native file sync.`);
      }
      return await driver.syncOut(input);
    },

    async openDuplexChannel(
      input: EnvironmentDriverOpenDuplexChannelInput,
    ): Promise<CommandManagedDuplexChannel> {
      const driver = requireDriverKey(getLeaseDriverKey(input.lease, input.environment));
      if (!driver.openDuplexChannel) {
        throw new Error(`Environment driver "${driver.driver}" does not support duplex channels.`);
      }
      // Centralize the duplex channel authorization here. Resolve the exact lease
      // capability snapshot and refuse unless the effective snapshot grants the
      // opt-in `duplexCommandStream` capability. This gate runs before the driver
      // call, so an unauthorized lease never reaches the worker. The
      // execution-target member gate stays as defense in depth. A driver that
      // cannot resolve the snapshot fails closed with the fixed refusal.
      const effective =
        (await driver.effectiveSandboxCapabilities?.(input)) ?? null;
      if (effective?.duplexCommandStream !== true) {
        throw new Error(DUPLEX_CHANNEL_CAPABILITY_DENIED);
      }
      return await driver.openDuplexChannel(input);
    },
  };
}

export type EnvironmentRuntimeService = ReturnType<typeof environmentRuntimeService>;
