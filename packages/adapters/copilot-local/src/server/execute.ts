import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  joinPromptSections,
  parseObject,
  readPaperclipRuntimeSkillEntries,
  renderPaperclipWakePrompt,
  renderTemplate,
  resolvePaperclipDesiredSkillNames,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_COPILOT_LOCAL_MODEL } from "../index.js";
import {
  approveAll,
  createCopilotClient,
  type CopilotClientLike,
  type GetAuthStatusResponse,
} from "./sdk-client.js";
import { parseCopilotJsonl } from "./parse.js";
import {
  buildCopilotClientBootstrap,
  buildLoggedInvocationEnv,
  isCopilotAuthRequiredMessage,
  isCopilotUnknownSessionMessage,
  loadInstructionsSystemMessage,
  materializeCopilotSkillDirectory,
  normalizeCopilotDiscoveredModels,
  normalizeEnvConfig,
  normalizeRuntimeEnv,
  removeDirSafe,
  resolveCopilotModelSelection,
} from "./runtime.js";
import { isCopilotIdleTimeoutError, sendPromptAndWaitForIdle } from "./session.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function resolveGithubToken(env: Record<string, string>): string | null {
  const token = (env.COPILOT_GITHUB_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "").trim();
  return token.length > 0 ? token : null;
}

function createSessionParams(
  sessionId: string | null,
  cwd: string,
  workspaceId: string,
  workspaceRepoUrl: string,
  workspaceRepoRef: string,
): Record<string, unknown> | null {
  if (!sessionId) return null;
  return {
    sessionId,
    cwd,
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
    ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
  };
}

function authErrorMeta(authStatus: GetAuthStatusResponse | null): Record<string, unknown> | undefined {
  if (!authStatus) return undefined;
  return {
    isAuthenticated: authStatus.isAuthenticated,
    ...(authStatus.authType ? { authType: authStatus.authType } : {}),
    ...(authStatus.host ? { host: authStatus.host } : {}),
    ...(authStatus.login ? { login: authStatus.login } : {}),
    ...(authStatus.statusMessage ? { statusMessage: authStatus.statusMessage } : {}),
  };
}

