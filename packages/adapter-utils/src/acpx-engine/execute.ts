import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  AdapterBillingType,
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetSessionIdentity,
  describeAdapterExecutionTarget,
  adapterExecutionTargetDuplexTelemetryRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  formatAdapterExecutionTimeoutErrorMessage,
  formatAdapterExecutionTimeoutStartLogLine,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeout,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
  startAdapterExecutionTargetProcessSessionBridge,
  type AdapterExecutionTarget,
  type AdapterExecutionTargetPaperclipBridgeHandle,
  type AdapterExecutionTargetProcessSessionBridgeHandle,
  type AdapterExecutionTargetTimeoutResolution,
  type AdapterManagedRuntimeAsset,
  type PreparedAdapterExecutionTargetRuntime,
  type SandboxAdditionalSource,
} from "@paperclipai/adapter-utils/execution-target";
import type { DuplexLossReason } from "../duplex-telemetry.js";
import { DUPLEX_CHANNEL_LOST_ERROR_CODE } from "../duplex-bridge-broker.js";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  applyPaperclipWorkspaceEnv,
  asNumber,
  asString,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  ensurePaperclipSkillSymlink,
  isForbiddenConfigEnvKey,
  isPaperclipRuntimeEnvKey,
  joinPromptSections,
  materializePaperclipSkillCopy,
  parseObject,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  renderPaperclipWakePrompt,
  renderTemplate,
  resolvePaperclipInstanceRootForAdapter,
  selectPaperclipTaskMarkdown,
  resolvePaperclipDesiredSkillNames,
  removeMaintainerOnlySkillSymlinks,
  rewriteWorkspaceCwdEnvVarsForExecution,
  shapePaperclipWorkspaceEnvForExecution,
  stringifyPaperclipWakePayload,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import {
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
  isAcpRuntimeError,
  type AcpAgentRegistry,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeStatus,
  type AcpRuntimeTurn,
  type AcpRuntimeTurnResult,
  type AcpRuntimeUsageBreakdown,
  type AcpRuntimeUsageCost,
} from "acpx/runtime";
import {
  DEFAULT_ACP_ENGINE_AGENT,
  DEFAULT_ACP_ENGINE_MODE,
  DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACP_ENGINE_PERMISSION_MODE,
  DEFAULT_ACP_ENGINE_TIMEOUT_SEC,
  DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
} from "./constants.js";
import type {
  AcpRunContext,
  AcquiredRunResources,
  LaunchEnvironment,
  LaunchEnvironmentContribution,
  PreTurnFailedCause,
  SessionFingerprintIdentity,
  SessionKeyIdentity,
  SettlementCause,
  StartupReady,
  StartupResult,
  TurnCompletion,
} from "./run-contracts.js";
import { createRunResourceLedger } from "./run-resource-ledger.js";
import { settleAcpRun, type SettlementSteps } from "./settlement-sequence.js";
import {
  runAttempt,
  type RunPlan,
  type SettlementReason,
  type SettlementDispositionReport,
} from "./run-coordinator.js";
import {
  runTurn as runTurnSequence,
  type StartedTurn,
  type TurnFinalizeInput,
} from "./turn-sequence.js";
import {
  createHostRunSite,
  type AcpxAgentProcessIdentity,
  type AcpxProcessIdentitySink,
  type ChildStderrState,
  type RuntimeCacheEntry,
} from "./run-site-host.js";
import { createSandboxRunSite, type SandboxRunSite } from "./run-site-sandbox.js";
import {
  createRuntimeSpanRunner,
  emitRunPhaseTiming,
  emitSkippedStartupStep,
  getActiveStepContext,
  measureStartupStep,
  NOOP_STARTUP_SPAN,
  NOOP_STARTUP_TRACE_CONTEXT,
  runWithRuntimeParent,
  setSandboxRootSpanAttributes,
  type RuntimeSpanRunner,
  type SandboxRootSpanContext,
  type StartupSpan,
  type StartupSpanContext,
  type StartupStepMeasureOptions,
  type StartupTraceContext,
} from "./startup-timing.js";

const defaultModuleDir = path.dirname(fileURLToPath(import.meta.url));
const PAPERCLIP_MANAGED_CODEX_SKILLS_MANIFEST = ".paperclip-managed-skills.json";
const BENIGN_NES_CLOSE_STDERR = /method: ['"]nes\/close['"].*-32601/;

function routeChildStderr(state: ChildStderrState, chunk: string) {
  if (state.logPath) {
    fsSync.mkdirSync(path.dirname(state.logPath), { recursive: true });
    fsSync.appendFileSync(state.logPath, chunk);
  }
  const combined = state.pendingLiveLine + chunk;
  const lastNewline = combined.lastIndexOf("\n");
  if (lastNewline < 0) {
    state.pendingLiveLine = combined;
    return;
  }
  const complete = combined.slice(0, lastNewline + 1);
  state.pendingLiveLine = combined.slice(lastNewline + 1);
  const filtered = complete
    .split(/(?<=\n)/)
    .filter((line) => !BENIGN_NES_CLOSE_STDERR.test(line))
    .join("");
  if (filtered) process.stderr.write(filtered);
}

function flushChildStderr(state: ChildStderrState) {
  if (state.pendingLiveLine && !BENIGN_NES_CLOSE_STDERR.test(state.pendingLiveLine)) {
    process.stderr.write(state.pendingLiveLine);
  }
  state.pendingLiveLine = "";
}

type PaperclipAcpRuntimeOptions = AcpRuntimeOptions & {
  onAgentSpawn?: (meta: AcpxAgentProcessIdentity) => Promise<void>;
  // Return the current-run parent-context token. It is the `task.run` token
  // during startup and after the turn, and the `agent.turn` token during the
  // turn. A detached exec reads this getter to parent to the live run span. The
  // real `createAcpRuntime` ignores this optional field.
  getRuntimeParentContext?: () => StartupSpanContext | undefined;
};

type AcpxRuntimeFactory = (options: PaperclipAcpRuntimeOptions) => AcpRuntime;

/**
 * A remote runner-backed session's staged runtime, kept warm across runs so a
 * compatible resume reuses it instead of re-shipping the workspace / re-seeding
 * the managed home (PR 3: "stage once per session"). Keyed by the session's
 * `sessionKey` (`paperclip:companyId:agentId:taskKey:fingerprint`) — the SAME
 * fingerprint scoping the warm handle uses — so one session can never read
 * another session's staged credentials: a different agent/task/config hashes to
 * a different key, misses this cache, and stages its own home.
 *
 * Remote sessions are never held in the warm-handle cache (their agent process
 * lives behind a per-run process-session bridge, torn down each run and resumed
 * via `session/load`); the only thing that survives between their runs is the
 * in-sandbox staged workspace + home, which this cache reuses.
 */
export interface StagedRuntimeCacheEntry {
  stagedRuntime: PreparedAdapterExecutionTargetRuntime;
  /**
   * The env keys the per-adapter managed-home seam mutated when it staged (e.g.
   * `CODEX_HOME` repointed onto the in-sandbox home). Re-applied verbatim on a
   * reused run so the spawned agent still receives the in-sandbox home paths
   * without re-invoking the seam. These values are deterministic (derived from
   * the staged asset dirs), so they are identical across the session's runs.
   */
  envDelta: Record<string, string>;
  /**
   * The seam's per-run copy-back (codex auth copy-back via `restoreWorkspace()`),
   * or null for adapters/customs with no seam. Reused on every run's teardown so
   * the copy-back cadence stays exactly per-run — unchanged from PR 2.
   * `restoreWorkspace()` reads the sandbox live through the stable (stateless)
   * runner, so reusing the closure across resumes copies back the current
   * in-sandbox credential, not a stale snapshot. It never removes the staged
   * in-sandbox home, so re-running it on each reuse can't invalidate this entry.
   */
  teardown: (() => Promise<void>) | null;
  /**
   * The seam's one-time host-side staged-resource cleanup (e.g. remove the
   * staged home temp dir), or null. Fired ONLY when this entry is dropped —
   * failed/cancelled/timed-out turn, incompatible re-stage, or idle eviction —
   * never while the entry stays warm for reuse. Kept separate from `teardown`
   * so a clean turn's per-run copy-back can't delete resources the next
   * compatible resume still relies on.
   */
  dispose: (() => Promise<void>) | null;
  lastUsedAt: number;
}

interface AcpxEngineSettings {
  adapterType: string;
  moduleDir: string;
  packageRootDir: string;
}

export interface AcpxEngineBillingIdentity {
  provider?: string | null;
  biller?: string | null;
  billingType?: AdapterBillingType | null;
}

/**
 * Per-adapter remote managed-home seed seam, injected by each adapter's ACP
 * wiring ({codex,claude,gemini}-local `acp.ts`). The adapter-specific
 * credential/home helpers (`copyBackCodexAuth`, `stageCodexHomeForSync`,
 * `prepareClaudeConfigSeed`, the Gemini skills stager, …) live in the adapter
 * packages, and the shared engine — which lives *inside*
 * `@paperclipai/adapter-utils`, a dependency of those packages — cannot import
 * them without a circular dependency. So the engine exposes this seam and each
 * adapter supplies it, reusing the exact same vetted helpers (no duplication of
 * the security-critical copy-back path).
 *
 * The seam mirrors the adapter's CLI lane: seed the managed home into the
 * sandbox through the staging seam, repoint the adapter's home env var to the
 * in-sandbox path, and — codex only — wire auth copy-back on teardown. It is
 * invoked ONLY on the runner-backed remote sandbox lane
 * (`useRemoteProcessSession`); when absent (custom agents, the shared-engine
 * tests) the engine stages the workspace with no home asset, byte-identical to
 * the PR-1 behavior and to the local / runner-less ACP→CLI fallback.
 *
 * This context is deliberately adapter-agnostic: it carries only generic inputs
 * (the resolved run `env`, the target, the host workspace dir, the `stage`
 * callback, …) so that nothing adapter-specific leaks across the boundary. A
 * seam derives every adapter-specific path it needs — the Gemini skills dir, the
 * Codex home, the Claude config dir — from `config`/`env` on its own side, the
 * same way the adapter's CLI lane does. No field here is named after or scoped
 * to a single adapter.
 */
export interface AcpxRemoteManagedHomeContext {
  acpxAgent: string;
  companyId: string;
  runId: string;
  config: Record<string, unknown>;
  /** The runner-backed remote sandbox target the workspace stages into. */
  executionTarget: AdapterExecutionTarget;
  /** Host workspace dir being staged (the local cwd). */
  workspaceLocalDir: string;
  timeoutSec: number;
  /**
   * The run env. The seam MUST repoint the adapter's home env var here onto the
   * in-sandbox path (e.g. `env.CODEX_HOME = staged.assetDirs.home`). At call
   * time it already carries the host managed-home paths the engine resolved —
   * notably `env.CODEX_HOME` is the host managed Codex home for the codex agent.
   */
  env: Record<string, string>;
  onLog: AdapterExecutionContext["onLog"];
  onRuntimeProgress: AdapterExecutionContext["onRuntimeProgress"];
  /**
   * Runs the shared workspace+assets staging seam and returns the prepared
   * runtime. The seam passes its per-adapter home `assets` here; the returned
   * `assetDirs`/`runtimeRootDir` are what it remaps the home env var onto.
   */
  stage: (assets: AdapterManagedRuntimeAsset[]) => Promise<PreparedAdapterExecutionTargetRuntime>;
}

export interface AcpxRemoteManagedHomeResult {
  stagedRuntime: PreparedAdapterExecutionTargetRuntime;
  /**
   * Per-run copy-back, invoked once on every teardown/exit path (mirrors the CLI
   * restore-hook finally). For codex this runs `restoreWorkspace()` — the seam
   * that fires the auth copy-back. It reads the sandbox live and does NOT remove
   * the staged in-sandbox home/workspace, so it is safe to re-run on every
   * compatible resume that reuses the staged runtime — the copy-back cadence
   * stays exactly per-run. Failures are logged by the seam, never fatal to the
   * run result (an unclean-teardown copy-back miss is the accepted
   * `refresh_token_reused` residual, loud on the next host Codex use, never
   * silent).
   *
   * Host-side staged-resource cleanup (e.g. removing the staged home temp dir)
   * is NOT done here — it moved to {@link disposeStaged} so that reusing the
   * cached staged runtime across resumes never destroys resources a later run
   * still needs.
   */
  teardown?: () => Promise<void>;
  /**
   * One-time cleanup of host-side staged resources (e.g. the curated staged
   * home temp dir). Split out from {@link teardown} so it fires ONLY when the
   * staged runtime is actually dropped — a failed/cancelled/timed-out turn, an
   * incompatible re-stage, or idle eviction — never on a clean turn that keeps
   * the staged runtime warm for the next compatible resume. Idempotent (safe to
   * call more than once — it force-removes and swallows already-gone paths).
   * Null for adapters that seed from a managed cache and hold no disposable
   * temp.
   */
  disposeStaged?: () => Promise<void>;
}

export interface AcpxEngineExecutorOptions {
  createRuntime?: AcpxRuntimeFactory;
  now?: () => number;
  warmHandles?: Map<string, RuntimeCacheEntry>;
  /**
   * Per-session staged-runtime cache for the remote runner-backed lane (PR 3).
   * Keyed by `sessionKey`. Reused across runs so a compatible resume does not
   * re-ship the workspace / re-seed the managed home. Defaults to a shared
   * module-level map; tests pass an isolated map.
   */
  stagedRuntimes?: Map<string, StagedRuntimeCacheEntry>;
  /**
   * Per-`sessionKey` staging mutex for the remote runner-backed lane (PR 3).
   * Serializes the stage-or-reuse decision so two overlapping runs of the same
   * session can never ship into the same remote workspace concurrently (one
   * stages while the other waits, then re-checks the cache). Defaults to a
   * shared module-level map; tests pass an isolated map. Entries are ephemeral —
   * cleared as soon as the last waiter for a key finishes staging.
   */
  stagingLocks?: Map<string, Promise<unknown>>;
  adapterType?: string;
  moduleDir?: string;
  packageRootDir?: string;
  /**
   * Adapter-specific billing classification (provider/biller/billingType) for
   * cost-ledger attribution. Without it, results fall back to the opaque
   * "acpx" provider and an "unknown" billing type.
   */
  resolveBillingIdentity?: (
    ctx: AdapterExecutionContext,
  ) => AcpxEngineBillingIdentity | null | Promise<AcpxEngineBillingIdentity | null>;
  /**
   * Per-adapter remote managed-home seed + remap (+ codex copy-back). See
   * {@link AcpxRemoteManagedHomeContext}. Absent → the remote lane stages the
   * workspace with no home asset (PR-1 behavior).
   */
  prepareRemoteManagedHome?: (
    input: AcpxRemoteManagedHomeContext,
  ) => Promise<AcpxRemoteManagedHomeResult>;
  /**
   * Observe the final per-resource disposition report the run records at the end
   * of the attempt (`finalized` vs `transferred`). The coordinator records it on
   * every exit path: the settlement path reports what the settlement decided, and
   * the startup-rollback path reports every rolled-back entry as `finalized`. The
   * engine never reads it back; a test injects this hook to assert the report.
   */
  onSettlementDisposition?: (report: SettlementDispositionReport) => void;
}

interface AcpxPreparedRuntime {
  acpxAgent: string;
  coalescePlaceholderToolUpdates: boolean;
  mode: "persistent" | "oneshot";
  cwd: string;
  // Host-only spawn cwd for the acpx runtime's host `spawn()` of the relay
  // proxy on the remote process-session lane. On that lane `cwd` is the
  // IN-SANDBOX `remoteCwd` (host-nonexistent), so the host proxy must `chdir`
  // into a HOST-valid dir instead — the engine's host `cwd`. `undefined` on
  // every other lane, where acpx falls back to `cwd` (byte-identical). It is
  // deliberately NOT part of the session fingerprint / compat key.
  hostSpawnCwd: string | undefined;
  workspaceId: string;
  workspaceRepoUrl: string;
  workspaceRepoRef: string;
  env: Record<string, string>;
  loggedEnv: Record<string, string>;
  stateDir: string;
  permissionMode: "approve-all" | "approve-reads" | "deny-all";
  nonInteractivePermissions: "deny" | "fail";
  requestedModel: string;
  requestedThinkingEffort: string;
  fastMode: boolean;
  timeoutSec: number;
  timeoutResolution: AdapterExecutionTargetTimeoutResolution;
  sessionKey: string;
  fingerprint: string;
  agentCommand: string | null;
  agentRegistry: AcpAgentRegistry;
  processSessionBridge: AdapterExecutionTargetProcessSessionBridgeHandle | null;
  paperclipBridge: AdapterExecutionTargetPaperclipBridgeHandle | null;
  // The workspace/runtime staged into a runner-backed remote sandbox (null for
  // local runs and the runner-less ACP→CLI fallback). PR 1 stages the workspace
  // + cwd only; the `assetDirs`/`runtimeRootDir`/`restoreWorkspace` it carries
  // are what PR 2 (managed-home seeding + codex copy-back) and PR 3 (session
  // lifecycle re-staging) build on.
  stagedRuntime: PreparedAdapterExecutionTargetRuntime | null;
  // Per-run copy-back hook from the per-adapter remote managed-home seam: runs
  // the codex auth copy-back (via `restoreWorkspace()`). Invoked once on every
  // exit path by the settlement `syncBack` step; it never removes staged temp, so
  // it is safe on every compatible resume. Null for local runs, the runner-less
  // fallback, and adapters with no seam.
  remoteManagedHomeTeardown: (() => Promise<void>) | null;
  // One-time host-side staged-resource cleanup from the seam (remove staged temp
  // dirs). Fired ONLY when the staged runtime is dropped (failed/cancelled/timed
  // -out turn, incompatible re-stage, idle eviction), not on a clean turn that
  // keeps the runtime warm. Null for local runs, the runner-less fallback, and
  // adapters with no disposable temp.
  remoteStagingDispose: (() => Promise<void>) | null;
  // PR 3: for the remote runner-backed lane, the env keys the managed-home seam
  // mutated on this run (or the reused delta on a compatible resume), so the
  // executor can cache/refresh the staged-runtime entry after a clean turn.
  // Null for local runs, the runner-less fallback, and non-remote lanes.
  remoteStagingEnvDelta: Record<string, string> | null;
  // Per-session staging lease held from the initial stage-or-reuse decision
  // through the active turn and released only after bridge cleanup completes.
  // This keeps later overlapping runs from re-staging into the same remote
  // workspace while a prior turn is still using it.
  sessionStagingLeaseRelease: (() => void) | null;
  remoteExecutionIdentity: Record<string, unknown> | null;
  skillPromptInstructions: string;
  skillsIdentity: Record<string, unknown>;
  childStderrLogPath: string | null;
  paperclipClaudeSettings: PaperclipClaudeSettingsResult | null;
  mcpServers: NonNullable<AcpRuntimeOptions["mcpServers"]>;
  mcpIdentity: Array<{ name: string; url: string; connectionId: string }>;
  // Per-step round-trip / provider-duration readers sourced from the sandbox
  // runner's counters (Open Q1). Empty for local runs and the runner-less
  // fallback, where no host→sandbox exec seam exists. Threaded into the
  // `acp.handshake` `measureStartupStep` call in the executor (the other six
  // boundaries live inside `buildRuntime` and read it directly).
  stepMetrics: StartupStepMeasureOptions;
}

const defaultWarmHandles = new Map<string, RuntimeCacheEntry>();
const defaultStagedRuntimes = new Map<string, StagedRuntimeCacheEntry>();
const defaultStagingLocks = new Map<string, Promise<unknown>>();

function resolveEngineSettings(options: AcpxEngineExecutorOptions): AcpxEngineSettings {
  const moduleDir = path.resolve(options.moduleDir ?? defaultModuleDir);
  return {
    adapterType: options.adapterType?.trim() || "acp_engine",
    moduleDir,
    packageRootDir: path.resolve(options.packageRootDir ?? path.resolve(moduleDir, "../..")),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function shortHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);
}

/**
 * Hash the session fingerprint. The builder accepts only a
 * `SessionFingerprintIdentity`, so no company, agent, or task identifier can
 * enter the hash. Those identifiers scope the outer session key only (see
 * `SessionKeyIdentity`).
 */
export function buildSessionFingerprint(identity: SessionFingerprintIdentity): string {
  return shortHash(identity);
}

/**
 * Build the session key from the fingerprint and the outer-key identity. The key
 * form is `paperclip:companyId:agentId:taskKey:fingerprint`.
 */
export function buildSessionKey(identity: SessionKeyIdentity, fingerprint: string): string {
  return `paperclip:${identity.companyId}:${identity.agentId}:${identity.taskKey}:${fingerprint}`;
}

/**
 * Build the single branded launch environment for a run. This is the sole
 * constructor of `LaunchEnvironment`. It applies each contribution into the base
 * env in registration order, then resolves and freezes the launch env.
 *
 * A contribution carries its credential scope. A run-scoped contribution (the
 * run API key, a bridge token) and a session-scoped contribution (the Codex auth
 * copy-back material) both merge here. Neither scope can escape into a reuse
 * payload, because the branded contribution type and the branded environment
 * type forbid it.
 */
export function finalizeLaunchEnvironment(
  baseEnv: Record<string, string>,
  contributions: readonly LaunchEnvironmentContribution[],
): LaunchEnvironment {
  for (const contribution of contributions) {
    Object.assign(baseEnv, contribution.env);
  }
  const env = Object.freeze(resolveRuntimeEnv(baseEnv));
  return { env } as unknown as LaunchEnvironment;
}

// Directory names the staging path never ships for a referenced project (heavy
// build/cache output and git history). The content signature skips them so it
// reflects only the staged tree and never reads their bytes. Keep this set equal
// to the staging excludes in the sandbox and remote runtimes.
const REFERENCED_SOURCE_SIGNATURE_SKIP_DIRS = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".git",
]);

/**
 * Content signature of a referenced-project host tree for the session fingerprint.
 *
 * The staged-runtime cache reuses an already-staged referenced-project tree on a
 * compatible resume and does not re-sync it. Referenced-project metadata (id, host
 * path, workspace id, repo url, pinned ref) can stay identical while the files at
 * that host path change: a branch moved to a new commit, a re-checkout in place, or
 * a dirty worktree. So the metadata identity alone lets a resume serve a stale tree.
 * This signature folds the tree's own content state into the identity.
 *
 * The walk reads each file's relative path and bytes and folds them into the hash.
 * It reads bytes, not only file stats. A stat-only signature (size and modification
 * time) collides when an edit keeps the byte length and the modification time — a
 * re-checkout that restores the same size and timestamp. The byte hash busts on any
 * content change, so the fingerprint busts and the next launch stages the current
 * tree. The walk skips the heavy build, cache, and git directories the staging path
 * never ships, and records a symlink by its target text without following it. On a
 * read error the function returns a stable marker, so the fingerprint does not churn
 * while staging surfaces the real error. The walk runs only when the run carries
 * referenced projects (the multi-project sync path).
 */
