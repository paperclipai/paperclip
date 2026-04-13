import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  joinPromptSections,
  parseObject,
  readPaperclipRuntimeSkillEntries,
  removeMaintainerOnlySkillSymlinks,
  renderPaperclipWakePrompt,
  renderTemplate,
  resolveCommandForLogs,
  resolvePaperclipDesiredSkillNames,
  runChildProcess,
  stringifyPaperclipWakePayload,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";
import { isCopilotUnknownSessionError, parseCopilotJsonl } from "./parse.js";
import { buildCopilotPromptBundleKey } from "./prompt-bundle.js";
import { resolveCopilotSkillsHome } from "./skills.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_COPILOT_LOCAL_MODEL = "claude-sonnet-4.5";
const COPILOT_LOCAL_SKILL_ROOT_CANDIDATES = [
  path.resolve(__moduleDir, "../../../../skills"),
];
const COPILOT_SHELL_APPROVAL_NOTE = [
  "Safety note:",
  "If a shell command is blocked because it contains dangerous shell expansion patterns",
  "(for example parameter transformation, indirect expansion, or nested command substitution),",
  "do not retry or work around the guard automatically.",
  "Stop and respond with:",
  "Approval needed: <brief reason>",
  "Reply approve to allow it, or deny to block it.",
].join("\n");
const COPILOT_RATE_LIMIT_RETRY_MS = 65_000;

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

