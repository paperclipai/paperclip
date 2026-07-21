import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { buildCodexAuthInboundProvision } from "./codex-auth-merge-scripts.js";
import { copyBackCodexAuth } from "./codex-auth-copyback.js";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolvePaperclipDesiredSkillNames,
  renderTemplate,
  renderPaperclipWakePrompt,
  isPaperclipRecoveryWakePayload,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseLocalProcessFilesystemScope,
  parseLocalProcessSandboxExtraPaths,
  parseLocalProcessNetworkAllowlist,
  parseLocalProcessNetworkScope,
  type LocalProcessSandboxOptions,
} from "@paperclipai/adapter-utils/local-process-sandbox";
import {
  parseCodexJsonl,
  classifyCodexAuthRefreshFailure,
  extractCodexRetryNotBefore,
  isCodexProviderQuotaError,
  isCodexTransientUpstreamError,
  isCodexUnknownSessionError,
} from "./parse.js";
import {
  codexHomeHasUsableAuth,
  evaluateCodexCredentialReadiness,
  isManagedCodexHomePath,
  pathExists,
  prepareManagedCodexHome,
  resolveManagedCodexHomeDir,
  resolveSharedCodexHomeDir,
  seedManagedCodexHome,
  stageCodexHomeForSync,
  mergeManagedCodexMcpGateways,
  writeManagedCodexMcpConfig,
  type ManagedCodexMcpGateway,
} from "./codex-home.js";
import {
  CODEX_SANDBOX_AUTH_EXISTS_COMMAND,
  CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING,
  CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING_LOG_LINE,
  resolveCodexAuthPrecedence,
} from "./auth-precedence.js";
import { prepareCodexRuntimeConfig } from "./runtime-config.js";
import { resolveCodexDesiredSkillNames } from "./skills.js";
import { buildCodexExecArgs } from "./codex-args.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import {
  CODEX_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS,
  createCodexOutputInactivityMonitor,
  formatOutputInactivityMonitorErrorMessage,
  resolveCodexInactivityTimeout,
} from "./output-inactivity-monitor.js";
import {
  createCodexAcpExecutor,
  formatCodexAcpFallbackMessage,
  resolveCodexExecutionEngineForRun,
} from "./acp.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const executeCodexAcp = createCodexAcpExecutor();
const CODEX_ROLLOUT_NOISE_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_core::rollout::list:\s+state db missing rollout path for thread\s+[a-z0-9-]+$/i;

