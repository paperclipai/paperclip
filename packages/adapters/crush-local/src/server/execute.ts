import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { readAdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  parseObject,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePaperclipSkillSymlink,
  joinPromptSections,
  ensurePathInEnv,
  readPaperclipRuntimeSkillEntries,
  resolveCommandForLogs,
  resolveLegacyPaperclipDesiredSkillNames,
  removeMaintainerOnlySkillSymlinks,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { crushDataDir, crushExtraArgs, crushRunArgs, crushSkillsDir } from "./command.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function isCrushAgentFailure(output: string): boolean {
  return output.trimStart().startsWith("Agent processing failed:");
}

async function ensureCrushSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsHome: string,
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
): Promise<void> {
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (selectedEntries.length === 0) return;

  try {
    await fs.mkdir(skillsHome, { recursive: true });
  } catch (err) {
    await onLog(
      "stderr",
      `[paperclip] Failed to prepare Crush skills directory ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  }

  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only Crush skill "${skillName}" from ${skillsHome}\n`,
    );
  }

  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Linked"} Crush skill: ${entry.key}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to link Crush skill "${entry.key}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function fetchLastSession(
  command: string,
  cwd: string,
  dataDir: string,
  env: Record<string, string>,
  runId: string,
): Promise<{ id: string; failed: boolean } | null> {
  try {
    const result = await runChildProcess(
      `${runId}-session-probe`,
      command,
      ["session", "last", "--json", "--cwd", cwd, "--data-dir", dataDir],
      {
        cwd,
        env,
        timeoutSec: 10,
        graceSec: 3,
        onLog: async () => {},
      },
    );
    if ((result.exitCode ?? 1) !== 0 || !result.stdout.trim()) return null;
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    const meta = parsed.meta as Record<string, unknown> | undefined;
    const id = meta?.id;
    if (typeof id !== "string" || !id.trim()) return null;
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const lastAssistant = messages.findLast((message) =>
      typeof message === "object" && message !== null && (message as Record<string, unknown>).role === "assistant"
    ) as Record<string, unknown> | undefined;
    const parts = Array.isArray(lastAssistant?.parts) ? lastAssistant.parts : [];
    const failed = parts.some((part) =>
      typeof part === "object" && part !== null &&
      (part as Record<string, unknown>).type === "finish" &&
      (part as Record<string, unknown>).reason === "error"
    );
    return { id: id.trim(), failed };
  } catch {
    return null;
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  if (executionTarget?.kind === "remote") {
    throw new Error("The Crush adapter supports local execution only. Select a local environment for this agent.");
  }

  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const command = asString(config.command, "crush");
  const model = asString(config.model, "").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  // `session last` is otherwise shared by every Crush invocation on the host.
  // Give each Paperclip agent its own data directory so a different agent's
  // run cannot be mistaken for this agent's resumable session.
  const dataDir = crushDataDir(agent.companyId, agent.id);
  const skillsHome = crushSkillsDir(agent.companyId, agent.id);
  await fs.mkdir(dataDir, { recursive: true });
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

  const crushSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = resolveLegacyPaperclipDesiredSkillNames(config, crushSkillEntries);
  await ensureCrushSkillsInjected(onLog, skillsHome, crushSkillEntries, desiredSkillNames);

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
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
    if (typeof value === "string") env[key] = value;
  }
  // Crush replaces its global skill search paths with this directory. Never
  // expose another Paperclip agent's company skills through a shared home.
  env.CRUSH_SKILLS_DIR = skillsHome;
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  await ensureCommandResolvable(command, cwd, runtimeEnv);
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);
  const extraArgs = crushExtraArgs(config);

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
      `[paperclip] Crush session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
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
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const buildPrompt = (resumeSessionId: string | null) => {
    const renderedBootstrapPrompt =
      !resumeSessionId && bootstrapPromptTemplate.trim().length > 0
        ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
        : "";
    const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
      resumedSession: Boolean(resumeSessionId),
    });
    const shouldUseResumeDeltaPrompt = Boolean(resumeSessionId) && wakePrompt.length > 0;
    const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
    const prompt = joinPromptSections([
      instructionsPrefix,
      renderedBootstrapPrompt,
      wakePrompt,
      sessionHandoffNote,
      renderedPrompt,
    ]);
    return {
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
        instructionsChars: instructionsPrefix.length,
        bootstrapPromptChars: renderedBootstrapPrompt.length,
        wakePromptChars: wakePrompt.length,
        sessionHandoffChars: sessionHandoffNote.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
    };
  };

  const commandNotes: string[] = [
    "Prompt is passed to Crush as a positional argument; output is plain text.",
    "Running non-interactively via crush run.",
  ];
  if (instructionsFilePath && instructionsPrefix.length > 0) {
    commandNotes.push(`Loaded agent instructions from ${instructionsFilePath}`);
  }

  const runAttempt = async (resumeSessionId: string | null) => {
    const { prompt, promptMetrics } = buildPrompt(resumeSessionId);
    const args = crushRunArgs({ cwd, dataDir, model, extraArgs, sessionId: resumeSessionId, prompt });
    if (onMeta) {
      await onMeta({
        adapterType: "crush_local",
        command: resolvedCommand,
        cwd,
        commandNotes,
        commandArgs: [...args.slice(0, -1), `<prompt ${prompt.length} chars>`],
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog,
    });
    return proc;
  };

  const initial = await runAttempt(sessionId);

  const toResult = async (
    proc: Awaited<ReturnType<typeof runAttempt>>,
    clearSessionOnMissingSession = false,
  ): Promise<AdapterExecutionResult> => {
    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const exitCode = proc.exitCode ?? 0;
    const processSucceeded = exitCode === 0;

    let resolvedSessionId: string | null = null;
    let sessionFailed = false;
    if (processSucceeded) {
      const session = await fetchLastSession(command, cwd, dataDir, runtimeEnv, runId);
      resolvedSessionId = session?.id ?? null;
      sessionFailed = session?.failed === true || isCrushAgentFailure(proc.stdout);
    } else if (!clearSessionOnMissingSession) {
      resolvedSessionId = runtimeSessionId || runtime.sessionId || null;
    }
    // Crush can exit 0 after a provider/agent error. Its saved assistant
    // finish reason is the completion signal, not the process code alone.
    const succeeded = processSucceeded && !sessionFailed;

    if (sessionFailed) resolvedSessionId = null;
    const resolvedSessionParams = resolvedSessionId
      ? ({
          sessionId: resolvedSessionId,
          cwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
        } as Record<string, unknown>)
      : null;

    const firstStderrLine =
      proc.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";

    const summary = proc.stdout.trim();

    return {
      exitCode: sessionFailed ? 1 : proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: succeeded
        ? null
        : firstStderrLine || (sessionFailed ? proc.stdout.trim() || "Crush agent run failed" : `Crush exited with code ${exitCode}`),
      usage: undefined,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: null,
      model: model || null,
      costUsd: null,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
      summary: summary || null,
      clearSession: (clearSessionOnMissingSession && !resolvedSessionId) || sessionFailed,
    };
  };

  if (
    sessionId &&
    !initial.timedOut &&
    (initial.exitCode ?? 0) !== 0 &&
    isCrushUnknownSessionError(initial.stdout, initial.stderr)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Crush session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toResult(retry, true);
  }

  return toResult(initial);
}

export function isCrushUnknownSessionError(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  return (
    combined.includes("session not found") ||
    combined.includes("unknown session") ||
    combined.includes("session does not exist") ||
    combined.includes("invalid session") ||
    combined.includes("could not find session")
  );
}
