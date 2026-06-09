import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inferOpenAiCompatibleBiller,
  preflightHostnameLookup,
  type AdapterExecutionContext,
  type AdapterExecutionResult,
  type HostnamePreflightOptions,
} from "@paperclipai/adapter-utils";
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
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseCodexJsonl,
  classifyCodexDnsError,
  CODEX_DEFAULT_DNS_ERROR_CODE,
  extractCodexRetryNotBefore,
  isCodexTransientUpstreamError,
  isCodexUnknownSessionError,
} from "./parse.js";
import { pathExists, prepareManagedCodexHome, resolveManagedCodexHomeDir, resolveSharedCodexHomeDir } from "./codex-home.js";
import { resolveCodexDesiredSkillNames } from "./skills.js";
import { buildCodexExecArgs } from "./codex-args.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const CODEX_ROLLOUT_NOISE_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_core::rollout::list:\s+state db missing rollout path for thread\s+[a-z0-9-]+$/i;

// Primary Codex upstream host. The stream-disconnect bug recorded in RUD-852
// traces back to a `getaddrinfo` failure for this host; probing it before
// spawning the CLI lets us fail in <2s instead of burning the full
// reconnect budget (~80s).
export const CODEX_DNS_PREFLIGHT_HOST = "chatgpt.com";
// Cool down DNS-failed runs so the next heartbeat doesn't immediately
// re-enter the same outage. Manual wake cycles are the recovery path.
export const CODEX_DNS_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

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

type CodexDnsPreflightResult = {
  outcome: Awaited<ReturnType<typeof preflightHostnameLookup>>;
  preflight: HostnamePreflightOptions;
};

export async function preflightCodexUpstreamDns(
  options: { host?: string; preflight?: HostnamePreflightOptions } = {},
): Promise<CodexDnsPreflightResult> {
  const host = options.host ?? CODEX_DNS_PREFLIGHT_HOST;
  const outcome = await preflightHostnameLookup(host, options.preflight);
  return { outcome, preflight: options.preflight ?? {} };
}

