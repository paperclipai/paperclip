import fs from "node:fs/promises";
import path from "node:path";
import {
  type AdapterExecutionContext,
  type AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  parseObject,
  applyPaperclipWorkspaceEnv,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  renderTemplate,
  renderPaperclipWakePrompt,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import { adapterExecutionTargetIsRemote, readAdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { DEFAULT_CURSOR_SDK_MODEL } from "../index.js";
import { buildRuntimeOptions } from "../runtime.js";
import { loadCursorSdk, type SdkAgent, type SdkRun, type SdkRunResult } from "../sdk-types.js";
import { buildResultEvent, makeEmitter, translateSdkMessage } from "../events.js";

interface PromptMetrics {
  promptChars: number;
  instructionsChars: number;
  bootstrapPromptChars: number;
  wakePromptChars: number;
  sessionHandoffChars: number;
  runtimeNoteChars: number;
  heartbeatPromptChars: number;
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
    "",
    "",
  ].join("\n");
}

function resolveProviderFromModel(model: string): string | null {
  const trimmed = model.trim().toLowerCase();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash > 0) return trimmed.slice(0, slash);
  if (trimmed.includes("sonnet") || trimmed.includes("claude") || trimmed.includes("opus")) return "anthropic";
  if (trimmed.startsWith("gpt") || trimmed.startsWith("composer") || trimmed.startsWith("o")) return "openai";
  if (trimmed.startsWith("gemini")) return "google";
  return null;
}

function resolveBillingType(env: Record<string, string>): "api" | "subscription" {
  const has = (key: string) => typeof env[key] === "string" && env[key].trim().length > 0;
  return has("CURSOR_API_KEY") || has("OPENAI_API_KEY") ? "api" : "subscription";
}

function buildEnv(
  ctx: AdapterExecutionContext,
  envConfig: Record<string, unknown>,
  workspace: { cwd: string; source: string; workspaceId: string; repoUrl: string; repoRef: string; agentHome: string },
): Record<string, string> {
  const env: Record<string, string> = { ...buildPaperclipEnv(ctx.agent) };
  env.PAPERCLIP_RUN_ID = ctx.runId;

  const wakeTaskId =
    (typeof ctx.context.taskId === "string" && ctx.context.taskId.trim()) ||
    (typeof ctx.context.issueId === "string" && ctx.context.issueId.trim()) ||
    "";
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  const wakeReason = typeof ctx.context.wakeReason === "string" ? ctx.context.wakeReason.trim() : "";
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  const wakeCommentId =
    (typeof ctx.context.wakeCommentId === "string" && ctx.context.wakeCommentId.trim()) ||
    (typeof ctx.context.commentId === "string" && ctx.context.commentId.trim()) ||
    "";
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  const approvalId = typeof ctx.context.approvalId === "string" ? ctx.context.approvalId.trim() : "";
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  const approvalStatus = typeof ctx.context.approvalStatus === "string" ? ctx.context.approvalStatus.trim() : "";
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  const linkedIssueIds = Array.isArray(ctx.context.issueIds)
    ? ctx.context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");

  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: workspace.cwd,
    workspaceSource: workspace.source,
    workspaceId: workspace.workspaceId,
    workspaceRepoUrl: workspace.repoUrl,
    workspaceRepoRef: workspace.repoRef,
    agentHome: workspace.agentHome,
  });

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  if (!hasExplicitApiKey && ctx.authToken) {
    env.PAPERCLIP_API_KEY = ctx.authToken;
  }
  return env;
}

