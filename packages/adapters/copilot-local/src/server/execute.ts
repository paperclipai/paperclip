import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  resolveCommandForLogs,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  runChildProcess,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
  ensurePaperclipSkillSymlink,
} from "@paperclipai/adapter-utils/server-utils";
import { parseCopilotLocalJsonl, isCopilotLocalStaleSessionError } from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

// ---------------------------------------------------------------------------
// Skill injection (ephemeral: symlink desired skills into a cache dir)
// ---------------------------------------------------------------------------

async function ensureCopilotSkillsInjected(
  config: Record<string, unknown>,
  onLog: AdapterExecutionContext["onLog"],
  skillsCacheDir: string,
): Promise<string[]> {
  const allSkillsEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = resolvePaperclipDesiredSkillNames(config, allSkillsEntries);
  const desiredSet = new Set(desiredSkillNames);
  const skillsEntries = allSkillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (skillsEntries.length === 0) return [];

  await fs.mkdir(skillsCacheDir, { recursive: true });
  const warnings: string[] = [];
  const activeNames = new Set<string>();

  for (const entry of skillsEntries) {
    activeNames.add(entry.runtimeName);
    const target = path.join(skillsCacheDir, entry.runtimeName);
    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stdout",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Copilot skill "${entry.runtimeName}" into ${skillsCacheDir}\n`,
      );
    } catch (err) {
      const msg = `Failed to inject Copilot skill "${entry.key}" into ${skillsCacheDir}: ${err instanceof Error ? err.message : String(err)}`;
      warnings.push(msg);
      await onLog("stderr", `[paperclip] ${msg}\n`);
    }
  }

  // Prune stale symlinks from the cache dir that are no longer desired
  const dirEntries = await fs.readdir(skillsCacheDir, { withFileTypes: true }).catch(() => []);
  for (const entry of dirEntries) {
    if (activeNames.has(entry.name) || !entry.isSymbolicLink()) continue;
    const target = path.join(skillsCacheDir, entry.name);
    await fs.unlink(target).catch(() => {});
    await onLog(
      "stdout",
      `[paperclip] Removed stale Copilot skill "${entry.name}" from ${skillsCacheDir}\n`,
    );
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  // ---- Config fields ----
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const command = asString(config.command, "copilot");
  const model = asString(config.model, "").trim();
  const gheHost = asString(config.gheHost, "").trim();
  const effort = asString(config.effort, "").trim();
  const byokBaseUrl = asString(config.byokBaseUrl, "").trim();
  const byokApiKey = asString(config.byokApiKey, "").trim();
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const isolateSession = asBoolean(config.isolateSession, false);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();
  const skillsDir = asString(config.skillsDir, "").trim();

  // ---- Workspace context ----
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

  // ---- Skill injection (ephemeral via COPILOT_SKILLS_DIRS) ----
  const skillsCacheDir = path.join(cwd, ".paperclip", "copilot-skill-cache");
  const skillWarnings = await ensureCopilotSkillsInjected(config, onLog, skillsCacheDir);

  // ---- Environment ----
  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  // Wake context
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

  // BYOK environment variables
  if (byokBaseUrl) {
    env.COPILOT_PROVIDER_BASE_URL = byokBaseUrl;
    env.COPILOT_OFFLINE = "true";
  }
  if (byokApiKey) {
    env.COPILOT_PROVIDER_API_KEY = byokApiKey;
  }
  if (model) {
    env.COPILOT_MODEL = model;
  }

  // GHE host
  if (gheHost) {
    env.GH_HOST = gheHost;
  }

  // Copilot CLI skill discovery via COPILOT_SKILLS_DIRS env var
  // Points to the ephemeral skill cache dir with symlinked Paperclip skills
  try {
    const cacheEntries = await fs.readdir(skillsCacheDir).catch(() => []);
    if (cacheEntries.length > 0) {
      env.COPILOT_SKILLS_DIRS = skillsCacheDir;
    }
  } catch {
    // Ignore — skills won't be injected but execution continues
  }

  // User-supplied env overrides
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
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

  // ---- Instructions file ----
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const resolvedInstructionsFilePath = instructionsFilePath
    ? path.resolve(cwd, instructionsFilePath)
    : "";
  const instructionsDir = resolvedInstructionsFilePath ? `${path.dirname(resolvedInstructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (resolvedInstructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
      );
    }
  }

  const commandNotes: string[] = [];
  if (skillWarnings.length > 0) {
    commandNotes.push(...skillWarnings.map((w) => `[skills] ${w}`));
  }
  if (env.COPILOT_SKILLS_DIRS) {
    commandNotes.push(`Injected Paperclip skills via COPILOT_SKILLS_DIRS=${env.COPILOT_SKILLS_DIRS}`);
  }
  if (resolvedInstructionsFilePath) {
    if (instructionsPrefix.length > 0) {
      commandNotes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}`);
      commandNotes.push(
        `Prepended instructions + path directive to prompt (relative references from ${instructionsDir}).`,
      );
    } else {
      commandNotes.push(
        `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      );
    }
  }

  // ---- Session handling ----
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    !isolateSession &&
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession && !isolateSession) {
    await onLog(
      "stdout",
      `[paperclip] Copilot session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  // ---- Build prompt ----
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
    instructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars: instructionsPrefix.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  // ---- Build CLI args ----
  const buildArgs = (resumeSessionId: string | null) => {
    const args = ["-p", prompt, "--output-format", "json", "--no-color", "-s", "--no-ask-user"];
    if (dangerouslySkipPermissions) args.push("--allow-all-tools");
    if (model) args.push("--model", model);
    if (resumeSessionId) args.push(`--resume=${resumeSessionId}`);
    if (effort) args.push("--effort", effort);
    if (gheHost) args.push("--hostname", gheHost);
    if (skillsDir) args.push("--add-dir", skillsDir);
    // Grant Copilot CLI read/write access to the agent home directory
    // (workspace dir for agent state, config, etc.)
    if (agentHome) args.push("--add-dir", agentHome);
    // Grant access to the instructions directory so Copilot CLI can read
    // AGENTS.md and other instruction files via its own `view` tool.
    // The path is derived dynamically from the resolved instructions file path
    // so it works regardless of how Paperclip manages the agent config.
    if (instructionsDir) args.push("--add-dir", instructionsDir);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  // ---- Run attempt ----
  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "copilot_local",
        command: resolvedCommand,
        cwd,
        commandNotes,
        commandArgs: [...args.filter((a) => a !== prompt), `<prompt ${prompt.length} chars>`],
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
    return {
      proc,
      rawStderr: proc.stderr,
      parsed: parseCopilotLocalJsonl(proc.stdout),
    };
  };

  // ---- Build result ----
  const toResult = (
    attempt: {
      proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string };
      rawStderr: string;
      parsed: ReturnType<typeof parseCopilotLocalJsonl>;
    },
    clearSessionOnMissingSession = false,
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

    const resolvedSessionId =
      attempt.parsed.sessionId ||
      (clearSessionOnMissingSession ? null : runtimeSessionId || runtime.sessionId || null);
    const resolvedSessionParams = resolvedSessionId
      ? ({
          sessionId: resolvedSessionId,
          cwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
        } as Record<string, unknown>)
      : null;

    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const rawExitCode = attempt.proc.exitCode;
    const synthesizedExitCode = parsedError && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode;
    const fallbackErrorMessage =
      parsedError ||
      stderrLine ||
      `Copilot exited with code ${synthesizedExitCode ?? -1}`;
    const resolvedModel = attempt.parsed.model || model || null;
    const isByok = byokBaseUrl.length > 0;

    return {
      exitCode: synthesizedExitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: (synthesizedExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
      usage: {
        inputTokens: attempt.parsed.usage.inputTokens,
        outputTokens: attempt.parsed.usage.outputTokens,
        cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
      },
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "copilot",
      biller: isByok ? "byok" : "subscription",
      model: resolvedModel,
      billingType: "subscription",
      costUsd: 0,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      },
      summary: attempt.parsed.summary || null,
      clearSession: Boolean(clearSessionOnMissingSession && !attempt.parsed.sessionId),
    };
  };

  // ---- Execute with stale-session retry ----
  const initial = await runAttempt(sessionId);
  const initialFailed =
    !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || Boolean(initial.parsed.errorMessage));
  if (
    sessionId &&
    initialFailed &&
    isCopilotLocalStaleSessionError(initial.proc.stdout, initial.rawStderr)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Copilot session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toResult(retry, true);
  }

  return toResult(initial);
}