function stripCodexRolloutNoise(text: string): string {
  const parts = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      kept.push(part);
      continue;
    }
    if (CODEX_ROLLOUT_NOISE_RE.test(trimmed)) continue;
    kept.push(part);
  }
  return kept.join("\n");
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function signalCodexChild(
  target: { pid: number | null; processGroupId: number | null },
  signal: NodeJS.Signals,
): boolean {
  if (process.platform !== "win32" && target.processGroupId && target.processGroupId > 0) {
    try {
      process.kill(-target.processGroupId, signal);
      return true;
    } catch {
      // Fall back to direct child signal if group signaling fails (e.g. group already gone).
    }
  }
  if (target.pid && target.pid > 0) {
    try {
      process.kill(target.pid, signal);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveCodexBillingType(env: Record<string, string>): "api" | "subscription" {
  // Codex uses API-key auth when OPENAI_API_KEY is present; otherwise rely on local login/session auth.
  return hasNonEmptyEnvValue(env, "OPENAI_API_KEY") ? "api" : "subscription";
}

function resolveCodexBiller(env: Record<string, string>, billingType: "api" | "subscription"): string {
  const openAiCompatibleBiller = inferOpenAiCompatibleBiller(env, "openai");
  if (openAiCompatibleBiller === "openrouter") return "openrouter";
  return billingType === "subscription" ? "chatgpt" : openAiCompatibleBiller ?? "openai";
}

async function isLikelyPaperclipRepoRoot(candidate: string): Promise<boolean> {
  const [hasWorkspace, hasPackageJson, hasServerDir, hasAdapterUtilsDir] = await Promise.all([
    pathExists(path.join(candidate, "pnpm-workspace.yaml")),
    pathExists(path.join(candidate, "package.json")),
    pathExists(path.join(candidate, "server")),
    pathExists(path.join(candidate, "packages", "adapter-utils")),
  ]);

  return hasWorkspace && hasPackageJson && hasServerDir && hasAdapterUtilsDir;
}

async function isLikelyPaperclipRuntimeSkillPath(
  candidate: string,
  skillName: string,
  options: { requireSkillMarkdown?: boolean } = {},
): Promise<boolean> {
  if (path.basename(candidate) !== skillName) return false;
  const skillsRoot = path.dirname(candidate);
  if (path.basename(skillsRoot) !== "skills") return false;
  if (options.requireSkillMarkdown !== false && !(await pathExists(path.join(candidate, "SKILL.md")))) {
    return false;
  }

  let cursor = path.dirname(skillsRoot);
  for (let depth = 0; depth < 6; depth += 1) {
    if (await isLikelyPaperclipRepoRoot(cursor)) return true;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return false;
}

async function pruneBrokenUnavailablePaperclipSkillSymlinks(
  skillsHome: string,
  allowedSkillNames: Iterable<string>,
  onLog: AdapterExecutionContext["onLog"],
) {
  const allowed = new Set(Array.from(allowedSkillNames));
  const entries = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (allowed.has(entry.name) || !entry.isSymbolicLink()) continue;

    const target = path.join(skillsHome, entry.name);
    const linkedPath = await fs.readlink(target).catch(() => null);
    if (!linkedPath) continue;

    const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
    if (await pathExists(resolvedLinkedPath)) continue;
    if (
      !(await isLikelyPaperclipRuntimeSkillPath(resolvedLinkedPath, entry.name, {
        requireSkillMarkdown: false,
      }))
    ) {
      continue;
    }

    await fs.unlink(target).catch(() => {});
    await onLog(
      "stdout",
      `[paperclip] Removed stale Codex skill "${entry.name}" from ${skillsHome}\n`,
    );
  }
}

function resolveCodexSkillsDir(codexHome: string): string {
  return path.join(codexHome, "skills");
}

type EnsureCodexSkillsInjectedOptions = {
  skillsHome?: string;
  skillsEntries?: Array<{ key: string; runtimeName: string; source: string }>;
  desiredSkillNames?: string[];
  linkSkill?: (source: string, target: string) => Promise<void>;
};

type CodexTransientFallbackMode =
  | "same_session"
  | "safer_invocation"
  | "fresh_session"
  | "fresh_session_safer_invocation";

function readCodexTransientFallbackMode(context: Record<string, unknown>): CodexTransientFallbackMode | null {
  const value = asString(context.codexTransientFallbackMode, "").trim();
  switch (value) {
    case "same_session":
    case "safer_invocation":
    case "fresh_session":
    case "fresh_session_safer_invocation":
      return value;
    default:
      return null;
  }
}

function fallbackModeUsesSaferInvocation(mode: CodexTransientFallbackMode | null): boolean {
  return mode === "safer_invocation" || mode === "fresh_session_safer_invocation";
}

function fallbackModeUsesFreshSession(mode: CodexTransientFallbackMode | null): boolean {
  return mode === "fresh_session" || mode === "fresh_session_safer_invocation";
}

function managedMcpGatewaysFromContext(context: Record<string, unknown>): ManagedCodexMcpGateway[] {
  const managedMcp = parseObject(context.paperclipManagedMcp);
  if (managedMcp.managedMcpOnly !== true) return [];
  const gateways = Array.isArray(managedMcp.gateways) ? managedMcp.gateways : [];
  return gateways
    .map((raw): ManagedCodexMcpGateway | null => {
      const gateway = parseObject(raw);
      const name = asString(gateway.name, "").trim();
      const endpointPath = asString(gateway.endpointPath, "").trim();
      const bearerToken = asString(gateway.bearerToken, "").trim();
      if (!name || !endpointPath || !bearerToken) return null;
      return { name, endpointPath, bearerToken };
    })
    .filter((gateway): gateway is ManagedCodexMcpGateway => Boolean(gateway));
}

type ResolvedExecutionTarget = ReturnType<typeof readAdapterExecutionTarget>;
type MaybeResolvedExecutionTarget = ResolvedExecutionTarget | undefined;

async function sandboxCodexAuthJsonExists(input: {
  runId: string;
  target: MaybeResolvedExecutionTarget;
  cwd: string;
}): Promise<boolean> {
  if (!input.target || input.target.kind !== "remote" || input.target.transport !== "sandbox") {
    return false;
  }

  try {
    const result = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.target,
      CODEX_SANDBOX_AUTH_EXISTS_COMMAND,
      {
        cwd: input.cwd,
        env: {},
        timeoutSec: 5,
      },
    );
    return !result.timedOut && result.exitCode === 0;
  } catch {
    return false;
  }
}

async function emitSandboxAuthPrecedenceWarningIfNeeded(input: {
  runId: string;
  target: MaybeResolvedExecutionTarget;
  cwd: string;
  configuredApiKey: boolean;
  hostAuthJson: boolean;
  onLog: AdapterExecutionContext["onLog"];
  onEvent: AdapterExecutionContext["onEvent"];
}): Promise<void> {
  if (!input.target || input.target.kind !== "remote" || input.target.transport !== "sandbox") {
    return;
  }

  const sandboxAuthJson = await sandboxCodexAuthJsonExists({
    runId: input.runId,
    target: input.target,
    cwd: input.cwd,
  });
  const resolution = resolveCodexAuthPrecedence({
    configuredApiKey: input.configuredApiKey,
    hostAuthJson: input.hostAuthJson,
    sandboxAuthJson,
  });
  if (!resolution.shouldWarn) return;

  await input.onLog("stderr", CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING_LOG_LINE);
  await input.onEvent?.({
    eventType: "codex.auth_precedence_warning",
    stream: "system",
    level: "warn",
    message: CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING,
    payload: {
      configuredApiKey: input.configuredApiKey,
      hostAuthJson: input.hostAuthJson,
      sandboxAuthJson,
      winner: resolution.winner,
      sandboxLoginShadowed: resolution.sandboxLoginShadowed,
    },
  });
}

function buildCodexTransientHandoffNote(input: {
  previousSessionId: string | null;
  fallbackMode: CodexTransientFallbackMode;
  continuationSummaryBody: string | null;
}): string {
  return [
    "Paperclip session handoff:",
    input.previousSessionId ? `- Previous session: ${input.previousSessionId}` : "",
    "- Rotation reason: repeated Codex transient remote-compaction failures",
    `- Fallback mode: ${input.fallbackMode}`,
    input.continuationSummaryBody
      ? `- Issue continuation summary: ${input.continuationSummaryBody.slice(0, 1_500)}`
      : "",
    "Continue from the current task state. Rebuild only the minimum context you need.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function ensureCodexSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  options: EnsureCodexSkillsInjectedOptions = {},
) {
  const allSkillsEntries = options.skillsEntries ?? await readPaperclipRuntimeSkillEntries({}, __moduleDir);
  const desiredSkillNames =
    options.desiredSkillNames ?? allSkillsEntries.map((entry) => entry.key);
  const desiredSet = new Set(desiredSkillNames);
  const skillsEntries = allSkillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (skillsEntries.length === 0) return;

  const skillsHome = options.skillsHome ?? resolveCodexSkillsDir(resolveSharedCodexHomeDir());
  await fs.mkdir(skillsHome, { recursive: true });
  const linkSkill = options.linkSkill;
  for (const entry of skillsEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const existing = await fs.lstat(target).catch(() => null);
      if (existing?.isSymbolicLink()) {
        const linkedPath = await fs.readlink(target).catch(() => null);
        const resolvedLinkedPath = linkedPath
          ? path.resolve(path.dirname(target), linkedPath)
          : null;
        if (
          resolvedLinkedPath &&
          resolvedLinkedPath !== entry.source &&
          (await isLikelyPaperclipRuntimeSkillPath(resolvedLinkedPath, entry.runtimeName))
        ) {
          await fs.unlink(target);
          if (linkSkill) {
            await linkSkill(entry.source, target);
          } else {
            await fs.symlink(entry.source, target);
          }
          await onLog(
            "stdout",
            `[paperclip] Repaired Codex skill "${entry.runtimeName}" into ${skillsHome}\n`,
          );
          continue;
        }
      }

      const result = await ensurePaperclipSkillSymlink(entry.source, target, linkSkill);
      if (result === "skipped") continue;

      await onLog(
        "stdout",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Codex skill "${entry.runtimeName}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Codex skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  await pruneBrokenUnavailablePaperclipSkillSymlinks(
    skillsHome,
    skillsEntries.map((entry) => entry.runtimeName),
    onLog,
  );
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const engineSelection = await resolveCodexExecutionEngineForRun(ctx);
  if (engineSelection.engine === "acp") {
    try {
      return await executeCodexAcp(ctx);
    } catch (err) {
      if (engineSelection.explicit) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.onLog(
        "stderr",
        formatCodexAcpFallbackMessage(`Codex ACP startup failed: ${reason}`),
      );
    }
  }
  if (!engineSelection.explicit && engineSelection.fallbackReason) {
    await ctx.onLog("stderr", formatCodexAcpFallbackMessage(engineSelection.fallbackReason));
  }

  const { runId, agent, runtime, config, context, onLog, onMeta, onEvent, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "codex");
  const model = asString(config.model, "");

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const workspaceBranch = asString(workspaceContext.branchName, "");
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServiceIntents = Array.isArray(context.paperclipRuntimeServiceIntents)
    ? context.paperclipRuntimeServiceIntents.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServices = Array.isArray(context.paperclipRuntimeServices)
    ? context.paperclipRuntimeServices.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimePrimaryUrl = asString(context.paperclipRuntimePrimaryUrl, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  const envConfig = parseObject(config.env);
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);
  const configuredCodexHome =
    typeof envConfig.CODEX_HOME === "string" && envConfig.CODEX_HOME.trim().length > 0
      ? path.resolve(envConfig.CODEX_HOME.trim())
      : null;
  const codexSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = resolveCodexDesiredSkillNames(config, codexSkillEntries);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const configuredOpenAiApiKey =
    typeof envConfig.OPENAI_API_KEY === "string" && envConfig.OPENAI_API_KEY.trim().length > 0
      ? envConfig.OPENAI_API_KEY.trim()
      : null;
  // A configured CODEX_HOME that lives under the Paperclip-managed company tree
  // (the per-agent home set by the server isolation guard) still needs auth
  // seeded — it ships with no credentials and OPENAI_API_KEY="" by default.
  // Only a genuine external/user-supplied override is treated as self-managed
  // and left untouched.
  const configuredHomeIsManaged =
    configuredCodexHome != null &&
    isManagedCodexHomePath(process.env, agent.companyId, configuredCodexHome);
  if (configuredCodexHome == null) {
    await prepareManagedCodexHome(process.env, onLog, agent.companyId, {
      apiKey: configuredOpenAiApiKey,
    });
  } else if (configuredHomeIsManaged) {
    await seedManagedCodexHome(configuredCodexHome, process.env, onLog, {
      apiKey: configuredOpenAiApiKey,
    });
  }
  const defaultCodexHome = resolveManagedCodexHomeDir(process.env, agent.companyId);
  const effectiveCodexHome = configuredCodexHome ?? defaultCodexHome;
  await fs.mkdir(effectiveCodexHome, { recursive: true });

  // Never launch a managed CODEX_HOME with no credentials. Without auth.json and
  // with OPENAI_API_KEY="" the provider rejects every request with
  // "401 Missing bearer"; fail fast with a clear adapter error instead of
  // emitting unauthenticated calls. External overrides manage their own auth.
  // This is the execute-time backstop for the control plane's pre-dispatch
  // configuration-incomplete gate (see server heartbeat) — both decide
  // readiness through the same `evaluateCodexCredentialReadiness` predicate, so
  // they cannot drift.
  const credentialReadiness = await evaluateCodexCredentialReadiness({
    env: process.env,
    companyId: agent.companyId,
    configuredCodexHome,
    configuredApiKey: configuredOpenAiApiKey,
  });
  if (credentialReadiness.managed && !credentialReadiness.ready) {
    throw new Error(
      `no Codex credentials provisioned for managed home "${effectiveCodexHome}" ` +
        `(no usable auth.json and OPENAI_API_KEY is empty). ` +
        `Sign in to Codex on the host with a ChatGPT subscription, or configure a per-agent ` +
        `OPENAI_API_KEY.`,
    );
  }
  // Merge custom model providers (PAPERCLIP_CODEX_PROVIDERS) into the managed
  // CODEX_HOME's config.toml BEFORE the home is shipped to a remote execution
  // target, so both local and sandboxed Codex processes pick up the routing.
  // An explicit env.CODEX_HOME override is treated as user-managed and skipped.
  const envConfigStrings = Object.fromEntries(
    Object.entries(envConfig).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const preparedRuntimeConfig = await prepareCodexRuntimeConfig({
    env: envConfigStrings,
    codexHome: configuredCodexHome ? null : effectiveCodexHome,
  });
  // Curated allowlist dir staged for the remote `home` asset (see below). Held
  // here so the outer `finally` can remove it on every exit path (teardown and
  // error), never only the happy path.
  let stagedCodexHomeDir: string | null = null;
  try {
    for (const note of preparedRuntimeConfig.notes) {
      await onLog("stdout", `[paperclip] ${note}\n`);
    }
    const paperclipBaseEnv = buildPaperclipEnv(agent);
    const runtimeMcpGateways = (ctx.runtimeMcp?.getServers() ?? []).map((server) => ({
      name: server.name,
      endpointPath: server.url,
      bearerToken: server.token,
    }));
    const managedMcpGateways = mergeManagedCodexMcpGateways(
      runtimeMcpGateways,
      managedMcpGatewaysFromContext(context),
    );
    const managedMcp = await writeManagedCodexMcpConfig({
      codexHome: effectiveCodexHome,
      apiBaseUrl: paperclipBaseEnv.PAPERCLIP_API_URL,
      gateways: managedMcpGateways,
    });
    if (managedMcpGateways.length > 0) {
      await onLog(
        "stdout",
        `[paperclip] Wrote ${managedMcpGateways.length} managed MCP gateway(s) into Codex config "${managedMcp.configPath}".\n`,
      );
    }
    for (const warning of managedMcp.warnings) {
      await onLog("stderr", `[paperclip] ${warning}\n`);
    }
    // Inject skills into the same CODEX_HOME that Codex will actually run with
    // (managed home in the default case, or an explicit override from adapter config).
    const codexSkillsDir = resolveCodexSkillsDir(effectiveCodexHome);
    await ensureCodexSkillsInjected(
      onLog,
      {
        skillsHome: codexSkillsDir,
        skillsEntries: codexSkillEntries,
        desiredSkillNames,
      },
    );
    const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
      executionTarget,
      asNumber(config.timeoutSec, 0),
    );
    const graceSec = asNumber(config.graceSec, 20);
    let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
    const preparedExecutionTargetRuntime = executionTargetIsRemote
      ? await (async () => {
          await onLog(
            "stdout",
            `[paperclip] Syncing workspace and CODEX_HOME to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
          );
          // Stage only the files Codex actually needs into a curated temp dir and
          // ship THAT as the `home` asset, instead of the whole managed
          // CODEX_HOME + a name denylist. Staged AFTER the config.toml rewrites
          // (provider merge + MCP block splice above) and skills injection, so the
          // staged config.toml/skills reflect their final state. Symlinks (incl.
          // the single-use `auth.json`) are dereferenced to bytes. This drops the
          // large runtime state (`sessions/`, `*.sqlite`, `plugins/`, …) that the
          // 4-name denylist missed and that a sandbox run never needs.
          stagedCodexHomeDir = await stageCodexHomeForSync(effectiveCodexHome, { runId });
          return await prepareAdapterExecutionTargetRuntime({
            runId,
            target: executionTarget,
            adapterKey: "codex",
            timeoutSec,
            workspaceLocalDir: cwd,
            installCommand: SANDBOX_INSTALL_COMMAND,
            detectCommand: command,
            onProgress: (line) => onLog("stdout", line),
            onRuntimeProgress: ctx.onRuntimeProgress,
            assets: [
              {
                key: "home",
                localDir: stagedCodexHomeDir,
                followSymlinks: true,
                // Inbound (host→sandbox) auth-merge contribution: stages the two
                // merge scripts and runs the merge-extract command so a sandbox
                // that already carries a Codex `auth.json` keeps whichever
                // credential is newer. The sandbox runtime core stays adapter-
                // agnostic — it just invokes this generic `provision` seam.
                provision: buildCodexAuthInboundProvision(),
                // Outbound (sandbox→host) auth copy-back contribution: at
                // teardown, read the sandbox's `auth.json` and — guarded by the
                // same direction-agnostic decision predicate under a directory
                // lock — atomically install it onto the shared host credential
                // when it is a strictly-newer same-identity subscription copy.
                // The sandbox core stays adapter-agnostic; it just awaits this
                // generic `restore` seam per asset before destroying the sandbox.
                // Target is the shared symlink SOURCE (what managed homes point
                // `auth.json` at), not the in-sandbox symlink.
                restore: async ({ assetDir, readFile }) =>
                  void (await copyBackCodexAuth({
                    readSandboxAuth: () => readFile(path.posix.join(assetDir, "auth.json")),
                    hostAuthPath: path.join(resolveSharedCodexHomeDir(process.env), "auth.json"),
                    log: (line) => onLog("stdout", `${line}\n`),
                  })),
                // No `exclude` denylist: `stagedCodexHomeDir` already contains
                // ONLY the allowlisted files (auth/config/skills), so there is
                // nothing to filter out.
              },
            ],
          });
        })()
      : null;
    if (preparedExecutionTargetRuntime?.workspaceRemoteDir) {
      effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir;
    }
    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    const executionTargetIsSandbox =
      runtimeExecutionTarget?.kind === "remote" && runtimeExecutionTarget.transport === "sandbox";
    const restoreRemoteWorkspace = preparedExecutionTargetRuntime
      ? () => preparedExecutionTargetRuntime.restoreWorkspace((line) => onLog("stdout", line))
      : null;
    let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
    const remoteCodexHome = executionTargetIsRemote
      ? preparedExecutionTargetRuntime?.assetDirs.home ??
        path.posix.join(effectiveExecutionCwd, ".paperclip-runtime", "codex", "home")
      : null;
    await emitSandboxAuthPrecedenceWarningIfNeeded({
      runId,
      target: runtimeExecutionTarget,
      cwd: effectiveExecutionCwd,
      configuredApiKey: Boolean(configuredOpenAiApiKey),
      hostAuthJson: await codexHomeHasUsableAuth(effectiveCodexHome),
      onLog,
      onEvent,
    });
    const hasExplicitApiKey =
      typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
    const env: Record<string, string> = { ...paperclipBaseEnv };
    env.PAPERCLIP_RUN_ID = runId;
    const wakeTaskId =
      (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
      (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
      null;
    const wakeReason =
      typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
        ? context.wakeReason.trim()
        : null;
    const wakeCommentId =
      (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
      (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
      null;
    const approvalId =
      typeof context.approvalId === "string" && context.approvalId.trim().length > 0
        ? context.approvalId.trim()
        : null;
    const approvalStatus =
      typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
        ? context.approvalStatus.trim()
        : null;
    const linkedIssueIds = Array.isArray(context.issueIds)
      ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
    const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
    if (wakeTaskId) {
      env.PAPERCLIP_TASK_ID = wakeTaskId;
    }
    if (issueWorkMode) {
      env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
    }
    if (wakeReason) {
      env.PAPERCLIP_WAKE_REASON = wakeReason;
    }
    if (wakeCommentId) {
      env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
    }
    if (approvalId) {
      env.PAPERCLIP_APPROVAL_ID = approvalId;
    }
    if (approvalStatus) {
      env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
    }
    if (linkedIssueIds.length > 0) {
      env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
    }
    if (wakePayloadJson) {
      env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
    }
    refreshPaperclipWorkspaceEnvForExecution({
      env,
      envConfig,
      workspaceCwd: effectiveWorkspaceCwd,
      workspaceSource,
      workspaceStrategy,
      workspaceId,
      workspaceRepoUrl,
      workspaceRepoRef,
      workspaceBranch,
      workspaceWorktreePath,
      workspaceHints,
      agentHome,
      executionTargetIsRemote,
      executionCwd: effectiveExecutionCwd,
    });
    if (runtimeServiceIntents.length > 0) {
      env.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(runtimeServiceIntents);
    }
    if (runtimeServices.length > 0) {
      env.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(runtimeServices);
    }
    if (runtimePrimaryUrl) {
      env.PAPERCLIP_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;
    }
    env.CODEX_HOME = remoteCodexHome ?? effectiveCodexHome;
    if (!hasExplicitApiKey && authToken) {
      env.PAPERCLIP_API_KEY = authToken;
    }
    if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        runtimeRootDir: preparedExecutionTargetRuntime?.runtimeRootDir,
        adapterKey: "codex",
        timeoutSec,
        hostApiToken: env.PAPERCLIP_API_KEY,
        onLog,
      });
      if (paperclipBridge) {
        Object.assign(env, paperclipBridge.env);
      }
    }
    const effectiveEnv = Object.fromEntries(
      Object.entries({ ...process.env, ...env }).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const billingType = resolveCodexBillingType(effectiveEnv);
    const networkScope = parseLocalProcessNetworkScope(config.networkScope);
    const filesystemScope = parseLocalProcessFilesystemScope(config.filesystemScope);
    const localProcessSandbox: LocalProcessSandboxOptions | null =
      (filesystemScope || networkScope) && !executionTargetIsRemote
        ? {
            workspaceDir: effectiveExecutionCwd,
            filesystemScope,
            managedPaths: [{ path: effectiveCodexHome, access: "rw" }],
            extraPaths: parseLocalProcessSandboxExtraPaths(config.filesystemExtraPaths),
            homeDir: filesystemScope ? effectiveCodexHome : null,
            networkScope,
            networkAllowlist: parseLocalProcessNetworkAllowlist(config.networkAllowlist),
            command: asString(config.filesystemSandboxCommand, "bwrap"),
          }
        : null;
    if (localProcessSandbox) {
      const scopes = [filesystemScope ? "workspace filesystem" : null, networkScope ? `${networkScope} network` : null]
        .filter(Boolean)
        .join(" and ");
      await onLog(
        "stdout",
        `[paperclip] Confining Codex with ${scopes} scope.\n`,
      );
    }
    const runtimeEnv = Object.fromEntries(
      Object.entries(ensurePathInEnv(effectiveEnv)).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: executionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
      detectCommand: ctx.runtimeCommandSpec?.detectCommand,
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog,
    });
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv);
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
    const loggedEnv = buildInvocationEnvForLogs(env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });

    const monitorResolution = resolveCodexInactivityTimeout(config.outputInactivityTimeoutMs);
    if (monitorResolution.mode === "disabled") {
      await onLog(
        "stdout",
        `[paperclip] Codex output inactivity monitor is DISABLED via adapterConfig.outputInactivityTimeoutMs=null. Hung codex runs will only be detected by the platform-level silent-run safety net.\n`,
      );
    } else if (monitorResolution.mode === "default" && "reason" in monitorResolution) {
      await onLog(
        "stdout",
        `[paperclip] Ignoring non-positive adapterConfig.outputInactivityTimeoutMs; falling back to default ${monitorResolution.timeoutMs}ms.\n`,
      );
    }
    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
    const canResumeSession =
      runtimeSessionId.length > 0 &&
      (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
      adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
    const codexTransientFallbackMode = readCodexTransientFallbackMode(context);
    const forceSaferInvocation = fallbackModeUsesSaferInvocation(codexTransientFallbackMode);
    const forceFreshSession = fallbackModeUsesFreshSession(codexTransientFallbackMode);
    const sessionId = canResumeSession && !forceFreshSession ? runtimeSessionId : null;
    if (executionTargetIsRemote && runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] Codex session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
      );
    } else if (runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] Codex session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
      );
    }
    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
    let instructionsPrefix = "";
    let instructionsChars = 0;
    if (instructionsFilePath) {
      try {
        const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
        instructionsPrefix =
          `${instructionsContents}\n\n` +
          `The above agent instructions were loaded from ${instructionsFilePath}. ` +
          `Resolve any relative file references from ${instructionsDir}.\n\n`;
        instructionsChars = instructionsPrefix.length;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await onLog(
          "stdout",
          `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
        );
      }
    }
    const repoAgentsNote =
      "Codex exec automatically applies repo-scoped AGENTS.md instructions from the current workspace; Paperclip does not currently suppress that discovery.";
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
      !sessionId && bootstrapPromptTemplate.trim().length > 0
        ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
        : "";
    const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
    const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
    const promptInstructionsPrefix = shouldUseResumeDeltaPrompt ? "" : instructionsPrefix;
    instructionsChars = promptInstructionsPrefix.length;
    const continuationSummary = parseObject(context.paperclipContinuationSummary);
    const continuationSummaryBody = asString(continuationSummary.body, "").trim() || null;
    const codexFallbackHandoffNote =
      forceFreshSession
        ? buildCodexTransientHandoffNote({
            previousSessionId: runtimeSessionId || runtime.sessionId || null,
            fallbackMode: codexTransientFallbackMode ?? "fresh_session",
            continuationSummaryBody,
          })
        : "";
    const commandNotes = (() => {
      if (!instructionsFilePath) {
        const notes = [repoAgentsNote];
        if (forceSaferInvocation) {
          notes.push("Codex transient fallback requested safer invocation settings for this retry.");
        }
        if (forceFreshSession) {
          notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
        }
        return notes;
      }
      if (instructionsPrefix.length > 0) {
        if (shouldUseResumeDeltaPrompt) {
          const notes = [
            `Loaded agent instructions from ${instructionsFilePath}`,
            "Skipped stdin instruction reinjection because an existing Codex session is being resumed with a wake delta.",
            repoAgentsNote,
          ];
          if (forceSaferInvocation) {
            notes.push("Codex transient fallback requested safer invocation settings for this retry.");
          }
          if (forceFreshSession) {
            notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
          }
          return notes;
        }
        const notes = [
          `Loaded agent instructions from ${instructionsFilePath}`,
          `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
          repoAgentsNote,
        ];
        if (forceSaferInvocation) {
          notes.push("Codex transient fallback requested safer invocation settings for this retry.");
        }
        if (forceFreshSession) {
          notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
        }
        return notes;
      }
      const notes = [
        `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
        repoAgentsNote,
      ];
      if (forceSaferInvocation) {
        notes.push("Codex transient fallback requested safer invocation settings for this retry.");
      }
      if (forceFreshSession) {
        notes.push("Codex transient fallback forced a fresh session with a continuation handoff.");
      }
      return notes;
    })();
    if (executionTargetIsSandbox) {
      commandNotes.push(
        "Added --skip-git-repo-check for sandbox execution because Codex requires an explicit trust bypass in headless remote workspaces.",
      );
    }
    if (preparedRuntimeConfig.notes.length > 0) {
      commandNotes.unshift(...preparedRuntimeConfig.notes);
    }
    const renderedPrompt = shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const prompt = joinPromptSections([
      promptInstructionsPrefix,
      renderedBootstrapPrompt,
      wakePrompt,
      codexFallbackHandoffNote,
      sessionHandoffNote,
      renderedPrompt,
    ]);
    const promptMetrics = {
      promptChars: prompt.length,
      instructionsChars,
      bootstrapPromptChars: renderedBootstrapPrompt.length,
      wakePromptChars: wakePrompt.length,
      sessionHandoffChars: sessionHandoffNote.length,
      heartbeatPromptChars: renderedPrompt.length,
    };

    const runAttempt = async (resumeSessionId: string | null) => {
      const execArgs = buildCodexExecArgs(
        forceSaferInvocation ? { ...config, fastMode: false } : config,
        {
          resumeSessionId,
          skipGitRepoCheck: executionTargetIsSandbox,
        },
      );
      const args = execArgs.args;
      const commandNotesWithFastMode =
        execArgs.fastModeIgnoredReason == null
          ? commandNotes
          : [...commandNotes, execArgs.fastModeIgnoredReason];
      if (onMeta) {
        await onMeta({
          adapterType: "codex_local",
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandNotes: commandNotesWithFastMode,
          commandArgs: args.map((value, idx) => {
            if (idx === args.length - 1 && value !== "-") return `<prompt ${prompt.length} chars>`;
            return value;
          }),
          env: loggedEnv,
          prompt,
          promptMetrics,
          context,
        });
      }

      let monitorFired = false;
      let monitorTerminationSignal: NodeJS.Signals | null = null;
      let monitorElapsedMs = 0;
      let monitorTimeoutMs = 0;
      let killTarget: { pid: number | null; processGroupId: number | null } | null = null;
      let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
      let monitorLogPromise: Promise<unknown> | null = null;

      const monitor =
        monitorResolution.mode === "disabled"
          ? null
          : createCodexOutputInactivityMonitor({
              timeoutMs: monitorResolution.timeoutMs,
              onFire: (state) => {
                monitorFired = true;
                monitorElapsedMs = (state.firedAt ?? Date.now()) - state.lastEventAt;
                monitorTimeoutMs = monitorResolution.timeoutMs;
                const message = formatOutputInactivityMonitorErrorMessage(monitorElapsedMs);
                const elapsedSec = Math.round(monitorElapsedMs / 1000);
                const timeoutSecLabel = Math.round(monitorResolution.timeoutMs / 1000);
                const logLine =
                  `[paperclip] adapter.invoke ${message}; ` +
                  `timeoutMs=${monitorResolution.timeoutMs} elapsedSinceLastEventMs=${monitorElapsedMs} ` +
                  `outputChunkCount=${state.outputChunkCount} outputBytes=${state.outputBytes} ` +
                  `parsedEvents=${state.parsedEventCount} (timeout=${timeoutSecLabel}s elapsed=${elapsedSec}s); ` +
                  `terminating codex child via SIGTERM (5s grace, then SIGKILL).\n`;
                // Issue the log without awaiting on the kill hot path, but capture
                // the promise so the surrounding try/finally can await flush before
                // the run resolves. Without this the diagnostic that explains the
                // kill could be dropped if the child exits faster than onLog flushes.
                monitorLogPromise = Promise.resolve(onLog("stderr", logLine)).catch(() => {});
                const target = killTarget;
                if (!target || (target.pid == null && target.processGroupId == null)) {
                  return;
                }
                const sentSig = signalCodexChild(target, "SIGTERM");
                if (sentSig) monitorTerminationSignal = "SIGTERM";
                sigkillTimer = setTimeout(() => {
                  sigkillTimer = null;
                  const stillSent = signalCodexChild(target, "SIGKILL");
                  if (stillSent) monitorTerminationSignal = "SIGKILL";
                }, CODEX_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS);
                if (typeof (sigkillTimer as { unref?: () => void }).unref === "function") {
                  (sigkillTimer as { unref: () => void }).unref();
                }
              },
            });

      const wrappedOnSpawn = async (meta: { pid: number; processGroupId: number | null; startedAt: string }) => {
        killTarget = { pid: meta.pid ?? null, processGroupId: meta.processGroupId };
        if (onSpawn) {
          await onSpawn(meta);
        }
      };

      try {
        const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
          cwd,
          env,
          stdin: prompt,
          timeoutSec,
          graceSec,
          onSpawn: wrappedOnSpawn,
          onRuntimeProgress: ctx.onRuntimeProgress,
          onLog: async (stream, chunk) => {
            monitor?.noteOutputChunk(stream, chunk);
            if (stream === "stdout") {
              await onLog(stream, chunk);
              return;
            }
            const cleaned = stripCodexRolloutNoise(chunk);
            if (!cleaned.trim()) return;
            await onLog(stream, cleaned);
          },
          runLogTail: paperclipBridge?.runLogTail,
          localProcessSandbox,
        });
        const cleanedStderr = stripCodexRolloutNoise(proc.stderr);
        return {
          proc: {
            ...proc,
            stderr: cleanedStderr,
          },
          rawStderr: proc.stderr,
          parsed: parseCodexJsonl(proc.stdout),
          monitor: monitorFired
            ? {
                fired: true as const,
                terminationSignal: monitorTerminationSignal,
                elapsedMsSinceLastEvent: monitorElapsedMs,
                timeoutMs: monitorTimeoutMs,
              }
            : { fired: false as const },
        };
      } finally {
        monitor?.stop();
        if (sigkillTimer) {
          clearTimeout(sigkillTimer);
          sigkillTimer = null;
        }
        if (monitorLogPromise) {
          await monitorLogPromise;
          monitorLogPromise = null;
        }
      }
    };

    const toResult = (
      attempt: {
        proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string };
        rawStderr: string;
        parsed: ReturnType<typeof parseCodexJsonl>;
        monitor?:
          | { fired: false }
          | { fired: true; terminationSignal: NodeJS.Signals | null; elapsedMsSinceLastEvent: number; timeoutMs: number };
      },
      clearSessionOnMissingSession = false,
      isRetry = false,
    ): AdapterExecutionResult => {
      if (attempt.monitor?.fired) {
        const errorMessage = formatOutputInactivityMonitorErrorMessage(attempt.monitor.elapsedMsSinceLastEvent);
        return {
          exitCode: null,
          signal: attempt.monitor.terminationSignal ?? attempt.proc.signal,
          timedOut: false,
          errorMessage,
          errorCode: "codex_output_inactivity_monitor",
          errorFamily: null,
          usage: attempt.parsed.usage,
          usageBasis: attempt.parsed.usageBasis,
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          provider: "openai",
          biller: resolveCodexBiller(effectiveEnv, billingType),
          model,
          billingType,
          costUsd: null,
          resultJson: {
            stdout: attempt.proc.stdout,
            stderr: attempt.proc.stderr,
            outputInactivityMonitor: {
              kind: "output_inactivity",
              timeoutMs: attempt.monitor.timeoutMs,
              elapsedMsSinceLastEvent: attempt.monitor.elapsedMsSinceLastEvent,
              terminationSignal: attempt.monitor.terminationSignal,
            },
          },
          summary: attempt.parsed.summary,
          clearSession: clearSessionOnMissingSession,
        };
      }
      if (attempt.proc.timedOut) {
        return {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          clearSession: clearSessionOnMissingSession,
        };
      }

      const canFallbackToRuntimeSession = !isRetry && !forceFreshSession;
      const resolvedSessionId =
        attempt.parsed.sessionId ??
        (canFallbackToRuntimeSession ? (runtimeSessionId ?? runtime.sessionId ?? null) : null);
      const resolvedSessionParams = resolvedSessionId
        ? ({
          sessionId: resolvedSessionId,
          cwd: effectiveExecutionCwd,
          ...(executionTargetIsRemote
            ? {
                remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
              }
            : {}),
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
        } as Record<string, unknown>)
        : null;
      const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      const fallbackErrorMessage =
        parsedError ||
        stderrLine ||
        `Codex exited with code ${attempt.proc.exitCode ?? -1}`;
      const transientRetryNotBefore =
        (attempt.proc.exitCode ?? 0) !== 0
          ? extractCodexRetryNotBefore({
              stdout: attempt.proc.stdout,
              stderr: attempt.proc.stderr,
              errorMessage: fallbackErrorMessage,
            })
          : null;
      const authRefreshFailure =
        (attempt.proc.exitCode ?? 0) !== 0
          ? classifyCodexAuthRefreshFailure({
              stdout: attempt.proc.stdout,
              stderr: attempt.proc.stderr,
              errorMessage: fallbackErrorMessage,
            })
          : null;
      const providerQuota =
        (attempt.proc.exitCode ?? 0) !== 0 &&
        !authRefreshFailure &&
        isCodexProviderQuotaError({
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
          errorMessage: fallbackErrorMessage,
        });
      const transientUpstream =
        (attempt.proc.exitCode ?? 0) !== 0 &&
        !authRefreshFailure &&
        !providerQuota &&
        isCodexTransientUpstreamError({
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
          errorMessage: fallbackErrorMessage,
        });
      const errorFamily = authRefreshFailure ?? (providerQuota ? "provider_quota" : transientUpstream ? "transient_upstream" : null);

      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        errorMessage:
          (attempt.proc.exitCode ?? 0) === 0
            ? null
            : fallbackErrorMessage,
        errorCode:
          authRefreshFailure
            ? authRefreshFailure
            : providerQuota
            ? "provider_quota"
            : transientUpstream
            ? "codex_transient_upstream"
            : null,
        errorFamily,
        retryNotBefore: transientRetryNotBefore ? transientRetryNotBefore.toISOString() : null,
        usage: attempt.parsed.usage,
        usageBasis: attempt.parsed.usageBasis,
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: "openai",
        biller: resolveCodexBiller(effectiveEnv, billingType),
        model,
        billingType,
        costUsd: null,
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
          ...(errorFamily ? { errorFamily } : {}),
          ...(transientRetryNotBefore ? { retryNotBefore: transientRetryNotBefore.toISOString() } : {}),
          ...(transientRetryNotBefore ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
          ...(providerQuota && transientRetryNotBefore ? { providerQuotaRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
        },
        summary: attempt.parsed.summary,
        clearSession: Boolean((clearSessionOnMissingSession || forceFreshSession) && !resolvedSessionId),
      };
    };

    try {
      const initial = await runAttempt(sessionId);
      if (
        sessionId &&
        !initial.proc.timedOut &&
        (initial.proc.exitCode ?? 0) !== 0 &&
        isCodexUnknownSessionError(initial.proc.stdout, initial.rawStderr)
      ) {
        await onLog(
          "stdout",
          `[paperclip] Codex resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
        );
        const retry = await runAttempt(null);
        return toResult(retry, true, true);
      }

      return toResult(initial, false, false);
    } finally {
      if (paperclipBridge) {
        await paperclipBridge.stop();
      }
      if (restoreRemoteWorkspace) {
        await onLog(
          "stdout",
          `[paperclip] Restoring workspace changes from ${describeAdapterExecutionTarget(executionTarget)}.\n`,
        );
        await restoreRemoteWorkspace();
      }
    }
  } finally {
    // Remove the staged CODEX_HOME allowlist temp dir on every exit path
    // (teardown AND error), never only the happy path. Cleanup failure is
    // logged, not fatal — a leaked temp dir must not crash the run.
    if (stagedCodexHomeDir) {
      await fs.rm(stagedCodexHomeDir, { recursive: true, force: true }).catch(async (error) => {
        await onLog(
          "stderr",
          `[paperclip] Failed to remove staged Codex home "${stagedCodexHomeDir}": ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      });
    }
    // Restore the managed config.toml so PAPERCLIP_CODEX_PROVIDERS changes
    // (or removal) between runs never leave stale provider routing behind. This
    // finally starts the moment prepareCodexRuntimeConfig returns, so a throw
    // anywhere in the remaining setup (skill injection, remote runtime
    // preparation, command building) restores the original config.toml too.
    // If the process dies before reaching this, the next
    // prepareCodexRuntimeConfig restores the original from the pre-run backup
    // written at prepare time.
    await preparedRuntimeConfig.cleanup();
  }
}
