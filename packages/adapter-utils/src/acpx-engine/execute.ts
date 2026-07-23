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
  formatAdapterExecutionTimeoutErrorMessage,
  formatAdapterExecutionTimeoutStartLogLine,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeout,
  startAdapterExecutionTargetPaperclipBridge,
  startAdapterExecutionTargetProcessSessionBridge,
  type AdapterExecutionTarget,
  type AdapterExecutionTargetPaperclipBridgeHandle,
  type AdapterExecutionTargetProcessSessionBridgeHandle,
  type AdapterExecutionTargetTimeoutResolution,
  type AdapterManagedRuntimeAsset,
  type PreparedAdapterExecutionTargetRuntime,
} from "@paperclipai/adapter-utils/execution-target";
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

const defaultModuleDir = path.dirname(fileURLToPath(import.meta.url));
const PAPERCLIP_MANAGED_CODEX_SKILLS_MANIFEST = ".paperclip-managed-skills.json";
const BENIGN_NES_CLOSE_STDERR = /method: ['"]nes\/close['"].*-32601/;

interface ChildStderrState {
  logPath: string | null;
  pendingLiveLine: string;
}

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

type AcpxRuntimeFactory = (options: AcpRuntimeOptions) => AcpRuntime;

export interface RuntimeCacheEntry {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  childStderrState: ChildStderrState;
  fingerprint: string;
  lastUsedAt: number;
  cleanupTimer?: NodeJS.Timeout;
}

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
}

interface AcpxPreparedRuntime {
  acpxAgent: string;
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
  // exit path by `cleanupRemoteBridges`; it never removes staged temp, so it is
  // safe on every compatible resume. Null for local runs, the runner-less
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
}): Promise<{ identity: Record<string, unknown>; commandNotes: string[] }> {
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
  await reconcileManagedCodexSkills({
    skillsHome,
    allSkills,
    selectedSkills,
    onLog: input.onLog,
  });

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
  onLog: AdapterExecutionContext["onLog"];
  onRuntimeProgress: AdapterExecutionContext["onRuntimeProgress"];
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
    onProgress: (line) => input.onLog("stdout", line),
    onRuntimeProgress: input.onRuntimeProgress,
  });
}

