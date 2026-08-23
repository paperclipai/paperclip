import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { weightedBudgetTokens } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetSessionIdentity,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  overrideAdapterExecutionTargetRemoteCwd,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  joinPromptSections,
  materializePaperclipSkillCopy,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  readPaperclipRuntimeSkillEntries,
  refreshPaperclipWorkspaceEnvForExecution,
  renderPaperclipWakePrompt,
  renderTemplate,
  resolvePaperclipDesiredSkillNames,
  runningProcesses,
  signalRunningProcess,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import {
  inspectAntigravityStream,
  parseAntigravityOutput,
  isAntigravityUnknownSessionError,
  detectAntigravityQuotaExhausted,
  isAntigravityTransientSilentExit,
} from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ANTIGRAVITY_MAX_TOKENS_PER_RUN = 100_000;
const ANTIGRAVITY_FINALIZATION_REMINDER =
  "Before ending this run, record the real issue state through Paperclip. " +
  "If that write cannot be confirmed, your FINAL response line MUST be exactly a " +
  "PAPERCLIP_DISPOSITION JSON record (done, cancelled, in_review, or blocked); " +
  "a prose status line or comment is not a disposition.";

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
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

function renderApiAccessNote(env: Record<string, string>): string {
  if (!hasNonEmptyEnvValue(env, "PAPERCLIP_API_URL") || !hasNonEmptyEnvValue(env, "PAPERCLIP_API_KEY")) return "";
  return [
    "Paperclip API access note:",
    "Use shell commands with curl to make Paperclip API requests when needed.",
    "Include Authorization: Bearer $PAPERCLIP_API_KEY on every request and X-Paperclip-Run-Id on mutating requests.",
    "",
    "",
  ].join("\n");
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

async function stageInstructions(cwd: string, instructionsFilePath: string): Promise<() => Promise<void>> {
  if (!instructionsFilePath) return async () => {};
  const target = path.join(cwd, "AGENTS.md");
  if (await pathExists(target)) return async () => {};
  await fs.copyFile(instructionsFilePath, target);
  return async () => {
    await fs.rm(target, { force: true }).catch(() => undefined);
  };
}

async function stageSkills(input: {
  cwd: string;
  config: Record<string, unknown>;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{ count: number; root: string | null; cleanup: () => Promise<void> }> {
  const skillEntries = await readPaperclipRuntimeSkillEntries(input.config, __moduleDir);
  const desiredNames = new Set(resolvePaperclipDesiredSkillNames(input.config, skillEntries));
  const selectedSkills = skillEntries.filter((entry) => desiredNames.has(entry.key));
  if (selectedSkills.length === 0) {
    return { count: 0, root: null, cleanup: async () => {} };
  }

  const root = path.join(input.cwd, ".paperclip", "skills");
  await fs.mkdir(root, { recursive: true });
  const stagedTargets: string[] = [];
  for (const skill of selectedSkills) {
    const target = path.join(root, skill.runtimeName);
    if (await pathExists(target)) {
      await input.onLog(
        "stdout",
        `[paperclip] Antigravity skill target already exists at ${target}; leaving it unchanged.\n`,
      );
      continue;
    }
    await materializePaperclipSkillCopy(skill.source, target);
    stagedTargets.push(target);
  }

  return {
    count: stagedTargets.length,
    root,
    cleanup: async () => {
      for (const target of stagedTargets.reverse()) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

export function buildAntigravityArgs(input: {
  prompt: string;
  printTimeout: string;
  sessionId: string | null;
  autoApprove: boolean;
  sandbox: boolean;
  extraDirs: string[];
  extraArgs: string[];
  model?: string | null;
}): string[] {
  const args = ["--print", input.prompt];
  if (input.printTimeout) args.push("--print-timeout", input.printTimeout);
  if (input.sessionId) args.push("--conversation", input.sessionId);
  if (input.autoApprove) args.push("--dangerously-skip-permissions");
  if (input.sandbox) args.push("--sandbox");
  for (const dir of input.extraDirs) args.push("--add-dir", dir);
  // Pass the configured model through to `agy --model`.
  //
  // Until 2026-07-26 this adapter never emitted --model at all, so EVERY agy lane ran on
  // whatever agy's session default was, and `config.model` was silently ignored — no effect,
  // no warning. That is why the lane-health guard carried 25 standing "antigravity_local agents
  // naming a Gemini model the adapter never selects" findings, and why the Google plan's
  // Claude Opus 4.6 / Claude Sonnet 4.6 / GPT-OSS 120B bands — which sit on usage allowances
  // SEPARATE from Gemini's and which we pay for — had never been consumed at all.
  //
  // ⚠ agy model ids are the DISPLAY NAMES verbatim, effort included:
  //     "Claude Opus 4.6 (Thinking)"   "GPT-OSS 120B (Medium)"   "Gemini 3.1 Pro (High)"
  // The dashed internal form (`claude-opus-4-6`) that appears under ~/.gemini is REJECTED with
  // "not recognized as a known model". Pass config.model straight through, unmangled.
  //
  // Emitted before extraArgs so an explicit extraArgs --model still wins — that was the
  // pre-existing workaround and some agents/bench entries may still rely on it.
  if (input.model && input.model.trim().length > 0) args.push("--model", input.model.trim());
  // Stream-json is mandatory: it is the only Antigravity mode that exposes
  // usage while a multi-step turn is still running. Strip caller overrides so
  // the configured token ceiling cannot be silently disabled with extraArgs.
  for (let index = 0; index < input.extraArgs.length; index += 1) {
    const value = input.extraArgs[index];
    if (value === "--output-format") {
      index += 1;
      continue;
    }
    if (value.startsWith("--output-format=")) continue;
    args.push(value);
  }
  args.push("--output-format", "stream-json");
  return args;
}

export function resolveAntigravityMaxTokensPerRun(config: Record<string, unknown>): number {
  return Math.max(
    1,
    Math.floor(asNumber(config.maxTokensPerRun, DEFAULT_ANTIGRAVITY_MAX_TOKENS_PER_RUN)),
  );
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = executionTarget?.kind === "remote";
  if (executionTargetIsRemote) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorCode: "antigravity_live_token_cancellation_unavailable",
      errorMessage:
        "Antigravity remote execution is disabled because Paperclip cannot yet enforce live in-turn token cancellation on that target. Use a local Antigravity target or an ACP adapter.",
      resultJson: {
        stopReason: "antigravity_live_token_cancellation_unavailable",
        modelDispatched: false,
      },
    };
  }

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "agy");

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
  const effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const cleanupInstructions = await stageInstructions(cwd, asString(config.instructionsFilePath, "").trim());
  const stagedSkills = await stageSkills({ cwd, config, onLog });
  try {
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
      ? context.issueIds.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
    const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
    if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
    if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
    if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
    if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
    if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
    if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
    if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
    if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
    refreshPaperclipWorkspaceEnvForExecution({
      env,
      envConfig,
      workspaceCwd: effectiveWorkspaceCwd,
      workspaceSource,
      workspaceId,
      workspaceRepoUrl,
      workspaceRepoRef,
      workspaceHints,
      agentHome,
      executionTargetIsRemote,
      executionCwd: effectiveExecutionCwd,
    });
    if (!hasExplicitApiKey && authToken) {
      env.PAPERCLIP_API_KEY = authToken;
    }

    const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
      executionTarget,
      asNumber(config.timeoutSec, 0),
    );
    const graceSec = asNumber(config.graceSec, 20);
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: executionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
      detectCommand: ctx.runtimeCommandSpec?.detectCommand,
      cwd,
      env,
      timeoutSec,
      graceSec,
      onLog,
    });

    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    const effectiveEnv = Object.fromEntries(
      Object.entries({ ...process.env, ...env }).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const runtimeEnv = ensurePathInEnv(effectiveEnv);
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
      installCommand: ctx.runtimeCommandSpec?.installCommand ?? null,
      timeoutSec,
    });
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
    const sessionId = canResumeSession ? runtimeSessionId : null;
    if (runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] Antigravity conversation "${runtimeSessionId}" does not match the current execution target or cwd and will not be resumed in "${effectiveExecutionCwd}".\n`,
      );
    }

    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
    const renderedPrompt = Boolean(sessionId) && wakePrompt.length > 0 ? "" : renderTemplate(promptTemplate, templateData);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const prompt = joinPromptSections([
      wakePrompt,
      sessionHandoffNote,
      stagedSkills.root && stagedSkills.count > 0
        ? `Paperclip runtime skills are available in ${stagedSkills.root}. Use those skill instructions when they match the task.`
        : "",
      renderPaperclipEnvNote(env),
      renderApiAccessNote(env),
      renderedPrompt,
      ANTIGRAVITY_FINALIZATION_REMINDER,
    ]);
    const printTimeout = asString(config.printTimeout, "5m0s").trim();
    const autoApprove = asBoolean(config.autoApprove, true);
    const sandbox = asBoolean(config.sandbox, false);
    const extraDirs = asStringArray(config.extraDirs);
    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();

    // Read the configured model so it can be passed to `agy --model`. Previously nothing read
    // config.model for this adapter, so setting it on an agent did nothing and said nothing.
    const model = asString(config.model, "").trim();
    const maxTokensPerRun = resolveAntigravityMaxTokensPerRun(config);
    let tokenBudgetExceeded = false;
    let tokenBudgetObserved = 0;
    let observedStdout = "";
    let forceKillTimer: NodeJS.Timeout | null = null;

    const boundedOnLog: AdapterExecutionContext["onLog"] = async (stream, chunk) => {
      await onLog(stream, chunk);
      if (stream !== "stdout" || tokenBudgetExceeded) return;
      observedStdout = `${observedStdout}${chunk}`.slice(-1024 * 1024);
      const observedUsage = inspectAntigravityStream(observedStdout).usage;
      // Budget-weighted: cache reads at reduced weight (TSMC-20840).
      const observed = weightedBudgetTokens(observedUsage);
      tokenBudgetObserved = Math.max(tokenBudgetObserved, observed);
      if (observed <= maxTokensPerRun) return;

      tokenBudgetExceeded = true;
      await onLog(
        "stderr",
        `[paperclip] Antigravity maxTokensPerRun budget of ${maxTokensPerRun} tokens exhausted (observed ${observed}); stopping before another model turn.\n`,
      );
      const running = runningProcesses.get(runId);
      if (running) signalRunningProcess(running, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        const stillRunning = runningProcesses.get(runId);
        if (stillRunning) signalRunningProcess(stillRunning, "SIGKILL");
      }, Math.max(1, graceSec) * 1000);
    };

    const runAttempt = async (resumeSessionId: string | null) => {
      const args = buildAntigravityArgs({
        prompt,
        printTimeout,
        sessionId: resumeSessionId,
        autoApprove,
        sandbox,
        extraDirs,
        extraArgs,
        model,
      });
      if (onMeta) {
        await onMeta({
          adapterType: "antigravity_local",
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandNotes: [
            "Prompt is passed to Antigravity via --print --prompt.",
            resumeSessionId ? "Resuming saved conversation with --conversation." : "Starting a fresh Antigravity print-mode conversation.",
            autoApprove ? "Added --dangerously-skip-permissions for unattended execution." : "",
            stagedSkills.count > 0 ? `Staged ${stagedSkills.count} Paperclip skill(s) into .paperclip/skills.` : "",
          ].filter(Boolean),
          commandArgs: args.map((value, index) => (
            index > 0 && args[index - 1] === "--prompt" ? `<prompt ${prompt.length} chars>` : value
          )),
          env: loggedEnv,
          prompt,
          promptMetrics: {
            promptChars: prompt.length,
            wakePromptChars: wakePrompt.length,
            sessionHandoffChars: sessionHandoffNote.length,
            heartbeatPromptChars: renderedPrompt.length,
          },
          context,
        });
      }

      const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
        cwd,
        env,
        timeoutSec,
        graceSec,
        onSpawn,
        onLog: boundedOnLog,
      });
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
      const parsed = parseAntigravityOutput(proc.stdout, proc.stderr);
      if (parsed.resultStatus && parsed.resultStatus !== "SUCCESS") {
        // Visibility only: the run's success/failure classification is unchanged
        // here on purpose (68 of 91 succeeded runs in one day carry CANCELED, so
        // reclassifying is an operator decision, not a silent one).
        await onLog(
          "stderr",
          `[paperclip] Antigravity reported turn status ${parsed.resultStatus} with ${parsed.summary.trim() ? "a response" : "an EMPTY response"}.\n`,
        );
      }
      const finalObserved = weightedBudgetTokens(parsed.usage);
      tokenBudgetObserved = Math.max(tokenBudgetObserved, finalObserved);
      if (finalObserved > maxTokensPerRun) tokenBudgetExceeded = true;
      return { proc, parsed };
    };

    const toResult = (
      attempt: Awaited<ReturnType<typeof runAttempt>>,
      clearSessionOnMissingSession = false,
      isRetry = false,
    ): AdapterExecutionResult => {
      const quotaMeta = detectAntigravityQuotaExhausted({
        stderr: attempt.proc.stderr,
      });
      if (attempt.proc.timedOut) {
        return {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          clearSession: clearSessionOnMissingSession,
        };
      }

      const failed = (attempt.proc.exitCode ?? 0) !== 0;
      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      const fallbackErrorMessage = stderrLine || `Antigravity exited with code ${attempt.proc.exitCode ?? -1}`;
      const transientSilentExit = failed && isAntigravityTransientSilentExit({
        exitCode: attempt.proc.exitCode,
        stderr: attempt.proc.stderr,
      });
      const canFallbackToRuntimeSession = !isRetry;
      const resolvedSessionId =
        attempt.parsed.sessionId ??
        (canFallbackToRuntimeSession ? (runtimeSessionId || runtime.sessionId || null) : null);
      const resolvedSessionParams = resolvedSessionId
        ? ({
          sessionId: resolvedSessionId,
          cwd: effectiveExecutionCwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
          ...(executionTargetIsRemote
            ? { remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget) }
            : {}),
        } as Record<string, unknown>)
        : null;

      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        errorMessage: tokenBudgetExceeded
          ? `Paperclip maxTokensPerRun budget of ${maxTokensPerRun} tokens exhausted (observed ${tokenBudgetObserved}).`
          : failed ? fallbackErrorMessage : null,
        errorCode: tokenBudgetExceeded
          ? "antigravity_token_budget_exhausted"
          : failed && quotaMeta.exhausted ? "antigravity_quota_exhausted"
            : transientSilentExit ? "antigravity_transient_silent_exit" : null,
        errorFamily: transientSilentExit ? "transient_upstream" : null,
        usage: attempt.parsed.usage,
        usageBasis: "per_run",
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: "google",
        biller: "antigravity",
        model: model || "antigravity",
        billingType: "subscription",
        costUsd: null,
        resultJson: failed || tokenBudgetExceeded
          ? {
            stderr: attempt.proc.stderr,
            ...(attempt.parsed.disposition ? { disposition: attempt.parsed.disposition } : {}),
            ...(tokenBudgetExceeded
              ? {
                tokenBudget: {
                  exhausted: true,
                  maxTokensPerRun,
                  observedTokens: tokenBudgetObserved,
                },
              }
              : {}),
            ...(quotaMeta.exhausted
              ? {
                quotaFailure: {
                  provider: "antigravity",
                  matchedLine: quotaMeta.matchedLine,
                  resetAt: quotaMeta.resetAt?.toISOString() ?? null,
                },
                ...(quotaMeta.resetAt ? { resetAt: quotaMeta.resetAt.toISOString() } : {}),
              }
              : {}),
            ...(transientSilentExit
              ? {
                transientFailure: {
                  provider: "antigravity",
                  kind: "silent_nonzero_exit",
                  exitCode: attempt.proc.exitCode,
                },
              }
              : {}),
          }
          : {
            ...(attempt.parsed.disposition ? { disposition: attempt.parsed.disposition } : {}),
            ...(attempt.parsed.resultStatus ? { agyResultStatus: attempt.parsed.resultStatus } : {}),
            ...(attempt.parsed.resultStatus && attempt.parsed.resultStatus !== "SUCCESS"
              ? { stopReason: `antigravity_${attempt.parsed.resultStatus.toLowerCase()}` }
              : {}),
          },
        summary: attempt.parsed.summary,
        clearSession: Boolean(clearSessionOnMissingSession && !resolvedSessionId),
      };
    };

    const initial = await runAttempt(sessionId);
    if (
      sessionId &&
      !tokenBudgetExceeded &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      isAntigravityUnknownSessionError(initial.proc.stdout, initial.proc.stderr)
    ) {
      await onLog(
        "stdout",
        `[paperclip] Antigravity conversation "${sessionId}" is unavailable; retrying with a fresh conversation.\n`,
      );
      const retry = await runAttempt(null);
      return toResult(retry, true, true);
    }

    return toResult(initial);
  } finally {
    await Promise.all([
      cleanupInstructions(),
      stagedSkills.cleanup(),
    ]);
  }
}