async function reportSpawn(
  client: CopilotClientLike,
  onSpawn: AdapterExecutionContext["onSpawn"] | undefined,
): Promise<void> {
  if (!onSpawn) return;
  const cliProcess = (client as unknown as { cliProcess?: ChildProcess | null }).cliProcess ?? null;
  if (!cliProcess?.pid) return;
  await onSpawn({
    pid: cliProcess.pid,
    processGroupId: null,
    startedAt: new Date().toISOString(),
  });
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const configuredModel = asString(config.model, "").trim();
  const defaultModel = configuredModel || DEFAULT_COPILOT_LOCAL_MODEL;

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = normalizeEnvConfig(config.env);
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
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  if (effectiveWorkspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  if (workspaceSource) env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceId) env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (agentHome) env.AGENT_HOME = agentHome;
  if (workspaceHints.length > 0) env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);

  for (const [key, value] of Object.entries(envConfig)) {
    env[key] = value;
  }
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = normalizeRuntimeEnv(ensurePathInEnv({ ...process.env, ...env }));
  const githubToken = resolveGithubToken(runtimeEnv);
  const timeoutSec = Math.max(0, Number(config.timeoutSec ?? 0) || 0);

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Copilot session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  const instructionsMessage = await loadInstructionsSystemMessage(
    cwd,
    asString(config.instructionsFilePath, ""),
    onLog,
  );

  let skillsDir: string | null = null;
  try {
    const skillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
    if (skillEntries.length > 0) {
      const desiredNames = resolvePaperclipDesiredSkillNames(config, skillEntries);
      skillsDir = await materializeCopilotSkillDirectory(
        agentHome || cwd,
        runId,
        skillEntries,
        desiredNames,
        onLog,
      );
    }
  } catch {
    skillsDir = null;
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
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    systemMessageChars: instructionsMessage?.chars ?? 0,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  try {
    const bootstrap = await buildCopilotClientBootstrap({
      command: config.command,
      args: config.args,
      extraArgs: config.extraArgs,
      cwd,
      runtimeEnv,
    });
    const loggedEnv = buildLoggedInvocationEnv(env, runtimeEnv, bootstrap.resolvedCommand);
    const baseNotes = [
      ...bootstrap.commandNotes,
      ...(skillsDir ? [`Materialized Paperclip runtime skills into ${skillsDir}`] : []),
      ...(instructionsMessage?.notes ?? []),
      githubToken
        ? "Using explicit GitHub auth from the runtime environment."
        : "Using the Copilot SDK's logged-in-user auth flow.",
    ];

    const runAttempt = async (resumeSessionId: string | null) => {
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const logWrites: Array<Promise<void>> = [];
      const writeLog = (stream: "stdout" | "stderr", line: string) => {
        if (stream === "stdout") {
          stdoutLines.push(line);
        } else {
          stderrLines.push(line);
        }
        logWrites.push(onLog(stream, `${line}\n`));
      };

      let authStatus: GetAuthStatusResponse | null = null;
      let runtimeError: string | null = null;
      let timedOut = false;
      let activeSessionId: string | null = null;
      let modelForAttempt = defaultModel;
      let client: CopilotClientLike | null = null;
      let session: Awaited<ReturnType<CopilotClientLike["createSession"]>> | null = null;
      let unsubscribe: (() => void) | null = null;

      try {
        client = await createCopilotClient({
          ...bootstrap.clientOptions,
          ...(githubToken ? { githubToken, useLoggedInUser: false } : { useLoggedInUser: true }),
        });
        await client.start();
        await reportSpawn(client, onSpawn);

        const cliProcess = (client as unknown as { cliProcess?: ChildProcess | null }).cliProcess ?? null;
        if (cliProcess?.stderr) {
          cliProcess.stderr.on("data", (chunk: string | Buffer) => {
            const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
            logWrites.push(onLog("stderr", text));
          });
        }

        authStatus = await client.getAuthStatus().catch(() => null);
        if (authStatus && !authStatus.isAuthenticated) {
          runtimeError =
            authStatus.statusMessage?.trim() || "GitHub Copilot authentication is not ready.";
        }

        try {
          const availableModels = normalizeCopilotDiscoveredModels(await client.listModels());
          if (availableModels.length > 0) {
            const selection = resolveCopilotModelSelection(configuredModel, availableModels);
            if (selection.errorMessage) {
              runtimeError = selection.errorMessage;
            } else if (selection.warningMessage) {
              modelForAttempt = "";
              writeLog("stdout", `[paperclip] ${selection.warningMessage}`);
            } else {
              modelForAttempt = selection.effectiveModel ?? defaultModel;
            }
          }
        } catch {
          // Discovery is best-effort; execution still provides the authoritative result.
        }

        const runNotes = [
          ...baseNotes,
          resumeSessionId
            ? `Attempting SDK resume for session ${resumeSessionId}.`
            : "Starting a fresh SDK session.",
          modelForAttempt ? `SDK model=${modelForAttempt}` : "SDK model=runtime default",
        ];

        if (onMeta) {
          await onMeta({
            adapterType: "copilot_local",
            command: bootstrap.command,
            cwd,
            commandArgs: bootstrap.commandArgs,
            commandNotes: runNotes,
            env: loggedEnv,
            prompt,
            promptMetrics,
            context,
          });
        }

        if (!runtimeError) {
          const sessionConfig = {
            ...(modelForAttempt ? { model: modelForAttempt } : {}),
            onPermissionRequest: approveAll,
            workingDirectory: cwd,
            ...(skillsDir ? { skillDirectories: [skillsDir] } : {}),
            ...(instructionsMessage?.systemMessage ? { systemMessage: instructionsMessage.systemMessage } : {}),
          };
          session = resumeSessionId
            ? await client.resumeSession(resumeSessionId, sessionConfig)
            : await client.createSession(sessionConfig);
          activeSessionId = session.sessionId;

          unsubscribe = session.on((event) => {
            try {
              writeLog("stdout", JSON.stringify(event));
            } catch {
              writeLog("stderr", "[paperclip] Failed to serialize Copilot SDK event.");
            }
          });

          try {
            await sendPromptAndWaitForIdle(session, prompt, timeoutSec > 0 ? timeoutSec * 1000 : null);
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            runtimeError = error.message;
            if (isCopilotIdleTimeoutError(error)) {
              timedOut = true;
              await session.abort().catch(() => {});
            }
          } finally {
            await session.disconnect().catch((err) => {
              const error = err instanceof Error ? err : new Error(String(err));
              if (!runtimeError) {
                runtimeError = error.message;
              }
              writeLog("stderr", `[paperclip] ${error.message}`);
            });
            unsubscribe?.();
            unsubscribe = null;
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        runtimeError = error.message;
        writeLog("stderr", `[paperclip] ${error.message}`);
      } finally {
        if (unsubscribe) unsubscribe();
        const stopResult = client ? await client.stop().catch(() => [] as Error[]) : [];
        const stopErrors = Array.isArray(stopResult) ? (stopResult as Error[]) : [];
        for (const error of stopErrors) {
          if (!error) continue;
          writeLog("stderr", `[paperclip] ${error.message}`);
        }
        await Promise.allSettled(logWrites);
      }

      const stdout = stdoutLines.join("\n");
      return {
        timedOut,
        sessionId: activeSessionId,
        stdout,
        stderr: stderrLines.join("\n"),
        parsed: parseCopilotJsonl(stdout),
        runtimeError,
        authStatus,
        model: modelForAttempt || defaultModel,
      };
    };

    const toResult = (
      attempt: Awaited<ReturnType<typeof runAttempt>>,
      clearSessionOnMissingSession = false,
    ): AdapterExecutionResult => {
      if (attempt.timedOut) {
        return {
          exitCode: null,
          signal: null,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          errorCode: "timeout",
          clearSession: clearSessionOnMissingSession,
        };
      }

      const resolvedSessionId =
        attempt.sessionId ??
        (clearSessionOnMissingSession ? null : runtimeSessionId || runtime.sessionId || null);
      const resolvedSessionParams = createSessionParams(
        resolvedSessionId,
        cwd,
        workspaceId,
        workspaceRepoUrl,
        workspaceRepoRef,
      );

      const parsedError =
        typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
      const runtimeError =
        typeof attempt.runtimeError === "string" ? attempt.runtimeError.trim() : "";
      const errorMessage = parsedError || runtimeError || null;
      const authRequired = Boolean(errorMessage && isCopilotAuthRequiredMessage(errorMessage));
      const exitCode = errorMessage ? 1 : 0;

      return {
        exitCode,
        signal: null,
        timedOut: false,
        errorMessage,
        errorCode: authRequired ? "copilot_auth_required" : null,
        errorMeta: authRequired ? authErrorMeta(attempt.authStatus) : undefined,
        usage: attempt.parsed.usage,
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: "github",
        biller: "github_copilot",
        model: (attempt.parsed.model || attempt.model).trim() || null,
        billingType: "subscription",
        costUsd: null,
        resultJson: {
          stdout: attempt.stdout,
          stderr: attempt.stderr,
          premiumRequests: attempt.parsed.premiumRequests,
          totalApiDurationMs: attempt.parsed.totalApiDurationMs,
          sessionDurationMs: attempt.parsed.sessionDurationMs,
          codeChanges: attempt.parsed.codeChanges,
          authStatus: attempt.authStatus,
        },
        summary: attempt.parsed.summary || null,
        clearSession: Boolean(clearSessionOnMissingSession && !resolvedSessionId),
      };
    };

    const initial = await runAttempt(sessionId);
    const initialFailed =
      !initial.timedOut && (Boolean(initial.runtimeError) || Boolean(initial.parsed.errorMessage));
    if (
      sessionId &&
      initialFailed &&
      isCopilotUnknownSessionMessage(`${initial.stdout}\n${initial.stderr}\n${initial.runtimeError ?? ""}`)
    ) {
      await onLog(
        "stdout",
        `[paperclip] Copilot session "${sessionId}" is unavailable; retrying with a fresh SDK session.\n`,
      );
      const retry = await runAttempt(null);
      return toResult(retry, true);
    }

    return toResult(initial);
  } finally {
    await removeDirSafe(skillsDir);
  }
}
