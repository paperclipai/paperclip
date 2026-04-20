import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  resolveCommandForLogs,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  runChildProcess,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { isOpenCodeUnknownSessionError, parseOpenCodeJsonl } from "./parse.js";
import { ensureOpenCodeModelConfiguredAndAvailable } from "./models.js";
import { removeMaintainerOnlySkillSymlinks } from "@paperclipai/adapter-utils/server-utils";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function resolveOpenCodeBiller(env: Record<string, string>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "unknown";
}

function claudeSkillsHome(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

async function ensureOpenCodeSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
) {
  const skillsHome = claudeSkillsHome();
  await fs.mkdir(skillsHome, { recursive: true });
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only OpenCode skill "${skillName}" from ${skillsHome}\n`,
    );
  }
  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} OpenCode skill "${entry.key}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject OpenCode skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "opencode");
  const model = asString(config.model, "").trim();
  const variant = asString(config.variant, "").trim();

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
  const openCodeSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredOpenCodeSkillNames = resolvePaperclipDesiredSkillNames(config, openCodeSkillEntries);
  await ensureOpenCodeSkillsInjected(
    onLog,
    openCodeSkillEntries,
    desiredOpenCodeSkillNames,
  );

  const envConfig = parseObject(config.env);
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
    if (typeof value === "string") env[key] = value;
  }
  // Prevent OpenCode from writing an opencode.json config file into the
  // project working directory (which would pollute the git repo).  Model
  // selection is already handled via the --model CLI flag.  Set after the
  // envConfig loop so user overrides cannot disable this guard.
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  const preparedRuntimeConfig = await prepareOpenCodeRuntimeConfig({ env, config });
  try {
    const runtimeEnv = Object.fromEntries(
      Object.entries(ensurePathInEnv({ ...process.env, ...preparedRuntimeConfig.env })).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
    const loggedEnv = buildInvocationEnvForLogs(preparedRuntimeConfig.env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });

    await ensureOpenCodeModelConfiguredAndAvailable({
      model,
      command,
      cwd,
      env: runtimeEnv,
    });

    const timeoutSec = asNumber(config.timeoutSec, 0);
    const graceSec = asNumber(config.graceSec, 20);
    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();

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
        `[paperclip] OpenCode session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
      );
    }
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

    const commandNotes = (() => {
      const notes = [...preparedRuntimeConfig.notes];
      if (!resolvedInstructionsFilePath) return notes;
      if (instructionsPrefix.length > 0) {
        notes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}`);
        notes.push(
          `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
        );
        return notes;
      }
      notes.push(
        `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      );
      return notes;
    })();

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

    const buildArgs = (resumeSessionId: string | null) => {
      const args = ["run", "--format", "json"];
      if (resumeSessionId) args.push("--session", resumeSessionId);
      if (model) args.push("--model", model);
      if (variant) args.push("--variant", variant);
      if (extraArgs.length > 0) args.push(...extraArgs);
      return args;
    };

    const runAttempt = async (resumeSessionId: string | null) => {
      const args = buildArgs(resumeSessionId);
      if (onMeta) {
        await onMeta({
          adapterType: "opencode_local",
          command: resolvedCommand,
          cwd,
          commandNotes,
          commandArgs: [...args, `<stdin prompt ${prompt.length} chars>`],
          env: loggedEnv,
          prompt,
          promptMetrics,
          context,
        });
      }

      const proc = await runChildProcess(runId, command, args, {
        cwd,
        env: runtimeEnv,
        stdin: prompt,
        timeoutSec,
        graceSec,
        onSpawn,
        onLog,
      });
      return {
        proc,
        rawStderr: proc.stderr,
        parsed: parseOpenCodeJsonl(proc.stdout),
      };
    };

    const toResult = (
      attempt: {
        proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string };
        rawStderr: string;
        parsed: ReturnType<typeof parseOpenCodeJsonl>;
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
        attempt.parsed.sessionId ??
        (clearSessionOnMissingSession ? null : runtimeSessionId ?? runtime.sessionId ?? null);
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
        `OpenCode exited with code ${synthesizedExitCode ?? -1}`;
      const modelId = model || null;

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
        provider: parseModelProvider(modelId),
        biller: resolveOpenCodeBiller(runtimeEnv, parseModelProvider(modelId)),
        model: modelId,
        billingType: "unknown",
        costUsd: attempt.parsed.costUsd,
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
        },
        summary: attempt.parsed.summary,
        clearSession: Boolean(clearSessionOnMissingSession && !attempt.parsed.sessionId),
      };
    };

    const initial = await runAttempt(sessionId);
    const initialFailed =
      !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || Boolean(initial.parsed.errorMessage));
    if (
      sessionId &&
      initialFailed &&
      isOpenCodeUnknownSessionError(initial.proc.stdout, initial.rawStderr)
    ) {
      await onLog(
        "stdout",
        `[paperclip] OpenCode session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toResult(retry, true);
    }

    return toResult(initial);
  } finally {
    await preparedRuntimeConfig.cleanup();
  }
}
