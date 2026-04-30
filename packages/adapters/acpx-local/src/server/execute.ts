import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { readAdapterExecutionTarget, adapterExecutionTargetSessionIdentity } from "@paperclipai/adapter-utils/execution-target";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  applyPaperclipWorkspaceEnv,
  asNumber,
  asString,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  joinPromptSections,
  parseObject,
  renderPaperclipWakePrompt,
  renderTemplate,
  stringifyPaperclipWakePayload,
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
  type AcpRuntimeTurn,
  type AcpRuntimeTurnResult,
} from "acpx/runtime";
import {
  DEFAULT_ACPX_LOCAL_AGENT,
  DEFAULT_ACPX_LOCAL_GRACE_SEC,
  DEFAULT_ACPX_LOCAL_MODE,
  DEFAULT_ACPX_LOCAL_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACPX_LOCAL_PERMISSION_MODE,
  DEFAULT_ACPX_LOCAL_TIMEOUT_SEC,
} from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WARM_HANDLE_IDLE_MS = 15 * 60 * 1000;

type AcpxRuntimeFactory = (options: AcpRuntimeOptions) => AcpRuntime;

interface RuntimeCacheEntry {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  fingerprint: string;
  lastUsedAt: number;
}

interface ExecuteDeps {
  createRuntime?: AcpxRuntimeFactory;
  now?: () => number;
  warmHandles?: Map<string, RuntimeCacheEntry>;
}

interface AcpxPreparedRuntime {
  acpxAgent: string;
  mode: "persistent" | "oneshot";
  cwd: string;
  workspaceId: string;
  workspaceRepoUrl: string;
  workspaceRepoRef: string;
  env: Record<string, string>;
  loggedEnv: Record<string, string>;
  stateDir: string;
  permissionMode: "approve-all" | "approve-reads" | "deny-all";
  nonInteractivePermissions: "deny" | "fail";
  timeoutSec: number;
  graceSec: number;
  sessionKey: string;
  fingerprint: string;
  agentCommand: string | null;
  agentRegistry: AcpAgentRegistry;
  remoteExecutionIdentity: Record<string, unknown> | null;
}

const defaultWarmHandles = new Map<string, RuntimeCacheEntry>();
let envLock: Promise<void> = Promise.resolve();

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
  return path.join(home, "instances", instanceId);
}

function defaultStateDir(companyId: string, agentId: string): string {
  return path.join(defaultPaperclipInstanceDir(), "companies", companyId, "acpx-local", "agents", agentId);
}

function packageRootDir(): string {
  return path.resolve(__moduleDir, "../..");
}

function resolveBuiltInAgentCommand(agent: string): string | null {
  const binName =
    agent === "claude"
      ? "claude-agent-acp"
      : agent === "codex"
        ? "codex-acp"
        : null;
  if (!binName) return null;
  return path.join(packageRootDir(), "node_modules", ".bin", binName);
}

function normalizeAgent(config: Record<string, unknown>): string {
  const agent = asString(config.agent, DEFAULT_ACPX_LOCAL_AGENT).trim();
  return agent || DEFAULT_ACPX_LOCAL_AGENT;
}

function normalizeMode(config: Record<string, unknown>): "persistent" | "oneshot" {
  return asString(config.mode, DEFAULT_ACPX_LOCAL_MODE) === "oneshot" ? "oneshot" : "persistent";
}

function normalizePermissionMode(config: Record<string, unknown>): "approve-all" | "approve-reads" | "deny-all" {
  const value = asString(config.permissionMode, DEFAULT_ACPX_LOCAL_PERMISSION_MODE).trim();
  if (value === "approve-reads" || value === "deny-all") return value;
  if (value === "default") return "approve-reads";
  return "approve-all";
}

function normalizeNonInteractivePermissions(config: Record<string, unknown>): "deny" | "fail" {
  return asString(config.nonInteractivePermissions, DEFAULT_ACPX_LOCAL_NON_INTERACTIVE_PERMISSIONS) === "fail"
    ? "fail"
    : "deny";
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
    ...(prepared.workspaceId ? { workspaceId: prepared.workspaceId } : {}),
    ...(prepared.workspaceRepoUrl ? { repoUrl: prepared.workspaceRepoUrl } : {}),
    ...(prepared.workspaceRepoRef ? { repoRef: prepared.workspaceRepoRef } : {}),
    ...(prepared.remoteExecutionIdentity ? { remoteExecution: prepared.remoteExecutionIdentity } : {}),
  };
}