async function ensureCopilotSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
  config: Record<string, unknown> = {},
): Promise<void> {
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (selectedEntries.length === 0) return;

  const skillsHome = resolveCopilotSkillsHome(config);
  try {
    await fs.mkdir(skillsHome, { recursive: true });
  } catch (err) {
    await onLog(
      "stderr",
      `[paperclip] Failed to prepare Copilot skills directory ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
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
      `[paperclip] Removed maintainer-only Copilot skill "${skillName}" from ${skillsHome}\n`,
    );
  }

  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Linked"} Copilot skill: ${entry.key}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to link Copilot skill "${entry.key}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const command = asString(config.command, "copilot");
  const model = asString(config.model, DEFAULT_COPILOT_LOCAL_MODEL).trim();
  const autopilot = asBoolean(config.autopilot, true);
  const experimental = asBoolean(config.experimental, false);
  const enableReasoningSummaries = asBoolean(config.enableReasoningSummaries, false);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const copilotSkillEntries = await readPaperclipRuntimeSkillEntries(
    config,
    __moduleDir,
    COPILOT_LOCAL_SKILL_ROOT_CANDIDATES,
  );
  const desiredSkillNames = resolvePaperclipDesiredSkillNames(config, copilotSkillEntries);
  await ensureCopilotSkillsInjected(onLog, copilotSkillEntries, desiredSkillNames, config);
  const selectedSkillEntries = copilotSkillEntries.filter((entry) =>
    new Set(desiredSkillNames).has(entry.key),
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
    (typeof context.wakeCommentId === "string" &&
      context.wakeCommentId.trim().length > 0 &&
      context.wakeCommentId.trim()) ||
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
    ? context.issueIds.filter(
        (value: unknown): value is string => typeof value === "string" && value.trim().length > 0,
      )
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
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const runtimeEnv = ensurePathInEnv(effectiveEnv);
  await ensureCommandResolvable(command, cwd, runtimeEnv);
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const effort = asString(config.effort, "").trim();
  const maxAutopilotContinues = Math.max(0, asNumber(config.maxAutopilotContinues, 0));
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  let instructionsContents: string | null = null;
  if (instructionsFilePath) {
    try {
      instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
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
  const promptBundleKey = await buildCopilotPromptBundleKey({
    skills: selectedSkillEntries as PaperclipSkillEntry[],
    instructionsContents,
  });
  const runtimeSessionPromptBundleKey = asString(runtimeSessionParams.promptBundleKey, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd)) &&
    (runtimeSessionPromptBundleKey.length === 0 || runtimeSessionPromptBundleKey === promptBundleKey);
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && (runtimeSessionCwd.length > 0 && path.resolve(runtimeSessionCwd) !== path.resolve(cwd))) {
    await onLog(
      "stdout",
      `[paperclip] Copilot session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  } else if (
    runtimeSessionId &&
    runtimeSessionPromptBundleKey.length > 0 &&
    runtimeSessionPromptBundleKey !== promptBundleKey
  ) {
    await onLog(
      "stdout",
      `[paperclip] Copilot session "${runtimeSessionId}" was saved for prompt bundle "${runtimeSessionPromptBundleKey}" and will not be resumed with "${promptBundleKey}".\n`,
    );
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
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    COPILOT_SHELL_APPROVAL_NOTE,
    renderedPrompt,
  ]);

  const commandNotes = [
    "Prompt is passed to GitHub Copilot CLI via -p in non-interactive mode.",
    "Paperclip enables allow-all permissions and disables interactive ask_user prompts for unattended runs.",
    `Paperclip skills are linked into ${resolveCopilotSkillsHome(config)}.`,
    `Using Copilot prompt bundle ${promptBundleKey}.`,
    ...(autopilot ? ["Added --autopilot for multi-step completion."] : []),
    ...(instructionsPrefix ? [`Loaded agent instructions from ${instructionsFilePath}.`] : []),
  ];

  async function runAttempt(resumeSessionId: string | null) {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--allow-all-tools",
      "--allow-all-paths",
      "--allow-all-urls",
      "--no-ask-user",
      "--stream",
      "off",
      "--no-color",
    ];
    if (autopilot) args.push("--autopilot");
    if (effort) args.push("--effort", effort);
    if (experimental) args.push("--experimental");
    if (enableReasoningSummaries) args.push("--enable-reasoning-summaries");
    if (maxAutopilotContinues > 0) args.push("--max-autopilot-continues", String(maxAutopilotContinues));
    if (model) args.push("--model", model);
    if (resumeSessionId) args.push(`--resume=${resumeSessionId}`);
    if (extraArgs.length > 0) args.push(...extraArgs);

    await onMeta?.({
      adapterType: "copilot_local",
      command,
      cwd,
      commandArgs: args,
      commandNotes,
      env: loggedEnv,
      prompt,
      promptMetrics: {
        characters: prompt.length,
        lines: prompt.split(/\r?\n/).length,
      },
      context,
    });

    return runChildProcess(runId, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onLog,
      onSpawn,
    });
  }

  const proc = await runAttempt(sessionId);
  const parsed = parseCopilotJsonl(proc.stdout);
  const exitCode = proc.exitCode ?? 0;

  const buildResult = (
    run: typeof proc,
    runParsed: ReturnType<typeof parseCopilotJsonl>,
    options?: { clearSession?: boolean },
  ): AdapterExecutionResult => {
    const runExitCode = run.exitCode ?? 0;
    return {
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      errorMessage:
        runParsed.errorMessage ??
        (runExitCode !== 0 || run.timedOut
          ? firstNonEmptyLine(run.stderr) || firstNonEmptyLine(run.stdout) || "Copilot run failed"
          : null),
      usage: runParsed.outputTokens > 0
        ? {
            inputTokens: 0,
            outputTokens: runParsed.outputTokens,
            cachedInputTokens: 0,
          }
        : undefined,
      sessionId: runParsed.sessionId,
      sessionParams: runParsed.sessionId
        ? {
            sessionId: runParsed.sessionId,
            cwd,
            promptBundleKey,
            ...(workspaceId ? { workspaceId } : {}),
            ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
            ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
          }
        : null,
      sessionDisplayId: runParsed.sessionId,
      provider: "github",
      biller: "copilot",
      model: runParsed.model ?? model ?? null,
      billingType: "subscription",
      costUsd: null,
      resultJson: runParsed.finalResult,
      summary: runParsed.summary || null,
      ...(options?.clearSession ? { clearSession: true } : {}),
    };
  };

  if (sessionId && !proc.timedOut && exitCode !== 0 && isCopilotUnknownSessionError(proc.stdout, proc.stderr)) {
    const retry = await runAttempt(null);
    const retryParsed = parseCopilotJsonl(retry.stdout);
    return buildResult(retry, retryParsed, { clearSession: true });
  }

  if (!proc.timedOut && exitCode !== 0 && parsed.isRateLimit) {
    await onLog(
      "stderr",
      `[paperclip] Copilot rate limit encountered; retrying once in ${Math.ceil(COPILOT_RATE_LIMIT_RETRY_MS / 1000)}s\n`,
    );
    await delay(COPILOT_RATE_LIMIT_RETRY_MS);
    const retry = await runAttempt(parsed.sessionId ?? sessionId);
    const retryParsed = parseCopilotJsonl(retry.stdout);
    return buildResult(retry, retryParsed);
  }

  return buildResult(proc, parsed);
}