async function referencedSourceContentSignature(localPath: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (relative: string): Promise<void> => {
    const current = relative ? path.join(localPath, relative) : localPath;
    const dirents = await fs.readdir(current, { withFileTypes: true });
    dirents.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const dirent of dirents) {
      const next = relative ? path.posix.join(relative, dirent.name) : dirent.name;
      if (dirent.isDirectory()) {
        if (REFERENCED_SOURCE_SIGNATURE_SKIP_DIRS.has(dirent.name)) {
          continue;
        }
        await walk(next);
        continue;
      }
      const absolute = path.join(localPath, next);
      const stats = await fs.lstat(absolute);
      if (stats.isSymbolicLink()) {
        const target = await fs.readlink(absolute);
        hash.update(`symlink:${next}:${target}\n`);
        continue;
      }
      if (!stats.isFile()) {
        hash.update(`other:${next}:${stats.mode}\n`);
        continue;
      }
      hash.update(`file:${next}:${stats.size}\n`);
      hash.update(await fs.readFile(absolute));
      hash.update("\n");
    }
  };
  try {
    await walk("");
  } catch (error) {
    return `unreadable:${String(error)}`;
  }
  return hash.digest("hex").slice(0, 16);
}

function defaultPaperclipInstanceDir(): string {
  const home = process.env.PAPERCLIP_HOME?.trim() || path.join(os.homedir(), ".paperclip");
  const instanceId = process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  return resolvePaperclipInstanceRootForAdapter({
    homeDir: home,
    instanceId,
  });
}

function defaultStateDir(companyId: string, agentId: string): string {
  return path.join(defaultPaperclipInstanceDir(), "companies", companyId, "acp-engine", "agents", agentId);
}

function resolveManagedCodexHomeDir(companyId: string): string {
  return path.join(defaultPaperclipInstanceDir(), "companies", companyId, "codex-home");
}