function partitionSessionEnv(env: Record<string, string>): Record<string, string> {
  // Cloud envVars cannot start with CURSOR_; PAPERCLIP_* are fine.
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("CURSOR_")) continue;
    if (typeof value !== "string" || value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

async function resolveTimeoutWait<T>(
  promise: Promise<T>,
  timeoutSec: number,
  onTimeout: () => Promise<void>,
): Promise<{ result: T | null; timedOut: boolean }> {
  if (timeoutSec <= 0) {
    return { result: await promise, timedOut: false };
  }
  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, timeoutSec * 1000);
  });
  try {
    const winner = await Promise.race([promise.then((value) => ({ kind: "ok", value }) as const), timeout.then(() => ({ kind: "timeout" }) as const)]);
    if (winner.kind === "ok") {
      return { result: winner.value, timedOut: false };
    }
    await onTimeout();
    return { result: null, timedOut: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function safeDispose(agent: SdkAgent | null): Promise<void> {
  if (!agent) return;
  try {
    if (typeof agent[Symbol.asyncDispose] === "function") {
      await agent[Symbol.asyncDispose]!();
      return;
    }
    if (typeof agent.close === "function") {
      agent.close();
    }
  } catch {
    // disposal is best-effort
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });

  if (adapterExecutionTargetIsRemote(executionTarget)) {
    const message =
      "cursor_sdk does not support remote execution targets in V1. " +
      "Use the existing 'cursor' adapter for E2B/SSH-style remote execution, " +
      "or set runtime: \"cloud\" to run inside Cursor-managed VMs.";
    await onLog("stderr", `[paperclip] ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
    };
  }

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const model = asString(config.model, DEFAULT_CURSOR_SDK_MODEL);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspace = {
    cwd: asString(workspaceContext.cwd, ""),
    source: asString(workspaceContext.source, ""),
    workspaceId: asString(workspaceContext.workspaceId, ""),
    repoUrl: asString(workspaceContext.repoUrl, ""),
    repoRef: asString(workspaceContext.repoRef, ""),
    agentHome: asString(workspaceContext.agentHome, ""),
  };

  const envConfig = parseObject(config.env);
  const env = buildEnv(ctx, envConfig, workspace);
  const apiKey = (typeof envConfig.CURSOR_API_KEY === "string" ? envConfig.CURSOR_API_KEY : "")
    || env.CURSOR_API_KEY
    || (typeof process.env.CURSOR_API_KEY === "string" ? process.env.CURSOR_API_KEY : "");

  const sessionEnvVars = parseObject(config.sessionEnvVars);
  const cloudSessionEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(sessionEnvVars)) {
    if (typeof value === "string") cloudSessionEnv[key] = value;
  }
  // Forward Paperclip identity vars too so cloud agents can call back if needed.
  Object.assign(cloudSessionEnv, partitionSessionEnv(env));

  const resolved = buildRuntimeOptions({
    config,
    workspaceCwd: workspace.cwd,
    workspaceRepoUrl: workspace.repoUrl,
    workspaceRepoRef: workspace.repoRef,
    apiKey: apiKey.trim(),
    sessionEnvVars: cloudSessionEnv,
  });

  if (resolved.validationErrors.length > 0) {
    const message = resolved.validationErrors.join(" ");
    await onLog("stderr", `[paperclip] cursor_sdk config error: ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
    };
  }

  if (resolved.runtime === "local" && resolved.effectiveCwd) {
    await ensureAbsoluteDirectory(resolved.effectiveCwd, { createIfMissing: true });
  }

  // Session resume policy
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimeSessionRepo = asString(runtimeSessionParams.repoUrl, "");
  const canResumeSession = (() => {
    if (!runtimeSessionId) return false;
    if (resolved.runtime === "local") {
      if (!runtimeSessionCwd) return true; // legacy/no cwd recorded
      return path.resolve(runtimeSessionCwd) === path.resolve(resolved.effectiveCwd);
    }
    if (!runtimeSessionRepo) return true;
    return runtimeSessionRepo === resolved.effectiveRepository;
  })();
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    const reason = resolved.runtime === "local"
      ? `cwd "${runtimeSessionCwd}" does not match "${resolved.effectiveCwd}"`
      : `repository "${runtimeSessionRepo}" does not match "${resolved.effectiveRepository}"`;
    await onLog("stdout", `[paperclip] Cursor SDK session "${runtimeSessionId}" will not be resumed: ${reason}.\n`);
  }

  // Prompt assembly
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  let instructionsPrefix = "";
  let instructionsChars = 0;
  if (instructionsFilePath) {
    try {
      const contents = await fs.readFile(instructionsFilePath, "utf8");
      const dir = `${path.dirname(instructionsFilePath)}/`;
      instructionsPrefix =
        `${contents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${dir}.\n\n`;
      instructionsChars = instructionsPrefix.length;
    } catch (err) {
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
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
  const renderedBootstrapPrompt = !sessionId && bootstrapPromptTemplate.trim().length > 0
    ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
    : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
  const useResumeDelta = Boolean(sessionId) && wakePrompt.length > 0;
  const renderedPrompt = useResumeDelta ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const paperclipEnvNote = renderPaperclipEnvNote(env);
  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    paperclipEnvNote,
    renderedPrompt,
  ]);

  const promptMetrics: PromptMetrics = {
    promptChars: prompt.length,
    instructionsChars,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    runtimeNoteChars: paperclipEnvNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const billingType = resolveBillingType(env);
  const provider = resolveProviderFromModel(model);

  if (onMeta) {
    await onMeta({
      adapterType: "cursor_sdk",
      command: "@cursor/sdk:Agent",
      cwd: resolved.runtime === "local" ? resolved.effectiveCwd : "",
      commandArgs: [resolved.runtime, model, sessionId ? "resume" : "create"],
      commandNotes: [
        `runtime=${resolved.runtime}`,
        sessionId ? `Resuming Cursor agent ${sessionId}` : "Creating new Cursor agent",
        resolved.runtime === "local"
          ? `local.cwd=${resolved.effectiveCwd}`
          : `cloud.repository=${resolved.effectiveRepository}@${resolved.effectiveRef}`,
        instructionsFilePath
          ? (instructionsChars > 0
              ? `Loaded agent instructions from ${instructionsFilePath}`
              : `Configured instructionsFilePath ${instructionsFilePath} (file unreadable)`)
          : "No instructions file configured",
      ],
      env: {},
      prompt,
      promptMetrics: promptMetrics as unknown as Record<string, number>,
      context: context as Record<string, unknown>,
    });
  }

  // Load SDK
  const sdk = await loadCursorSdk();
  if (!sdk) {
    const message =
      "cursor_sdk: @cursor/sdk is not installed. Add it to the Paperclip server's node_modules " +
      "(pnpm add @cursor/sdk) and retry.";
    await onLog("stderr", `[paperclip] ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
    };
  }

  if (!apiKey.trim()) {
    const message =
      "cursor_sdk: CURSOR_API_KEY is not set. Add it to adapter env (preferably as a secret_ref) " +
      "or to the Paperclip server's environment.";
    await onLog("stderr", `[paperclip] ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
    };
  }

  const emit = makeEmitter(onLog);
  let sdkAgent: SdkAgent | null = null;
  let sdkRun: SdkRun | null = null;

  try {
    sdkAgent = sessionId
      ? await sdk.Agent.resume(sessionId, resolved.sdkOptions)
      : await sdk.Agent.create(resolved.sdkOptions);

    await emit({
      type: "system",
      subtype: "init",
      model,
      sessionId: sdkAgent.agentId,
      runtime: resolved.runtime,
    });

    const sendOptions = {
      ...(resolved.sdkOptions.mcpServers ? { mcpServers: resolved.sdkOptions.mcpServers } : {}),
      ...(resolved.sdkOptions.agents ? { agents: resolved.sdkOptions.agents } : {}),
    };
    sdkRun = await sdkAgent.send({ text: prompt }, sendOptions);

    if (sdkRun.onDidChangeStatus) {
      sdkRun.onDidChangeStatus(async (status) => {
        await emit({ type: "status", status, runStatus: status });
      });
    }

    const streamPromise = (async () => {
      try {
        for await (const message of sdkRun!.stream()) {
          for (const event of translateSdkMessage(message, { runtime: resolved.runtime })) {
            await emit(event);
          }
        }
      } catch (err) {
        await emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();

    const waited = await resolveTimeoutWait(
      sdkRun.wait(),
      timeoutSec,
      async () => {
        try {
          await sdkRun!.cancel();
        } catch {
          // best-effort cancel; continue to dispose
        }
        // give the stream a brief grace window to drain
        await new Promise((resolve) => setTimeout(resolve, Math.min(graceSec, 5) * 1000));
      },
    );
    await streamPromise;

    if (waited.timedOut) {
      await emit({ type: "result", subtype: "cancelled", result: "", is_error: true });
      return {
        exitCode: 1,
        signal: null,
        timedOut: true,
        errorMessage: `Cursor SDK run timed out after ${timeoutSec}s`,
        sessionId: sdkAgent.agentId,
        sessionParams: buildSessionParams(sdkAgent.agentId, resolved, workspace),
        sessionDisplayId: sdkAgent.agentId,
        provider,
        biller: billingType === "subscription" ? "cursor" : provider ?? "cursor",
        model,
        billingType,
        costUsd: null,
      };
    }

    const result = (waited.result ?? { status: "error" as const }) as SdkRunResult;
    await emit(buildResultEvent(result));

    const isError = result.status === "error" || result.status === "cancelled";
    return {
      exitCode: isError ? 1 : 0,
      signal: null,
      timedOut: false,
      errorMessage: isError ? (result.errorMessage ?? `Cursor SDK run ended with status "${result.status}"`) : null,
      sessionId: sdkAgent.agentId,
      sessionParams: buildSessionParams(sdkAgent.agentId, resolved, workspace),
      sessionDisplayId: sdkAgent.agentId,
      provider,
      biller: billingType === "subscription" ? "cursor" : provider ?? "cursor",
      model,
      billingType,
      costUsd: null,
      summary: result.result ?? null,
      resultJson: {
        runtime: resolved.runtime,
        status: result.status,
        durationMs: result.durationMs ?? null,
        git: result.git ?? null,
        agentId: sdkAgent.agentId,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emit({ type: "error", message });
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
      sessionId: sdkAgent?.agentId ?? null,
      sessionParams: sdkAgent ? buildSessionParams(sdkAgent.agentId, resolved, workspace) : null,
      sessionDisplayId: sdkAgent?.agentId ?? null,
      provider,
      biller: billingType === "subscription" ? "cursor" : provider ?? "cursor",
      model,
      billingType,
      costUsd: null,
    };
  } finally {
    await safeDispose(sdkAgent);
  }
}

function buildSessionParams(
  agentId: string,
  resolved: ReturnType<typeof buildRuntimeOptions>,
  workspace: { workspaceId: string; repoUrl: string; repoRef: string },
): Record<string, unknown> {
  const params: Record<string, unknown> = { sessionId: agentId, runtime: resolved.runtime };
  if (resolved.runtime === "local") {
    if (resolved.effectiveCwd) params.cwd = resolved.effectiveCwd;
  } else {
    if (resolved.effectiveRepository) params.repoUrl = resolved.effectiveRepository;
    if (resolved.effectiveRef) params.repoRef = resolved.effectiveRef;
  }
  if (workspace.workspaceId) params.workspaceId = workspace.workspaceId;
  if (workspace.repoUrl && !params.repoUrl) params.repoUrl = workspace.repoUrl;
  if (workspace.repoRef && !params.repoRef) params.repoRef = workspace.repoRef;
  return params;
}