export function buildCodexDnsPreflightResult(input: {
  host: string;
  outcome: Awaited<ReturnType<typeof preflightHostnameLookup>>;
  attemptCount?: number;
}): AdapterExecutionResult {
  const { host, outcome } = input;
  const isFailure = !outcome.ok;
  const errorMessage = isFailure
    ? `Codex upstream ${host} is not resolvable (${outcome.reason}: ${outcome.message})`
    : null;
  const retryNotBefore = isFailure
    ? new Date(Date.now() + CODEX_DNS_RETRY_COOLDOWN_MS).toISOString()
    : null;
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    errorMessage,
    errorCode: isFailure ? CODEX_DEFAULT_DNS_ERROR_CODE : null,
    errorFamily: isFailure ? "transient_dns" : null,
    retryNotBefore,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    },
    sessionId: null,
    sessionParams: null,
    sessionDisplayId: null,
    provider: "openai",
    biller: null,
    model: null,
    billingType: null,
    costUsd: null,
    resultJson: {
      preflight: "dns",
      host,
      ...(isFailure
        ? { reason: outcome.reason, preflightErrorCode: outcome.errorCode, dnsHost: host }
        : { addressCount: outcome.addresses.length, dnsHost: host }),
      ...(retryNotBefore ? { retryNotBefore } : {}),
    },
    summary: errorMessage,
    clearSession: false,
  };
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
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

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
  // Adapter config can override the preflight host (e.g. when an OpenAI-
  // compatible proxy is in front of Codex) or disable the probe entirely
  // via `"none"`. The default is to probe `chatgpt.com` on local targets.
  // Tests can also pass a stubbed resolver through `codexDnsPreflightResolver`
  // to exercise the failure path without touching the system resolver.
  const preflightHostRaw = asString(config.codexDnsPreflightHost, CODEX_DNS_PREFLIGHT_HOST);
  const preflightHost = preflightHostRaw.trim().toLowerCase() === "none" ? null : preflightHostRaw.trim();
  const preflightEnabled = !executionTargetIsRemote && preflightHost !== null;
  const preflightResolver =
    typeof (config as Record<string, unknown>).codexDnsPreflightResolver === "function"
      ? ((config as Record<string, unknown>).codexDnsPreflightResolver as HostnamePreflightOptions["resolver"])
      : undefined;
  const preflightTimeoutMs = asNumber((config as Record<string, unknown>).codexDnsPreflightTimeoutMs, 1500);
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
  const preparedManagedCodexHome =
    configuredCodexHome
      ? null
      : await prepareManagedCodexHome(process.env, onLog, agent.companyId, {
          apiKey: configuredOpenAiApiKey,
        });
  const defaultCodexHome = resolveManagedCodexHomeDir(process.env, agent.companyId);
  const effectiveCodexHome = configuredCodexHome ?? preparedManagedCodexHome ?? defaultCodexHome;
  await fs.mkdir(effectiveCodexHome, { recursive: true });
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
        return await prepareAdapterExecutionTargetRuntime({
          runId,
          target: executionTarget,
          adapterKey: "codex",
          timeoutSec,
          workspaceLocalDir: cwd,
          installCommand: SANDBOX_INSTALL_COMMAND,
          detectCommand: command,
          assets: [
            {
              key: "home",
              localDir: effectiveCodexHome,
              followSymlinks: true,
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
    ? () => preparedExecutionTargetRuntime.restoreWorkspace()
    : null;
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
  const remoteCodexHome = executionTargetIsRemote
    ? preparedExecutionTargetRuntime?.assetDirs.home ??
      path.posix.join(effectiveExecutionCwd, ".paperclip-runtime", "codex", "home")
    : null;
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
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
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
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

    const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog: async (stream, chunk) => {
        if (stream !== "stderr") {
          await onLog(stream, chunk);
          return;
        }
        const cleaned = stripCodexRolloutNoise(chunk);
        if (!cleaned.trim()) return;
        await onLog(stream, cleaned);
      },
    });
    const cleanedStderr = stripCodexRolloutNoise(proc.stderr);
    return {
      proc: {
        ...proc,
        stderr: cleanedStderr,
      },
      rawStderr: proc.stderr,
      parsed: parseCodexJsonl(proc.stdout),
    };
  };

  const toResult = (
    attempt: { proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string }; rawStderr: string; parsed: ReturnType<typeof parseCodexJsonl> },
    clearSessionOnMissingSession = false,
    isRetry = false,
  ): AdapterExecutionResult => {
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
    const transientUpstream =
      (attempt.proc.exitCode ?? 0) !== 0 &&
      isCodexTransientUpstreamError({
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
        errorMessage: fallbackErrorMessage,
      });
    // DNS failures are not retryable inside the same run — they need a
    // manual operator cycle once resolver is back. Surface a stable code
    // so the run log and recovery routing treat them as their own family.
    const dnsFailure =
      (attempt.proc.exitCode ?? 0) !== 0
        ? classifyCodexDnsError({
            stdout: attempt.proc.stdout,
            stderr: attempt.proc.stderr,
            errorMessage: fallbackErrorMessage,
          })
        : null;
    const dnsRetryNotBefore =
      dnsFailure != null ? new Date(Date.now() + CODEX_DNS_RETRY_COOLDOWN_MS) : null;
    const errorCode = dnsFailure
      ? dnsFailure.errorCode
      : transientUpstream
        ? "codex_transient_upstream"
        : null;
    const errorFamily = dnsFailure
      ? dnsFailure.errorFamily
      : transientUpstream
        ? "transient_upstream"
        : null;
    const retryNotBeforeIso = dnsFailure
      ? dnsRetryNotBefore?.toISOString() ?? null
      : transientRetryNotBefore
        ? transientRetryNotBefore.toISOString()
        : null;

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage:
        (attempt.proc.exitCode ?? 0) === 0
          ? null
          : fallbackErrorMessage,
      errorCode,
      errorFamily,
      retryNotBefore: retryNotBeforeIso,
      usage: attempt.parsed.usage,
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
        ...(dnsFailure ? { errorFamily: "transient_dns", dnsHost: dnsFailure.matchedHost } : {}),
        ...(transientUpstream ? { errorFamily: "transient_upstream" } : {}),
        ...(retryNotBeforeIso ? { retryNotBefore: retryNotBeforeIso } : {}),
        ...(transientRetryNotBefore ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
      },
      summary: attempt.parsed.summary,
      clearSession: Boolean((clearSessionOnMissingSession || forceFreshSession) && !resolvedSessionId),
    };
  };

  try {
    if (preflightEnabled && preflightHost) {
      const probe = await preflightCodexUpstreamDns({
        host: preflightHost,
        preflight: {
          ...(preflightResolver ? { resolver: preflightResolver } : {}),
          timeoutMs: preflightTimeoutMs,
        },
      });
      if (!probe.outcome.ok) {
        await onLog(
          "stderr",
          `[paperclip] Codex DNS preflight for ${preflightHost} failed (${probe.outcome.reason}: ${probe.outcome.message}); skipping codex CLI spawn and cooling down retries for ${Math.round(CODEX_DNS_RETRY_COOLDOWN_MS / 1000)}s.\n`,
        );
        return buildCodexDnsPreflightResult({
          host: preflightHost,
          outcome: probe.outcome,
        });
      }
    }
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
}