// Walk up from startDir looking for `node_modules/.bin/<binName>`. This matches
// npm/pnpm binary hoisting in packaged installs while preserving monorepo dev.
export async function findAncestorBin(startDir: string, binName: string): Promise<string | null> {
  let current = path.resolve(startDir);
  while (true) {
    const binDir = path.join(current, "node_modules", ".bin");
    const candidates = process.platform === "win32"
      ? [path.join(binDir, `${binName}.cmd`), path.join(binDir, binName)]
      : [path.join(binDir, binName)];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

interface BuiltInAgentCommand {
  command: string;
  shellCommand: string;
}

async function resolveBuiltInAgentCommand(input: {
  agent: string;
  packageRootDir: string;
  executionTargetIsRemote: boolean;
}): Promise<BuiltInAgentCommand | null> {
  const { agent, packageRootDir, executionTargetIsRemote } = input;
  if (agent === "gemini") {
    return { command: "gemini --acp", shellCommand: "gemini --acp" };
  }
  if (agent === "kimi") {
    // Kimi Code exposes its ACP server via the `kimi acp` subcommand (stdio),
    // rather than a flag (gemini) or a dedicated bin (claude/codex).
    return { command: "kimi acp", shellCommand: "kimi acp" };
  }
  const binName = agent === "claude" ? "claude-agent-acp" : agent === "codex" ? "codex-acp" : null;
  if (!binName) return null;
  if (executionTargetIsRemote) {
    return { command: binName, shellCommand: binName };
  }
  const resolved = (await findAncestorBin(packageRootDir, binName)) ?? binName;
  return { command: resolved, shellCommand: shellQuote(resolved) };
}

const execFileAsync = promisify(execFile);
// Gemini CLI renamed --experimental-acp to --acp in 0.33.0. acpx normally
// rewrites the flag itself, but the agent wrapper script hides the gemini
// command from acpx's detection, so the engine must downgrade it here.
const GEMINI_NATIVE_ACP_FLAG_MIN_VERSION = [0, 33, 0] as const;
const GEMINI_VERSION_PROBE_TIMEOUT_MS = 2000;

export function parseGeminiVersionParts(output: string | null | undefined): number[] | null {
  const match = output?.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function geminiVersionSupportsNativeAcpFlag(parts: number[] | null): boolean {
  if (!parts) return true;
  for (let index = 0; index < GEMINI_NATIVE_ACP_FLAG_MIN_VERSION.length; index += 1) {
    const diff = (parts[index] ?? 0) - GEMINI_NATIVE_ACP_FLAG_MIN_VERSION[index];
    if (diff !== 0) return diff > 0;
  }
  return true;
}

export function rewriteGeminiAcpFlagForVersion(commandShell: string, versionParts: number[] | null): string {
  if (geminiVersionSupportsNativeAcpFlag(versionParts)) return commandShell;
  return commandShell
    .trim()
    .split(/\s+/)
    .map((token) => (token === "--acp" ? "--experimental-acp" : token))
    .join(" ");
}

function geminiAcpCommandTokens(commandShell: string): string[] | null {
  const tokens = commandShell.trim().split(/\s+/);
  const bin = tokens[0];
  if (!bin || bin.startsWith("'") || bin.startsWith('"')) return null;
  if (path.basename(bin) !== "gemini") return null;
  if (!tokens.includes("--acp")) return null;
  return tokens;
}

async function normalizeGeminiAcpCommandShell(commandShell: string, env: NodeJS.ProcessEnv): Promise<string> {
  const tokens = geminiAcpCommandTokens(commandShell);
  if (!tokens) return commandShell;
  let versionParts: number[] | null = null;
  try {
    const { stdout } = await execFileAsync(tokens[0], ["--version"], {
      timeout: GEMINI_VERSION_PROBE_TIMEOUT_MS,
      encoding: "utf8",
      env,
    });
    versionParts = parseGeminiVersionParts(stdout);
  } catch {
    return commandShell;
  }
  return rewriteGeminiAcpFlagForVersion(commandShell, versionParts);
}

function normalizeAgent(config: Record<string, unknown>): string {
  const agent = asString(config.agent, DEFAULT_ACP_ENGINE_AGENT).trim();
  return agent || DEFAULT_ACP_ENGINE_AGENT;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

async function ensureParentDir(target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

async function writeFileAtomically(input: {
  target: string;
  contents: string;
  mode: number;
}): Promise<void> {
  await ensureParentDir(input.target);
  const tempPath = `${input.target}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await fs.open(tempPath, "wx", input.mode);
  try {
    await handle.writeFile(input.contents, "utf8");
    await handle.close();
    await fs.rename(tempPath, input.target);
    await fs.chmod(input.target, input.mode).catch(() => {});
  } catch (err) {
    await handle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function ensureSymlink(target: string, source: string): Promise<void> {
  const resolvedSource = path.resolve(source);
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await ensureParentDir(target);
    await symlinkOrCopyFile(resolvedSource, target);
    return;
  }

  if (!existing.isSymbolicLink()) {
    await fs.rm(target, { recursive: true, force: true });
    await symlinkOrCopyFile(resolvedSource, target);
    return;
  }

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return;

  const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
  if (resolvedLinkedPath === resolvedSource) return;

  await fs.unlink(target);
  await symlinkOrCopyFile(resolvedSource, target);
}

async function symlinkOrCopyFile(source: string, target: string): Promise<void> {
  try {
    await fs.symlink(source, target);
  } catch (err) {
    if (!isErrnoException(err, "EPERM")) throw err;
    await fs.copyFile(source, target);
  }
}

function isErrnoException(err: unknown, code: string): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err && err.code === code;
}

async function ensureCopiedFile(target: string, source: string): Promise<void> {
  if (await pathExists(target)) return;
  await ensureParentDir(target);
  await fs.copyFile(source, target);
}

async function prepareManagedCodexHome(input: {
  companyId: string;
  sourceHome: string;
  targetHome: string;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<string> {
  const { sourceHome, targetHome, onLog } = input;
  if (path.resolve(sourceHome) === path.resolve(targetHome)) return targetHome;

  await fs.mkdir(targetHome, { recursive: true });

  const authJson = path.join(sourceHome, "auth.json");
  if (await pathExists(authJson)) await ensureSymlink(path.join(targetHome, "auth.json"), authJson);

  for (const name of ["config.json", "config.toml", "instructions.md"]) {
    const source = path.join(sourceHome, name);
    if (await pathExists(source)) await ensureCopiedFile(path.join(targetHome, name), source);
  }

  await onLog(
    "stdout",
    `[paperclip] Using Paperclip-managed ACPX Codex home "${targetHome}" (seeded from "${sourceHome}").\n`,
  );
  return targetHome;
}

async function hashPathContents(
  candidate: string,
  hash: ReturnType<typeof createHash>,
  relativePath: string,
  seenDirectories: Set<string>,
): Promise<void> {
  const stat = await fs.lstat(candidate);

  if (stat.isSymbolicLink()) {
    hash.update(`symlink-skipped:${relativePath}\n`);
    return;
  }

  if (stat.isDirectory()) {
    const realDir = await fs.realpath(candidate).catch(() => candidate);
    hash.update(`dir:${relativePath}\n`);
    if (seenDirectories.has(realDir)) {
      hash.update("loop\n");
      return;
    }
    seenDirectories.add(realDir);
    const entries = await fs.readdir(candidate, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelativePath = relativePath.length > 0 ? `${relativePath}/${entry.name}` : entry.name;
      await hashPathContents(path.join(candidate, entry.name), hash, childRelativePath, seenDirectories);
    }
    return;
  }

  if (stat.isFile()) {
    hash.update(`file:${relativePath}\n`);
    hash.update(await fs.readFile(candidate));
    hash.update("\n");
    return;
  }

  hash.update(`other:${relativePath}:${stat.mode}\n`);
}

async function buildSkillSetKey(input: {
  skills: PaperclipSkillEntry[];
  label: string;
}): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`paperclip-acpx-${input.label}-skills:v1\n`);
  const sorted = [...input.skills].sort((left, right) => left.runtimeName.localeCompare(right.runtimeName));
  for (const entry of sorted) {
    hash.update(`skill:${entry.key}:${entry.runtimeName}\n`);
    await hashPathContents(entry.source, hash, entry.runtimeName, new Set<string>());
  }
  return hash.digest("hex");
}

async function resolveSelectedRuntimeSkills(
  config: Record<string, unknown>,
  moduleDir: string,
): Promise<{ allSkills: PaperclipSkillEntry[]; selectedSkills: PaperclipSkillEntry[]; desiredSkillNames: string[] }> {
  const allSkills = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const desiredSkillNames = resolvePaperclipDesiredSkillNames(config, allSkills);
  const desiredSet = new Set(desiredSkillNames);
  return {
    allSkills,
    selectedSkills: allSkills.filter((entry) => desiredSet.has(entry.key)),
    desiredSkillNames,
  };
}

async function prepareClaudeSkillRuntime(input: {
  stateDir: string;
  config: Record<string, unknown>;
  moduleDir: string;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{
  identity: Record<string, unknown>;
  promptInstructions: string;
  commandNotes: string[];
}> {
  const { allSkills, selectedSkills, desiredSkillNames } = await resolveSelectedRuntimeSkills(input.config, input.moduleDir);
  const skillSetKey = await buildSkillSetKey({ skills: selectedSkills, label: "claude" });
  const bundleRoot = path.join(input.stateDir, "runtime-skills", "claude", skillSetKey);
  const skillsHome = path.join(bundleRoot, ".claude", "skills");
  await fs.mkdir(skillsHome, { recursive: true });

  for (const entry of selectedSkills) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      const result = await materializePaperclipSkillCopy(entry.source, target);
      if (result.skippedSymlinks.length > 0) {
        await input.onLog(
          "stdout",
          `[paperclip] Materialized ACPX Claude skill "${entry.runtimeName}" into ${skillsHome} and skipped ${result.skippedSymlinks.length} symlink(s).\n`,
        );
      }
    } catch (err) {
      await input.onLog(
        "stderr",
        `[paperclip] Failed to materialize ACPX Claude skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const selectedNames = selectedSkills.map((entry) => entry.runtimeName).sort();
  const promptInstructions = selectedSkills.length > 0
    ? [
        "Paperclip has materialized selected runtime skills for this ACPX Claude session.",
        `Skill root: ${skillsHome}`,
        selectedNames.length > 0 ? `Selected skills: ${selectedNames.join(", ")}` : "",
        "When a task calls for one of these skills, read its SKILL.md from that root and follow it.",
      ].filter(Boolean).join("\n")
    : "";

  return {
    identity: {
      mode: "claude",
      skillSetKey,
      desiredSkillNames,
      selectedSkills: selectedNames,
      skillRoot: selectedSkills.length > 0 ? skillsHome : null,
    },
    promptInstructions,
    commandNotes: selectedSkills.length > 0
      ? [`Materialized ${selectedSkills.length} Paperclip skill(s) for ACPX Claude at ${skillsHome}.`]
      : [],
  };
}

async function readManagedCodexSkillsManifest(skillsHome: string): Promise<Set<string>> {
  const manifestPath = path.join(skillsHome, PAPERCLIP_MANAGED_CODEX_SKILLS_MANIFEST);
  try {
    const raw = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
    const parsed = parseObject(raw);
    const skills = Array.isArray(parsed.managedSkillNames)
      ? parsed.managedSkillNames.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    return new Set(skills);
  } catch {
    return new Set();
  }
}

async function writeManagedCodexSkillsManifest(skillsHome: string, skillNames: Iterable<string>): Promise<void> {
  const managedSkillNames = Array.from(new Set(skillNames)).sort();
  await fs.writeFile(
    path.join(skillsHome, PAPERCLIP_MANAGED_CODEX_SKILLS_MANIFEST),
    `${JSON.stringify({ version: 1, managedSkillNames }, null, 2)}\n`,
    "utf8",
  );
}

async function removeSkillTarget(target: string): Promise<boolean> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) return false;
  await fs.rm(target, { recursive: true, force: true });
  return true;
}

async function reconcileManagedCodexSkills(input: {
  skillsHome: string;
  allSkills: PaperclipSkillEntry[];
  selectedSkills: PaperclipSkillEntry[];
  onLog: AdapterExecutionContext["onLog"];
}): Promise<void> {
  const desired = new Set(input.selectedSkills.map((entry) => entry.runtimeName));
  const managed = await readManagedCodexSkillsManifest(input.skillsHome);
  const availableByRuntimeName = new Map(input.allSkills.map((entry) => [entry.runtimeName, entry]));

  for (const name of managed) {
    if (desired.has(name)) continue;
    if (await removeSkillTarget(path.join(input.skillsHome, name))) {
      await input.onLog("stdout", `[paperclip] Revoked ACPX Codex skill "${name}" from ${input.skillsHome}\n`);
    }
  }

  for (const entry of input.allSkills) {
    if (desired.has(entry.runtimeName) || managed.has(entry.runtimeName)) continue;
    const target = path.join(input.skillsHome, entry.runtimeName);
    const existing = await fs.lstat(target).catch(() => null);
    if (!existing?.isSymbolicLink()) continue;
    const linkedPath = await fs.readlink(target).catch(() => null);
    if (!linkedPath) continue;
    const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
    if (resolvedLinkedPath !== path.resolve(entry.source)) continue;
    if (await removeSkillTarget(target)) {
      await input.onLog("stdout", `[paperclip] Revoked legacy ACPX Codex skill "${entry.runtimeName}" from ${input.skillsHome}\n`);
    }
  }

  for (const name of managed) {
    if (desired.has(name) || availableByRuntimeName.has(name)) continue;
    if (await removeSkillTarget(path.join(input.skillsHome, name))) {
      await input.onLog("stdout", `[paperclip] Revoked unavailable ACPX Codex skill "${name}" from ${input.skillsHome}\n`);
    }
  }
}

async function prepareCodexSkillRuntime(input: {
  companyId: string;
  config: Record<string, unknown>;
  env: Record<string, string>;
  moduleDir: string;
  onLog: AdapterExecutionContext["onLog"];
  // Step-timing seam: threaded from `buildRuntime` so the nested
  // `skills.reconcile` boundary (step 3) can emit its own `run.startup.step`
  // event at its call-site. Both optional — a caller without an event sink or
  // clock is a plain no-op passthrough (the timing helper guards a missing
  // `onEvent`), so the codex skill prep behaves identically when unmeasured.
  onEvent?: AdapterExecutionContext["onEvent"];
  now?: () => number;
  // Round-trip / provider-duration readers for the nested `skills.reconcile`
  // boundary (Open Q1). Threaded from `buildRuntime` so the step reports the
  // same host→sandbox counters as its siblings (0 here — skill prep is
  // host-only — which is itself the answer to "does this step exec?").
  stepMetrics?: StartupStepMeasureOptions;
}): Promise<{ identity: Record<string, unknown>; commandNotes: string[] }> {
  const now = input.now ?? (() => Date.now());
  const envConfig = parseObject(input.config.env);
  const configuredCodexHome =
    typeof envConfig.CODEX_HOME === "string" && envConfig.CODEX_HOME.trim().length > 0
      ? path.resolve(envConfig.CODEX_HOME.trim())
      : null;
  const sourceCodexHome =
    typeof process.env.CODEX_HOME === "string" && process.env.CODEX_HOME.trim().length > 0
      ? path.resolve(process.env.CODEX_HOME.trim())
      : path.join(os.homedir(), ".codex");
  const managedCodexHome = resolveManagedCodexHomeDir(input.companyId);
  const effectiveCodexHome = configuredCodexHome ??
    await prepareManagedCodexHome({
      companyId: input.companyId,
      sourceHome: sourceCodexHome,
      targetHome: managedCodexHome,
      onLog: input.onLog,
    });
  const { allSkills, selectedSkills, desiredSkillNames } = await resolveSelectedRuntimeSkills(input.config, input.moduleDir);
  const skillSetKey = await buildSkillSetKey({ skills: selectedSkills, label: "codex" });
  const skillsHome = path.join(effectiveCodexHome, "skills");
  await fs.mkdir(skillsHome, { recursive: true });
  // Step 3 — skills.reconcile: nested inside the codex-home seed (step 2), so it
  // emits its own boundary event and span at this call-site. It must NOT add its
  // wall time to the root work sum. The enclosing step 2 wall already covers this
  // interval, so a second `onWallMs` call would count the same milliseconds
  // twice. Drop `onWallMs` for the nested step; keep every other attribution
  // field.
  const nestedStepMetrics: StartupStepMeasureOptions = {
    ...(input.stepMetrics ?? {}),
    onWallMs: undefined,
  };
  await measureStartupStep({ onEvent: input.onEvent }, now, "skills.reconcile", () =>
    reconcileManagedCodexSkills({
      skillsHome,
      allSkills,
      selectedSkills,
      onLog: input.onLog,
    }),
    nestedStepMetrics,
  );

  for (const entry of selectedSkills) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      const result = await materializePaperclipSkillCopy(entry.source, target);
      if (result.skippedSymlinks.length > 0) {
        await input.onLog(
          "stdout",
          `[paperclip] Materialized ACPX Codex skill "${entry.runtimeName}" into ${skillsHome} and skipped ${result.skippedSymlinks.length} symlink(s).\n`,
        );
      }
    } catch (err) {
      await input.onLog(
        "stderr",
        `[paperclip] Failed to inject ACPX Codex skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  await writeManagedCodexSkillsManifest(skillsHome, selectedSkills.map((entry) => entry.runtimeName));

  input.env.CODEX_HOME = effectiveCodexHome;

  return {
    identity: {
      mode: "codex",
      skillSetKey,
      desiredSkillNames,
      selectedSkills: selectedSkills.map((entry) => entry.runtimeName).sort(),
      codexHome: effectiveCodexHome,
      skillsHome,
    },
    commandNotes: [`Prepared ACPX Codex skill home at ${skillsHome}.`],
  };
}

function resolveGeminiSkillsHome(config: Record<string, unknown>): string {
  const envConfig = parseObject(config.env);
  const configuredHome =
    typeof envConfig.HOME === "string" && envConfig.HOME.trim().length > 0
      ? path.resolve(envConfig.HOME.trim())
      : os.homedir();
  return path.join(configuredHome, ".gemini", "skills");
}

async function prepareGeminiSkillRuntime(input: {
  config: Record<string, unknown>;
  moduleDir: string;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{ identity: Record<string, unknown>; commandNotes: string[] }> {
  const { selectedSkills, desiredSkillNames } = await resolveSelectedRuntimeSkills(input.config, input.moduleDir);
  const skillSetKey = await buildSkillSetKey({ skills: selectedSkills, label: "gemini" });
  const skillsHome = resolveGeminiSkillsHome(input.config);
  await fs.mkdir(skillsHome, { recursive: true });

  const allowedSkillNames = selectedSkills.map((entry) => entry.runtimeName);
  const removedSkills = await removeMaintainerOnlySkillSymlinks(skillsHome, allowedSkillNames);
  for (const skillName of removedSkills) {
    await input.onLog("stdout", `[paperclip] Removed maintainer-only ACPX Gemini skill "${skillName}" from ${skillsHome}\n`);
  }

  for (const entry of selectedSkills) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "created" || result === "repaired") {
        await input.onLog(
          "stdout",
          `[paperclip] ${result === "repaired" ? "Repaired" : "Linked"} ACPX Gemini skill "${entry.runtimeName}" into ${skillsHome}\n`,
        );
      }
    } catch (err) {
      if (isErrnoException(err, "EPERM")) {
        const result = await materializePaperclipSkillCopy(entry.source, target);
        await input.onLog(
          "stdout",
          `[paperclip] Copied ACPX Gemini skill "${entry.runtimeName}" into ${skillsHome} because symlinks are unavailable.${result.skippedSymlinks.length > 0 ? ` Skipped ${result.skippedSymlinks.length} nested symlink(s).` : ""}\n`,
        );
        continue;
      }
      await input.onLog(
        "stderr",
        `[paperclip] Failed to link ACPX Gemini skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return {
    identity: {
      mode: "gemini",
      skillSetKey,
      desiredSkillNames,
      selectedSkills: selectedSkills.map((entry) => entry.runtimeName).sort(),
      skillsHome,
    },
    commandNotes: selectedSkills.length > 0
      ? [`Prepared ${selectedSkills.length} ACPX Gemini skill(s) at ${skillsHome}.`]
      : [],
  };
}

function normalizeMode(config: Record<string, unknown>): "persistent" | "oneshot" {
  return asString(config.mode, DEFAULT_ACP_ENGINE_MODE) === "oneshot" ? "oneshot" : "persistent";
}

function normalizePermissionMode(config: Record<string, unknown>): "approve-all" | "approve-reads" | "deny-all" {
  const value = asString(config.permissionMode, DEFAULT_ACP_ENGINE_PERMISSION_MODE).trim();
  if (value === "approve-reads" || value === "deny-all") return value;
  if (value === "default") return "approve-reads";
  return "approve-all";
}

function normalizeNonInteractivePermissions(config: Record<string, unknown>): "deny" | "fail" {
  return asString(config.nonInteractivePermissions, DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS) === "fail"
    ? "fail"
    : "deny";
}

function normalizeRequestedThinkingEffort(config: Record<string, unknown>): string {
  return (
    asString(config.modelReasoningEffort, "") ||
    asString(config.reasoningEffort, "") ||
    asString(config.thinkingEffort, "") ||
    asString(config.effort, "")
  ).trim();
}

function buildCodexStartupConfig(input: {
  existingConfig: string | undefined;
  requestedModel: string;
  requestedThinkingEffort: string;
  fastMode: boolean;
}): { value: string | null; invalidExistingConfig: boolean } {
  const hasRuntimeConfig = Boolean(
    input.requestedModel || input.requestedThinkingEffort || input.fastMode,
  );
  if (!hasRuntimeConfig) return { value: null, invalidExistingConfig: false };

  let existing: Record<string, unknown> = {};
  let invalidExistingConfig = false;
  if (input.existingConfig) {
    try {
      existing = parseObject(JSON.parse(input.existingConfig));
    } catch {
      invalidExistingConfig = true;
      existing = {};
    }
  }

  return {
    value: JSON.stringify({
      ...existing,
      ...(input.requestedModel ? { model: input.requestedModel } : {}),
      ...(input.requestedThinkingEffort
        ? { model_reasoning_effort: input.requestedThinkingEffort }
        : {}),
      ...(input.fastMode
        ? {
            service_tier: "fast",
            features: {
              ...parseObject(existing.features),
              fast_mode: true,
            },
          }
        : {}),
    }),
    invalidExistingConfig,
  };
}

function isCompatibleSession(
  params: Record<string, unknown>,
  runtime: Pick<AcpxPreparedRuntime, "fingerprint" | "sessionKey" | "cwd" | "mode" | "acpxAgent" | "remoteExecutionIdentity">,
): boolean {
  if (asString(params.configFingerprint, "") !== runtime.fingerprint) return false;
  if (asString(params.sessionKey, "") !== runtime.sessionKey) return false;
  if (asString(params.agent, "") !== runtime.acpxAgent) return false;
  if (asString(params.mode, "") !== runtime.mode) return false;
  const savedCwd = asString(params.cwd, "");
  if (!savedCwd || path.resolve(savedCwd) !== path.resolve(runtime.cwd)) return false;
  const savedRemote = parseObject(params.remoteExecution);
  return stableJson(savedRemote) === stableJson(runtime.remoteExecutionIdentity ?? {});
}

function buildSessionParams(input: {
  prepared: AcpxPreparedRuntime;
  handle: AcpRuntimeHandle;
}): Record<string, unknown> {
  const { prepared, handle } = input;
  return {
    sessionKey: prepared.sessionKey,
    runtimeSessionName: handle.runtimeSessionName,
    acpxRecordId: handle.acpxRecordId,
    acpSessionId: handle.backendSessionId,
    agentSessionId: handle.agentSessionId,
    agent: prepared.acpxAgent,
    cwd: prepared.cwd,
    mode: prepared.mode,
    stateDir: prepared.stateDir,
    configFingerprint: prepared.fingerprint,
    ...(prepared.requestedModel ? { model: prepared.requestedModel } : {}),
    ...(prepared.requestedThinkingEffort ? { thinkingEffort: prepared.requestedThinkingEffort } : {}),
    ...(prepared.fastMode ? { fastMode: true } : {}),
    skills: prepared.skillsIdentity,
    mcpServers: prepared.mcpIdentity,
    ...(prepared.workspaceId ? { workspaceId: prepared.workspaceId } : {}),
    ...(prepared.workspaceRepoUrl ? { repoUrl: prepared.workspaceRepoUrl } : {}),
    ...(prepared.workspaceRepoRef ? { repoRef: prepared.workspaceRepoRef } : {}),
    ...(prepared.remoteExecutionIdentity ? { remoteExecution: prepared.remoteExecutionIdentity } : {}),
  };
}

interface PaperclipClaudeSettingsResult {
  filePath: string;
  allow: string[];
  additionalDirectories: string[];
  defaultMode: string;
  overrodeDontAsk: boolean;
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
}

// The Claude Code SDK that `claude-agent-acp` runs uses
// `settingSources: ["user", "project", "local"]`. By writing a per-worktree
// `.claude/settings.local.json` we override the user's potentially-restrictive
// `~/.claude/settings.json` (e.g. `defaultMode: "dontAsk"`, which silently
// denies every non-allowlisted tool and never reaches `canUseTool`), and we
// widen the SDK's Read sandbox to include the Paperclip state dirs the agent
// needs to talk to its own control plane.
async function writePaperclipClaudeSettings(input: {
  cwd: string;
  stateDir: string;
  agentHome: string;
  companyId: string;
}): Promise<PaperclipClaudeSettingsResult> {
  const filePath = path.join(input.cwd, ".claude", "settings.local.json");
  const instanceRoot = defaultPaperclipInstanceDir();
  const companyRoot = path.join(instanceRoot, "companies", input.companyId);
  const paperclipAdditionalDirectories = uniqueSorted([
    input.stateDir,
    input.agentHome,
    companyRoot,
  ]);
  const paperclipAllow = uniqueSorted([
    "Bash(curl:*)",
    "Bash(env:*)",
    "Bash(env)",
    `Bash(${input.cwd}/scripts/paperclip-issue-update.sh:*)`,
    `Bash(${input.cwd}/scripts/paperclip:*)`,
  ]);

  let existing: Record<string, unknown> = {};
  const existingRaw = await fs.readFile(filePath, "utf8").catch(() => null);
  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
    } catch {
      // Malformed settings file — leave it alone in `existing` and our merge will replace it with a valid one.
    }
  }
  const existingPerms =
    existing.permissions && typeof existing.permissions === "object" && !Array.isArray(existing.permissions)
      ? (existing.permissions as Record<string, unknown>)
      : {};
  const existingAllow = Array.isArray(existingPerms.allow)
    ? (existingPerms.allow as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  const existingAdditionalDirectories = Array.isArray(existingPerms.additionalDirectories)
    ? (existingPerms.additionalDirectories as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  const mergedAllow = uniqueSorted([...existingAllow, ...paperclipAllow]);
  const mergedAdditionalDirectories = uniqueSorted([
    ...existingAdditionalDirectories,
    ...paperclipAdditionalDirectories,
  ]);
  const existingDefaultMode =
    typeof existingPerms.defaultMode === "string" ? (existingPerms.defaultMode as string) : "";
  const defaultMode =
    existingDefaultMode && existingDefaultMode !== "dontAsk" ? existingDefaultMode : "default";
  const overrodeDontAsk = existingDefaultMode === "dontAsk";

  const nextPermissions: Record<string, unknown> = {
    ...existingPerms,
    allow: mergedAllow,
    additionalDirectories: mergedAdditionalDirectories,
    defaultMode,
  };
  const next: Record<string, unknown> = { ...existing, permissions: nextPermissions };
  await writeFileAtomically({
    target: filePath,
    contents: `${JSON.stringify(next, null, 2)}\n`,
    mode: 0o600,
  });
  return {
    filePath,
    allow: mergedAllow,
    additionalDirectories: mergedAdditionalDirectories,
    defaultMode,
    overrodeDontAsk,
  };
}

// Cross the CLI's staging seam for a runner-backed remote sandbox: ship the
// workspace (and, in PR 2, the per-adapter managed-home `assets`) into the
// sandbox and obtain the in-sandbox `workspaceRemoteDir` plus the non-null
// `runtimeRootDir`/`assetDirs` the bridges and the home remap consume. This is
// the shared-engine mirror of the CLI lanes (codex/claude/gemini
// `*-local/execute.ts`). PR 1 shipped the workspace + cwd only; PR 2 threads
// the home `assets` (built by the per-adapter `prepareRemoteManagedHome` seam,
// carrying the codex `provision`/`restore` auth seams) through `assets` here so
// `assetDirs.<key>` resolves to the seeded in-sandbox home. The returned
// `restoreWorkspace` fires the per-asset `restore` (codex copy-back) at
// teardown.
async function stageAcpRemoteRuntime(input: {
  runId: string;
  target: AdapterExecutionTarget;
  adapterKey: string;
  workspaceLocalDir: string;
  // Pin the in-sandbox workspace dir so it provably equals the deterministic
  // `sessionCwd` the engine folded into the session fingerprint (PR 3).
  workspaceRemoteDir?: string;
  timeoutSec: number;
  assets?: AdapterManagedRuntimeAsset[];
  // Referenced (additional) projects to stage into the sandbox as plain,
  // read-only trees alongside the anchor workspace. Empty unless run prep
  // resolved referenced projects (gated upstream), so the anchor-only path is
  // unchanged.
  additionalSources?: SandboxAdditionalSource[];
  onLog: AdapterExecutionContext["onLog"];
  onRuntimeProgress: AdapterExecutionContext["onRuntimeProgress"];
  // Optional host span runner for the workspace tarball build. It rides down to
  // prepareSandboxManagedRuntime so the host pack time shows as one `pack` span.
  // The caller passes a runner that parents to the active `stage.sync` step, so
  // the `pack` span nests under `stage.sync`. The default is a no-op.
  runtimeSpan?: RuntimeSpanRunner;
}): Promise<PreparedAdapterExecutionTargetRuntime> {
  await input.onLog(
    "stdout",
    `[paperclip] Syncing workspace to ${describeAdapterExecutionTarget(input.target)}.\n`,
  );
  return await prepareAdapterExecutionTargetRuntime({
    runId: input.runId,
    target: input.target,
    adapterKey: input.adapterKey,
    timeoutSec: input.timeoutSec,
    workspaceLocalDir: input.workspaceLocalDir,
    ...(input.workspaceRemoteDir ? { workspaceRemoteDir: input.workspaceRemoteDir } : {}),
    ...(input.assets && input.assets.length > 0 ? { assets: input.assets } : {}),
    ...(input.additionalSources && input.additionalSources.length > 0
      ? { additionalSources: input.additionalSources }
      : {}),
    onProgress: (line) => input.onLog("stdout", line),
    onRuntimeProgress: input.onRuntimeProgress,
    runtimeSpan: input.runtimeSpan,
  });
}

// Dispose a freshly staged in-sandbox runtime after a managed-home seam threw. The
// seam shipped the workspace/home into the sandbox through `stage()` but threw
// before it could return its `disposeStaged`, so the engine removes the managed
// runtime root here — otherwise the abandoned in-sandbox managed home (with its
// staged credentials) leaks in a persistent sandbox. Fail-open: a cleanup miss on
// an already-failing run is logged and never re-thrown, so it cannot mask the seam
// error.
async function disposeFreshStagedRuntime(input: {
  runId: string;
  target: AdapterExecutionTarget;
  stagedRuntime: PreparedAdapterExecutionTargetRuntime;
  cwd: string;
  timeoutSec: number;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<void> {
  const runtimeRootDir = input.stagedRuntime.runtimeRootDir;
  if (!runtimeRootDir) return;
  try {
    await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.target,
      `rm -rf ${shellQuote(runtimeRootDir)}`,
      {
        cwd: input.cwd,
        env: {},
        timeoutSec: Math.max(input.timeoutSec, 15),
        graceSec: 20,
        onLog: input.onLog,
      },
    );
  } catch (err) {
    await input.onLog(
      "stderr",
      `[paperclip] Failed to dispose the fresh staged runtime after a managed-home seam error: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}

async function buildRuntime(input: {
  ctx: AdapterExecutionContext;
  engine: AcpxEngineSettings;
  deps: AcpxEngineExecutorOptions;
  // The run resource ledger. `executeAcpxEngine` creates the one ledger for the
  // attempt and passes it here, so the sandbox run site registers what it
  // acquires into that single ledger (one ledger until Phase 20 formalizes the
  // coordinator).
  ledger: AcquiredRunResources;
  // The staged-runtime idle bound, in milliseconds. The sandbox run site takes
  // it for its reuse store's idle policy.
  stagedIdleMs: number;
  // The injected tracer, the root-span parent-context token, and the
  // context-builder. Merged into every startup-step option set, so each
  // boundary span parents to the one root span (`sandbox.startup`) that the
  // executor opens, and each step publishes its own child context for an inner
  // exec span to parent to.
  spanParent: Pick<StartupStepMeasureOptions, "tracer" | "parentContext" | "contextWithSpan">;
  // Return the current-run parent-context token. `buildRuntime` threads it into
  // the two remote bridge factories, so a run-time exec from a bridge parents to
  // the live run span (`agent.turn` during the turn, `task.run` otherwise). The
  // run closure passes the run-scoped getter here; when it is absent, each
  // bridge site keeps its earlier unparented run-time behavior.
  getRuntimeParentContext?: () => StartupSpanContext | undefined;
  // Wrap each unit of bridge run-time work in its own named span.
  // `buildRuntime` threads it into the two remote bridge factories, so the
  // socket handler, the poll loop, and the callback worker each open a wrapper
  // span per unit of work. The run closure passes the run-scoped runner here;
  // when it is absent, each bridge site opens no wrapper span.
  runtimeSpan?: RuntimeSpanRunner;
  // Wrap the host workspace tarball build in one `pack` span. Unlike
  // `runtimeSpan`, this runner parents each span to the active startup step, so
  // the `pack` span nests under the `stage.sync` step that runs the staging
  // seam. `buildRuntime` threads it into the staging seam. When it is absent, the
  // staging seam opens no `pack` span.
  stageRuntimeSpan?: RuntimeSpanRunner;
}): Promise<AcpxPreparedRuntime> {
  const { runId, agent, config, context, authToken } = input.ctx;
  // Injectable monotonic clock for per-step startup timing. Hoisted above the
  // first instrumented boundary (step 1 `workspace.resolve`, below) so every
  // `measureStartupStep` call in this function shares one deterministic clock.
  const nowMs = input.deps.now ?? (() => Date.now());
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const secretsContext = parseObject(context.paperclipSecrets);
  const secretManifest = Array.isArray(secretsContext.manifest) ? secretsContext.manifest : [];
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const workspaceBranch = asString(workspaceContext.branchName, "");
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  // Referenced (additional) projects to stage into the sandbox alongside the
  // anchor workspace, read from the workspace realization record. The list is
  // empty unless run prep resolved referenced projects — gated upstream by the
  // multi-project workspace-sync kill-switch — so the anchor-only path is
  // unchanged.
  const realizationContext = parseObject(workspaceContext.realization);
  const additionalSourceRecords = (
    Array.isArray(realizationContext.additional) ? realizationContext.additional : []
  ).map((entry) => parseObject(entry));
  const additionalSources: SandboxAdditionalSource[] = additionalSourceRecords
    .map((entry) => ({ localPath: asString(entry.path, ""), projectId: asString(entry.projectId, "") }))
    .filter((entry) => entry.localPath.length > 0 && entry.projectId.length > 0);
  // Stable identity of the referenced-project set for the session fingerprint.
  // The staged-runtime cache reuses already-staged referenced-project trees on a
  // compatible resume, so the fingerprint must change when the set OR a project's
  // pinned checkout changes. Without this, a resume reuses a stale staged tree.
  // Fold in each project's id, host path, workspace id, and pinned ref; sort by
  // projectId so the identity depends on the set, not the record order.
  const additionalSourcesIdentityBase = additionalSourceRecords
    .map((entry) => ({
      projectId: asString(entry.projectId, ""),
      localPath: asString(entry.path, ""),
      projectWorkspaceId: asString(entry.projectWorkspaceId, ""),
      repoUrl: asString(entry.repoUrl, ""),
      repoRef: asString(entry.repoRef, ""),
    }))
    .filter((entry) => entry.localPath.length > 0 && entry.projectId.length > 0)
    .sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0));
  // Metadata alone does not change on a content-only checkout change (same host
  // path and pinned ref, new file bytes). Fold in each tree's content signature so
  // a file add, remove, or edit busts the fingerprint and the resume re-stages.
  const additionalSourcesIdentity = await Promise.all(
    additionalSourcesIdentityBase.map(async (entry) => ({
      ...entry,
      contentSignature: await referencedSourceContentSignature(entry.localPath),
    })),
  );
  // Referenced-project workspace hints exposed to the agent through PAPERCLIP_WORKSPACES_JSON. The
  // list joins the anchor project's alternative workspaces with the referenced (mentioned) projects.
  // On the confined sandbox lane the run repoints each referenced hint at its staged directory after
  // staging below. Empty unless run prep resolved referenced projects or alternative workspaces.
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: input.ctx.executionTarget,
    legacyRemoteExecution: input.ctx.executionTransport?.remoteExecution,
  });
  const remoteExecutionIdentity = adapterExecutionTargetSessionIdentity(executionTarget);
  const effectiveExecutionCwd =
    remoteExecutionIdentity && typeof remoteExecutionIdentity.remoteCwd === "string"
      ? remoteExecutionIdentity.remoteCwd
      : cwd;
  const executionTargetIsRemote = remoteExecutionIdentity !== null;
  // Merge the injected tracer + root parent-context into every step option set,
  // so each boundary span parents to the root span. With no injected trace
  // context both fields are no-ops and the span path stays inert.
  const stepMetrics: StartupStepMeasureOptions = {
    ...input.spanParent,
  };
  // The two bridge-start steps intentionally overlap. A shared `batch` tag marks
  // the two spans as one parallel batch, and `criticalPath: false` keeps their
  // inner exec spans off the critical path (their wall time overlaps).
  const concurrentBridgeStepMetrics: StartupStepMeasureOptions = {
    ...input.spanParent,
    batch: STARTUP_BRIDGE_BATCH,
    criticalPath: false,
  };
  const shapedWorkspaceEnv = shapePaperclipWorkspaceEnvForExecution({
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceWorktreePath,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  // Step 1 — workspace.resolve: the workspace resolution/fallback chain closes
  // here on the awaited directory materialization.
  await measureStartupStep(input.ctx, nowMs, "workspace.resolve", () =>
    ensureAbsoluteDirectory(cwd, { createIfMissing: true }),
    stepMetrics,
  );

  const acpxAgent = normalizeAgent(config);
  // Run summaries always fail closed to the final output segment so internal
  // thought text and intermediate narration cannot become issue comments.
  const coalescePlaceholderToolUpdates = config.coalescePlaceholderToolUpdates === true;
  const mode = normalizeMode(config);
  const permissionMode = normalizePermissionMode(config);
  const nonInteractivePermissions = normalizeNonInteractivePermissions(config);
  const requestedModel = asString(config.model, "").trim();
  const requestedThinkingEffort = normalizeRequestedThinkingEffort(config);
  const fastMode = acpxAgent === "codex" && config.fastMode === true;
  const runtimeMcpServers = input.ctx.runtimeMcp?.getServers() ?? [];
  const mcpIdentity = runtimeMcpServers.map(({ name, url, connectionId }) => ({
    name,
    url,
    connectionId,
  }));
  const mcpServers: NonNullable<AcpRuntimeOptions["mcpServers"]> = runtimeMcpServers.map((server) => ({
    type: "http",
    name: server.name,
    url: server.url,
    headers: [{ name: "Authorization", value: `Bearer ${server.token}` }],
  }));
  // Resolve the wall-clock timeout through the shared execution-target
  // resolver so sandbox-backed runs pick up the 4h backstop default while
  // local/SSH runs keep the historical "0 = no adapter timeout" behavior.
  const timeoutResolution = resolveAdapterExecutionTargetTimeout(
    executionTarget,
    asNumber(config.timeoutSec, DEFAULT_ACP_ENGINE_TIMEOUT_SEC),
  );
  const timeoutSec = timeoutResolution.timeoutSec;
  const stateDir = path.resolve(asString(config.stateDir, "") || defaultStateDir(agent.companyId, agent.id));
  await fs.mkdir(stateDir, { recursive: true });

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent), PAPERCLIP_RUN_ID: runId };
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    "";
  const wakeReason = typeof context.wakeReason === "string" ? context.wakeReason.trim() : "";
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim()) ||
    "";
  const approvalId = typeof context.approvalId === "string" ? context.approvalId.trim() : "";
  const approvalStatus = typeof context.approvalStatus === "string" ? context.approvalStatus.trim() : "";
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: shapedWorkspaceEnv.workspaceCwd,
    workspaceSource,
    workspaceStrategy,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceBranch,
    workspaceWorktreePath: shapedWorkspaceEnv.workspaceWorktreePath,
    agentHome,
  });
  const shapedEnvConfig = rewriteWorkspaceCwdEnvVarsForExecution({
    env: envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    executionCwd: shapedWorkspaceEnv.workspaceCwd,
    executionTargetIsRemote,
  });
  // Resolved adapter env (plain + server-resolved secret_ref values) that we
  // forward to the spawned agent process. Captured so a stable hash of it can be
  // folded into the session fingerprint below — a change here must invalidate a
  // warm/resumable session so the next launch picks up the latest env. Only
  // user/adapter-configured env flows through this loop; per-wake PAPERCLIP_*
  // runtime vars (PAPERCLIP_RUN_ID, wake/approval ids, ...) were assigned to
  // `env` above and are never present in shapedEnvConfig, so they inherently
  // stay out of the hash and don't reset the session every heartbeat.
  const resolvedAdapterEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(shapedEnvConfig)) {
    if (typeof value !== "string") continue;
    // Runtime PAPERCLIP_* always wins over config: skip a PAPERCLIP_* key that
    // Paperclip has already assigned this run. PAPERCLIP_API_KEY is never
    // accepted from config — the harness-minted run token is the only source.
    // A PAPERCLIP_* key Paperclip did NOT set is stable per-run config, so it
    // applies and feeds the fingerprint hash below.
    if (isForbiddenConfigEnvKey(key)) continue;
    if (isPaperclipRuntimeEnvKey(key) && key in env) continue;
    env[key] = value;
    resolvedAdapterEnv[key] = value;
  }
  if (authToken) env.PAPERCLIP_API_KEY = authToken;
  // For the claude agent, set model via ANTHROPIC_MODEL at startup rather than
  // via session/set_config_option — the ACP server's set_config_option handler
  // validates the value against its internal available-models list and rejects
  // bare model IDs (e.g. "claude-opus-4-7") that don't exactly match a model
  // entry in some versions. ANTHROPIC_MODEL is read during initialization, so
  // it reliably sets the model before any turns are run.
  if (requestedModel && acpxAgent === "claude" && !env.ANTHROPIC_MODEL) {
    env.ANTHROPIC_MODEL = requestedModel;
  }
  if (acpxAgent === "codex") {
    const codexStartupConfig = buildCodexStartupConfig({
      existingConfig: env.CODEX_CONFIG,
      requestedModel,
      requestedThinkingEffort,
      fastMode,
    });
    if (codexStartupConfig.invalidExistingConfig) {
      await input.ctx.onLog(
        "stderr",
        "[paperclip] Ignoring invalid user CODEX_CONFIG while applying runtime Codex settings; expected a JSON object.\n",
      );
    }
    if (codexStartupConfig.value) env.CODEX_CONFIG = codexStartupConfig.value;
  }

  let skillPromptInstructions = "";
  let skillsIdentity: Record<string, unknown> = { mode: "unsupported" };
  const skillCommandNotes: string[] = [];
  let paperclipClaudeSettings: PaperclipClaudeSettingsResult | null = null;
  if (acpxAgent === "claude") {
    const preparedSkills = await prepareClaudeSkillRuntime({
      stateDir,
      config,
      moduleDir: input.engine.moduleDir,
      onLog: input.ctx.onLog,
    });
    skillPromptInstructions = preparedSkills.promptInstructions;
    skillsIdentity = preparedSkills.identity;
    skillCommandNotes.push(...preparedSkills.commandNotes);
    paperclipClaudeSettings = await writePaperclipClaudeSettings({
      cwd,
      stateDir,
      agentHome,
      companyId: agent.companyId,
    });
    skillCommandNotes.push(
      `Wrote Paperclip-managed Claude settings to ${paperclipClaudeSettings.filePath} (defaultMode=${paperclipClaudeSettings.defaultMode}${
        paperclipClaudeSettings.overrodeDontAsk ? "; overrode user dontAsk" : ""
      }, +${paperclipClaudeSettings.additionalDirectories.length} read root(s), +${paperclipClaudeSettings.allow.length} allow rule(s)).`,
    );
  } else if (acpxAgent === "codex") {
    // Step 2 — codex-home.seed: the codex managed-home + skills preparation.
    // The nested skills.reconcile boundary (step 3) is timed inside via the
    // threaded onEvent/now seam.
    const preparedSkills = await measureStartupStep(input.ctx, nowMs, "codex-home.seed", () =>
      prepareCodexSkillRuntime({
        companyId: agent.companyId,
        config,
        env,
        moduleDir: input.engine.moduleDir,
        onLog: input.ctx.onLog,
        onEvent: input.ctx.onEvent,
        now: nowMs,
        stepMetrics,
      }),
      stepMetrics,
    );
    skillsIdentity = preparedSkills.identity;
    skillCommandNotes.push(...preparedSkills.commandNotes);
  } else if (acpxAgent === "gemini") {
    const preparedSkills = await prepareGeminiSkillRuntime({
      config,
      moduleDir: input.engine.moduleDir,
      onLog: input.ctx.onLog,
    });
    skillsIdentity = preparedSkills.identity;
    skillCommandNotes.push(...preparedSkills.commandNotes);
  } else {
    const desired = resolvePaperclipDesiredSkillNames(
      config,
      await readPaperclipRuntimeSkillEntries(config, input.engine.moduleDir),
    );
    skillsIdentity = { mode: "custom_unsupported", desiredSkillNames: desired };
    if (desired.length > 0) {
      skillCommandNotes.push("Selected Paperclip skills are tracked only; ACPX custom commands do not expose a runtime skill contract yet.");
    }
  }

  const configuredCommand = asString(config.agentCommand, "").trim();
  const builtInCommand = await resolveBuiltInAgentCommand({
    agent: acpxAgent,
    packageRootDir: input.engine.packageRootDir,
    executionTargetIsRemote,
  });
  let agentCommand = configuredCommand || builtInCommand?.command || null;
  let agentCommandShell = configuredCommand || builtInCommand?.shellCommand || "";
  if (acpxAgent === "gemini" && agentCommandShell) {
    const normalized = await normalizeGeminiAcpCommandShell(
      agentCommandShell,
      ensurePathInEnv({ ...process.env, ...env }),
    );
    if (normalized !== agentCommandShell) {
      agentCommandShell = normalized;
      agentCommand = normalized;
    }
  }
  const childStderrDir = path.join(stateDir, "run-stderr");
  const childStderrLogPath = agentCommand ? path.join(childStderrDir, `${runId}.log`) : null;
  // A runner-backed remote sandbox is the only lane that crosses the staging
  // seam: the runner-less ACP→CLI fallback (no `runner`) and local runs keep
  // their historical behavior untouched. This is the single gate shared by the
  // workspace stage and both sandbox bridges.
  const useRemoteProcessSession =
    executionTarget?.kind === "remote" &&
    executionTarget.transport === "sandbox" &&
    Boolean(executionTarget.runner) &&
    Boolean(agentCommandShell);
  // Stream the agent output through the persistent session log stream instead of
  // the host output-file poll. The decision comes from the effective capability
  // snapshot alone: the provider must declare and verify incremental session
  // output. `incrementalSessionOutput` is an opt-in capability, so a generic
  // one-shot provider that keeps persistent process sessions and runs independent
  // control commands, yet never emits incremental session output, keeps the poll
  // path. The snapshot resolves this key false when it is absent, undeclared, or
  // capability resolution failed, so this fails closed to the poll path.
  const streamAgentSessionOutput =
    executionTarget?.kind === "remote" &&
    executionTarget.transport === "sandbox" &&
    executionTarget.effectiveCapabilities?.incrementalSessionOutput === true;
  // The ACP `session/new` cwd and every cwd-keyed session-state site
  // (fingerprint, compat, persist, ensureSession, error) bind to THIS single
  // value so a warm/resumable session created with the in-sandbox cwd is reused
  // — not invalidated — on the next run. Remote runner-backed → the in-sandbox
  // workspace dir; local and the runner-less fallback → the HOST cwd,
  // byte-identical to today.
  //
  // PR 3: the staging transport derives the in-sandbox workspace dir
  // deterministically from the target's `remoteCwd` (it is exactly `remoteCwd`
  // for the sandbox transport), so we resolve `sessionCwd` — and therefore the
  // session fingerprint / cache key — BEFORE staging. That lets a compatible
  // resume decide to reuse an already-staged runtime instead of re-shipping the
  // workspace / re-seeding the managed home. The stage call below pins its
  // `workspaceRemoteDir` to this same value, so the staged cwd can never
  // diverge from the cwd that fed the fingerprint.
  const sessionCwd =
    useRemoteProcessSession && executionTarget?.kind === "remote"
      ? executionTarget.remoteCwd
      : cwd;
  // The 17 fields the session fingerprint hashes. Company, agent, and task
  // identifiers are NOT here; they scope the outer session key only (see
  // `keyIdentity`). The fingerprint builder accepts only this identity.
  const fingerprintIdentity: SessionFingerprintIdentity = {
    acpxAgent,
    agentCommand: agentCommand ?? acpxAgent,
    cwd: path.resolve(sessionCwd),
    mode,
    permissionMode,
    nonInteractivePermissions,
    requestedModel,
    requestedThinkingEffort,
    fastMode,
    remoteExecutionIdentity,
    // Referenced-project set + pinned-checkout identity. A change here (a project
    // added, removed, or re-pinned) invalidates a warm/resumable session so the
    // next launch stages the current referenced-project trees instead of reusing
    // a stale staged tree.
    additionalSourcesIdentity: additionalSourcesIdentity as unknown as Record<string, unknown>,
    skillsIdentity,
    skillPromptInstructions,
    paperclipClaudeSettings: paperclipClaudeSettings
      ? {
          allow: paperclipClaudeSettings.allow,
          additionalDirectories: paperclipClaudeSettings.additionalDirectories,
          defaultMode: paperclipClaudeSettings.defaultMode,
        }
      : null,
    mcpServers: mcpIdentity,
    secretManifestHash: shortHash(secretManifest),
    // Fold the resolved adapter env (all applied user-configured values —
    // plain, secret_ref, and stable PAPERCLIP_* config such as an explicit
    // PAPERCLIP_API_KEY) into the fingerprint so a change to any forwarded value
    // invalidates a warm handle / resumable session and forces a fresh launch
    // that sources the latest env. secretManifestHash alone misses plain-value
    // edits and same-version secret rotations. Per-wake runtime vars never enter
    // resolvedAdapterEnv, so they don't churn the fingerprint every heartbeat.
    adapterEnvHash: shortHash(resolvedAdapterEnv),
  };
  const fingerprint = buildSessionFingerprint(fingerprintIdentity);
  const taskKey = asString(input.ctx.runtime.taskKey, "") || wakeTaskId || workspaceId || "default";
  // Company, agent, and task identity for the outer session key. These parts
  // stay out of the fingerprint hash.
  const keyIdentity: SessionKeyIdentity = {
    companyId: agent.companyId,
    agentId: agent.id,
    taskKey,
  };
  const sessionKey = buildSessionKey(keyIdentity, fingerprint);

  // Ship the workspace into the sandbox and capture `{ workspaceRemoteDir,
  // runtimeRootDir, assetDirs, restoreWorkspace }`. Done once here, before the
  // bridges, so both bridges receive the real (non-null) `runtimeRootDir`.
  //
  // PR 2: on the remote lane, delegate staging to the per-adapter
  // `prepareRemoteManagedHome` seam when the adapter supplies one. The seam
  // ships the adapter's managed home as an `assets` entry (through the `stage`
  // callback = `stageAcpRemoteRuntime`), repoints the home env var (`env`) onto
  // the in-sandbox `assetDirs.*` path, and returns a `teardown` (per-run codex
  // auth copy-back via `restoreWorkspace()`) plus a `disposeStaged` (one-time
  // staged-temp cleanup). Without a seam (custom agents / shared-engine tests)
  // the engine stages the workspace with no home asset — identical to PR-1.
  //
  // PR 3 (stage once per session): a COMPATIBLE resume whose fingerprint matches
  // this exact `sessionKey` reuses the already-staged in-sandbox runtime — no
  // workspace re-ship, no home re-seed — while an incompatible fingerprint (a
  // different key) misses the cache and stages fresh. The `sessionKey`
  // (`companyId:agentId:taskKey:fingerprint`) is the single scoping key, so one
  // session can never read another session's staged credentials. The cache is
  // populated by the executor only after a clean turn and dropped on
  // failure/cancel/timeout, so it always holds a known-good staged runtime.
  //
  // Two guards close the concurrency / cross-session windows Greptile flagged:
  //   * Compatibility gate: reuse only when the supplied session params actually
  //     resume THIS staged session (the same `isCompatibleSession` predicate the
  //     warm-handle path uses). A fresh invocation with missing/cleared
  //     `sessionParams` starts a new ACP session via `session/new`, so it must
  //     NOT inherit the prior session's staged home/credentials — it stages
  //     fresh even when company/agent/task/fingerprint (and hence sessionKey)
  //     collide.
  //   * Per-key staging lock: the stage-or-reuse decision runs under a
  //     `sessionKey` mutex so two overlapping runs of the same session can never
  //     ship into the same remote workspace at once (the loser waits, then
  //     re-checks the cache before deciding).
  const stagedRuntimes = input.deps.stagedRuntimes ?? defaultStagedRuntimes;
  const stagingLocks = input.deps.stagingLocks ?? defaultStagingLocks;
  const previousParams = parseObject(input.ctx.runtime.sessionParams);
  const isCompatibleResume = isCompatibleSession(previousParams, {
    fingerprint,
    sessionKey,
    cwd: sessionCwd,
    mode,
    acpxAgent,
    remoteExecutionIdentity,
  });
  let stagedRuntime: PreparedAdapterExecutionTargetRuntime | null = null;
  let remoteManagedHomeTeardown: (() => Promise<void>) | null = null;
  let remoteStagingDispose: (() => Promise<void>) | null = null;
  let remoteStagingEnvDelta: Record<string, string> | null = null;
  let sessionStagingLeaseRelease: (() => void) | null = null;
  // The sandbox run site owns the sandbox lane's staging, the per-session
  // staging lease, both host-side bridges, the launch-environment contribution,
  // and sync-back. `buildRuntime` injects the leaf primitives (the workspace
  // stage call, the managed-home seam, the two bridge starts, the step timers,
  // and the launch-env finalizer) and reads the site's results back onto the
  // prepared-runtime fields, so the existing settlement path stays unchanged.
  let sandboxSite: SandboxRunSite | null = null;
  if (useRemoteProcessSession && executionTarget?.kind === "remote") {
    const remoteTarget = executionTarget;
    sandboxSite = createSandboxRunSite({
      ledger: input.ledger,
      stagedRuntimes,
      stagingLocks,
      now: nowMs,
      idleMs: input.stagedIdleMs,
      sessionCwd,
      spawnCwd: cwd,
      target: remoteTarget,
      env,
      isCompatibleResume,
      stage: (assets) =>
        stageAcpRemoteRuntime({
          runId,
          target: remoteTarget,
          adapterKey: input.engine.adapterType,
          workspaceLocalDir: cwd,
          workspaceRemoteDir: sessionCwd,
          timeoutSec,
          assets,
          additionalSources,
          onLog: input.ctx.onLog,
          onRuntimeProgress: input.ctx.onRuntimeProgress,
          runtimeSpan: input.stageRuntimeSpan,
        }),
      seedManagedHome: input.deps.prepareRemoteManagedHome
        ? async (stage) => {
            const seeded = await input.deps.prepareRemoteManagedHome!({
              acpxAgent,
              companyId: agent.companyId,
              runId,
              config,
              executionTarget: remoteTarget,
              workspaceLocalDir: cwd,
              timeoutSec,
              env,
              onLog: input.ctx.onLog,
              onRuntimeProgress: input.ctx.onRuntimeProgress,
              stage,
            });
            return {
              stagedRuntime: seeded.stagedRuntime,
              teardown: seeded.teardown ?? null,
              dispose: seeded.disposeStaged ?? null,
            };
          }
        : undefined,
      disposeFreshStagedRuntime: (freshStagedRuntime) =>
        disposeFreshStagedRuntime({
          runId,
          target: remoteTarget,
          stagedRuntime: freshStagedRuntime,
          cwd: sessionCwd,
          timeoutSec,
          onLog: input.ctx.onLog,
        }),
      measureStageStep: (run) => measureStartupStep(input.ctx, nowMs, "stage.sync", run, stepMetrics),
      publishStagedProjectHints: (stagedProjectDirs) => {
        const shapedHints = shapePaperclipWorkspaceEnvForExecution({
          workspaceCwd: effectiveWorkspaceCwd,
          workspaceWorktreePath,
          workspaceHints,
          executionTargetIsRemote,
          executionCwd: effectiveExecutionCwd,
          stagedProjectDirs,
        }).workspaceHints;
        if (shapedHints.length > 0) {
          env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(shapedHints);
        }
      },
      onReuseLog: () =>
        input.ctx.onLog(
          "stdout",
          "[paperclip] Reusing the staged in-sandbox runtime for this resumed session (no workspace re-ship / managed-home re-seed).\n",
        ),
      startPaperclipBridge: (runtimeRootDir) =>
        startAdapterExecutionTargetPaperclipBridge({
          runId,
          target: { ...remoteTarget, streamRunLogs: false },
          runtimeRootDir,
          adapterKey: input.engine.adapterType,
          timeoutSec,
          hostApiToken: env.PAPERCLIP_API_KEY,
          enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(remoteTarget),
          duplexTelemetryRecorder: adapterExecutionTargetDuplexTelemetryRecorder(remoteTarget),
          onLog: input.ctx.onLog,
          getRuntimeParentContext: input.getRuntimeParentContext,
          runtimeSpan: input.runtimeSpan,
        }),
      startProcessSessionBridge: ({ runtimeRootDir, launchEnv }) =>
        startAdapterExecutionTargetProcessSessionBridge({
          runId,
          target: remoteTarget,
          runtimeRootDir,
          adapterKey: input.engine.adapterType,
          command: "sh",
          args: ["-lc", `exec ${agentCommandShell}`],
          cwd: sessionCwd,
          env: launchEnv,
          timeoutSec,
          onLog: input.ctx.onLog,
          getRuntimeParentContext: input.getRuntimeParentContext,
          runtimeSpan: input.runtimeSpan,
          streamOutputViaSession: streamAgentSessionOutput,
        }),
      measureBridgeStep: (step, run) =>
        measureStartupStep(input.ctx, nowMs, step, run, concurrentBridgeStepMetrics),
      finalizeLaunchEnv: (contributions) => finalizeLaunchEnvironment(env, contributions).env,
      onPaperclipBridgeLog: () =>
        input.ctx.onLog("stdout", "[paperclip] Sandbox ACP API callback bridge enabled for this run.\n"),
      stopBridges: async ({ controlBridge, agentBridge }) => {
        await Promise.allSettled([agentBridge?.stop(), controlBridge?.stop()]);
        if (remoteManagedHomeTeardown) {
          await remoteManagedHomeTeardown().catch(() => {});
        }
      },
    });
    // Place the workspace (stage fresh or reuse the already-staged runtime) under
    // the per-session staging lease, then read the staged result back onto the
    // prepared-runtime fields the settlement path consumes.
    const placeWorkspaceStart = nowMs();
    await sandboxSite.placeWorkspace({ sessionKey } as unknown as AcpRunContext);
    await emitRunPhaseTiming(input.ctx, "place_workspace", nowMs() - placeWorkspaceStart, "ok");
    const placedStaged = sandboxSite.staged;
    stagedRuntime = placedStaged?.stagedRuntime ?? null;
    remoteManagedHomeTeardown = placedStaged?.teardown ?? null;
    remoteStagingDispose = placedStaged?.dispose ?? null;
    remoteStagingEnvDelta = placedStaged?.envDelta ?? null;
    sessionStagingLeaseRelease = sandboxSite.stagingLeaseRelease;
  }
  // Both bridge starts run under one try so a failure at EITHER — including the
  // paperclip callback bridge — fires the same abandon-path cleanup. The
  // paperclip bridge starts after the workspace + managed home were already
  // staged and the per-session staging lease is already held, so leaving it
  // outside the catch would strand the lease (and the staged temp) on a
  // start failure and deadlock the next run of this session.
  let paperclipBridge: AdapterExecutionTargetPaperclipBridgeHandle | null = null;
  let processSessionBridge: AdapterExecutionTargetProcessSessionBridgeHandle | null = null;
  let runtimeEnv: Record<string, string> = {};
  const startTransportStart = nowMs();
  try {
    if (useRemoteProcessSession && sandboxSite) {
      // The sandbox run site brings up both host-side bridges concurrently, keeps
      // the one paperclip-env → process-session-launch dependency at a single
      // sequencing point, settles both starts, and returns the started handles
      // plus the finalized launch env. On a partial failure it stops nothing and
      // rethrows; the catch below stops whichever bridge the site started.
      const transport = await sandboxSite.startTransport({ sessionKey } as unknown as AcpRunContext);
      paperclipBridge = transport.controlBridge;
      processSessionBridge = transport.agentBridge;
      runtimeEnv = transport.launchEnv;
      await emitRunPhaseTiming(input.ctx, "start_transport", nowMs() - startTransportStart, "ok");
    } else {
      // Local / runner-less lanes never start a bridge, so they add no
      // contribution. `finalizeLaunchEnvironment` still produces the one branded
      // launch env the prepared runtime and the log builder read.
      runtimeEnv = finalizeLaunchEnvironment(env, []).env;
    }
  } catch (err) {
    // On a partial concurrent bring-up failure, ONE bridge may have started while
    // the other threw; `Promise.allSettled` stops whichever started so no live
    // bridge leaks (mirrors the settlement `stopTransport` step). The site sets its
    // started bridges before it rethrows, so read them from the site here (the
    // local handles stay null when `startTransport` throws before it returns).
    const startedControl = sandboxSite?.controlBridge ?? paperclipBridge;
    const startedAgent = sandboxSite?.agentBridge ?? processSessionBridge;
    await Promise.allSettled([startedControl?.stop(), startedAgent?.stop()]);
    // The staged home / copy-back teardown must run even if a bridge fails to
    // start after the workspace + managed home were already staged into the
    // sandbox, so a refreshed credential is copied back on this error path too.
    // This run never reaches the executor, so also fire the one-time staged-temp
    // dispose here (it no longer rides the per-run copy-back) — the run is being
    // abandoned, so its staged temp must be released — and release the per-session
    // staging lease so the abandoned run does not strand the next same-session run
    // (the run root `finally`, which normally releases it, is never reached here).
    //
    // Route the dispose through the same ownership-guarded removal
    // `discardStagedRuntime` uses. When this run BORROWED the cached staged runtime
    // (a compatible resume), the dispose releases the shared host staged-temp, so
    // the map entry must go too — otherwise a later resume reuses an entry whose
    // temp is already gone. The identity guard removes the entry only when the map
    // still holds this exact staged runtime, so a fresh stage (no cache entry) and
    // a concurrent run's entry are both left untouched.
    await remoteManagedHomeTeardown?.().catch(() => {});
    await releaseStagedRuntimeEntry({
      handles: stagedRuntimes,
      sessionKey,
      stagedRuntime,
      dispose: remoteStagingDispose,
    });
    sessionStagingLeaseRelease?.();
    await emitRunPhaseTiming(input.ctx, "start_transport", nowMs() - startTransportStart, "failed");
    throw err;
  }
  const overrideCommand = processSessionBridge?.agentCommand ?? agentCommand;
  const overrides = overrideCommand ? { [acpxAgent]: overrideCommand } : undefined;
  const agentRegistry = createAgentRegistry({ overrides });
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand: agentCommand ?? acpxAgent,
  });

  return {
    acpxAgent,
    coalescePlaceholderToolUpdates,
    mode,
    // Remote runner-backed → the in-sandbox workspace dir; local / runner-less
    // → the HOST cwd (`sessionCwd` resolves both). Every cwd-keyed session site
    // reads `prepared.cwd`, so binding it once here keeps them consistent.
    cwd: sessionCwd,
    // Only the remote process-session lane needs the host proxy's `spawn()`
    // `chdir` redirected off the in-sandbox `sessionCwd` and onto the host
    // `cwd` (which is where the workspace was staged FROM, so it is host-valid).
    // Every other lane leaves it `undefined` → acpx falls back to `cwd`.
    hostSpawnCwd: useRemoteProcessSession ? cwd : undefined,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    loggedEnv,
    stateDir,
    permissionMode,
    nonInteractivePermissions,
    requestedModel,
    requestedThinkingEffort,
    fastMode,
    timeoutSec,
    timeoutResolution,
    sessionKey,
    fingerprint,
    agentCommand,
    agentRegistry,
    processSessionBridge,
    paperclipBridge,
    stagedRuntime,
    remoteManagedHomeTeardown,
    remoteStagingDispose,
    remoteStagingEnvDelta,
    sessionStagingLeaseRelease,
    remoteExecutionIdentity,
    skillPromptInstructions,
    skillsIdentity: {
      ...skillsIdentity,
      commandNotes: skillCommandNotes,
    },
    childStderrLogPath,
    paperclipClaudeSettings,
    mcpServers,
    mcpIdentity,
    stepMetrics,
  };
}

function sessionConfigOptions(prepared: AcpxPreparedRuntime): Array<{ key: string; value: string }> {
  const options: Array<{ key: string; value: string }> = [];
  // Claude and Codex runtime config is pre-set via startup env vars; skip
  // set_config_option to avoid ACP-server picker validation rejecting valid
  // backend model IDs that are not advertised by the local ACP server.
  if (
    prepared.requestedModel &&
    prepared.acpxAgent !== "claude" &&
    prepared.acpxAgent !== "codex"
  ) {
    options.push({ key: "model", value: prepared.requestedModel });
  }
  if (prepared.requestedThinkingEffort && prepared.acpxAgent !== "codex") {
    options.push({
      key: "effort",
      value: prepared.requestedThinkingEffort,
    });
  }
  if (prepared.fastMode && prepared.acpxAgent !== "codex") {
    options.push(
      { key: "service_tier", value: "fast" },
      { key: "features.fast_mode", value: "true" },
    );
  }
  return options;
}

async function applySessionConfigOptions(input: {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  prepared: AcpxPreparedRuntime;
  onLog: AdapterExecutionContext["onLog"];
}) {
  const options = sessionConfigOptions(input.prepared);
  if (options.length === 0) return;
  if (!input.runtime.setConfigOption) {
    const message =
      "ACPX runtime does not expose session config controls; upgrade ACPX or remove configured model, effort, and fast mode overrides.";
    await input.onLog("stderr", `[paperclip] ${message}\n`);
    throw new Error(message);
  }
  for (const option of options) {
    await input.runtime.setConfigOption({
      handle: input.handle,
      key: option.key,
      value: option.value,
    });
    await input.onLog(
      "stdout",
      `[paperclip] Applied ACPX ${input.prepared.acpxAgent} config ${option.key}=${option.value}\n`,
    );
  }
}

/**
 * Build the process-session launch env: the host env overlaid with the run's
 * `env` (so the merged paperclip bridge vars win) and a guaranteed `PATH`,
 * narrowed to string values. Shared by the remote concurrent bring-up and the
 * local / runner-less lane so both resolve the runtime env identically.
 */
function resolveRuntimeEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

// Stop both host-side bridges in one `allSettled`. This is the settlement
// `stopTransport` effect. The bridge tokens are run-scoped, so they die with the
// bridges here (Amendment B).
async function stopRunTransport(prepared: AcpxPreparedRuntime): Promise<void> {
  await Promise.allSettled([
    prepared.processSessionBridge?.stop(),
    prepared.paperclipBridge?.stop(),
  ]);
}

// The site sync-back. This is the settlement `syncBack` effect. It runs AFTER the
// bridges stop (mirrors the CLI finally: stop bridge → restore workspace). It
// fires the codex auth copy-back via `restoreWorkspace()` and removes staged temp
// dirs. The seam logs and swallows its own failures — an unclean-teardown
// copy-back miss is the accepted, loud `refresh_token_reused` residual on the
// next host Codex use, never silent HOST-credential corruption — so a teardown
// fault never masks or fails the run result here.
async function syncBackManagedHome(prepared: AcpxPreparedRuntime): Promise<void> {
  if (prepared.remoteManagedHomeTeardown) {
    await prepared.remoteManagedHomeTeardown().catch(() => {});
  }
  // The per-session staging lease does NOT release here. The settlement releases
  // it last, in its own `finally`, so a same-session second run cannot re-stage
  // until this run fully settles and the caller observes the result.
}

/** How the settlement `endSession` step releases the runtime a run acquired. */
interface RuntimeSettlementPlan {
  // "direct" closes the runtime itself and swallows or records the close error;
  // "warm_or_close" prefers a matching warm entry (which also flushes its stderr).
  readonly mode: "direct" | "warm_or_close";
  readonly handle: AcpRuntimeHandle;
  readonly reason: string;
  readonly discardPersistentState: boolean;
  // Drop a matching warm entry after a direct close (the pre-turn and turn-error
  // paths remove a warm-hit entry that failed).
  readonly dropWarmEntry: boolean;
  // Record a direct-close error to the run log; a warm_or_close error is
  // swallowed. This keeps today's split (the failure paths log, the turn path
  // swallows).
  readonly recordCloseError: boolean;
  // Cancel the running turn with this reason before the close (the turn-error
  // path cancels before it closes). Null on every other path.
  readonly cancelTurnReason: string | null;
}

function renderPaperclipEnvNote(env: Record<string, string>): string {
  const paperclipKeys = Object.keys(env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort();
  if (paperclipKeys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in this run: ${paperclipKeys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
  ].join("\n");
}

function renderApiAccessNote(env: Record<string, string>): string {
  if (!env.PAPERCLIP_API_URL || !env.PAPERCLIP_API_KEY) return "";
  const lines = [
    "Paperclip API access note:",
    "Use terminal commands with curl to make Paperclip API requests.",
    "Normalize the base URL before adding API paths:",
    `  PAPERCLIP_API_BASE="\${PAPERCLIP_API_URL%/}"; PAPERCLIP_API_BASE="\${PAPERCLIP_API_BASE%/api}"`,
    "GET example:",
    `  curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$PAPERCLIP_API_BASE/api/agents/me"`,
  ];
  if (env.PAPERCLIP_TASK_ID) {
    lines.push(
      "Scoped issue comment example:",
      `  curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" -d '{"body":"Status update from agent."}' "$PAPERCLIP_API_BASE/api/issues/$PAPERCLIP_TASK_ID/comments"`,
    );
  } else {
    lines.push("Use a real issue id from the current context before making issue write requests.");
  }
  return lines.join("\n");
}

async function buildPrompt(ctx: AdapterExecutionContext, resumedSession: boolean, env: Record<string, string>): Promise<{
  prompt: string;
  promptMetrics: Record<string, number>;
  commandNotes: string[];
}> {
  const { agent, runId, config, context, onLog } = ctx;
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  const commandNotes: string[] = [];
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
      commandNotes.push(
        `Loaded agent instructions from ${instructionsFilePath}`,
        `Prepended instructions + path directive to the ACPX prompt (relative references from ${instructionsDir}).`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
      commandNotes.push(`Configured instructionsFilePath ${instructionsFilePath}, but file could not be read.`);
    }
  }

  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !resumedSession && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const taskContextNote = selectPaperclipTaskMarkdown(context, { resumedSession });
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession,
    // The task-context markdown is the authoritative brief on this lane; keep
    // the wake prompt's description copy out so the prompt carries it once.
    suppressIssueDescription: taskContextNote.length > 0,
  });
  const shouldUseResumeDeltaPrompt = resumedSession && wakePrompt.length > 0;
  const promptInstructionsPrefix = shouldUseResumeDeltaPrompt ? "" : instructionsPrefix;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const paperclipEnvNote = renderPaperclipEnvNote(env);
  const apiAccessNote = renderApiAccessNote(env);
  const prompt = joinPromptSections([
    promptInstructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
    paperclipEnvNote,
    apiAccessNote,
    renderedPrompt,
  ]);

  return {
    prompt,
    commandNotes,
    promptMetrics: {
      promptChars: prompt.length,
      instructionsChars: promptInstructionsPrefix.length,
      bootstrapPromptChars: renderedBootstrapPrompt.length,
      wakePromptChars: wakePrompt.length,
      sessionHandoffChars: sessionHandoffNote.length,
      taskContextChars: taskContextNote.length,
      runtimeNoteChars: paperclipEnvNote.length + apiAccessNote.length,
      heartbeatPromptChars: renderedPrompt.length,
    },
  };
}

async function emitAcpxLog(ctx: AdapterExecutionContext, payload: Record<string, unknown>) {
  await ctx.onLog("stdout", `${JSON.stringify(payload)}\n`);
}

/**
 * Build the short run summary that Paperclip may auto-post as an issue comment
 * when the agent leaves no comment of its own.
 *
 * Prefer the last non-empty *output* segment after a tool call. Intermediate
 * "let me check…" narration between tools must not become a 50k-char dump.
 * Thought-stream text is never included (callers must not push it into segments).
 */
export function buildAcpxRunSummary(input: {
  outputSegments: string[];
  fallback?: string | null;
}): string {
  for (let i = input.outputSegments.length - 1; i >= 0; i -= 1) {
    const text = (input.outputSegments[i] ?? "").trim();
    if (text) return text;
  }
  const fallback = (input.fallback ?? "").trim();
  return fallback;
}

// acpx substitutes a literal "tool call" title when an ACP tool_call_update
// omits one, which would persist a generic name over the real one ("Terminal",
// "Read", …) in the stored run log. Remember each call's real title so update
// lines keep the name durably. Some ACP backends also stream partial tool
// arguments as one in-progress update per token under this placeholder;
// adapters that opt into coalescePlaceholderToolUpdates in their acpx config
// have those updates coalesced until a real title is available.
const GENERIC_ACP_TOOL_TITLE = "tool call";

async function emitRuntimeEvent(
  ctx: AdapterExecutionContext,
  event: AcpRuntimeEvent,
  toolTitles?: Map<string, string>,
  coalescePlaceholderToolUpdates?: boolean,
) {
  if (event.type === "text_delta") {
    await emitAcpxLog(ctx, {
      type: "acpx.text_delta",
      text: event.text,
      channel: event.stream === "thought" ? "thought" : "output",
      tag: event.tag,
    });
    return;
  }
  if (event.type === "tool_call") {
    // Coalesce token-by-token argument streaming for adapters that opt in via
    // their acpx config: skip in-progress updates that still carry only the
    // unresolved placeholder title. Backends that stream tool arguments
    // otherwise emit tens of thousands of these per run, flooding the
    // transcript and pinning the live activity indicator to a generic
    // "tool call" instead of the real tool. The initial pending event, the
    // resolved-title in-progress update, and the terminal
    // completed/failed/cancelled update all still flow through. Adapters that
    // do not opt in never have an event dropped.
    if (
      coalescePlaceholderToolUpdates &&
      event.status === "in_progress" &&
      (event.title ?? "").trim() === GENERIC_ACP_TOOL_TITLE
    ) {
      return;
    }
    const eventRecord = event as Record<string, unknown>;
    const toolInput = eventRecord.input;
    let name = event.title ?? "acp_tool";
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
    if (toolTitles && toolCallId) {
      if (event.title && event.title !== GENERIC_ACP_TOOL_TITLE) {
        // First real title is the call's identity; later retitles (ACP swaps
        // in the invocation, e.g. "Terminal" → "ls -la") keep their own line
        // but don't become the remembered name.
        if (!toolTitles.has(toolCallId)) toolTitles.set(toolCallId, event.title);
      } else {
        name = toolTitles.get(toolCallId) ?? name;
      }
    }
    await emitAcpxLog(ctx, {
      type: "acpx.tool_call",
      name,
      toolCallId: event.toolCallId,
      status: event.status,
      text: event.text,
      tag: event.tag,
      ...(toolInput !== undefined ? { input: toolInput } : {}),
    });
    return;
  }
  if (event.type === "status") {
    await emitAcpxLog(ctx, {
      type: "acpx.status",
      text: event.text,
      tag: event.tag,
      used: event.used,
      size: event.size,
      ...(event.cost ? { cost: event.cost } : {}),
      ...(event.breakdown ? { breakdown: event.breakdown } : {}),
    });
    return;
  }
  if (event.type === "done") {
    await emitAcpxLog(ctx, {
      type: "acpx.result",
      summary: event.stopReason ?? "completed",
      stopReason: event.stopReason,
    });
    return;
  }
  if (event.type === "error") {
    await emitAcpxLog(ctx, {
      type: "acpx.error",
      message: event.message,
      code: event.code,
      retryable: event.retryable,
    });
  }
}

function resultErrorMessage(result: AcpRuntimeTurnResult): string | null {
  if (result.status !== "failed") return null;
  return result.error.message;
}

function usageBreakdownsEqual(
  left: AcpRuntimeUsageBreakdown,
  right: AcpRuntimeUsageBreakdown,
): boolean {
  return (
    asNumber(left.inputTokens, 0) === asNumber(right.inputTokens, 0) &&
    asNumber(left.outputTokens, 0) === asNumber(right.outputTokens, 0) &&
    asNumber(left.cachedReadTokens, 0) === asNumber(right.cachedReadTokens, 0) &&
    asNumber(left.cachedWriteTokens, 0) === asNumber(right.cachedWriteTokens, 0) &&
    asNumber(left.thoughtTokens, 0) === asNumber(right.thoughtTokens, 0) &&
    asNumber(left.totalTokens, 0) === asNumber(right.totalTokens, 0)
  );
}

function usdCostAmount(cost: AcpRuntimeUsageCost | null | undefined): number | null {
  if (!cost || typeof cost.amount !== "number" || !Number.isFinite(cost.amount)) return null;
  if (cost.currency && cost.currency.trim().toUpperCase() !== "USD") return null;
  return cost.amount;
}

async function readRuntimeStatus(
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
): Promise<AcpRuntimeStatus | null> {
  if (!runtime.getStatus) return null;
  try {
    return (await runtime.getStatus({ handle })) ?? null;
  } catch {
    return null;
  }
}

/**
 * Fold the ACP runtime's post-turn usage into the adapter execution result
 * shape. The runtime persists the latest turn's token breakdown (adapters like
 * claude-agent-acp report per-turn accumulated usage in the prompt response),
 * so tokens are per-run. Cost is reported by agents as a cumulative session
 * amount, so the per-run cost is the delta against the pre-turn snapshot; a
 * decrease means the agent process restarted and its counter reset, in which
 * case the post-turn amount alone covers this run.
 */
export function summarizeAcpxTurnUsage(input: {
  preStatus: AcpRuntimeStatus | null;
  postStatus: AcpRuntimeStatus | null;
  eventBreakdown: AcpRuntimeUsageBreakdown | null;
  eventCostUsd: number | null;
}): {
  usage: UsageSummary | null;
  usageDetail: Record<string, number> | null;
  costUsd: number | null;
  cumulativeCostUsd: number | null;
} {
  // The persisted breakdown is overwritten per turn, so an unchanged value
  // is stale for this turn. Prefer an in-turn event breakdown when available;
  // otherwise suppress the stale value so it cannot be double-counted.
  const preBreakdown = input.preStatus?.usage?.cumulative ?? null;
  const postBreakdown = input.postStatus?.usage?.cumulative ?? null;
  const postBreakdownIsStale =
    preBreakdown != null &&
    postBreakdown != null &&
    usageBreakdownsEqual(preBreakdown, postBreakdown);
  const breakdown = postBreakdownIsStale
    ? input.eventBreakdown
    : postBreakdown ?? input.eventBreakdown ?? null;
  const inputTokens = Math.max(0, Math.floor(asNumber(breakdown?.inputTokens, 0)));
  const outputTokens = Math.max(0, Math.floor(asNumber(breakdown?.outputTokens, 0)));
  const cachedReadTokens = Math.max(0, Math.floor(asNumber(breakdown?.cachedReadTokens, 0)));
  const cachedWriteTokens = Math.max(0, Math.floor(asNumber(breakdown?.cachedWriteTokens, 0)));
  const hasTokens = inputTokens > 0 || outputTokens > 0 || cachedReadTokens > 0 || cachedWriteTokens > 0;
  // Cache-write tokens are prompt tokens the provider billed to create cache
  // entries; UsageSummary has no dedicated field, so count them as input.
  const usage: UsageSummary | null = hasTokens
    ? {
        inputTokens: inputTokens + cachedWriteTokens,
        outputTokens,
        cachedInputTokens: cachedReadTokens,
      }
    : null;
  const usageDetail = breakdown
    ? Object.fromEntries(
        Object.entries({
          inputTokens: breakdown.inputTokens,
          outputTokens: breakdown.outputTokens,
          cachedReadTokens: breakdown.cachedReadTokens,
          cachedWriteTokens: breakdown.cachedWriteTokens,
          thoughtTokens: breakdown.thoughtTokens,
          totalTokens: breakdown.totalTokens,
        }).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
      )
    : null;

  const previousCostUsd = usdCostAmount(input.preStatus?.usage?.cost);
  const postCostUsd = usdCostAmount(input.postStatus?.usage?.cost);
  const postCostIsStale =
    input.eventCostUsd != null &&
    previousCostUsd != null &&
    postCostUsd != null &&
    postCostUsd === previousCostUsd;
  const cumulativeCostUsd = postCostIsStale ? input.eventCostUsd : postCostUsd ?? input.eventCostUsd;
  let costUsd: number | null = null;
  if (cumulativeCostUsd != null) {
    costUsd =
      previousCostUsd != null && cumulativeCostUsd >= previousCostUsd
        ? cumulativeCostUsd - previousCostUsd
        : cumulativeCostUsd;
  }

  return { usage, usageDetail, costUsd, cumulativeCostUsd };
}

type AcpxExecutionPhase =
  | "create_runtime"
  | "ensure_session"
  | "configure_session"
  | "prepare_turn"
  | "turn";

function describeErrorDiagnostics(err: unknown): {
  errorName: string;
  acpCode: string | null;
  causeMessage: string | null;
  retryable: boolean | null;
  stackPreview: string | null;
} {
  const errorName =
    err instanceof Error ? err.name || err.constructor.name : typeof err;
  const maybeCode =
    err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : null;
  const acpCode =
    isAcpRuntimeError(err) || (maybeCode?.startsWith("ACP_") ?? false) ? maybeCode : null;
  const cause =
    err && typeof err === "object" && (err as { cause?: unknown }).cause !== undefined
      ? (err as { cause?: unknown }).cause
      : undefined;
  const causeMessage =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : null;
  const retryable =
    err && typeof err === "object" && typeof (err as { retryable?: unknown }).retryable === "boolean"
      ? (err as { retryable: boolean }).retryable
      : null;
  const stack = err instanceof Error && typeof err.stack === "string" ? err.stack : "";
  const stackPreview = stack ? stack.split("\n").slice(0, 6).join("\n") : null;
  return { errorName, acpCode, causeMessage, retryable, stackPreview };
}

function classifyError(
  err: unknown,
  phase?: AcpxExecutionPhase,
): Pick<AdapterExecutionResult, "errorCode" | "errorMeta"> {
  const message = err instanceof Error ? err.message : String(err);
  const diagnostics = describeErrorDiagnostics(err);
  const { acpCode, errorName, causeMessage, retryable, stackPreview } = diagnostics;
  const baseMeta: Record<string, unknown> = {
    errorName,
    ...(acpCode ? { acpCode } : {}),
    ...(causeMessage ? { causeMessage } : {}),
    ...(retryable !== null ? { retryable } : {}),
    ...(stackPreview ? { stackPreview } : {}),
    ...(phase ? { phase } : {}),
  };
  const lower = message.toLowerCase();
  const authLike = lower.includes("auth") || lower.includes("login") || lower.includes("credential");
  if (authLike) {
    return {
      errorCode: "acpx_auth_required",
      errorMeta: { category: "auth", ...baseMeta },
    };
  }
  const phaseCode = (() => {
    if (acpCode === "ACP_SESSION_INIT_FAILED") return "acpx_session_init_failed";
    if (acpCode === "ACP_TURN_FAILED") return "acpx_turn_failed";
    if (acpCode === "ACP_BACKEND_MISSING") return "acpx_backend_missing";
    if (acpCode === "ACP_BACKEND_UNAVAILABLE") return "acpx_backend_unavailable";
    if (phase === "ensure_session") return "acpx_session_init_failed";
    if (phase === "configure_session") return "acpx_session_config_failed";
    if (phase === "turn") return "acpx_turn_failed";
    return null;
  })();
  if (phaseCode) {
    return {
      errorCode: phaseCode,
      errorMeta: { category: acpCode ? "protocol" : "runtime", ...baseMeta },
    };
  }
  if (acpCode) {
    return {
      errorCode: "acpx_protocol_error",
      errorMeta: { category: "protocol", ...baseMeta },
    };
  }
  return {
    errorCode: "acpx_runtime_error",
    errorMeta: { category: "runtime", ...baseMeta },
  };
}

async function readChildStderrTail(input: {
  logPath: string | null;
  maxBytes?: number;
}): Promise<string | null> {
  if (!input.logPath) return null;
  const maxBytes = input.maxBytes ?? 4096;
  let handle: fs.FileHandle | null = null;
  try {
    const stat = await fs.stat(input.logPath);
    if (stat.size === 0) return null;
    handle = await fs.open(input.logPath, "r");
    const readBytes = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(readBytes);
    await handle.read(buffer, 0, readBytes, Math.max(0, stat.size - readBytes));
    const tail = buffer.toString("utf8").trim();
    return tail.length > 0 ? tail : null;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function emitAcpxFailure(input: {
  ctx: AdapterExecutionContext;
  prepared: AcpxPreparedRuntime;
  err: unknown;
  phase: AcpxExecutionPhase;
  // Replace the err-derived message in both the stderr-tail log header and the
  // acpx.error payload. Used by the turn path to surface the self-describing
  // adapter execution timeout message instead of the raw underlying error.
  messageOverride?: string;
}): Promise<{
  classified: Pick<AdapterExecutionResult, "errorCode" | "errorMeta">;
  message: string;
  childStderrTail: string | null;
}> {
  const { ctx, prepared, err, phase, messageOverride } = input;
  const rawMessage = err instanceof Error ? err.message : String(err);
  const message = messageOverride ?? rawMessage;
  const classified = classifyError(err, phase);
  const childStderrTail = await readChildStderrTail({ logPath: prepared.childStderrLogPath });
  if (childStderrTail) {
    await ctx.onLog(
      "stderr",
      `[paperclip] ACPX child stderr tail (${phase}):\n${childStderrTail}\n`,
    );
  }
  await emitAcpxLog(ctx, {
    type: "acpx.error",
    message,
    phase,
    ...classified.errorMeta,
    ...(childStderrTail ? { childStderrTail } : {}),
  });
  return { classified, message, childStderrTail };
}

function isResumeFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /resume|load|not found|no session|unknown session|conversation/i.test(message);
}

// Drop staged-runtime entries the session has not touched within the warm-idle
// window, so the cache does not accumulate abandoned sessions (e.g. every time
// a config change shifts the fingerprint to a new key). The per-run copy-back
// already ran on the entry's last run's settlement `syncBack`; eviction fires
// the entry's one-time `dispose` (host staged-temp cleanup) — the only place
// the staged temp is removed now that it no longer rides the per-run teardown.
// A later run of the same session simply re-stages fresh (re-shipping into the
// still-persistent sandbox, which the inbound monotonic auth-merge keeps safe).
async function cleanupIdleStagedRuntimes(input: {
  handles: Map<string, StagedRuntimeCacheEntry>;
  locks: Map<string, Promise<unknown>>;
  now: () => number;
  idleMs: number;
}) {
  if (input.idleMs <= 0) return;
  const stale: Array<[string, StagedRuntimeCacheEntry]> = [];
  for (const entry of input.handles.entries()) {
    if (input.now() - entry[1].lastUsedAt >= input.idleMs) stale.push(entry);
  }
  for (const [key, entry] of stale) {
    const lease = await withSessionStagingLease(input.locks, key, async () => {
      const current = input.handles.get(key);
      if (current !== entry) return;
      if (input.now() - current.lastUsedAt < input.idleMs) return;
      input.handles.delete(key);
      if (entry.dispose) await entry.dispose().catch(() => {});
    });
    lease.release();
  }
}

// Persist a remote runner-backed session's staged runtime for reuse on the next
// compatible resume. Called ONLY after a clean turn, so the cache never offers a
// half-staged or failed session for reuse. Non-remote lanes carry a null
// stagedRuntime / null envDelta and are skipped.
function saveStagedRuntimeAfterCleanTurn(input: {
  handles: Map<string, StagedRuntimeCacheEntry>;
  prepared: AcpxPreparedRuntime;
  now: number;
}) {
  const { prepared } = input;
  if (!prepared.stagedRuntime || prepared.remoteStagingEnvDelta === null) return;
  input.handles.set(prepared.sessionKey, {
    stagedRuntime: prepared.stagedRuntime,
    envDelta: prepared.remoteStagingEnvDelta,
    teardown: prepared.remoteManagedHomeTeardown,
    dispose: prepared.remoteStagingDispose,
    lastUsedAt: input.now,
  });
}

// Drop the staged-runtime entry a finished run owns and release its host-side
// staged resources. Two guards make this safe under overlapping runs of the same
// session key (PR 3 fix — "Concurrent Runs Corrupt Cache Ownership"):
//   1. Ownership guard: only delete the map entry when it is still the exact
//      staged runtime THIS run installed/reused (object identity). A concurrent
//      run that installed a different clean entry keeps it — a failed run can no
//      longer evict another run's good cache entry.
//   2. `dispose` is fired for THIS run's own staged resources regardless, so a
//      failed/cancelled run always frees its own staged temp. `dispose` is
//      idempotent, so a shared closure re-fired across a reuse chain is safe.
async function discardStagedRuntime(input: {
  handles: Map<string, StagedRuntimeCacheEntry>;
  prepared: AcpxPreparedRuntime;
}): Promise<void> {
  const { handles, prepared } = input;
  await releaseStagedRuntimeEntry({
    handles,
    sessionKey: prepared.sessionKey,
    stagedRuntime: prepared.stagedRuntime,
    dispose: prepared.remoteStagingDispose,
  });
}

// Ownership-guarded removal + dispose for a staged-runtime cache entry a run owns.
// Shared by `discardStagedRuntime` (clean-run drop) and the partial-bring-up
// rollback so both release a borrowed entry the same way:
//   1. Delete the map entry ONLY when it still holds the exact staged runtime this
//      run installed or reused (object identity). A concurrent run that replaced
//      the entry with its own keeps it.
//   2. Fire this run's own one-time host staged-temp dispose regardless. The
//      dispose closure is idempotent, so a shared closure re-fired across a reuse
//      chain is safe.
async function releaseStagedRuntimeEntry(input: {
  handles: Map<string, StagedRuntimeCacheEntry>;
  sessionKey: string;
  stagedRuntime: PreparedAdapterExecutionTargetRuntime | null;
  dispose: (() => Promise<void>) | null;
}): Promise<void> {
  const { handles, sessionKey, stagedRuntime, dispose } = input;
  const existing = handles.get(sessionKey);
  if (existing && stagedRuntime && existing.stagedRuntime === stagedRuntime) {
    handles.delete(sessionKey);
  }
  if (dispose) await dispose().catch(() => {});
}

// Per-`sessionKey` async lease: chains each caller after the previous one so
// the stage-or-reuse decision for a session runs serially, then keeps the
// lease held until the active turn finishes and bridge cleanup runs. That means
// overlapping runs of the same session can never stage fresh into the same
// remote workspace while a prior turn is still using it: the loser waits, then
// re-checks the cache before deciding to reuse or re-stage.
async function withSessionStagingLease<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>,
): Promise<{ value: T; release: () => void }> {
  const prev = locks.get(key) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  // The next waiter's `prev` is this promise; it settles only once we release
  // the gate below, so callers run one at a time.
  const mine: Promise<unknown> = prev.then(() => gate);
  locks.set(key, mine);
  await prev.catch(() => {});
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseGate();
    // GC the lock if no later caller has chained after us.
    if (locks.get(key) === mine) locks.delete(key);
  };
  try {
    return { value: await fn(), release };
  } catch (error) {
    if (!released) release();
    throw error;
  }
}

function clearWarmHandleTimer(entry: RuntimeCacheEntry) {
  if (!entry.cleanupTimer) return;
  clearTimeout(entry.cleanupTimer);
  entry.cleanupTimer = undefined;
}

async function closeWarmHandle(input: {
  handles: Map<string, RuntimeCacheEntry>;
  key: string;
  entry: RuntimeCacheEntry;
  reason: string;
  discardPersistentState?: boolean;
}) {
  if (input.handles.get(input.key) === input.entry) {
    input.handles.delete(input.key);
  }
  clearWarmHandleTimer(input.entry);
  await input.entry.runtime.close({
    handle: input.entry.handle,
    reason: input.reason,
    discardPersistentState: input.discardPersistentState ?? false,
  }).catch(() => {});
  flushChildStderr(input.entry.childStderrState);
}

function warmHandleMatches(
  entry: RuntimeCacheEntry | undefined,
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
): boolean {
  return entry !== undefined && entry.runtime === runtime && entry.handle === handle;
}

/** The stable name of the one root span for a sandbox bring-up. It is a fixed
 * low-cardinality constant, never derived from run/user data. */
const STARTUP_ROOT_SPAN_NAME = "sandbox.startup";

/** The shared batch tag for the two parallel bridge steps. It is a fixed
 * low-cardinality literal, so it marks the two spans as one batch without
 * carrying run or user data. */
const STARTUP_BRIDGE_BATCH = "bridge";

/**
 * Open the one root span for a sandbox bring-up and return its parent-context
 * token plus a guarded `end`. The span parents to the run root span through
 * `runParentContext`, so `sandbox.startup` becomes a child of `task.run`. The
 * span then parents every startup boundary span in turn: the engine forwards
 * `parentContext` to each `measureStartupStep` call. The `end` closure runs at
 * most once (bring-up complete OR a bring-up failure) and swallows every tracer
 * error, so observability never changes startup control flow. With no injected
 * trace context, the tracer is a no-op and the span is a no-op.
 */
function openStartupRootSpan(
  tracing: StartupTraceContext,
  nowMs: () => number,
  // The run root span parent context. `sandbox.startup` opens as a child of it,
  // so the whole bring-up parents to `task.run`. It is an opaque token here.
  runParentContext: StartupSpanContext,
  // Return the final root-span numbers and context at end time. The work sum
  // and the cold-start flag are known only after the bring-up runs, so the
  // caller reads them lazily here.
  finalize: () => { workMs: number; context: SandboxRootSpanContext },
): {
  parentContext: StartupSpanContext;
  end: (failed: boolean) => void;
} {
  let span: StartupSpan;
  try {
    span = tracing.tracer.startSpan(STARTUP_ROOT_SPAN_NAME, undefined, runParentContext);
  } catch {
    span = NOOP_STARTUP_SPAN;
  }
  let parentContext: StartupSpanContext;
  try {
    parentContext = tracing.contextWithSpan(span);
  } catch {
    parentContext = undefined;
  }
  const startedAtMs = nowMs();
  let ended = false;
  return {
    parentContext,
    end: (failed: boolean) => {
      if (ended) return;
      ended = true;
      try {
        // The root span records its own wall time, the step-work sum, and the
        // bounded context. `setSandboxRootSpanAttributes` sets only the closed
        // allowlist, so no raw id or image reference rides the span.
        const { workMs, context } = finalize();
        setSandboxRootSpanAttributes(span, { wallMs: nowMs() - startedAtMs, workMs }, context);
        // `2` is `SpanStatusCode.ERROR`. `adapter-utils` stays OTel-free, so it
        // uses the numeric value that a real injected span reads as the error
        // status.
        if (failed) span.setStatus({ code: 2 });
        span.end();
      } catch {
        // Observability must not change startup control flow.
      }
    },
  };
}

/** The stable name of the one root span for a whole run. It is a fixed
 * low-cardinality constant, never derived from run or user data. */
const RUN_ROOT_SPAN_NAME = "task.run";

/** The stable name of the one span for the agent turn. It is a fixed
 * low-cardinality constant, never derived from run or user data. The turn span
 * is a child of the run root span. */
const TURN_SPAN_NAME = "agent.turn";

/** The attribute prefix for the run root span. It groups the run-level span
 * attributes under one namespace, the same shape as the sandbox startup
 * prefix. */
const RUN_ROOT_SPAN_ATTR_PREFIX = "paperclip.task.run.";

/** The attribute prefix for the agent turn span. It groups the turn-level span
 * attributes under one namespace, the same shape as the run root prefix. */
const TURN_SPAN_ATTR_PREFIX = "paperclip.agent.turn.";

/** Map a run id to a non-reversible 12-hex hash for a span attribute. The raw
 * run id never rides a span; only this hash does. This mirrors the id-hash rule
 * that `clampSpanLabel` uses for the startup ids. */
function hashRunId(runId: string): string {
  return createHash("sha256").update(runId).digest("hex").slice(0, 12);
}

/**
 * Open the one root span for a whole run and return its parent-context token
 * plus a guarded `end`. The run root span is the trace root: the sandbox
 * bring-up span (`sandbox.startup`) parents to it, so the engine forwards
 * `parentContext` into `openStartupRootSpan`. The `end` closure runs at most
 * once and swallows every tracer error, so observability never changes run
 * control flow. With no injected trace context the tracer is a no-op and the
 * span is a no-op.
 *
 * The span carries only a bounded, non-reversible run-id hash and its own wall
 * time. It never carries the prompt, the command, or any user text, so no raw
 * run text rides the span. This follows the same allowlist rule as
 * `openStartupRootSpan`.
 */
function openRunRootSpan(
  tracing: StartupTraceContext,
  nowMs: () => number,
  runId: string,
): {
  parentContext: StartupSpanContext;
  end: (failed: boolean) => void;
} {
  let span: StartupSpan;
  try {
    span = tracing.tracer.startSpan(RUN_ROOT_SPAN_NAME);
  } catch {
    span = NOOP_STARTUP_SPAN;
  }
  let parentContext: StartupSpanContext;
  try {
    parentContext = tracing.contextWithSpan(span);
  } catch {
    parentContext = undefined;
  }
  const startedAtMs = nowMs();
  let ended = false;
  return {
    parentContext,
    end: (failed: boolean) => {
      if (ended) return;
      ended = true;
      try {
        // The run id rides only as a non-reversible short hash, never as the raw
        // id. The wall time is a plain duration. No raw run text rides the span.
        span.setAttribute(`${RUN_ROOT_SPAN_ATTR_PREFIX}run_id`, hashRunId(runId));
        span.setAttribute(`${RUN_ROOT_SPAN_ATTR_PREFIX}wall_ms`, nowMs() - startedAtMs);
        // `2` is `SpanStatusCode.ERROR`. `adapter-utils` stays OTel-free, so it
        // uses the numeric value that a real injected span reads as the error
        // status.
        if (failed) span.setStatus({ code: 2 });
        span.end();
      } catch {
        // Observability must not change run control flow.
      }
    },
  };
}

/**
 * Open the one span for the agent turn and return its parent-context token plus
 * a guarded `end`. The span parents to the run root span through
 * `runParentContext`, so `agent.turn` becomes a child of `task.run`. The
 * executor holds the returned `parentContext` for later exec parenting. The
 * `end` closure runs at most once and swallows every tracer error, so
 * observability never changes turn control flow. With no injected trace context
 * the tracer is a no-op and the span is a no-op.
 *
 * The span carries only its own wall time. It never carries the prompt, the
 * command, or any user text, so no raw run text rides the span. This follows the
 * same allowlist rule as `openStartupRootSpan`.
 */
function openTurnSpan(
  tracing: StartupTraceContext,
  nowMs: () => number,
  // The run root span parent context. `agent.turn` opens as a child of it, so
  // the turn parents to `task.run`. It is an opaque token here.
  runParentContext: StartupSpanContext,
): {
  parentContext: StartupSpanContext;
  end: (failed: boolean) => void;
} {
  let span: StartupSpan;
  try {
    span = tracing.tracer.startSpan(TURN_SPAN_NAME, undefined, runParentContext);
  } catch {
    span = NOOP_STARTUP_SPAN;
  }
  let parentContext: StartupSpanContext;
  try {
    parentContext = tracing.contextWithSpan(span);
  } catch {
    parentContext = undefined;
  }
  const startedAtMs = nowMs();
  let ended = false;
  return {
    parentContext,
    end: (failed: boolean) => {
      if (ended) return;
      ended = true;
      try {
        // The wall time is a plain duration. No raw run text rides the span.
        span.setAttribute(`${TURN_SPAN_ATTR_PREFIX}wall_ms`, nowMs() - startedAtMs);
        // `2` is `SpanStatusCode.ERROR`. `adapter-utils` stays OTel-free, so it
        // uses the numeric value that a real injected span reads as the error
        // status.
        if (failed) span.setStatus({ code: 2 });
        span.end();
      } catch {
        // Observability must not change turn control flow.
      }
    },
  };
}

export function createAcpxEngineExecutor(deps: AcpxEngineExecutorOptions = {}) {
  const createRuntime = deps.createRuntime ?? createAcpRuntime;
  const now = deps.now ?? (() => Date.now());
  const warmHandles = deps.warmHandles ?? defaultWarmHandles;
  const stagedRuntimes = deps.stagedRuntimes ?? defaultStagedRuntimes;
  const stagingLocks = deps.stagingLocks ?? defaultStagingLocks;
  const engine = resolveEngineSettings(deps);

  return async function executeAcpxEngine(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    let billingIdentity: AcpxEngineBillingIdentity | null = null;
    try {
      billingIdentity = (await deps.resolveBillingIdentity?.(ctx)) ?? null;
    } catch {
      billingIdentity = null;
    }
    const billingFields = {
      provider: billingIdentity?.provider ?? "acpx",
      ...(billingIdentity?.biller ? { biller: billingIdentity.biller } : {}),
      billingType: billingIdentity?.billingType ?? ("unknown" as const),
    };
    const warmIdleMs = asNumber(ctx.config.warmHandleIdleMs, DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS);
    // The host run site owns the warm-handle store on this run. It operates over
    // the engine's persistent `warmHandles` map, so a warm runtime stays live for
    // the next compatible resume. The store arms the per-entry idle timer on a
    // warm save, sweeps idle entries at run start, and closes a released entry
    // through `closeWarmEntry`. The run reads `warmHandleIdleMs` per run, so the
    // site takes this run's bound.
    const hostSite = createHostRunSite({
      warmHandles,
      now,
      idleMs: warmIdleMs,
      closeWarmEntry: async (entry) => {
        await entry.runtime
          .close({ handle: entry.handle, reason: "paperclip idle cleanup", discardPersistentState: false })
          .catch(() => {});
        flushChildStderr(entry.childStderrState);
      },
    });
    const hostStore = hostSite.reuse();
    // The `task.run` and `sandbox.startup` spans must not cover a local or SSH
    // run: those runs have no sandbox, so they stay out of sandbox telemetry.
    // Open a real root span only when the target is a remote sandbox and the
    // server injected a trace context; every other target forces the no-op
    // trace context, so the whole span path stays inert.
    const startupExecutionTarget = readAdapterExecutionTarget({
      executionTarget: ctx.executionTarget,
      legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
    });
    const sandboxTarget =
      startupExecutionTarget?.kind === "remote" && startupExecutionTarget.transport === "sandbox"
        ? startupExecutionTarget
        : null;
    const targetsRemoteSandbox = sandboxTarget !== null;
    const tracing =
      targetsRemoteSandbox && ctx.startupTraceContext
        ? ctx.startupTraceContext
        : NOOP_STARTUP_TRACE_CONTEXT;
    // Open the one run root span at the engine first line, before any bring-up
    // work. It is the trace root for the whole run: the sandbox bring-up and the
    // agent turn parent to it. The engine forwards its parent context into the
    // startup span. `runRootSpan.end` runs exactly once, in the `finally` below,
    // on every return and on a throw.
    const runRootSpan = openRunRootSpan(tracing, now, ctx.runId);
    // Hold the current-run parent-context token for the whole run. It starts as
    // the `task.run` token, switches to the `agent.turn` token during the turn,
    // and switches back to the `task.run` token after the turn. It is never
    // `undefined` while the run is live. The holder is a run-scoped local, so two
    // concurrent runs in one host process keep separate tokens. A detached exec
    // reads it through `getRuntimeParentContext` to parent to the live span.
    let currentRunParentContext: StartupSpanContext | undefined = runRootSpan.parentContext;
    const getRuntimeParentContext = (): StartupSpanContext | undefined => currentRunParentContext;
    // Wrap each unit of bridge run-time work (one outbound ACP message, one poll
    // tick, one callback request) in its own named span, parented to the live run
    // span. The runner reads the run parent per call through
    // `getRuntimeParentContext`, so a wrapper span always parents to the current
    // run span. On a no-op trace context the runner opens no real span.
    const runRuntimeSpan = createRuntimeSpanRunner(tracing, getRuntimeParentContext);
    // Wrap the host workspace tarball build in one `pack` span. This runner
    // parents each span to the ACTIVE startup step (not the run span), so the
    // `pack` span nests under the `stage.sync` step that runs the staging seam.
    // The staging seam runs inside `stage.sync`'s measured step, so
    // `getActiveStepContext()` returns that step's child context at pack time.
    // On a no-op trace context the runner opens no real span.
    const runStageSpan = createRuntimeSpanRunner(
      tracing,
      () => getActiveStepContext()?.parentContext,
    );
    // `runFailed` marks the run root span status at end time. It stays `true`
    // until the run reaches a clean completed turn, so every failure and every
    // early exit closes the span with error status.
    let runFailed = true;
    // The run's per-session staging lease release. `buildRuntime` returns it on
    // `prepared` after it acquires the lease; the startup step captures it here so
    // the run root `finally` can release it as the final settlement act. It stays
    // null on the host lane (no staging) and on a build failure (where
    // `buildRuntime` already released its own partial lease).
    let releaseStagingLease: (() => void) | null = null;
    try {
      // Evict idle staged runtimes BEFORE building the runtime, since buildRuntime
      // consults the staged cache to decide whether a compatible resume may reuse
      // an already-staged runtime — an expired entry must not be reused.
      await cleanupIdleStagedRuntimes({
        handles: stagedRuntimes,
        locks: stagingLocks,
        now,
        idleMs: warmIdleMs,
      });
      // The sum of the step wall times. The root span records it as `root.work_ms`
      // and the difference from its own wall time as `root.diff_ms` (the overlap
      // the parallel steps saved). Every step reports its wall time through
      // `onWallMs`; a skipped step adds zero.
      let stepWallSumMs = 0;
      // Whether this bring-up is a cold start (no warm handle). Set once the warm-
      // handle lookup runs below; it stays undefined on an early build failure, so
      // the root span omits the attribute (fail open).
      let coldStart: boolean | undefined;
      const rootSpan = openStartupRootSpan(tracing, now, runRootSpan.parentContext, () => ({
        workMs: stepWallSumMs,
        context: {
          coldStart,
          // The provider key and the lease id are the only low-cardinality
          // context values this provider-agnostic layer holds. The region, the
          // image id, and the sandbox id are not threaded here, so the root span
          // omits them (fail open). The lease id rides only as a hash.
          provider: sandboxTarget?.providerKey ?? undefined,
          leaseId: sandboxTarget?.leaseId ?? undefined,
        },
      }));
      const spanParent: Pick<
        StartupStepMeasureOptions,
        "tracer" | "parentContext" | "contextWithSpan" | "onWallMs"
      > = {
        tracer: tracing.tracer,
        parentContext: rootSpan.parentContext,
        // Each step uses this to publish its own child context, so an inner exec
        // span parents to the step span, not to the root.
        contextWithSpan: (span) => tracing.contextWithSpan(span),
        // Accumulate each step wall time into the root work sum.
        onWallMs: (wallMs) => {
          stepWallSumMs += wallMs;
        },
      };
      // `startupFailed` drives the sandbox.startup span end status. It stays true
      // until the bring-up establishes a session handle. The one `finally` below
      // ends the span exactly once, on every return and on every throw.
      let startupFailed = true;
      // `buildRuntimeSettled` marks that buildRuntime returned. A failure before it
      // settled has nothing to settle here; a failure after it settled routes
      // through the create_runtime handler below.
      let buildRuntimeSettled = false;
      // The bring-up assigns these. The turn and teardown paths read them after
      // the sandbox.startup span closes, so they are declared here.
      let prepared!: AcpxPreparedRuntime;
      let runtime!: AcpRuntime;
      let sessionHandle!: AcpRuntimeHandle;
      let childStderrState!: ChildStderrState;
      let processIdentitySink!: AcpxProcessIdentitySink;
      let resumedSession = false;
      let clearSession = false;
      let referencedProjectStagingFailuresField:
        | { referencedProjectStagingFailures: Array<{ projectId: string; error: string }> }
        | Record<string, never> = {};
      const recordTeardownError = async (step: string, teardownErr: unknown) => {
        const reason = teardownErr instanceof Error ? teardownErr.message : String(teardownErr);
        await ctx
          .onLog("stderr", `[paperclip] ACPX teardown step "${step}" failed: ${reason}\n`)
          .catch(() => {});
      };
      // Emit one per-phase timing telemetry event. It is observability-only: it
      // carries the phase name (from the closed allowlist), the wall time, and the
      // outcome, and never a command, a path, an environment value, or an
      // identifier. Telemetry failure never fails the run.
      const emitPhase = (phase: string, startMs: number, outcome: "ok" | "failed"): Promise<void> =>
        emitRunPhaseTiming(ctx, phase, now() - startMs, outcome);
      // Time a settlement step and emit its phase timing on every path. A step
      // error still emits `failed` before it re-throws to the Phase 3 error policy.
      const timedPhase = async (phase: string, run: () => Promise<void> | void): Promise<void> => {
        const start = now();
        try {
          await run();
        } catch (error) {
          await emitPhase(phase, start, "failed");
          throw error;
        }
        await emitPhase(phase, start, "ok");
      };
      // The turn the run started. It is hoisted to the run scope so the settlement
      // `endSession` step can cancel a running turn before it closes the runtime
      // (the cancel-before-close order). The turn wrapper assigns it in `turnStart`.
      let activeTurn: AcpRuntimeTurn | null = null;
      // How the settlement `endSession` step must release the runtime for the path
      // this run took. Each exit path that acquired the runtime records it before it
      // returns; a build or create-runtime failure never registers the runtime, so
      // the step no-ops on the empty slot and this stays null.
      let runtimeSettlement: RuntimeSettlementPlan | null = null;
      // A synthetic close handle from the prepared identity, for a close that has no
      // established session handle (a cold `ensureSession` throw or a missing
      // handle). `runtime.close` reads the session key and the runtime session name.
      const syntheticCloseHandle = (): AcpRuntimeHandle => ({
        sessionKey: prepared.sessionKey,
        backend: prepared.acpxAgent,
        runtimeSessionName: prepared.sessionKey,
      });
      // The run coordinator owns the one ledger for the attempt. The engine
      // creates it here, passes it into `buildRuntime` (the sandbox site registers
      // what it acquires into it), and hands it to `runAttempt` as the plan
      // ledger. The turn and settlement code still runs inline in the step
      // wrappers below; Phases 21-22 move it into its own modules.
      const runResourceLedger = createRunResourceLedger();
      // The step wrappers build the external result inline (today's behavior) and
      // record it here; the coordinator reproduces it after settlement. An empty
      // consumed set satisfies the `settle` result shape without claiming the run
      // ledger, because the inline teardown reads `prepared.*`, not the ledger, in
      // this phase.
      let capturedResult: AdapterExecutionResult | null = null;
      const emptyConsumed = createRunResourceLedger().takeForSettlement();
      // Build the `settle` startup result for a pre-turn failure. The step wrapper
      // already recorded the external result and ran the inline teardown; this
      // carries only the routing kind and the cause for the coordinator.
      const settleFor = (phase: PreTurnFailedCause["phase"], error: unknown): StartupResult => ({
        kind: "settle",
        cause: {
          kind: "pre_turn_failed",
          phase,
          error: error instanceof Error ? error : new Error(String(error)),
        },
        resources: emptyConsumed,
      });
      // The startup step: bring up the runtime, establish the session, and apply
      // the session config. It returns `ready` on success, `settle` on a pre-turn
      // failure after the ledger acquired resources, and throws on a build failure
      // or a partial-bridge failure (the coordinator owns that rollback).
      const startup = async (): Promise<StartupResult> => {
       try {
        // Publish the `sandbox.startup` context to the runtime-parent store for
        // the whole bring-up. A startup-body exec that runs outside a measured
        // step reads this token and parents its span to `sandbox.startup`, not to
        // a detached root. A measured step nests its own `activeStepContextStorage`
        // run inside this wrap and overrides the store, so an in-step exec still
        // parents to its step span. On a local or SSH target
        // `spanParent.parentContext` is a no-op token, so the wrap is inert.
        prepared = await runWithRuntimeParent(spanParent.parentContext, () =>
          buildRuntime({
            ctx,
            engine,
            deps,
            ledger: runResourceLedger,
            stagedIdleMs: warmIdleMs,
            spanParent,
            getRuntimeParentContext,
            runtimeSpan: runRuntimeSpan,
            stageRuntimeSpan: runStageSpan,
          }),
        );
        buildRuntimeSettled = true;
        // Capture the run's staging lease release now that the runtime built. The
        // run root `finally` releases it as the final settlement act.
        releaseStagingLease = prepared.sessionStagingLeaseRelease;
        // Per-project staging outcomes for the referenced (mentioned) projects, surfaced back to the
        // server on the run result. A referenced project that failed to stage into the sandbox is a
        // first-class, counted failure in the requested-vs-synced observability, not only a warning. The
        // list is empty on a local target, on a transport that does not stage referenced projects, or
        // when every staged referenced project succeeded, so the spread adds the field only when there
        // is a failure to report.
        const referencedProjectStagingFailures = (
          prepared.stagedRuntime?.additionalSourceFailures ?? []
        ).map((failure) => ({ projectId: failure.projectId, error: failure.error }));
        referencedProjectStagingFailuresField =
          referencedProjectStagingFailures.length > 0 ? { referencedProjectStagingFailures } : {};
        // Write one run-log line per failure, so a reader of the run log alone sees
        // each dropped referenced project and its reason. The run continues without
        // the failed project (per-project failure isolation). Goes to stderr: the
        // acpx stdout log stream carries machine-parseable JSON event payloads.
        for (const failure of referencedProjectStagingFailures) {
          await ctx.onLog(
            "stderr",
            `[paperclip] Referenced project ${failure.projectId} failed to stage; the run continues without it: ${failure.error}\n`,
          );
        }
        // State the effective wall-clock timeout and its source up front so a
        // later timeout is diagnosable from the run log alone. Goes to stderr:
        // the acpx stdout log stream carries JSON acpx.* event payloads and must
        // stay machine-parseable line by line.
        await ctx.onLog(
          "stderr",
          `[paperclip] ${formatAdapterExecutionTimeoutStartLogLine(prepared.timeoutResolution)}\n`,
        );
        await hostStore.evictIdle(now());

        const previousParams = parseObject(ctx.runtime.sessionParams);
        const canResume = isCompatibleSession(previousParams, prepared);
        const resumeSessionId = canResume ? asString(previousParams.acpSessionId, "") || undefined : undefined;
        // Borrow the warm entry without removing it, so an overlapping run of the
        // same session still sees it. The borrow clears the entry's idle timer, so
        // the reused runtime cannot expire under its own timer while this run uses
        // it (today's `clearWarmHandleTimer(cached)` after the reuse decision).
        const cached = canResume ? hostStore.borrow(prepared.sessionKey) : undefined;
        childStderrState = cached?.childStderrState ?? { logPath: null, pendingLiveLine: "" };
        processIdentitySink = cached?.processIdentitySink ?? {
          current: ctx.onSpawn,
          latest: null,
        };
        // ACPX runtimes can stay warm across heartbeat runs. Keep the callback
        // target mutable so a later agent respawn records identity on the current
        // heartbeat instead of the run that originally created the runtime.
        processIdentitySink.current = ctx.onSpawn;
        flushChildStderr(childStderrState);
        childStderrState.logPath = prepared.childStderrLogPath;
        const runtimeOptions: PaperclipAcpRuntimeOptions = {
          cwd: prepared.cwd,
          // Host-only spawn cwd for the relay proxy on the remote process-session
          // lane; `undefined` elsewhere so acpx falls back to `cwd` (byte-identical).
          // The advertised `session/new` cwd (`prepared.cwd` = `remoteCwd`) and the
          // fingerprint / compat key are unaffected — this redirects ONLY the host
          // `spawn()` `chdir`, not the in-sandbox data path.
          spawnCwd: prepared.hostSpawnCwd,
          sessionStore: createRuntimeStore({ stateDir: prepared.stateDir }),
          agentRegistry: prepared.agentRegistry,
          permissionMode: prepared.permissionMode,
          nonInteractivePermissions: prepared.nonInteractivePermissions,
          mcpServers: prepared.mcpServers,
          timeoutMs: prepared.timeoutSec > 0 ? prepared.timeoutSec * 1000 : undefined,
          // Scope ACPX runtime verbose logs to the claude agent only. Codex
          // and custom agents already emit their own per-tool output and don't
          // benefit from doubling the log volume.
          verbose: prepared.acpxAgent === "claude",
          onAgentStderr: prepared.childStderrLogPath
            ? (chunk) => routeChildStderr(childStderrState, chunk)
            : undefined,
          onAgentSpawn: async (meta) => {
            processIdentitySink.latest = meta;
            await processIdentitySink.current?.({
              pid: meta.pid,
              processGroupId: null,
              startedAt: meta.startedAt,
            });
          },
          getRuntimeParentContext,
        };
        // Open Q2: split the ~7s `acp.handshake` into the two in-repo-observable
        // sub-phases — the ACP runtime construction (`createRuntime`) vs the session
        // establishment envelope (`ensureSession`). The patched spawn lifecycle
        // hook records process identity, but the finer spawn/`initialize`/
        // `session/new` timing split still lives inside external `acpx`.
        // `createRuntime` runs once and only on a cold start; a warm-handle hit
        // reuses `cached.runtime`, so `createRuntimeMs` stays undefined and the
        // split reports nothing for it.
        let createRuntimeMs: number | undefined;
        // A warm handle reuses the running ACP runtime; a miss constructs one. The
        // root span records this as `cold_start`.
        coldStart = !cached?.runtime;
        if (cached?.runtime) {
          runtime = cached.runtime;
        } else {
          const createRuntimeStart = now();
          runtime = createRuntime(runtimeOptions);
          createRuntimeMs = now() - createRuntimeStart;
          // The create_runtime phase runs only on a cold start.
          await emitRunPhaseTiming(ctx, "create_runtime", createRuntimeMs, "ok");
        }
        // Register the runtime composite in the ledger now that it exists. The
        // settlement `endSession` step closes it on every path the reuse decision
        // does not transfer. Registration here (before `ensureSession`) closes the
        // cold-handshake leak: a cold `ensureSession` throw before a handle exists
        // still leaves the runtime in the ledger for `endSession` to close. A
        // create-runtime failure throws before this line, so the runtime never
        // enters the ledger and the settlement no-ops on the empty slot. The
        // session handle fills in below; the payload carries the best-known handle
        // for the composite (`runtime.close` is the one release boundary).
        runResourceLedger.register({
          id: "acp_runtime",
          payload: {
            runtime,
            sessionHandle: cached?.handle ?? syntheticCloseHandle(),
            childProcessPid: processIdentitySink.latest?.pid ?? null,
          },
          scope: "per_run",
        });
        if (!canResume && asString(previousParams.runtimeSessionName, "")) {
          await ctx.onLog(
            "stdout",
            `[paperclip] ACPX session "${asString(previousParams.runtimeSessionName, "")}" does not match the current agent/cwd/mode/runtime identity; starting fresh in "${prepared.cwd}".\n`,
          );
        }

        let handle = cached?.handle ?? null;
        // The ensure_session phase covers the handshake (session establishment or
        // resume) up to the established handle.
        const ensureSessionPhaseStart = now();
        resumedSession = Boolean(handle ?? resumeSessionId);

        try {
          if (!handle) {
            try {
              // Step 7 — acp.handshake: ACP session establishment (session/new or
              // resume). A throwing handshake still reports its duration before the
              // resume-retry path below runs. The createRuntime/ensureSession
              // sub-split rides the step span as fixed, closed keys (Open Q2).
              let ensureSessionMs: number | undefined;
              handle = await measureStartupStep(ctx, now, "acp.handshake", async () => {
                const ensureSessionStart = now();
                const established = await runtime.ensureSession({
                  sessionKey: prepared.sessionKey,
                  agent: prepared.acpxAgent,
                  mode: prepared.mode,
                  cwd: prepared.cwd,
                  resumeSessionId,
                  sessionOptions: { env: prepared.env },
                });
                ensureSessionMs = now() - ensureSessionStart;
                return established;
              }, {
                ...prepared.stepMetrics,
                // The two sub-times ride the span as fixed, closed keys.
                spanWallTimes: () => ({
                  createRuntime: createRuntimeMs,
                  ensureSession: ensureSessionMs,
                }),
              });
            } catch (err) {
              if (!resumeSessionId || !isResumeFailure(err)) throw err;
              clearSession = true;
              resumedSession = false;
              await ctx.onLog(
                "stdout",
                `[paperclip] ACPX resume session "${resumeSessionId}" is unavailable; retrying with a fresh session.\n`,
              );
              // Fresh-session retry: the runtime was already constructed on the
              // first attempt (never re-created), so this event reports only its
              // own `ensureSessionMs` — no `createRuntimeMs`.
              let retryEnsureSessionMs: number | undefined;
              handle = await measureStartupStep(ctx, now, "acp.handshake", async () => {
                const ensureSessionStart = now();
                const established = await runtime.ensureSession({
                  sessionKey: prepared.sessionKey,
                  agent: prepared.acpxAgent,
                  mode: prepared.mode,
                  cwd: prepared.cwd,
                  sessionOptions: { env: prepared.env },
                });
                retryEnsureSessionMs = now() - ensureSessionStart;
                return established;
              }, {
                ...prepared.stepMetrics,
                // The retry reuses the runtime from the first attempt, so it reports
                // only its own ensure-session sub-time on the span.
                spanWallTimes: () => ({ ensureSession: retryEnsureSessionMs }),
              });
            }
          } else {
            // Warm-handle hit: a compatible cached handle reuses the running ACP
            // agent, so the `acp.handshake` step does no work. Emit a step span and
            // event with `outcome = skipped` and a zero wall time, so the trace and
            // the run log show the skip as a distinct outcome, never a misleading
            // zero-work `ok` step.
            await emitSkippedStartupStep(ctx, "acp.handshake", {
              tracer: prepared.stepMetrics.tracer,
              parentContext: prepared.stepMetrics.parentContext,
            });
          }
          // A compatible warm handle reuses the already-running ACP agent and does
          // not emit another spawn event. Persist its known identity on this run
          // before the next prompt starts so every running heartbeat is adoptable.
          if (handle && cached && processIdentitySink.latest && ctx.onSpawn) {
            await ctx.onSpawn({
              pid: processIdentitySink.latest.pid,
              processGroupId: null,
              startedAt: processIdentitySink.latest.startedAt,
            });
          }
        } catch (err) {
          // Record how the settlement closes the runtime on a pre-turn handshake
          // failure: a direct close that drops a matching warm entry, the same as
          // the configuration-failure path. A warm-hit reuse already cleared the
          // idle timer before the handshake ran, so the failure must close and
          // remove the entry, never re-arm it. A cold `ensureSession` throw has no
          // established handle, so the settlement closes the synthetic handle — the
          // ledger now holds the runtime, so `endSession` closes it and the former
          // cold-handshake leak is gone. The settlement stops the bridges, releases
          // the staging lease, and flushes the child stderr on every exit path.
          runtimeSettlement = {
            mode: "direct",
            handle: handle ?? syntheticCloseHandle(),
            reason: "paperclip handshake cleanup",
            discardPersistentState: false,
            dropWarmEntry: true,
            recordCloseError: true,
            cancelTurnReason: null,
          };
          await emitPhase("ensure_session", ensureSessionPhaseStart, "failed");
          const { classified, message } = await emitAcpxFailure({
            ctx,
            prepared,
            err,
            phase: "ensure_session",
          });
          capturedResult = {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage: message,
            ...classified,
            ...billingFields,
            ...referencedProjectStagingFailuresField,
            model: prepared.requestedModel || null,
            clearSession,
            resultJson: { phase: "ensure_session" },
            summary: message,
          };
          return settleFor("handshake", err);
        }

        if (!handle) {
          // ensureSession returned no session handle. The ledger holds the runtime
          // the run constructed, so record a direct close of the synthetic handle
          // for the settlement `endSession` step (the child process cannot leak).
          runtimeSettlement = {
            mode: "direct",
            handle: syntheticCloseHandle(),
            reason: "paperclip missing-handle cleanup",
            discardPersistentState: false,
            dropWarmEntry: false,
            recordCloseError: true,
            cancelTurnReason: null,
          };
          await emitPhase("ensure_session", ensureSessionPhaseStart, "failed");
          capturedResult = {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage: "ACPX did not return a runtime session handle.",
            errorCode: "acpx_runtime_error",
            ...billingFields,
            ...referencedProjectStagingFailuresField,
            model: prepared.requestedModel || null,
            resultJson: { phase: "ensure_session" },
            summary: "ACPX did not return a runtime session handle.",
          };
          return settleFor(
            "session_handle_missing",
            new Error("ACPX did not return a runtime session handle."),
          );
        }
        sessionHandle = handle;
        startupFailed = false;
        await emitPhase("ensure_session", ensureSessionPhaseStart, "ok");
      } catch (err) {
        if (!buildRuntimeSettled) {
          // buildRuntime failed before it staged or bridged anything, so there is
          // nothing to settle here. The finally below ends the sandbox.startup
          // span; let the failure propagate.
          throw err;
        }
        // The post-build runtime-creation window failed after buildRuntime returned
        // live bridges and a held staging lease. `createRuntime` throws before the
        // ledger registers the runtime, so the settlement `endSession` step no-ops
        // on the empty slot (create_runtime never closes a runtime). The settlement
        // still stops the bridges, discards the staged runtime, releases the staging
        // lease, and flushes the child stderr.
        const { classified, message } = await emitAcpxFailure({
          ctx,
          prepared,
          err,
          phase: "create_runtime",
        });
        capturedResult = {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: message,
          ...classified,
          ...billingFields,
          ...referencedProjectStagingFailuresField,
          model: prepared.requestedModel || null,
          clearSession,
          resultJson: { phase: "create_runtime" },
          summary: message,
        };
        return settleFor("runtime_create", err);
      } finally {
        // End the sandbox.startup span exactly once, on every return and on every
        // throw. It covers buildRuntime through acp.handshake and no further; the
        // agent turn runs after and is out of the span's scope.
        rootSpan.end(startupFailed);
      }
      const configureSessionStart = now();
      try {
        await applySessionConfigOptions({
          runtime,
          handle: sessionHandle,
          prepared,
          onLog: ctx.onLog,
        });
        await emitPhase("configure_session", configureSessionStart, "ok");
      } catch (err) {
        // Record a direct close that drops the matching warm entry for the
        // settlement `endSession` step. The settlement stops the bridges, discards
        // the staged runtime, releases the staging lease, and flushes the child
        // stderr on this exit path too.
        runtimeSettlement = {
          mode: "direct",
          handle: sessionHandle,
          reason: "paperclip config cleanup",
          discardPersistentState: false,
          dropWarmEntry: true,
          recordCloseError: true,
          cancelTurnReason: null,
        };
        await emitPhase("configure_session", configureSessionStart, "failed");
        const { classified, message } = await emitAcpxFailure({
          ctx,
          prepared,
          err,
          phase: "configure_session",
        });
        capturedResult = {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: message,
          ...classified,
          ...billingFields,
          ...referencedProjectStagingFailuresField,
          model: prepared.requestedModel || null,
          clearSession,
          resultJson: {
            phase: "configure_session",
            agent: prepared.acpxAgent,
            requestedModel: prepared.requestedModel || null,
            requestedThinkingEffort: prepared.requestedThinkingEffort || null,
            fastMode: prepared.fastMode,
          },
          summary: message,
        };
        return settleFor("session_configuration", err);
      }
      // Startup succeeded: seal the ledger (promotes the startup_rollback entries
      // that survived to `per_run`) and hand the ready resources to the turn. The
      // turn wrapper reads the run state through the shared closure locals in this
      // phase, so the sealed view and the context are the contract carriers only.
      return {
        kind: "ready",
        resources: runResourceLedger.seal([]),
        context: { sessionKey: prepared.sessionKey } as unknown as AcpRunContext,
      };
      };
      // The turn step: run the turn sequence and settle the runtime inline
      // (today's behavior). The sequence owns the wall-clock timer and the abort
      // controller and never rejects; it returns a `TurnCompletion`. The step
      // bodies below record the external result for the coordinator to reproduce.
      const runTurn = async (_ready: StartupReady): Promise<TurnCompletion> => {
      // Summary accumulation collects output text only (never thought stream),
      // segmented on tool starts so multi-step narration is not glued into one
      // automatic comment dump.
      const outputSegments: string[] = [];
      let currentOutputChunk: string[] = [];
      const flushOutputSegment = () => {
        if (currentOutputChunk.length === 0) return;
        outputSegments.push(currentOutputChunk.join(""));
        currentOutputChunk = [];
      };
      let eventBreakdown: AcpRuntimeUsageBreakdown | null = null;
      let eventCostUsd: number | null = null;
      // The turn-local state the sequence steps share. `promptBuild` sets the
      // prompt, `preTurnUsage` sets the pre-turn status, `turnStart` sets the
      // active turn, and `turnFinalize` reads all three. `activeTurn` is the run-
      // scoped hoisted local, so the settlement `endSession` step can cancel it.
      let runPrompt = "";
      let preTurnStatus: AcpRuntimeStatus | null = null;
      // Phase-timing markers for the prepare_turn and turn phases. The prepare
      // phase covers the prompt build and the pre-turn usage snapshot; the turn
      // phase covers the started turn and the event relay.
      let preparePhaseStart = now();
      let turnPhaseStart = now();
      // Open the agent turn span as a child of the run root span. It wraps the
      // whole turn: the executor holds `turnSpan.parentContext` for later exec
      // parenting, and the `finally` below ends the span once on every path. The
      // span is declared before the `try` so the `finally` can reach it.
      const turnSpan = openTurnSpan(tracing, now, runRootSpan.parentContext);
      // Switch the current-run holder to the `agent.turn` token for the turn, so
      // a detached exec during the turn parents to `agent.turn`. The turn
      // `finally` resets the holder to the `task.run` token.
      currentRunParentContext = turnSpan.parentContext;
      const stepPromptBuild = async (_signal: AbortSignal): Promise<void> => {
        // Build the prompt and emit the run metadata inside the turn failure
        // boundary. A failure here returns an error result with phase
        // `prepare_turn`.
        preparePhaseStart = now();
        const { prompt, promptMetrics, commandNotes } = await buildPrompt(ctx, resumedSession, prepared.env);
        runPrompt = joinPromptSections([prepared.skillPromptInstructions, prompt]);
        await emitAcpxLog(ctx, {
          type: "acpx.session",
          agent: prepared.acpxAgent,
          sessionId: sessionHandle.backendSessionId,
          acpSessionId: sessionHandle.backendSessionId,
          agentSessionId: sessionHandle.agentSessionId,
          runtimeSessionName: sessionHandle.runtimeSessionName,
          mode: prepared.mode,
          permissionMode: prepared.permissionMode,
          model: prepared.requestedModel || null,
          thinkingEffort: prepared.requestedThinkingEffort || null,
          fastMode: prepared.fastMode,
        });
        if (ctx.onMeta) {
          await ctx.onMeta({
            adapterType: engine.adapterType,
            command: prepared.agentCommand ?? prepared.acpxAgent,
            cwd: prepared.cwd,
            commandNotes: [
              `ACPX runtime embedded in Paperclip with ${prepared.mode} session mode.`,
              `Effective ACPX permission mode: ${prepared.permissionMode}.`,
              ...(prepared.requestedModel
                ? [
                    prepared.acpxAgent === "claude"
                      ? `Requested ACPX model: ${prepared.requestedModel} (set via ANTHROPIC_MODEL env at startup).`
                      : prepared.acpxAgent === "codex"
                        ? `Requested ACPX model: ${prepared.requestedModel} (set via CODEX_CONFIG at startup).`
                      : `Requested ACPX model: ${prepared.requestedModel}.`,
                  ]
                : []),
              ...(prepared.requestedThinkingEffort ? [`Requested ACPX thinking effort: ${prepared.requestedThinkingEffort}.`] : []),
              ...(prepared.fastMode ? ["Requested ACPX Codex fast mode."] : []),
              ...(Array.isArray(prepared.skillsIdentity.commandNotes)
                ? prepared.skillsIdentity.commandNotes.filter((note): note is string => typeof note === "string")
                : []),
              ...commandNotes,
            ],
            env: prepared.loggedEnv,
            prompt: runPrompt,
            promptMetrics,
            context: ctx.context,
          });
        }
      };
      const stepPreTurnUsage = async (): Promise<void> => {
        // Snapshot pre-turn usage so cumulative agent-reported cost can be
        // attributed to this run alone.
        preTurnStatus = await readRuntimeStatus(runtime, sessionHandle);
        // The prepare phase (prompt build + usage snapshot) finished; the turn
        // phase starts next.
        await emitPhase("prepare_turn", preparePhaseStart, "ok");
        turnPhaseStart = now();
      };
      const stepTurnStart = (signal: AbortSignal, startTimeoutMs: number | undefined): StartedTurn => {
        const turn = runtime.startTurn({
          handle: sessionHandle,
          text: runPrompt,
          mode: "prompt",
          requestId: ctx.runId,
          timeoutMs: startTimeoutMs,
          signal,
        });
        activeTurn = turn;
        return {
          cancel: async (reason: string) => {
            await turn.cancel({ reason });
          },
        };
      };
      const stepEventRelay = async (): Promise<AcpRuntimeTurnResult> => {
        const turn = activeTurn as AcpRuntimeTurn;
        const toolTitles = new Map<string, string>();
        for await (const event of turn.events) {
          if (event.type === "text_delta" && event.stream !== "thought") {
            currentOutputChunk.push(event.text);
          } else if (event.type === "tool_call" && event.tag !== "tool_call_update") {
            // ACP makes tool-call status optional. The normalized event tag is
            // the reliable boundary between an initial call and its updates,
            // so a statusless initial call must still end the preceding output
            // segment while updates must not create extra boundaries.
            flushOutputSegment();
          }
          if (event.type === "status" && event.tag === "usage_update") {
            eventBreakdown = event.breakdown ?? eventBreakdown;
            eventCostUsd = usdCostAmount(event.cost) ?? eventCostUsd;
          }
          await emitRuntimeEvent(ctx, event, toolTitles, prepared.coalescePlaceholderToolUpdates);
        }
        flushOutputSegment();
        return await turn.result;
      };
      const stepTurnFinalize = async (
        input: TurnFinalizeInput<AcpRuntimeTurnResult>,
      ): Promise<TurnCompletion> => {
        if (input.kind === "terminal") {
        const terminal = input.terminal;
        const timedOut = input.timedOut;
        // Read the sandbox duplex control-channel disposition at the ACP
        // terminal-finalization boundary, before the bridge teardown. A control
        // channel that died mid-turn latches a failure with a typed loss reason;
        // a healthy channel or a normal-teardown loss reports a success. Only a
        // nominally completed, non-timed-out terminal is success-eligible, so the
        // seam reads the disposition only there. For that success-eligible
        // terminal the seam marks the host-observed orderly completion, so a later
        // teardown loss cannot flip the run to a failure. The file bridge path
        // never sets these methods, so the optional calls no-op there.
        let duplexLossReason: DuplexLossReason | null = null;
        if (terminal.status === "completed" && !timedOut) {
          // Success-eligible terminal. Atomically read the disposition and mark
          // the orderly completion in one broker step. No `await` separates the
          // read from the mark, so a teardown loss cannot slip in between them. A
          // latched loss fails the run closed; a healthy channel marks its
          // orderly completion, so a later teardown loss stays a normal teardown.
          const disposition = prepared.paperclipBridge?.settleRunDisposition?.() ?? null;
          if (disposition?.failed) {
            duplexLossReason = disposition.lossReason ?? "other";
          }
        } else {
          // Non-success-eligible terminal (failed, cancelled, or timed out). A
          // deliberate host teardown follows, so mark the orderly completion now.
          // This stops the teardown `channel_exit` from latching `lossSeq`, from
          // emitting a false loss event, and from incrementing the loss counters.
          // The mark no-ops once a loss latched, so a real mid-run loss still
          // fails the run.
          prepared.paperclipBridge?.markOrderlyCompletion?.();
        }
        // A terminal that reports "completed" but whose duplex control channel
        // died before the completion is not a success. The seam fails it closed.
        const channelLost = duplexLossReason !== null;
        // Build the boundary failure message only from the closed loss-reason
        // enum, so no raw provider text rides the message.
        const channelLostMessage = duplexLossReason
          ? `The sandbox duplex control channel was lost (${duplexLossReason}) before the run completed.`
          : null;
        // A completed, non-timed-out turn whose channel stayed live is the one
        // success path. Every other outcome — a failed, cancelled, or timed-out
        // terminal, or a completed terminal with a lost channel — is a failure.
        const turnSucceeded = terminal.status === "completed" && !timedOut && !channelLost;
        // Read usage before the settlement can discard runtime state.
        const postTurnStatus = await readRuntimeStatus(runtime, sessionHandle);
        const turnUsage = summarizeAcpxTurnUsage({
          preStatus: preTurnStatus,
          postStatus: postTurnStatus,
          eventBreakdown,
          eventCostUsd,
        });
        const failedTurn = terminal.status === "failed" || terminal.status === "cancelled" || timedOut;
        // Record how the settlement `endSession` step closes the runtime for this
        // outcome. A clean persistent host turn is save-eligible, but the
        // Amendment B credential gate fails on the host lane (the run API key is
        // never revoked), so the reuse decision discards and `endSession` closes it
        // (close-and-relaunch). The sandbox lane always closes the runtime; its
        // staged files are the reuse. A matching warm entry closes through the warm
        // store (which also flushes its stderr); otherwise the runtime closes
        // directly. The settlement then stops the bridges, saves or discards the
        // staged runtime, releases the staging lease, and flushes the child stderr.
        runtimeSettlement = {
          mode: "warm_or_close",
          handle: sessionHandle,
          reason: timedOut
            ? "paperclip timeout cleanup"
            : channelLost
              ? "paperclip duplex channel lost cleanup"
              : failedTurn
                ? `paperclip turn ${terminal.status}`
                : "paperclip completed turn cleanup",
          discardPersistentState: terminal.status === "cancelled" || timedOut || channelLost,
          dropWarmEntry: false,
          recordCloseError: false,
          cancelTurnReason: null,
        };

        const errorMessage = timedOut
          ? formatAdapterExecutionTimeoutErrorMessage(prepared.timeoutResolution)
          : channelLost
            ? channelLostMessage
            : resultErrorMessage(terminal);
        const terminalStopReason = terminal.status === "failed" ? terminal.error.message : terminal.stopReason;
        await emitAcpxLog(ctx, {
          type: turnSucceeded ? "acpx.result" : "acpx.error",
          summary: channelLost ? "duplex_channel_lost" : terminal.status,
          stopReason: terminalStopReason,
          message: errorMessage,
        });
        // The one clean-completion path clears the run failure flag; every other
        // path keeps it set, so the run root span closes with error status. A
        // completed terminal with a lost duplex channel keeps the flag set.
        runFailed = turnSucceeded ? false : true;
        capturedResult = {
          exitCode: turnSucceeded ? 0 : 1,
          signal: timedOut ? "SIGTERM" : null,
          timedOut,
          errorMessage,
          errorCode: terminal.status === "failed"
            ? "acpx_turn_failed"
            : timedOut
              ? "acpx_timeout"
              : channelLost
                ? DUPLEX_CHANNEL_LOST_ERROR_CODE
                : null,
          sessionId: sessionHandle.backendSessionId ?? sessionHandle.runtimeSessionName,
          sessionParams: buildSessionParams({ prepared, handle: sessionHandle }),
          sessionDisplayId: sessionHandle.agentSessionId ?? sessionHandle.backendSessionId ?? sessionHandle.runtimeSessionName,
          ...billingFields,
          ...referencedProjectStagingFailuresField,
          model: prepared.requestedModel || null,
          ...(turnUsage.usage ? { usage: turnUsage.usage, usageBasis: "per_run" as const } : {}),
          costUsd: turnUsage.costUsd,
          resultJson: {
            status: channelLost ? "failed" : terminal.status,
            stopReason: terminalStopReason,
            permissionMode: prepared.permissionMode,
            mode: prepared.mode,
            requestedModel: prepared.requestedModel || null,
            requestedThinkingEffort: prepared.requestedThinkingEffort || null,
            fastMode: prepared.fastMode,
            ...(turnUsage.usageDetail ? { usage: turnUsage.usageDetail } : {}),
            ...(turnUsage.cumulativeCostUsd != null
              ? { cumulativeCostUsd: turnUsage.cumulativeCostUsd }
              : {}),
          },
          summary: buildAcpxRunSummary({
            outputSegments,
            fallback: terminalStopReason || terminal.status,
          }),
          clearSession,
        };
        // The turn phase finished. A completed, non-timed-out turn with a live
        // duplex channel is `ok`; every other terminal outcome is `failed`.
        await emitPhase(
          "turn",
          turnPhaseStart,
          turnSucceeded ? "ok" : "failed",
        );
        // Return the typed turn completion so the coordinator settles for the right
        // cause. The completion carries no live resources; the settlement claims the
        // ledger and owns the release. A clean completed turn carries no cause, so
        // the reuse decision can permit a save; a timed-out, failed, or cancelled
        // turn carries its cause, which forbids the save.
        if (timedOut) {
          return {
            kind: "timed_out",
            cause: { kind: "turn_timed_out", timeoutSec: prepared.timeoutSec },
            resources: emptyConsumed,
          };
        }
        if (terminal.status === "failed") {
          return {
            kind: "failed",
            cause: {
              kind: "turn_failed",
              error: terminal.error instanceof Error ? terminal.error : new Error(String(terminal.error)),
            },
            resources: emptyConsumed,
          };
        }
        if (terminal.status === "cancelled") {
          return {
            kind: "cancelled",
            cause: { kind: "turn_cancelled", reason: terminal.stopReason ?? "cancelled" },
            resources: emptyConsumed,
          };
        }
        // A completed terminal whose duplex control channel died mid-turn returns
        // a failed completion, so the coordinator settles for a failure and the
        // reuse decision forbids a save. The message carries only the typed loss
        // reason, so no raw provider text rides the cause.
        if (channelLost) {
          return {
            kind: "failed",
            cause: {
              kind: "turn_failed",
              error: new Error(channelLostMessage ?? "The sandbox duplex control channel was lost."),
            },
            resources: emptyConsumed,
          };
        }
        return { kind: "finalized" };
        }
        const err = input.error;
        const timedOut = input.timedOut;
        // The failure phase comes from the sequence: a failure before the turn
        // started is `prepare_turn`; a failure after it is `turn`. The teardown is
        // the same; only the reported phase differs.
        const phase: AcpxExecutionPhase = input.phase;
        // Emit the failed phase timing for the phase the sequence reported.
        if (phase === "prepare_turn") {
          await emitPhase("prepare_turn", preparePhaseStart, "failed");
        } else {
          await emitPhase("turn", turnPhaseStart, "failed");
        }
        const messageOverride = timedOut
          ? formatAdapterExecutionTimeoutErrorMessage(prepared.timeoutResolution)
          : undefined;
        const preEmitMessage =
          messageOverride ?? (err instanceof Error ? err.message : String(err));
        // Record a direct close for the settlement `endSession` step: cancel the
        // running turn first (cancel-before-close), then close the runtime and drop
        // a matching warm entry. The settlement discards the staged runtime, stops
        // the bridges, releases the staging lease, and flushes the child stderr.
        runtimeSettlement = {
          mode: "direct",
          handle: sessionHandle,
          reason: timedOut ? "paperclip timeout cleanup" : "paperclip error cleanup",
          discardPersistentState: timedOut,
          dropWarmEntry: true,
          recordCloseError: true,
          cancelTurnReason: preEmitMessage,
        };
        // Emit the failure best-effort. `turnFinalize` must not reject, so a
        // failing emission never propagates: the settlement owns the teardown, and
        // it runs only after this returns a completion. On an emission failure the
        // run records a degraded result from the pre-emit message.
        let emitted: Awaited<ReturnType<typeof emitAcpxFailure>> | null = null;
        try {
          emitted = await emitAcpxFailure({ ctx, prepared, err, phase, messageOverride });
        } catch {
          emitted = null;
        }
        const message = emitted?.message ?? preEmitMessage;
        capturedResult = {
          exitCode: 1,
          signal: timedOut ? "SIGTERM" : null,
          timedOut,
          errorMessage: message,
          errorCode: timedOut ? "acpx_timeout" : (emitted?.classified.errorCode ?? null),
          errorMeta: emitted?.classified.errorMeta,
          ...billingFields,
          ...referencedProjectStagingFailuresField,
          model: prepared.requestedModel || null,
          clearSession: clearSession || timedOut,
          resultJson: { phase },
          summary: message,
        };
        // Return a typed failed completion so the coordinator settles for a cause
        // that forbids the save. The reported phase lives on the recorded result.
        return {
          kind: "failed",
          cause: { kind: "turn_failed", error: err instanceof Error ? err : new Error(String(err)) },
          resources: emptyConsumed,
        };
      };
      try {
        return await runTurnSequence<AcpRuntimeTurnResult>({
          timeoutMs: prepared.timeoutSec > 0 ? prepared.timeoutSec * 1000 : undefined,
          timeoutMessage: formatAdapterExecutionTimeoutErrorMessage(prepared.timeoutResolution),
          promptBuild: stepPromptBuild,
          preTurnUsage: stepPreTurnUsage,
          turnStart: stepTurnStart,
          eventRelay: stepEventRelay,
          turnFinalize: stepTurnFinalize,
        });
      } finally {
        // End the agent turn span exactly once, on every return and on a throw.
        // `runFailed` is `false` only on a completed, non-timed-out turn, so the
        // span status is correct for success, error, and timeout.
        turnSpan.end(runFailed);
        // Reset the current-run holder to the `task.run` token after the turn.
        // The run stays live here, so the holder is never `undefined`. A detached
        // exec after the turn parents to `task.run`.
        currentRunParentContext = runRootSpan.parentContext;
      }
      };
      // A live run-scoped credential marker. The host-lane reuse candidate carries
      // it, so the Amendment B credential gate blocks the host warm save: the
      // run-minted API key is never revoked, so it stays valid and forces a
      // close-and-relaunch. It is a non-secret marker; the settlement reads only its
      // presence, and no report or reuse payload carries it.
      const LIVE_RUN_SCOPED_API_KEY = "paperclip-run-scoped-api-key";
      // Record the final per-resource disposition report where a test can observe
      // it. The engine never reads it back.
      const recordDispositionReport = (report: SettlementDispositionReport): void => {
        deps.onSettlementDisposition?.(report);
      };
      // The settlement sequence is the one live cleanup owner for every settled path
      // (Phase 22). It claims the ledger once, makes the pure reuse decision, then
      // runs the ordered steps: `endSession`, `settleReuse`, `stopTransport`,
      // `syncBack`, and `releaseStagingLease` (in a finally). Each step reads the run
      // state through the shared closure locals and no-ops on an empty ledger slot.
      // The Phase 3 error policy governs every step. The coordinator alone owns the
      // startup rollback.
      const settlementSteps: SettlementSteps = {
        // Derive the reuse candidate. Only a clean turn (no cause) can save. The
        // host lane would save the live runtime, but the Amendment B credential gate
        // fails there: the run-minted API key is never revoked, so a live run-scoped
        // credential stays valid and the decision discards (close-and-relaunch). The
        // sandbox lane saves its staged files, which carry no credential.
        reuseCandidate: (slots, cause) => {
          const clean = cause === null;
          if (prepared.processSessionBridge) {
            // Sandbox lane: the staged files are the reuse. Save only after a clean
            // turn and only when the run holds a staged runtime.
            if (!clean || !slots.has("staged_runtime")) return null;
            return { kind: "sandbox", causePermitsSave: true, liveRunScopedCredentials: [] };
          }
          // Host lane: save a clean persistent warm-eligible turn, but carry the
          // live run-scoped credential so the gate blocks the transfer.
          if (!slots.has("acp_runtime")) return null;
          const permits = clean && prepared.mode === "persistent" && warmIdleMs > 0;
          if (!permits) return null;
          return { kind: "host", causePermitsSave: true, liveRunScopedCredentials: [LIVE_RUN_SCOPED_API_KEY] };
        },
        // Close every runtime the decision did not transfer, and drop the warm entry
        // on close.
        endSession: (slots, decision) => timedPhase("end_session", async () => {
          if (!slots.has("acp_runtime")) return;
          if (decision.kind === "save" && decision.savedId === "acp_runtime") return;
          const settlement: RuntimeSettlementPlan = runtimeSettlement ?? {
            mode: "direct",
            handle: syntheticCloseHandle(),
            reason: "paperclip cleanup",
            discardPersistentState: false,
            dropWarmEntry: false,
            recordCloseError: true,
            cancelTurnReason: null,
          };
          // Cancel a running turn before the close (the turn-error path).
          if (settlement.cancelTurnReason && activeTurn) {
            await activeTurn.cancel({ reason: settlement.cancelTurnReason }).catch(() => {});
          }
          const existing = warmHandles.get(prepared.sessionKey);
          if (
            settlement.mode === "warm_or_close" &&
            warmHandleMatches(existing, runtime, settlement.handle) &&
            existing
          ) {
            // A matching warm entry closes through the warm store, which also
            // clears its idle timer and flushes its child stderr.
            await closeWarmHandle({
              handles: warmHandles,
              key: prepared.sessionKey,
              entry: existing,
              reason: settlement.reason,
              discardPersistentState: settlement.discardPersistentState,
            });
            return;
          }
          const onCloseError = settlement.recordCloseError
            ? (closeErr: unknown) => recordTeardownError("runtime-close", closeErr)
            : () => {};
          await runtime
            .close({
              handle: settlement.handle,
              reason: settlement.reason,
              discardPersistentState: settlement.discardPersistentState,
            })
            .catch(onCloseError);
          if (settlement.dropWarmEntry && warmHandleMatches(existing, runtime, settlement.handle) && existing) {
            clearWarmHandleTimer(existing);
            warmHandles.delete(prepared.sessionKey);
          }
        }),
        // Perform the reuse decision. A save transfers the staged files to the site
        // store (which arms the idle policy); every other case discards the staged
        // runtime. The host warm save is closed in `endSession`.
        settleReuse: (slots, decision) => timedPhase("settle_reuse", async () => {
          if (!slots.has("staged_runtime")) return;
          if (decision.kind === "save" && decision.savedId === "staged_runtime") {
            saveStagedRuntimeAfterCleanTurn({ handles: stagedRuntimes, prepared, now: now() });
            return;
          }
          await discardStagedRuntime({ handles: stagedRuntimes, prepared });
        }),
        // Stop both bridges in one allSettled.
        stopTransport: () => timedPhase("stop_transport", async () => {
          await stopRunTransport(prepared);
        }),
        // The site sync-back (the managed-home copy-back). The run-parented span
        // runner wraps the restore in a `sandbox.syncBack` span. The runner also
        // publishes the run parent into the runtime-parent store while the restore
        // runs, so the host mints a `traceparent` for the provider spans, and the
        // per-task restore spans parent to `sandbox.syncBack`.
        syncBack: () => timedPhase("sync_back", async () => {
          await runRuntimeSpan("sandbox.syncBack", async () => {
            await syncBackManagedHome(prepared);
          });
        }),
        // The staging lease releases as the run's final act, AFTER the coordinator
        // reproduces the result, in the run root `finally` below. This step stays a
        // no-op in the live engine: a same-session second run must stay blocked on
        // the lease until this run fully returns, not merely until the settlement
        // sync-back finishes, so the release cannot move earlier into settlement.
        releaseStagingLease: () => {},
        recordError: async (step, error) => {
          await recordTeardownError(`settlement-${step}`, error);
        },
      };
      // Drive the attempt through the coordinator routing table. The startup step
      // returns `ready` or `settle` (or throws on a build or partial-bridge
      // failure); the coordinator runs the turn on the ready path, settles, then
      // reproduces the recorded result.
      const plan: RunPlan<AdapterExecutionResult> = {
        ledger: runResourceLedger,
        startup,
        runTurn,
        // The coordinator owns the startup rollback: `buildRuntime` runs its own
        // partial-bring-up rollback and throws, so no ledger resource is left to
        // release here.
        rollbackStartup: () => {},
        recordDisposition: recordDispositionReport,
        // The settlement sequence is the one live cleanup owner. It claims the
        // ledger, releases every settled resource, and returns the final
        // disposition report. The child stderr flushes after the sync-back on every
        // settled exit path (it stays null before the run reads the warm entry).
        settle: async (reason: SettlementReason) => {
          const cause: SettlementCause | null =
            reason.kind === "pre_turn"
              ? reason.cause
              : reason.completion.kind === "finalized"
                ? null
                : reason.completion.cause;
          const report = await settleAcpRun(runResourceLedger, cause, settlementSteps);
          recordDispositionReport(report);
          if (childStderrState) flushChildStderr(childStderrState);
        },
        reproduceResult: (): AdapterExecutionResult => {
          if (!capturedResult) {
            throw new Error("run coordinator reproduced a result before the run recorded one");
          }
          return capturedResult;
        },
      };
      return await runAttempt(plan);
    } finally {
      // End the run root span exactly once, on every return and on a throw.
      runRootSpan.end(runFailed);
      // Release the per-session staging lease as the run's final act, AFTER the
      // coordinator settled every other resource and reproduced the result. It runs
      // last, in this `finally`, so a same-session second run stays blocked on the
      // lease until this run fully returns (not merely until the settlement
      // sync-back finishes) and an earlier teardown fault never strands the lease.
      // It stays null on a build failure (where `buildRuntime` released its own
      // partial lease) and on the host lane (no staging). The settlement stopped the
      // bridges and ran the sync-back before this point, so the ordering is
      // bridge-stop → sync-back → lease release.
      const leaseRelease = releaseStagingLease as (() => void) | null;
      if (leaseRelease) {
        const leaseStart = now();
        leaseRelease();
        // Fire-and-forget the phase timing: the release is the run's final act, so
        // the run must not await telemetry here. `emitRunPhaseTiming` swallows a
        // sink failure, so this never rejects.
        void emitRunPhaseTiming(ctx, "release_staging_lease", now() - leaseStart, "ok");
      }
    }
  };
}


export const execute = createAcpxEngineExecutor();
