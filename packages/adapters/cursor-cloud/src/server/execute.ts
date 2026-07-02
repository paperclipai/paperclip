import fs from "node:fs/promises";
import path from "node:path";
import {
  Agent,
  type AgentOptions,
  type ModelSelection,
  type Run,
  type RunResult,
  type SDKAgent,
} from "@cursor/sdk";
import type { AdapterExecutionContext, AdapterExecutionResult, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  asString,
  joinPromptSections,
  normalizePaperclipChatWakePayload,
  parseObject,
  renderPaperclipChatWakePrompt,
  renderPaperclipWakePrompt,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";
import { classifyCursorApiError } from "./cursor-api-retry.js";
import { eventLine, flattenPrUrl, type CursorCloudEvent } from "./cursor-run-events.js";
import { resolveCursorCloudMcpServers } from "./mcp-servers.js";
import { estimateCursorCloudCostUsd } from "./pricing-fallback.js";
import {
  parseCursorCloudAdapterConfig,
  resolveCursorCloudRepos,
  resolveExecutionTarget,
} from "./repos.js";
import { sessionIdentityMatches } from "./session.js";
import { observeRunStream } from "./sse-stream.js";
import { fetchCursorRunUsage, mapUsageToAdapterResult } from "./usage.js";
import { buildCursorCloudWakeEnv } from "./wake-env.js";

type CursorCloudSession = {
  cursorAgentId: string;
  latestRunId?: string;
  runtime: "cloud";
  envType?: "cloud" | "pool" | "machine";
  envName?: string;
  repos: Array<{ url: string; startingRef?: string; prUrl?: string }>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asStringEnvMap(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") {
      env[key] = entry;
    } else if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const rec = entry as Record<string, unknown>;
      if (rec.type === "plain" && typeof rec.value === "string") env[key] = rec.value;
    }
  }
  return env;
}

