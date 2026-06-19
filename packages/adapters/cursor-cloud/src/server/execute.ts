import fs from "node:fs/promises";
import path from "node:path";
import {
  Agent,
  type AgentOptions,
  type ModelSelection,
  type Run,
  type RunResult,
  type SDKAgent,
  type SDKMessage,
} from "@cursor/sdk";
import type { AdapterExecutionContext, AdapterExecutionResult, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  asBoolean,
  asString,
  buildPaperclipEnv,
  joinPromptSections,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  renderPaperclipWakePrompt,
  renderTemplate,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";

type CursorCloudSession = {
  cursorAgentId: string;
  latestRunId?: string;
  runtime: "cloud";
  envType?: "cloud" | "pool" | "machine";
  envName?: string;
  repos: Array<{ url: string; startingRef?: string; prUrl?: string }>;
};

type CursorCloudEvent =
  | { type: "cursor_cloud.init"; sessionId: string; agentId: string; runId?: string; model?: string }
  | { type: "cursor_cloud.status"; status: string; message?: string }
  | { type: "cursor_cloud.message"; message: SDKMessage }
  | {
      type: "cursor_cloud.result";
      status: string;
      result?: string;
      model?: string;
      durationMs?: number;
      git?: unknown;
      error?: string;
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

function normalizeEnvType(raw: string): "cloud" | "pool" | "machine" {
  const value = raw.trim().toLowerCase();
  if (value === "pool" || value === "machine") return value;
  return "cloud";
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

function buildWakeEnv(ctx: AdapterExecutionContext, configEnv: Record<string, string>): Record<string, string> {
  const { runId, agent, context, authToken } = ctx;
  const env: Record<string, string> = {
    ...configEnv,
    ...buildPaperclipEnv(agent),
    PAPERCLIP_RUN_ID: runId,
  };

  const wakeTaskId = trimNullable(context.taskId) ?? trimNullable(context.issueId);
  const wakeReason = trimNullable(context.wakeReason);
  const wakeCommentId = trimNullable(context.wakeCommentId) ?? trimNullable(context.commentId);
  const approvalId = trimNullable(context.approvalId);
  const approvalStatus = trimNullable(context.approvalStatus);
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (!trimNullable(env.PAPERCLIP_API_KEY) && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const workspace = parseObject(context.paperclipWorkspace);
  const workspaceMappings: Array<[string, unknown]> = [
    ["PAPERCLIP_WORKSPACE_CWD", workspace.cwd],
    ["PAPERCLIP_WORKSPACE_SOURCE", workspace.source],
    ["PAPERCLIP_WORKSPACE_ID", workspace.workspaceId],
    ["PAPERCLIP_WORKSPACE_REPO_URL", workspace.repoUrl],
    ["PAPERCLIP_WORKSPACE_REPO_REF", workspace.repoRef],
    ["PAPERCLIP_WORKSPACE_BRANCH", workspace.branch],
    ["PAPERCLIP_WORKSPACE_WORKTREE_PATH", workspace.worktreePath],
    ["AGENT_HOME", workspace.agentHome],
  ];
  for (const [key, value] of workspaceMappings) {
    const normalized = trimNullable(value);
    if (normalized) env[key] = normalized;
  }

  delete env.CURSOR_API_KEY;
  return env;
}

async function buildInstructionsPrefix(
  config: Record<string, unknown>,
  onLog: AdapterExecutionContext["onLog"],
): Promise<{ prefix: string; notes: string[]; chars: number }> {
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
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
  const envType = trimNullable(record.envType);
  const envName = trimNullable(record.envName);
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
    ...(envType ? { envType: normalizeEnvType(envType) } : {}),
    ...(envName ? { envName } : {}),
    repos,
  };
}

function sessionMatches(
  session: CursorCloudSession | null,
  envType: "cloud" | "pool" | "machine",
  envName: string | null,
  repos: Array<{ url: string; startingRef?: string; prUrl?: string }>,
): boolean {
  if (!session) return false;
  if ((session.envType ?? "cloud") !== envType) return false;
  if ((session.envName ?? null) !== envName) return false;
  if (session.repos.length !== repos.length) return false;
  return session.repos.every((repo, index) => {
    const next = repos[index];
    return repo.url === next.url
      && (repo.startingRef ?? null) === (next.startingRef ?? null)
      && (repo.prUrl ?? null) === (next.prUrl ?? null);
  });
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
}): AgentOptions {
  return {
    apiKey: input.apiKey,
    name: input.name,
    ...(input.model ? { model: input.model } : {}),
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

function eventLine(event: CursorCloudEvent): string {
  return `${JSON.stringify(event)}\n`;
}

async function emitMessage(onLog: AdapterExecutionContext["onLog"], message: SDKMessage) {
  await onLog("stdout", eventLine({ type: "cursor_cloud.message", message }));
}

async function emitStatus(onLog: AdapterExecutionContext["onLog"], status: string, message?: string) {
  await onLog("stdout", eventLine({ type: "cursor_cloud.status", status, ...(message ? { message } : {}) }));
}

async function streamRun(run: Run, onLog: AdapterExecutionContext["onLog"]) {
  if (!run.supports("stream")) return;
  for await (const message of run.stream()) {
    await emitMessage(onLog, message);
  }
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
  const envConfig = asStringEnvMap(config.env);
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
  const repoUrl =
    asString(config.repoUrl, "").trim() ||
    asString(workspace.repoUrl, "").trim();
  if (!repoUrl) {
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

  const repoStartingRef =
    trimNullable(config.repoStartingRef) ??
    trimNullable(workspace.repoRef) ??
    undefined;
  const repoPullRequestUrl = trimNullable(config.repoPullRequestUrl) ?? undefined;
  const envType = normalizeEnvType(asString(config.runtimeEnvType, "cloud"));
  const envName = trimNullable(config.runtimeEnvName);
  const workOnCurrentBranch = asBoolean(config.workOnCurrentBranch, false);
  const autoCreatePR = asBoolean(config.autoCreatePR, false);
  const skipReviewerRequest = asBoolean(config.skipReviewerRequest, false);
  const model = toModelSelection(asString(config.model, ""));
  const repos = [{
    url: repoUrl,
    ...(repoStartingRef ? { startingRef: repoStartingRef } : {}),
    ...(repoPullRequestUrl ? { prUrl: repoPullRequestUrl } : {}),
  }];
  const remoteEnv = buildWakeEnv(ctx, envConfig);
  const session = readSession(runtime.sessionParams) ?? (runtime.sessionId
    ? {
        cursorAgentId: runtime.sessionId,
        runtime: "cloud" as const,
        repos,
      }
    : null);
  const canReuseSession = sessionMatches(session, envType, envName, repos);
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
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
  const instructions = await buildInstructionsPrefix(config, onLog);
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: canReuseSession });
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
  });

  const commandNotes = [
    ...instructions.notes,
    canReuseSession
      ? `Reusing Cursor cloud agent session ${session?.cursorAgentId ?? "unknown"}`
      : "Creating a new Cursor cloud agent session",
    `Repository: ${repoUrl}${repoStartingRef ? ` @ ${repoStartingRef}` : ""}`,
    `Runtime target: ${envType}${envName ? ` (${envName})` : ""}`,
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
          repoUrl,
          repoStartingRef,
          repoPullRequestUrl,
          canReuseSession,
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
      }));
      const priorStreamPromise = streamRun(attachedRun, onLog).catch((err) => {
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
    run = await sdkAgent.send(finalPrompt, {
      ...(model ? { model } : {}),
    });
    await onLog("stdout", eventLine({
      type: "cursor_cloud.init",
      sessionId: sdkAgent.agentId,
      agentId: sdkAgent.agentId,
      runId: run.id,
      ...(model?.id ? { model: model.id } : {}),
    }));
    await emitStatus(onLog, "running", `Started Cursor run ${run.id}.`);

    const streamPromise = streamRun(run, onLog).catch((err) => {
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

    const modelId = result.model?.id ?? model?.id ?? null;
    await onLog("stdout", eventLine({
      type: "cursor_cloud.result",
      status: result.status,
      ...(result.result ? { result: result.result } : {}),
      ...(modelId ? { model: modelId } : {}),
      ...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
      ...(result.git ? { git: result.git } : {}),
      ...(streamError ? { error: streamError } : {}),
    }));

    const nextSession: CursorCloudSession = {
      cursorAgentId: run.agentId,
      latestRunId: result.id,
      runtime: "cloud",
      envType,
      ...(envName ? { envName } : {}),
      repos,
    };
    const isError = result.status !== "finished";
    return {
      exitCode: isError ? 1 : 0,
      signal: null,
      timedOut: false,
      errorMessage: isError ? (trimNullable(result.result) ?? streamError ?? `Cursor run ${result.status}`) : null,
      sessionId: run.agentId,
      sessionDisplayId: run.agentId,
      sessionParams: nextSession,
      provider: "cursor",
      biller: "cursor",
      billingType: "api",
      model: modelId,
      costUsd: null,
      summary: toSummary(result),
      resultJson: {
        status: result.status,
        cursorAgentId: run.agentId,
        cursorRunId: result.id,
        envType,
        envName,
        repos,
        ...(result.result ? { result: result.result } : {}),
        ...(result.git ? { git: result.git } : {}),
        ...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
        ...(streamError ? { streamError } : {}),
      },
      clearSession: false,
    };
  } catch (err) {
    const reason = formatRunError(err);
    if (run) {
      await onLog("stdout", eventLine({
        type: "cursor_cloud.result",
        status: "error",
        error: reason,
      }));
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