async function writeAgentWrapper(input: {
  stateDir: string;
  acpxAgent: string;
  agentCommandShell: string;
  env: Record<string, string>;
}): Promise<string> {
  const wrappersDir = path.join(input.stateDir, "wrappers");
  await fs.mkdir(wrappersDir, { recursive: true });
  const wrapperHash = shortHash({
    agent: input.acpxAgent,
    command: input.agentCommandShell,
    env: input.env,
  });
  const wrapperPath = path.join(wrappersDir, `${input.acpxAgent}-${wrapperHash}.sh`);
  const exports = Object.entries(input.env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    ...exports,
    `exec ${input.agentCommandShell} "$@"`,
    "",
  ].join("\n");
  await fs.writeFile(wrapperPath, script, "utf8");
  await fs.chmod(wrapperPath, 0o700);
  return wrapperPath;
}

async function buildRuntime(input: {
  ctx: AdapterExecutionContext;
}): Promise<AcpxPreparedRuntime> {
  const { runId, agent, config, context, authToken } = input.ctx;
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
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const acpxAgent = normalizeAgent(config);
  const mode = normalizeMode(config);
  const permissionMode = normalizePermissionMode(config);
  const nonInteractivePermissions = normalizeNonInteractivePermissions(config);
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_ACPX_LOCAL_TIMEOUT_SEC);
  const graceSec = asNumber(config.graceSec, DEFAULT_ACPX_LOCAL_GRACE_SEC);
  const stateDir = path.resolve(asString(config.stateDir, "") || defaultStateDir(agent.companyId, agent.id));
  await fs.mkdir(stateDir, { recursive: true });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
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
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceStrategy,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceBranch,
    workspaceWorktreePath,
    agentHome,
  });
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!hasExplicitApiKey && authToken) env.PAPERCLIP_API_KEY = authToken;

  const configuredCommand = asString(config.agentCommand, "").trim();
  const builtInCommand = resolveBuiltInAgentCommand(acpxAgent);
  const agentCommand = configuredCommand || builtInCommand || null;
  const agentCommandShell = configuredCommand || (builtInCommand ? shellQuote(builtInCommand) : "");
  const wrapperPath = agentCommand
    ? await writeAgentWrapper({
        stateDir,
        acpxAgent,
        agentCommandShell,
        env,
      })
    : null;
  const overrides = wrapperPath ? { [acpxAgent]: wrapperPath } : undefined;
  const agentRegistry = createAgentRegistry({ overrides });
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: input.ctx.executionTarget,
    legacyRemoteExecution: input.ctx.executionTransport?.remoteExecution,
  });
  const remoteExecutionIdentity = adapterExecutionTargetSessionIdentity(executionTarget);
  const fingerprint = shortHash({
    acpxAgent,
    agentCommand: wrapperPath ?? agentCommand,
    cwd: path.resolve(cwd),
    mode,
    permissionMode,
    nonInteractivePermissions,
    remoteExecutionIdentity,
  });
  const taskKey = asString(input.ctx.runtime.taskKey, "") || wakeTaskId || workspaceId || "default";
  const sessionKey = `paperclip:${agent.companyId}:${agent.id}:${taskKey}:${fingerprint}`;
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand: wrapperPath ?? agentCommand ?? acpxAgent,
  });

  return {
    acpxAgent,
    mode,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    loggedEnv,
    stateDir,
    permissionMode,
    nonInteractivePermissions,
    timeoutSec,
    graceSec,
    sessionKey,
    fingerprint,
    agentCommand,
    agentRegistry,
    remoteExecutionIdentity,
  };
}

async function buildPrompt(ctx: AdapterExecutionContext, resumedSession: boolean): Promise<{
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
  const prompt = joinPromptSections([
    promptInstructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
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
    await emitAcpxLog(ctx, {
      type: "acpx.tool_call",
      name: event.title ?? "acp_tool",
      toolCallId: event.toolCallId,
      status: event.status,
      text: event.text,
      tag: event.tag,
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

function classifyError(err: unknown): Pick<AdapterExecutionResult, "errorCode" | "errorMeta"> {
  const message = err instanceof Error ? err.message : String(err);
  const maybeCode =
    err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : null;
  const acpCode = isAcpRuntimeError(err) || (maybeCode?.startsWith("ACP_") ?? false) ? maybeCode : null;
  const lower = message.toLowerCase();
  const authLike = lower.includes("auth") || lower.includes("login") || lower.includes("credential");
  if (authLike) {
    return {
      errorCode: "acpx_auth_required",
      errorMeta: { category: "auth", ...(acpCode ? { acpCode } : {}) },
    };
  }
  if (acpCode) {
    return {
      errorCode: "acpx_protocol_error",
      errorMeta: { category: "protocol", acpCode },
    };
  }
  return {
    errorCode: "acpx_runtime_error",
    errorMeta: { category: "runtime" },
  };
}

function isResumeFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /resume|load|not found|no session|unknown session|conversation/i.test(message);
}

async function withProcessEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = envLock;
  envLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  const oldValues = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    oldValues.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, oldValue] of oldValues) {
      if (oldValue === undefined) delete process.env[key];
      else process.env[key] = oldValue;
    }
    release();
  }
}