function trimNullable(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function toModelSelection(rawModel: string): ModelSelection | undefined {
  const model = rawModel.trim();
  return model ? { id: model } : undefined;
}

function toSummary(result: RunResult): string | null {
  const direct = trimNullable(result.result);
  if (direct) return firstNonEmptyLine(direct);
  return null;
}

function formatRunError(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message.trim();
  return String(err);
}

async function buildInstructionsPrefix(
  instructionsFilePath: string | undefined,
  onLog: AdapterExecutionContext["onLog"],
): Promise<{ prefix: string; notes: string[]; chars: number }> {
  if (!instructionsFilePath) {
    return { prefix: "", notes: [], chars: 0 };
  }

  try {
    const contents = await fs.readFile(instructionsFilePath, "utf8");
    const instructionsDir = `${path.dirname(instructionsFilePath)}/`;
    const prefix = `${contents.trim()}\n\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsDir}.\n`;
    return {
      prefix,
      chars: prefix.length,
      notes: [
        `Loaded agent instructions from ${instructionsFilePath}`,
        `Prepended instructions + path directive to prompt (relative references from ${instructionsDir}).`,
      ],
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await onLog(
      "stderr",
      `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
    );
    return {
      prefix: "",
      chars: 0,
      notes: [
        `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      ],
    };
  }
}

function renderPaperclipEnvNote(env: Record<string, string>): string {
  const keys = Object.keys(env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort();
  if (keys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in the cloud agent shell: ${keys.join(", ")}`,
    "Use them directly instead of assuming they are absent.",
  ].join("\n");
}

function readSession(params: Record<string, unknown> | null): CursorCloudSession | null {
  if (!params) return null;
  const record = asRecord(params);
  if (!record) return null;
  const cursorAgentId =
    trimNullable(record.cursorAgentId) ??
    trimNullable(record.agentId) ??
    trimNullable(record.sessionId);
  if (!cursorAgentId) return null;
  const latestRunId = trimNullable(record.latestRunId) ?? trimNullable(record.runId) ?? undefined;
  const envType = trimNullable(record.envType) as CursorCloudSession["envType"];
  const envName = trimNullable(record.envName) ?? undefined;
  const reposValue = Array.isArray(record.repos) ? record.repos : [];
  const repos = reposValue
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => ({
      url: asString(entry.url, "").trim(),
      startingRef: trimNullable(entry.startingRef) ?? undefined,
      prUrl: trimNullable(entry.prUrl) ?? undefined,
    }))
    .filter((entry) => entry.url.length > 0);
  return {
    cursorAgentId,
    ...(latestRunId ? { latestRunId } : {}),
    runtime: "cloud",
    ...(envType ? { envType } : {}),
    ...(envName ? { envName } : {}),
    repos,
  };
}

function buildAgentOptions(input: {
  apiKey: string;
  name: string;
  model?: ModelSelection;
  envType: "cloud" | "pool" | "machine";
  envName: string | null;
  repos: Array<{ url: string; startingRef?: string; prUrl?: string }>;
  workOnCurrentBranch: boolean;
  autoCreatePR: boolean;
  skipReviewerRequest: boolean;
  envVars: Record<string, string>;
  mcpServers?: AgentOptions["mcpServers"];
  mode?: AgentOptions["mode"];
}): AgentOptions {
  return {
    apiKey: input.apiKey,
    name: input.name,
    ...(input.model ? { model: input.model } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.mcpServers && Object.keys(input.mcpServers).length > 0
      ? { mcpServers: input.mcpServers }
      : {}),
    cloud: {
      env: {
        type: input.envType,
        ...(input.envName ? { name: input.envName } : {}),
      },
      repos: input.repos,
      workOnCurrentBranch: input.workOnCurrentBranch,
      autoCreatePR: input.autoCreatePR,
      skipReviewerRequest: input.skipReviewerRequest,
      envVars: input.envVars,
    },
  };
}

async function emitStatus(onLog: AdapterExecutionContext["onLog"], status: string, message?: string) {
  await onLog("stdout", eventLine({ type: "cursor_cloud.status", status, ...(message ? { message } : {}) }));
}

async function streamRun(run: Run, agentId: string, apiKey: string, onLog: AdapterExecutionContext["onLog"]) {
  if (!run.supports("stream")) return;
  await observeRunStream({
    run,
    agentId,
    onLog,
    getRunFallback: async () => {
      const snapshot = await Agent.getRun(run.id, {
        runtime: "cloud",
        agentId,
        apiKey,
      });
      return {
        status: snapshot.status,
        git: snapshot.git as { branches: Array<{ repoUrl: string; branch?: string; prUrl?: string }> } | undefined,
      };
    },
  });
}

async function getAttachedRun(input: {
  apiKey: string;
  session: CursorCloudSession | null;
}): Promise<Run | null> {
  const latestRunId = input.session?.latestRunId;
  const cursorAgentId = input.session?.cursorAgentId;
  if (!latestRunId || !cursorAgentId) return null;
  try {
    const run = await Agent.getRun(latestRunId, {
      runtime: "cloud",
      agentId: cursorAgentId,
      apiKey: input.apiKey,
    });
    return run.status === "running" ? run : null;
  } catch {
    return null;
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta } = ctx;
  const adapterConfig = parseCursorCloudAdapterConfig(config);
  const envConfig = asStringEnvMap(adapterConfig.env ?? config.env);
  const apiKey = asString(envConfig.CURSOR_API_KEY, "").trim();
  if (!apiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "CURSOR_API_KEY is required for cursor_cloud.",
      provider: "cursor",
      biller: "cursor",
      billingType: "api",
      clearSession: false,
    };
  }

  const workspace = parseObject(context.paperclipWorkspace);
  const repos = resolveCursorCloudRepos(adapterConfig, workspace);
  const primaryRepo = repos[0];
  if (!primaryRepo?.url) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "cursor_cloud requires repoUrl in adapterConfig or workspace context.",
      provider: "cursor",
      biller: "cursor",
      billingType: "api",
      clearSession: false,
    };
  }

  const { envType, envName } = resolveExecutionTarget(adapterConfig);
  const workOnCurrentBranch = adapterConfig.workOnCurrentBranch ?? false;
  const autoCreatePR = adapterConfig.autoCreatePR ?? false;
  const skipReviewerRequest = adapterConfig.skipReviewerRequest ?? false;
  const model = toModelSelection(adapterConfig.model ?? asString(config.model, ""));
  const sendMode = adapterConfig.mode;
  const mcpServers = resolveCursorCloudMcpServers({
    config: adapterConfig,
    resolvedSecrets: envConfig,
  });
  const remoteEnv = buildCursorCloudWakeEnv(ctx, envConfig);
  const session = readSession(runtime.sessionParams) ?? (runtime.sessionId
    ? {
        cursorAgentId: runtime.sessionId,
        runtime: "cloud" as const,
        repos,
      }
    : null);
  const canReuseSession = Boolean(session) && sessionIdentityMatches(
    {
      cursorAgentId: session!.cursorAgentId,
      envType: session!.envType ?? "cloud",
      envName: session!.envName ?? null,
      repos: session!.repos.length > 0 ? session!.repos : repos,
    },
    { envType, envName, repos },
  );
  const chatWake = normalizePaperclipChatWakePayload(context.paperclipChatWake);
  const promptTemplate = adapterConfig.promptTemplate ?? asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const bootstrapPromptTemplate = adapterConfig.bootstrapPromptTemplate ?? asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const instructions = await buildInstructionsPrefix(adapterConfig.instructionsFilePath, onLog);
  const wakePrompt = chatWake
    ? renderPaperclipChatWakePrompt(chatWake, { resumedSession: canReuseSession })
    : renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: canReuseSession });
  const renderedBootstrapPrompt =
    !canReuseSession && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const renderedPrompt =
    canReuseSession && wakePrompt.length > 0
      ? ""
      : renderTemplate(promptTemplate, templateData).trim();
  const paperclipEnvNote = renderPaperclipEnvNote(remoteEnv);
  const prompt = joinPromptSections([
    instructions.prefix,
    renderedBootstrapPrompt,
    wakePrompt,
    paperclipEnvNote,
    renderedPrompt,
  ]);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const finalPrompt = joinPromptSections([prompt, sessionHandoffNote]);

  const agentOptions = buildAgentOptions({
    apiKey,
    name: `Paperclip ${agent.name}`,
    model,
    envType,
    envName,
    repos,
    workOnCurrentBranch,
    autoCreatePR,
    skipReviewerRequest,
    envVars: remoteEnv,
    mcpServers,
    mode: sendMode,
  });

  const sendOptions = {
    ...(model ? { model } : {}),
    ...(sendMode ? { mode: sendMode } : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
  };

  const commandNotes = [
    ...instructions.notes,
    canReuseSession
      ? `Reusing Cursor cloud agent session ${session?.cursorAgentId ?? "unknown"}`
      : "Creating a new Cursor cloud agent session",
    `Repository: ${primaryRepo.url}${primaryRepo.startingRef ? ` @ ${primaryRepo.startingRef}` : ""}`,
    `Runtime target: ${envType}${envName ? ` (${envName})` : ""}`,
    ...(chatWake ? ["Chat-mode wake (paperclipChatWake)"] : []),
    ...(Object.keys(mcpServers).length > 0
      ? [`MCP servers: ${Object.keys(mcpServers).join(", ")}`]
      : []),
  ];

  if (onMeta) {
    const meta: AdapterInvocationMeta = {
      adapterType: "cursor_cloud",
      command: "@cursor/sdk",
      commandNotes,
      prompt: finalPrompt,
      promptMetrics: {
        promptChars: finalPrompt.length,
        instructionsChars: instructions.chars,
        bootstrapPromptChars: renderedBootstrapPrompt.length,
        wakePromptChars: wakePrompt.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      context: {
        cursorCloud: {
          envType,
          envName,
          repoUrl: primaryRepo.url,
          repoStartingRef: primaryRepo.startingRef,
          repoPullRequestUrl: primaryRepo.prUrl,
          canReuseSession,
          chatMode: Boolean(chatWake),
          mcpServerNames: Object.keys(mcpServers),
        },
      },
    };
    await onMeta(meta);
  }

  let sdkAgent: SDKAgent | null = null;
  let run: Run | null = null;
  let streamError: string | null = null;
  try {
    const attachedRun = canReuseSession
      ? await getAttachedRun({ apiKey, session })
      : null;

    if (attachedRun) {
      await emitStatus(onLog, "running", `Reattached to existing Cursor run ${attachedRun.id}.`);
      await onLog("stdout", eventLine({
        type: "cursor_cloud.init",
        sessionId: attachedRun.agentId,
        agentId: attachedRun.agentId,
        runId: attachedRun.id,
        ...(model?.id ? { model: model.id } : {}),
      } satisfies CursorCloudEvent));
      const priorStreamPromise = streamRun(attachedRun, attachedRun.agentId, apiKey, onLog).catch((err) => {
        streamError = formatRunError(err);
      });
      if (attachedRun.supports("wait")) await attachedRun.wait();
      await priorStreamPromise;
      streamError = null;
      await emitStatus(
        onLog,
        "running",
        `Prior Cursor run ${attachedRun.id} finished; sending heartbeat follow-up so this wake's context is not dropped.`,
      );
    }

    sdkAgent = canReuseSession && session
      ? await Agent.resume(session.cursorAgentId, agentOptions)
      : await Agent.create(agentOptions);
    run = await sdkAgent.send(finalPrompt, sendOptions);
    await onLog("stdout", eventLine({
      type: "cursor_cloud.init",
      sessionId: sdkAgent.agentId,
      agentId: sdkAgent.agentId,
      runId: run.id,
      ...(model?.id ? { model: model.id } : {}),
    } satisfies CursorCloudEvent));
    await emitStatus(onLog, "running", `Started Cursor run ${run.id}.`);

    const streamPromise = streamRun(run, run.agentId, apiKey, onLog).catch((err) => {
      streamError = formatRunError(err);
    });
    const result = run.supports("wait")
      ? await run.wait()
      : {
          id: run.id,
          status: run.status === "running" ? "error" : run.status,
          result: run.result,
          model: run.model,
          durationMs: run.durationMs,
          git: run.git,
        };
    await streamPromise;

    const hasGitEvidence = !!(result.git?.branches?.length);
    const isPhantomSuccess = result.status === "finished" && !hasGitEvidence && !chatWake;
    const phantomDiagnostic = isPhantomSuccess
      ? `Phantom success detected: Cursor run finished without evidence of code execution (no git branches/PRs). Result text: ${trimNullable(result.result)?.slice(0, 200) ?? "(empty)"}`
      : null;
    const prUrl = flattenPrUrl(result.git);

    const modelId = result.model?.id ?? model?.id ?? null;
    await onLog("stdout", eventLine({
      type: "cursor_cloud.result",
      status: result.status,
      ...(result.result ? { result: result.result } : {}),
      ...(modelId ? { model: modelId } : {}),
      ...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
      ...(result.git ? { git: result.git } : {}),
      ...(streamError ? { error: streamError } : {}),
      ...(isPhantomSuccess ? { phantomSuccess: true } : {}),
    } satisfies CursorCloudEvent));

    const nextSession: CursorCloudSession = {
      cursorAgentId: run.agentId,
      latestRunId: result.id,
      runtime: "cloud",
      envType,
      ...(envName ? { envName } : {}),
      repos,
    };
    const isError = result.status !== "finished" || isPhantomSuccess;
    let mappedUsage: ReturnType<typeof mapUsageToAdapterResult> | undefined;
    let cursorUsage: Awaited<ReturnType<typeof fetchCursorRunUsage>> = null;
    let costUsd: number | null = null;
    let costEstimated = false;

    if (result.status === "finished") {
      cursorUsage = await fetchCursorRunUsage({
        apiKey,
        agentId: run.agentId,
        runId: result.id,
      });
      if (cursorUsage) {
        mappedUsage = mapUsageToAdapterResult(cursorUsage);
        const estimated = estimateCursorCloudCostUsd({ modelId, usage: cursorUsage });
        if (estimated != null) {
          costUsd = estimated;
          costEstimated = true;
        }
      } else {
        await onLog(
          "stderr",
          "[cursor_cloud] Warning: could not fetch run usage from Cursor API.\n",
        );
      }
    }

    return {
      exitCode: isError ? 1 : 0,
      signal: null,
      timedOut: false,
      errorMessage: phantomDiagnostic ?? (isError ? (trimNullable(result.result) ?? streamError ?? `Cursor run ${result.status}`) : null),
      sessionId: run.agentId,
      sessionDisplayId: run.agentId,
      sessionParams: nextSession,
      provider: "cursor",
      biller: "cursor",
      billingType: "api",
      model: modelId,
      costUsd,
      ...(mappedUsage ? { usage: mappedUsage } : {}),
      summary: toSummary(result),
      resultJson: {
        status: result.status,
        cursorAgentId: run.agentId,
        cursorRunId: result.id,
        envType,
        envName,
        repos,
        ...(prUrl ? { prUrl } : {}),
        ...(result.result ? { result: result.result } : {}),
        ...(result.git ? { git: result.git } : {}),
        ...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
        ...(streamError ? { streamError } : {}),
        ...(cursorUsage ? { cursorUsage } : {}),
        ...(result.status === "finished"
          ? {
              costEstimated,
              costSource: costEstimated ? "paperclip_pricing_fallback" : cursorUsage ? "cursor_usage_api" : "unknown",
            }
          : {}),
        ...(isPhantomSuccess ? { phantomSuccess: true, hasGitEvidence: false } : {}),
        ...(chatWake ? { chatMode: true, threadId: chatWake.threadId } : {}),
      },
      clearSession: false,
    };
  } catch (err) {
    const classified = classifyCursorApiError(err);
    const reason = formatRunError(err);
    const isAgentBusy = classified.kind === "agent_busy";
    if (run) {
      await onLog("stdout", eventLine({
        type: "cursor_cloud.result",
        status: "error",
        error: reason,
      } satisfies CursorCloudEvent));
    }
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: reason,
      sessionId: session?.cursorAgentId ?? null,
      sessionDisplayId: session?.cursorAgentId ?? null,
      sessionParams: session,
      provider: "cursor",
      biller: "cursor",
      billingType: "api",
      costUsd: null,
      clearSession: false,
      resultJson: {
        status: "error",
        ...(run ? { cursorRunId: run.id } : {}),
        ...(session?.cursorAgentId ? { cursorAgentId: session.cursorAgentId } : {}),
        error: reason,
        ...(isAgentBusy ? { cursorAgentBusy: true, errorFamily: "cursor_agent_busy" } : {}),
      },
    };
  } finally {
    if (sdkAgent) {
      try {
        await sdkAgent[Symbol.asyncDispose]();
      } catch {
        // Best effort only.
      }
    }
  }
}