async function buildRuntime(input: {
  ctx: AdapterExecutionContext;
  engine: AcpxEngineSettings;
  deps: AcpxEngineExecutorOptions;
}): Promise<AcpxPreparedRuntime> {
  const { runId, agent, config, context, authToken } = input.ctx;
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
  const shapedWorkspaceEnv = shapePaperclipWorkspaceEnvForExecution({
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceWorktreePath,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const acpxAgent = normalizeAgent(config);
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
    const preparedSkills = await prepareCodexSkillRuntime({
      companyId: agent.companyId,
      config,
      env,
      moduleDir: input.engine.moduleDir,
      onLog: input.ctx.onLog,
    });
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
  const fingerprint = shortHash({
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
  });
  const taskKey = asString(input.ctx.runtime.taskKey, "") || wakeTaskId || workspaceId || "default";
  const sessionKey = `paperclip:${agent.companyId}:${agent.id}:${taskKey}:${fingerprint}`;

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
  const nowMs = input.deps.now ?? (() => Date.now());
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
  if (useRemoteProcessSession && executionTarget?.kind === "remote") {
    const remoteTarget = executionTarget;
    const staged = await withSessionStagingLease(stagingLocks, sessionKey, async (): Promise<{
      stagedRuntime: PreparedAdapterExecutionTargetRuntime;
      teardown: (() => Promise<void>) | null;
      dispose: (() => Promise<void>) | null;
      envDelta: Record<string, string>;
    }> => {
      const cachedStaged = isCompatibleResume ? stagedRuntimes.get(sessionKey) : undefined;
      if (cachedStaged) {
        // Reuse the already-staged in-sandbox workspace + managed home. Re-apply
        // the env keys the seam repointed onto the in-sandbox home (deterministic,
        // identical across the session's runs) and reuse the seam's per-run
        // copy-back so the codex auth copy-back still fires on THIS run's teardown
        // — the copy-back cadence stays exactly per-run, unchanged from PR 2. The
        // copy-back reads the sandbox auth.json live at teardown, so the reused
        // closure copies back the current credential, never a stale snapshot, and
        // it never removes the staged in-sandbox home (host staged-temp cleanup
        // moved to `dispose`, fired only when the entry is dropped), so reusing it
        // can't leave this run without its staged home.
        // (The workspace restore in that same closure diffs against the ORIGINAL
        // staging run's host baseline — an accepted consequence of "reuse, don't
        // re-ship": the in-sandbox workspace is the source of truth mid-session
        // and the host stays synced from it each run.)
        Object.assign(env, cachedStaged.envDelta);
        cachedStaged.lastUsedAt = nowMs();
        await input.ctx.onLog(
          "stdout",
          "[paperclip] Reusing the staged in-sandbox runtime for this resumed session (no workspace re-ship / managed-home re-seed).\n",
        );
        return {
          stagedRuntime: cachedStaged.stagedRuntime,
          teardown: cachedStaged.teardown,
          dispose: cachedStaged.dispose,
          envDelta: cachedStaged.envDelta,
        };
      }
      // Not a compatible resume (or no cache entry): stage fresh. If a stale
      // entry sits at this key (e.g. an incompatible new session colliding on
      // company/agent/task/fingerprint), drop it and release its host staged
      // resources first so we neither reuse nor leak it.
      const stale = stagedRuntimes.get(sessionKey);
      if (stale) {
        stagedRuntimes.delete(sessionKey);
        if (stale.dispose) await stale.dispose().catch(() => {});
      }
      const stage = (assets: AdapterManagedRuntimeAsset[]) =>
        stageAcpRemoteRuntime({
          runId,
          target: remoteTarget,
          adapterKey: input.engine.adapterType,
          workspaceLocalDir: cwd,
          workspaceRemoteDir: sessionCwd,
          timeoutSec,
          assets,
          onLog: input.ctx.onLog,
          onRuntimeProgress: input.ctx.onRuntimeProgress,
        });
      // Snapshot env before the seam so we can capture exactly which keys it
      // repointed onto the in-sandbox home (e.g. `CODEX_HOME`) and replay them
      // verbatim on a later compatible resume. Add/change only — every seam sets
      // (never deletes) its home env var, so a set-based delta is complete.
      const envBeforeStage = { ...env };
      let freshStagedRuntime: PreparedAdapterExecutionTargetRuntime;
      let freshTeardown: (() => Promise<void>) | null = null;
      let freshDispose: (() => Promise<void>) | null = null;
      if (input.deps.prepareRemoteManagedHome) {
        const seeded = await input.deps.prepareRemoteManagedHome({
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
        freshStagedRuntime = seeded.stagedRuntime;
        freshTeardown = seeded.teardown ?? null;
        freshDispose = seeded.disposeStaged ?? null;
      } else {
        freshStagedRuntime = await stage([]);
      }
      const delta: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) {
        if (envBeforeStage[key] !== value) delta[key] = value;
      }
      return {
        stagedRuntime: freshStagedRuntime,
        teardown: freshTeardown,
        dispose: freshDispose,
        envDelta: delta,
      };
    });
    sessionStagingLeaseRelease = staged.release;
    stagedRuntime = staged.value.stagedRuntime;
    remoteManagedHomeTeardown = staged.value.teardown;
    remoteStagingDispose = staged.value.dispose;
    remoteStagingEnvDelta = staged.value.envDelta;
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
  try {
    if (useRemoteProcessSession) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: { ...executionTarget, streamRunLogs: false },
        runtimeRootDir: stagedRuntime?.runtimeRootDir ?? null,
        adapterKey: input.engine.adapterType,
        timeoutSec,
        hostApiToken: env.PAPERCLIP_API_KEY,
        onLog: input.ctx.onLog,
      });
      if (paperclipBridge) {
        Object.assign(env, paperclipBridge.env);
        await input.ctx.onLog("stdout", "[paperclip] Sandbox ACP API callback bridge enabled for this run.\n");
      }
    }
    runtimeEnv = Object.fromEntries(
      Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    processSessionBridge = useRemoteProcessSession
      ? await startAdapterExecutionTargetProcessSessionBridge({
          runId,
          target: executionTarget,
          runtimeRootDir: stagedRuntime?.runtimeRootDir ?? null,
          adapterKey: input.engine.adapterType,
          command: "sh",
          args: ["-lc", `exec ${agentCommandShell}`],
          cwd: sessionCwd,
          env: runtimeEnv,
          timeoutSec,
          onLog: input.ctx.onLog,
        })
      : null;
  } catch (err) {
    await paperclipBridge?.stop().catch(() => {});
    // The staged home / copy-back teardown must run even if a bridge fails to
    // start after the workspace + managed home were already staged into the
    // sandbox, so a refreshed credential is copied back on this error path too.
    // This run never reaches the executor, so also fire the one-time staged-temp
    // dispose here (it no longer rides the per-run copy-back) — the run is being
    // abandoned, so its staged temp must be released — and release the per-session
    // staging lease so the abandoned run does not strand the next same-session run
    // (cleanupRemoteBridges, which normally releases it, is never reached here).
    await remoteManagedHomeTeardown?.().catch(() => {});
    await remoteStagingDispose?.().catch(() => {});
    sessionStagingLeaseRelease?.();
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

async function cleanupRemoteBridges(prepared: AcpxPreparedRuntime): Promise<void> {
  await Promise.allSettled([
    prepared.processSessionBridge?.stop(),
    prepared.paperclipBridge?.stop(),
  ]);
  // Runs AFTER the bridges stop (mirrors the CLI finally: stop bridge → restore
  // workspace). Fires the codex auth copy-back via `restoreWorkspace()` and
  // removes staged temp dirs. The seam logs and swallows its own failures — an
  // unclean-teardown copy-back miss is the accepted, loud `refresh_token_reused`
  // residual on the next host Codex use, never silent HOST-credential corruption
  // — so a teardown fault never masks or fails the run result here.
  if (prepared.remoteManagedHomeTeardown) {
    await prepared.remoteManagedHomeTeardown().catch(() => {});
  }
  prepared.sessionStagingLeaseRelease?.();
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
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession });
  const shouldUseResumeDeltaPrompt = resumedSession && wakePrompt.length > 0;
  const promptInstructionsPrefix = shouldUseResumeDeltaPrompt ? "" : instructionsPrefix;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const taskContextNote = asString(context.paperclipTaskMarkdown, "").trim();
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

async function emitRuntimeEvent(ctx: AdapterExecutionContext, event: AcpRuntimeEvent) {
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
    const eventRecord = event as Record<string, unknown>;
    const toolInput = eventRecord.input;
    await emitAcpxLog(ctx, {
      type: "acpx.tool_call",
      name: event.title ?? "acp_tool",
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

type AcpxExecutionPhase = "ensure_session" | "configure_session" | "turn";

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

async function cleanupIdleHandles(input: {
  handles: Map<string, RuntimeCacheEntry>;
  now: number;
  idleMs: number;
}) {
  if (input.idleMs <= 0) return;

  const stale: Array<[string, RuntimeCacheEntry]> = [];
  for (const entry of input.handles.entries()) {
    if (input.now - entry[1].lastUsedAt >= input.idleMs) stale.push(entry);
  }
  for (const [key, entry] of stale) {
    await closeWarmHandle({
      handles: input.handles,
      key,
      entry,
      reason: "paperclip idle cleanup",
    });
  }
}

// Drop staged-runtime entries the session has not touched within the warm-idle
// window, so the cache does not accumulate abandoned sessions (e.g. every time
// a config change shifts the fingerprint to a new key). The per-run copy-back
// already ran on the entry's last run's `cleanupRemoteBridges`; eviction fires
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
  const existing = handles.get(prepared.sessionKey);
  if (existing && prepared.stagedRuntime && existing.stagedRuntime === prepared.stagedRuntime) {
    handles.delete(prepared.sessionKey);
  }
  if (prepared.remoteStagingDispose) await prepared.remoteStagingDispose().catch(() => {});
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

function scheduleIdleHandleCleanup(input: {
  handles: Map<string, RuntimeCacheEntry>;
  key: string;
  entry: RuntimeCacheEntry;
  idleMs: number;
  now: () => number;
}) {
  clearWarmHandleTimer(input.entry);
  if (input.idleMs <= 0) return;

  const delayMs = Math.max(1, input.entry.lastUsedAt + input.idleMs - input.now());
  input.entry.cleanupTimer = setTimeout(() => {
    void (async () => {
      const current = input.handles.get(input.key);
      if (current !== input.entry) return;
      const idleForMs = input.now() - input.entry.lastUsedAt;
      if (idleForMs < input.idleMs) {
        scheduleIdleHandleCleanup(input);
        return;
      }
      await closeWarmHandle({
        handles: input.handles,
        key: input.key,
        entry: input.entry,
        reason: "paperclip idle cleanup",
      });
    })();
  }, delayMs);
  input.entry.cleanupTimer.unref?.();
}

function warmHandleMatches(
  entry: RuntimeCacheEntry | undefined,
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
): boolean {
  return entry !== undefined && entry.runtime === runtime && entry.handle === handle;
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
    // Evict idle staged runtimes BEFORE building the runtime, since buildRuntime
    // consults the staged cache to decide whether a compatible resume may reuse
    // an already-staged runtime — an expired entry must not be reused.
    await cleanupIdleStagedRuntimes({
      handles: stagedRuntimes,
      locks: stagingLocks,
      now,
      idleMs: warmIdleMs,
    });
    const prepared = await buildRuntime({ ctx, engine, deps });
    // State the effective wall-clock timeout and its source up front so a
    // later timeout is diagnosable from the run log alone. Goes to stderr:
    // the acpx stdout log stream carries JSON acpx.* event payloads and must
    // stay machine-parseable line by line.
    await ctx.onLog(
      "stderr",
      `[paperclip] ${formatAdapterExecutionTimeoutStartLogLine(prepared.timeoutResolution)}\n`,
    );
    await cleanupIdleHandles({ handles: warmHandles, now: now(), idleMs: warmIdleMs });

    const previousParams = parseObject(ctx.runtime.sessionParams);
    const canResume = isCompatibleSession(previousParams, prepared);
    const resumeSessionId = canResume ? asString(previousParams.acpSessionId, "") || undefined : undefined;
    const cached = canResume ? warmHandles.get(prepared.sessionKey) : undefined;
    const childStderrState = cached?.childStderrState ?? { logPath: null, pendingLiveLine: "" };
    flushChildStderr(childStderrState);
    childStderrState.logPath = prepared.childStderrLogPath;
    const runtimeOptions: AcpRuntimeOptions = {
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
    };
    const runtime = cached?.runtime ?? createRuntime(runtimeOptions);
    if (cached) clearWarmHandleTimer(cached);
    if (!canResume && asString(previousParams.runtimeSessionName, "")) {
      await ctx.onLog(
        "stdout",
        `[paperclip] ACPX session "${asString(previousParams.runtimeSessionName, "")}" does not match the current agent/cwd/mode/runtime identity; starting fresh in "${prepared.cwd}".\n`,
      );
    }

    let handle = cached?.handle ?? null;
    let resumedSession = Boolean(handle ?? resumeSessionId);
    let clearSession = false;

    try {
      if (!handle) {
        try {
          handle = await runtime.ensureSession({
            sessionKey: prepared.sessionKey,
            agent: prepared.acpxAgent,
            mode: prepared.mode,
            cwd: prepared.cwd,
            resumeSessionId,
            sessionOptions: { env: prepared.env },
          });
        } catch (err) {
          if (!resumeSessionId || !isResumeFailure(err)) throw err;
          clearSession = true;
          resumedSession = false;
          await ctx.onLog(
            "stdout",
            `[paperclip] ACPX resume session "${resumeSessionId}" is unavailable; retrying with a fresh session.\n`,
          );
          handle = await runtime.ensureSession({
            sessionKey: prepared.sessionKey,
            agent: prepared.acpxAgent,
            mode: prepared.mode,
            cwd: prepared.cwd,
            sessionOptions: { env: prepared.env },
          });
        }
      }
    } catch (err) {
      const { classified, message } = await emitAcpxFailure({
        ctx,
        prepared,
        err,
        phase: "ensure_session",
      });
      await discardStagedRuntime({ handles: stagedRuntimes, prepared });
      await cleanupRemoteBridges(prepared);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: message,
        ...classified,
        ...billingFields,
        model: prepared.requestedModel || null,
        clearSession,
        resultJson: { phase: "ensure_session" },
        summary: message,
      };
    }

    if (!handle) {
      await discardStagedRuntime({ handles: stagedRuntimes, prepared });
      await cleanupRemoteBridges(prepared);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "ACPX did not return a runtime session handle.",
        errorCode: "acpx_runtime_error",
        ...billingFields,
        model: prepared.requestedModel || null,
        resultJson: { phase: "ensure_session" },
        summary: "ACPX did not return a runtime session handle.",
      };
    }
    const sessionHandle = handle;
    try {
      await applySessionConfigOptions({
        runtime,
        handle: sessionHandle,
        prepared,
        onLog: ctx.onLog,
      });
    } catch (err) {
      const { classified, message } = await emitAcpxFailure({
        ctx,
        prepared,
        err,
        phase: "configure_session",
      });
      await runtime.close({
        handle: sessionHandle,
        reason: "paperclip config cleanup",
        discardPersistentState: false,
      }).catch(() => {});
      const existing = warmHandles.get(prepared.sessionKey);
      if (warmHandleMatches(existing, runtime, sessionHandle) && existing) {
        clearWarmHandleTimer(existing);
        warmHandles.delete(prepared.sessionKey);
      }
      await discardStagedRuntime({ handles: stagedRuntimes, prepared });
      await cleanupRemoteBridges(prepared);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: message,
        ...classified,
        ...billingFields,
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
    }
    const { prompt, promptMetrics, commandNotes } = await buildPrompt(ctx, resumedSession, prepared.env);
    const runPrompt = joinPromptSections([prepared.skillPromptInstructions, prompt]);
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

    let cancelActiveTurn: ((reason: string) => Promise<void>) | null = null;
    let controller: AbortController | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let timedOut = false;
    const textParts: string[] = [];
    let eventBreakdown: AcpRuntimeUsageBreakdown | null = null;
    let eventCostUsd: number | null = null;
    try {
      // Snapshot pre-turn usage so cumulative agent-reported cost can be
      // attributed to this run alone.
      const preTurnStatus = await readRuntimeStatus(runtime, sessionHandle);
      const timeoutMs = prepared.timeoutSec > 0 ? prepared.timeoutSec * 1000 : undefined;
      controller = new AbortController();
      if (timeoutMs) {
        timeout = setTimeout(() => {
          timedOut = true;
          controller?.abort();
          void cancelActiveTurn?.(formatAdapterExecutionTimeoutErrorMessage(prepared.timeoutResolution)).catch(() => {});
        }, timeoutMs);
      }
      const turn = runtime.startTurn({
        handle: sessionHandle,
        text: runPrompt,
        mode: "prompt",
        requestId: ctx.runId,
        timeoutMs,
        signal: controller?.signal,
      });
      cancelActiveTurn = async (reason: string) => {
        await turn.cancel({ reason });
      };
      for await (const event of turn.events) {
        if (event.type === "text_delta") textParts.push(event.text);
        if (event.type === "status" && event.tag === "usage_update") {
          eventBreakdown = event.breakdown ?? eventBreakdown;
          eventCostUsd = usdCostAmount(event.cost) ?? eventCostUsd;
        }
        await emitRuntimeEvent(ctx, event);
      }
      const terminal = await turn.result;
      if (timeout) clearTimeout(timeout);
      // Read usage before the close/warm-handle paths below can discard state.
      const postTurnStatus = await readRuntimeStatus(runtime, sessionHandle);
      const turnUsage = summarizeAcpxTurnUsage({
        preStatus: preTurnStatus,
        postStatus: postTurnStatus,
        eventBreakdown,
        eventCostUsd,
      });
      if (terminal.status === "failed" || terminal.status === "cancelled" || timedOut) {
        const existing = warmHandles.get(prepared.sessionKey);
        if (warmHandleMatches(existing, runtime, sessionHandle) && existing) {
          await closeWarmHandle({
            handles: warmHandles,
            key: prepared.sessionKey,
            entry: existing,
            reason: timedOut ? "paperclip timeout cleanup" : `paperclip turn ${terminal.status}`,
            discardPersistentState: terminal.status === "cancelled" || timedOut,
          });
        } else {
          await runtime.close({
            handle: sessionHandle,
            reason: timedOut ? "paperclip timeout cleanup" : `paperclip turn ${terminal.status}`,
            discardPersistentState: terminal.status === "cancelled" || timedOut,
          }).catch(() => {});
        }
      } else if (prepared.mode === "persistent" && warmIdleMs > 0 && !prepared.processSessionBridge) {
        const existing = warmHandles.get(prepared.sessionKey);
        if (existing && !warmHandleMatches(existing, runtime, sessionHandle)) {
          await runtime.close({
            handle: sessionHandle,
            reason: "paperclip duplicate warm handle cleanup",
            discardPersistentState: false,
          }).catch(() => {});
        } else {
          const entry: RuntimeCacheEntry = {
            runtime,
            handle: sessionHandle,
            childStderrState,
            fingerprint: prepared.fingerprint,
            lastUsedAt: now(),
          };
          warmHandles.set(prepared.sessionKey, entry);
          scheduleIdleHandleCleanup({
            handles: warmHandles,
            key: prepared.sessionKey,
            entry,
            idleMs: warmIdleMs,
            now,
          });
        }
      } else {
        const existing = warmHandles.get(prepared.sessionKey);
        if (warmHandleMatches(existing, runtime, sessionHandle) && existing) {
          await closeWarmHandle({
            handles: warmHandles,
            key: prepared.sessionKey,
            entry: existing,
            reason: "paperclip completed turn cleanup",
          });
        } else {
          await runtime.close({
            handle: sessionHandle,
            reason: "paperclip completed turn cleanup",
            discardPersistentState: false,
          }).catch(() => {});
        }
      }

      // PR 3: keep the staged runtime warm for the next compatible resume only
      // after a clean turn; a failed/cancelled/timed-out turn discards it so the
      // next run stages fresh instead of reusing a torn-down session's staged
      // credentials. Copy-back still fires for every outcome via
      // `cleanupRemoteBridges` below (unchanged from PR 2).
      if (terminal.status === "completed" && !timedOut) {
        saveStagedRuntimeAfterCleanTurn({ handles: stagedRuntimes, prepared, now: now() });
      } else {
        await discardStagedRuntime({ handles: stagedRuntimes, prepared });
      }

      const errorMessage = timedOut
        ? formatAdapterExecutionTimeoutErrorMessage(prepared.timeoutResolution)
        : resultErrorMessage(terminal);
      const terminalStopReason = terminal.status === "failed" ? terminal.error.message : terminal.stopReason;
      await emitAcpxLog(ctx, {
        type: terminal.status === "completed" ? "acpx.result" : "acpx.error",
        summary: terminal.status,
        stopReason: terminalStopReason,
        message: errorMessage,
      });
      await cleanupRemoteBridges(prepared);
      flushChildStderr(childStderrState);
      return {
        exitCode: terminal.status === "completed" ? 0 : 1,
        signal: timedOut ? "SIGTERM" : null,
        timedOut,
        errorMessage,
        errorCode: terminal.status === "failed" ? "acpx_turn_failed" : timedOut ? "acpx_timeout" : null,
        sessionId: sessionHandle.backendSessionId ?? sessionHandle.runtimeSessionName,
        sessionParams: buildSessionParams({ prepared, handle: sessionHandle }),
        sessionDisplayId: sessionHandle.agentSessionId ?? sessionHandle.backendSessionId ?? sessionHandle.runtimeSessionName,
        ...billingFields,
        model: prepared.requestedModel || null,
        ...(turnUsage.usage ? { usage: turnUsage.usage, usageBasis: "per_run" as const } : {}),
        costUsd: turnUsage.costUsd,
        resultJson: {
          status: terminal.status,
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
        summary: textParts.join("").trim() || terminalStopReason || terminal.status,
        clearSession,
      };
    } catch (err) {
      if (timeout) clearTimeout(timeout);
      const messageOverride = timedOut
        ? formatAdapterExecutionTimeoutErrorMessage(prepared.timeoutResolution)
        : undefined;
      const cancel = cancelActiveTurn as ((reason: string) => Promise<void>) | null;
      const preEmitMessage =
        messageOverride ?? (err instanceof Error ? err.message : String(err));
      if (cancel) await cancel(preEmitMessage).catch(() => {});
      await runtime.close({
        handle: sessionHandle,
        reason: timedOut ? "paperclip timeout cleanup" : "paperclip error cleanup",
        discardPersistentState: timedOut,
      }).catch(() => {});
      const existing = warmHandles.get(prepared.sessionKey);
      if (warmHandleMatches(existing, runtime, sessionHandle) && existing) {
        clearWarmHandleTimer(existing);
        warmHandles.delete(prepared.sessionKey);
      }
      await discardStagedRuntime({ handles: stagedRuntimes, prepared });
      const { classified, message } = await emitAcpxFailure({
        ctx,
        prepared,
        err,
        phase: "turn",
        messageOverride,
      });
      await cleanupRemoteBridges(prepared);
      flushChildStderr(childStderrState);
      return {
        exitCode: 1,
        signal: timedOut ? "SIGTERM" : null,
        timedOut,
        errorMessage: message,
        errorCode: timedOut ? "acpx_timeout" : classified.errorCode,
        errorMeta: classified.errorMeta,
        ...billingFields,
        model: prepared.requestedModel || null,
        clearSession: clearSession || timedOut,
        resultJson: { phase: "turn" },
        summary: message,
      };
    }
  };
}


export const execute = createAcpxEngineExecutor();