async function cleanupIdleHandles(input: {
  handles: Map<string, RuntimeCacheEntry>;
  now: number;
  idleMs: number;
}) {
  const stale: Array<[string, RuntimeCacheEntry]> = [];
  for (const entry of input.handles.entries()) {
    if (input.now - entry[1].lastUsedAt >= input.idleMs) stale.push(entry);
  }
  for (const [key, entry] of stale) {
    input.handles.delete(key);
    await entry.runtime.close({
      handle: entry.handle,
      reason: "paperclip idle cleanup",
      discardPersistentState: false,
    }).catch(() => {});
  }
}

export function createAcpxLocalExecutor(deps: ExecuteDeps = {}) {
  const createRuntime = deps.createRuntime ?? createAcpRuntime;
  const now = deps.now ?? (() => Date.now());
  const warmHandles = deps.warmHandles ?? defaultWarmHandles;

  return async function executeAcpxLocal(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    const prepared = await buildRuntime({ ctx });
    const warmIdleMs = asNumber(ctx.config.warmHandleIdleMs, DEFAULT_WARM_HANDLE_IDLE_MS);
    await cleanupIdleHandles({ handles: warmHandles, now: now(), idleMs: warmIdleMs });

    const previousParams = parseObject(ctx.runtime.sessionParams);
    const canResume = isCompatibleSession(previousParams, prepared);
    const resumeSessionId = canResume ? asString(previousParams.acpSessionId, "") || undefined : undefined;
    const cached = canResume ? warmHandles.get(prepared.sessionKey) : undefined;
    const runtimeOptions: AcpRuntimeOptions = {
      cwd: prepared.cwd,
      sessionStore: createRuntimeStore({ stateDir: prepared.stateDir }),
      agentRegistry: prepared.agentRegistry,
      permissionMode: prepared.permissionMode,
      nonInteractivePermissions: prepared.nonInteractivePermissions,
      timeoutMs: prepared.timeoutSec > 0 ? prepared.timeoutSec * 1000 : undefined,
    };
    const runtime = cached?.runtime ?? createRuntime(runtimeOptions);
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
      await withProcessEnv(prepared.env, async () => {
        if (!handle) {
          try {
            handle = await runtime.ensureSession({
              sessionKey: prepared.sessionKey,
              agent: prepared.acpxAgent,
              mode: prepared.mode,
              cwd: prepared.cwd,
              resumeSessionId,
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
            });
          }
        }
      });
    } catch (err) {
      const classified = classifyError(err);
      const message = err instanceof Error ? err.message : String(err);
      await emitAcpxLog(ctx, { type: "acpx.error", message, ...classified.errorMeta });
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: message,
        ...classified,
        provider: "acpx",
        model: asString(ctx.config.model, "") || null,
        clearSession,
        resultJson: { phase: "ensure_session" },
        summary: message,
      };
    }

    if (!handle) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "ACPX did not return a runtime session handle.",
        errorCode: "acpx_runtime_error",
        provider: "acpx",
        model: asString(ctx.config.model, "") || null,
        resultJson: { phase: "ensure_session" },
        summary: "ACPX did not return a runtime session handle.",
      };
    }
    const sessionHandle = handle;
    const { prompt, promptMetrics, commandNotes } = await buildPrompt(ctx, resumedSession);
    await emitAcpxLog(ctx, {
      type: "acpx.session",
      agent: prepared.acpxAgent,
      sessionId: sessionHandle.backendSessionId,
      acpSessionId: sessionHandle.backendSessionId,
      agentSessionId: sessionHandle.agentSessionId,
      runtimeSessionName: sessionHandle.runtimeSessionName,
      mode: prepared.mode,
      permissionMode: prepared.permissionMode,
    });
    if (ctx.onMeta) {
      await ctx.onMeta({
        adapterType: "acpx_local",
        command: prepared.agentCommand ?? prepared.acpxAgent,
        cwd: prepared.cwd,
        commandNotes: [
          `ACPX runtime embedded in Paperclip with ${prepared.mode} session mode.`,
          `Effective ACPX permission mode: ${prepared.permissionMode}.`,
          ...commandNotes,
        ],
        env: prepared.loggedEnv,
        prompt,
        promptMetrics,
        context: ctx.context,
      });
    }

    let cancelActiveTurn: ((reason: string) => Promise<void>) | null = null;
    let controller: AbortController | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let timedOut = false;
    const textParts: string[] = [];
    try {
      const timeoutMs = prepared.timeoutSec > 0 ? prepared.timeoutSec * 1000 : undefined;
      controller = new AbortController();
      if (timeoutMs) {
        timeout = setTimeout(() => {
          timedOut = true;
          controller?.abort();
          void cancelActiveTurn?.(`Timed out after ${prepared.timeoutSec}s`).catch(() => {});
        }, timeoutMs);
      }
      const terminal = await withProcessEnv(prepared.env, async () => {
        const turn = runtime.startTurn({
          handle: sessionHandle,
          text: prompt,
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
          await emitRuntimeEvent(ctx, event);
        }
        return await turn.result;
      });
      if (timeout) clearTimeout(timeout);
      if (terminal.status === "failed" || terminal.status === "cancelled" || timedOut) {
        warmHandles.delete(prepared.sessionKey);
        await runtime.close({
          handle: sessionHandle,
          reason: timedOut ? "paperclip timeout cleanup" : `paperclip turn ${terminal.status}`,
          discardPersistentState: terminal.status === "cancelled" || timedOut,
        }).catch(() => {});
      } else if (prepared.mode === "persistent") {
        warmHandles.set(prepared.sessionKey, {
          runtime,
          handle: sessionHandle,
          fingerprint: prepared.fingerprint,
          lastUsedAt: now(),
        });
      }

      const errorMessage = timedOut
        ? `Timed out after ${prepared.timeoutSec}s`
        : resultErrorMessage(terminal);
      const terminalStopReason = terminal.status === "failed" ? terminal.error.message : terminal.stopReason;
      await emitAcpxLog(ctx, {
        type: terminal.status === "completed" ? "acpx.result" : "acpx.error",
        summary: terminal.status,
        stopReason: terminalStopReason,
        message: errorMessage,
      });
      return {
        exitCode: terminal.status === "completed" ? 0 : 1,
        signal: timedOut ? "SIGTERM" : null,
        timedOut,
        errorMessage,
        errorCode: terminal.status === "failed" ? "acpx_turn_failed" : timedOut ? "acpx_timeout" : null,
        sessionId: sessionHandle.backendSessionId ?? sessionHandle.runtimeSessionName,
        sessionParams: buildSessionParams({ prepared, handle: sessionHandle }),
        sessionDisplayId: sessionHandle.agentSessionId ?? sessionHandle.backendSessionId ?? sessionHandle.runtimeSessionName,
        provider: "acpx",
        model: asString(ctx.config.model, "") || null,
        billingType: "unknown",
        costUsd: null,
        resultJson: {
          status: terminal.status,
          stopReason: terminalStopReason,
          permissionMode: prepared.permissionMode,
          mode: prepared.mode,
        },
        summary: textParts.join("").trim() || terminalStopReason || terminal.status,
        clearSession,
      };
    } catch (err) {
      if (timeout) clearTimeout(timeout);
      const classified = classifyError(err);
      const message = timedOut ? `Timed out after ${prepared.timeoutSec}s` : err instanceof Error ? err.message : String(err);
      const cancel = cancelActiveTurn as ((reason: string) => Promise<void>) | null;
      if (cancel) await cancel(message).catch(() => {});
      await runtime.close({
        handle: sessionHandle,
        reason: timedOut ? "paperclip timeout cleanup" : "paperclip error cleanup",
        discardPersistentState: timedOut,
      }).catch(() => {});
      warmHandles.delete(prepared.sessionKey);
      await emitAcpxLog(ctx, { type: "acpx.error", message, ...classified.errorMeta });
      return {
        exitCode: 1,
        signal: timedOut ? "SIGTERM" : null,
        timedOut,
        errorMessage: message,
        errorCode: timedOut ? "acpx_timeout" : classified.errorCode,
        errorMeta: classified.errorMeta,
        provider: "acpx",
        model: asString(ctx.config.model, "") || null,
        clearSession: clearSession || timedOut,
        resultJson: { phase: "turn" },
        summary: message,
      };
    }
  };
}

export const execute = createAcpxLocalExecutor();
