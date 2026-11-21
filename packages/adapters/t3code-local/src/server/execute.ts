import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  readAdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { createProviderStoppedBoundary } from "@paperclipai/adapter-utils/provider-stopped-boundary";
import {
  asNumber,
  asString,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  hydrateFreshSessionHandoff,
  isForbiddenConfigEnvKey,
  isPaperclipRecoveryWakePayload,
  joinPromptSections,
  parseObject,
  renderTemplate,
  resolveCommandForLogs,
  runChildProcess,
  runningProcesses,
  signalRunningProcess,
  selectInitialCommunicationGuidance,
  selectPaperclipPromptSections,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  type RunProcessResult,
} from "@paperclipai/adapter-utils/server-utils";
import {
  firstNonEmptyLine,
  isT3CommandUnsupported,
  isT3ProjectNotFound,
  isT3ServerUnavailable,
  isT3ThreadNotFound,
  parseT3RunResult,
  parseT3StopStatus,
  parseT3ThreadList,
  T3_STOPPED_STATUSES,
  type T3RunResult,
} from "./parse.js";

const HELPER_TIMEOUT_SEC = 30;
const STOP_POLL_MS = 1000;

interface Attempt {
  proc: RunProcessResult;
  result: T3RunResult | null;
  threadId: string | null;
  markStopped: () => void;
}

function configError(message: string): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: "t3code_config_invalid",
    errorMessage: message,
    executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
  };
}

function exitedCleanly(proc: RunProcessResult): boolean {
  return !proc.timedOut && proc.signal === null && proc.exitCode !== null;
}

function failedBeforeLaunch(proc: RunProcessResult): boolean {
  return exitedCleanly(proc) && (
    isT3ServerUnavailable(proc.stderr) || isT3ProjectNotFound(proc.stderr) || isT3ThreadNotFound(proc.stderr)
  );
}

function cancellationAcknowledged() {
  return { executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString(), forced: false } };
}

function stoppedBeforeTurn(): AdapterExecutionResult {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    errorCode: "cancelled",
    errorMessage: "Stopped before T3 Code started a turn",
    executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    resultJson: cancellationAcknowledged(),
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, signal } = ctx;
  await ctx.onCancellationReady?.();
  if (signal?.aborted) {
    return stoppedBeforeTurn();
  }
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  if (adapterExecutionTargetIsRemote(executionTarget)) {
    return configError("t3code_local runs only on the Paperclip host; it needs the local T3 Code server.");
  }

  const command = asString(config.command, "t3");
  const provider = asString(config.provider, "").trim();
  const model = asString(config.model, "").trim();
  if (Boolean(provider) !== Boolean(model)) {
    return configError("T3 Code needs provider and model together. Set both, or neither to use the project's default model.");
  }
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);
  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome =
    asString(workspaceContext.source, "") === "agent_home" && configuredCwd.length > 0;
  const cwd = (useConfiguredInsteadOfAgentHome ? "" : asString(workspaceContext.cwd, ""))
    || configuredCwd
    || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const env = Object.fromEntries(
    Object.entries(parseObject(config.env)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && !isForbiddenConfigEnvKey(entry[0]),
    ),
  );
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return configError(`${reason}. Install the T3 Code CLI (t3) or set command to its path.`);
  }
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);

  const sessionParams = parseObject(runtime.sessionParams);
  const storedThreadId = asString(sessionParams.threadId, runtime.sessionId ?? "").trim();
  const storedCwd = asString(sessionParams.cwd, "");
  const cwdMatches = storedCwd.length === 0 || path.resolve(storedCwd) === path.resolve(cwd);
  const storedSelection = `${asString(sessionParams.provider, "")}/${asString(sessionParams.model, "")}`;
  const selectionMatches = storedSelection === `${provider}/${model}`;
  const canResume = storedThreadId.length > 0 && cwdMatches && selectionMatches;
  if (storedThreadId && !cwdMatches) {
    await onLog(
      "stdout",
      `[paperclip] T3 Code thread "${storedThreadId}" was saved for cwd "${storedCwd}" and will not be resumed in "${cwd}".\n`,
    );
  } else if (storedThreadId && !selectionMatches) {
    await onLog(
      "stdout",
      `[paperclip] T3 Code thread "${storedThreadId}" used provider/model "${storedSelection}"; starting a new thread for "${provider}/${model}".\n`,
    );
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    const instructionsDir = `${path.dirname(instructionsFilePath)}/`;
    try {
      instructionsPrefix =
        `${await fs.readFile(instructionsFilePath, "utf8")}\n\n` +
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

  const buildPrompt = async (resumed: boolean) => {
    await hydrateFreshSessionHandoff(ctx, { resumedSession: resumed });
    const sections = selectPaperclipPromptSections(context, {
      resumedSession: resumed,
      includeCommunicationGuidance: false,
    });
    const bootstrapPrompt = !resumed && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
    const renderedPrompt = (resumed && sections.wakePrompt.length > 0)
      || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData);
    return joinPromptSections([
      selectInitialCommunicationGuidance(context, { resumedSession: resumed }),
      instructionsPrefix,
      bootstrapPrompt,
      sections.wakePrompt,
      sections.taskContextNote,
      sessionHandoffNote,
      renderedPrompt,
    ]);
  };

  const runT3 = (args: string[], options: { helper?: string; stdin?: string; timeoutSec?: number } = {}) =>
    runChildProcess(options.helper ? `${runId}:${options.helper}` : runId, command, args, {
      cwd,
      env,
      stdin: options.stdin,
      timeoutSec: options.timeoutSec ?? (options.helper ? HELPER_TIMEOUT_SEC : timeoutSec),
      graceSec: options.helper ? 1 : graceSec,
      onLog,
      onSpawn: options.helper ? undefined : onSpawn,
    });

  const title = `Paperclip: ${agent.name} (${runId.slice(0, 8)})`;
  const providerStop = createProviderStoppedBoundary(ctx.onProviderStopped);

  const runTurn = async (threadId: string | null): Promise<Attempt | null> => {
    if (signal?.aborted) return null;
    const prompt = await buildPrompt(Boolean(threadId));
    if (signal?.aborted) return null;
    const args = threadId
      ? ["thread", "send", threadId, "-", "--wait", "--json"]
      : [
        "thread", "start", cwd, "-",
        ...(provider ? ["--provider", provider, "--model", model] : []),
        "--title", title, "--wait", "--json",
      ];
    await onMeta?.({
      adapterType: "t3code_local",
      command: resolvedCommand,
      cwd,
      commandArgs: args,
      commandNotes: [
        threadId
          ? `Queued the message on T3 Code thread ${threadId}.`
          : "Started a new T3 Code thread in the project containing the cwd.",
        "The message is passed on stdin.",
      ],
      env: buildInvocationEnvForLogs(env, { resolvedCommand }),
      prompt,
      promptMetrics: { promptChars: prompt.length, instructionsChars: instructionsPrefix.length },
      context,
    });
    if (signal?.aborted) return null;
    const markStopped = providerStop.beginInvocation();
    const proc = await runT3(args, { stdin: prompt });
    return { proc, result: parseT3RunResult(proc.stdout), threadId, markStopped };
  };

  const startThread = async (): Promise<Attempt | null> => {
    const first = await runTurn(null);
    if (!first || first.result || !exitedCleanly(first.proc) || !isT3ProjectNotFound(first.proc.stderr)) return first;
    if (signal?.aborted) return first;
    await onLog("stdout", `[paperclip] No T3 Code project contains "${cwd}"; adding it as a project.\n`);
    if (signal?.aborted) return first;
    const helperKey = `${runId}:project-add`;
    const stopSetup = () => {
      const running = runningProcesses.get(helperKey);
      if (running) signalRunningProcess(running, "SIGTERM");
    };
    signal?.addEventListener("abort", stopSetup, { once: true });
    const added = await runT3(["project", "add", cwd], { helper: "project-add" })
      .finally(() => signal?.removeEventListener("abort", stopSetup));
    if (signal?.aborted) return first;
    return added.exitCode === 0 ? (await runTurn(null)) ?? first : first;
  };

  const confirmStopped = async (attempt: Attempt): Promise<{ threadId: string | null; error: string | null }> => {
    if (failedBeforeLaunch(attempt.proc)) return { threadId: attempt.threadId, error: null };
    const budgetSec = Math.max(graceSec, 5);
    const deadline = Date.now() + budgetSec * 1000;
    const remainingSec = () => Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    const notConfirmed = (id: string) => `T3 Code did not confirm within ${budgetSec}s that thread ${id} stopped.`;
    let threadId = attempt.result?.threadId ?? attempt.threadId;
    while (!threadId) {
      const listed = await runT3(["thread", "list", "--project", cwd, "--json"], {
        helper: "thread-list",
        timeoutSec: remainingSec(),
      });
      const threads = parseT3ThreadList(listed.stdout);
      if (!threads) {
        const reason = firstNonEmptyLine(listed.stderr) || `t3 thread list exited with code ${listed.exitCode ?? -1}`;
        return { threadId: null, error: `Could not check whether T3 Code started a thread for this run: ${reason}` };
      }
      threadId = threads.find((thread) => thread.title === title)?.threadId ?? null;
      if (threadId) break;
      if (Date.now() + STOP_POLL_MS >= deadline) {
        return { threadId: null, error: `T3 Code did not list a thread for this run within ${budgetSec}s; the interrupted start may still create one.` };
      }
      await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
    }
    for (;;) {
      const stop = await runT3(["thread", "stop", threadId, "--json"], {
        helper: "thread-stop",
        timeoutSec: remainingSec(),
      });
      if (stop.timedOut) return { threadId, error: notConfirmed(threadId) };
      const status = parseT3StopStatus(stop.stdout);
      if (status && T3_STOPPED_STATUSES.has(status)) return { threadId, error: null };
      if (stop.exitCode !== 0 && isT3ThreadNotFound(stop.stderr)) return { threadId, error: null };
      if (stop.exitCode !== 0 && isT3CommandUnsupported(stop.stderr)) {
        return {
          threadId,
          error: `Could not confirm that T3 Code thread ${threadId} stopped: this t3 CLI has no \`thread stop\` command, so the run may still be active in T3 Code.`,
        };
      }
      if (status !== "interrupt_requested") {
        const reason = firstNonEmptyLine(stop.stderr) || `exit code ${stop.exitCode ?? -1}`;
        return { threadId, error: `Could not stop T3 Code thread ${threadId}: ${reason}` };
      }
      if (Date.now() + STOP_POLL_MS >= deadline) return { threadId, error: notConfirmed(threadId) };
      await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
    }
  };

  let attempt = canResume ? await runTurn(storedThreadId) : await startThread();
  let staleThreadReplaced = false;
  if (
    attempt && canResume && !attempt.result && exitedCleanly(attempt.proc) && isT3ThreadNotFound(attempt.proc.stderr)
    && !signal?.aborted
  ) {
    await onLog(
      "stdout",
      `[paperclip] T3 Code thread "${storedThreadId}" is unavailable; starting a new thread.\n`,
    );
    staleThreadReplaced = true;
    attempt = (await startThread()) ?? attempt;
  }
  if (!attempt) {
    return stoppedBeforeTurn();
  }

  let threadId = attempt.result?.threadId ?? attempt.threadId;
  let stopError: string | null = null;
  if (attempt.result && T3_STOPPED_STATUSES.has(attempt.result.status)) {
    attempt.markStopped();
  } else {
    const confirmed = await confirmStopped(attempt);
    threadId = confirmed.threadId;
    stopError = confirmed.error;
    if (!stopError) attempt.markStopped();
  }
  await providerStop.collectBeforeRestore();

  const { proc, result } = attempt;
  const cancelled = signal?.aborted === true && result?.status !== "completed";
  if (cancelled && failedBeforeLaunch(proc)) return stoppedBeforeTurn();
  const waiting = result?.status === "waiting";
  const failed = proc.timedOut || proc.exitCode !== 0 || result?.status !== "completed";
  const runError = !failed
    ? null
    : cancelled
      ? "Stopped by the operator"
      : proc.timedOut
        ? `Timed out after ${timeoutSec}s`
        : waiting
          ? `T3 Code thread ${result!.threadId} is waiting for an answer. Open it in T3 Code to respond.`
          : result?.error
            || firstNonEmptyLine(proc.stderr)
            || (result ? `T3 Code run ended with status ${result.status}` : null)
            || (proc.signal ? `t3 was terminated by signal ${proc.signal}` : `t3 exited with code ${proc.exitCode ?? -1}`);
  const errorMessage = stopError ? [runError, stopError].filter(Boolean).join(" ") : runError;

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    errorMessage,
    errorCode: stopError
      ? "t3code_stop_unverified"
      : cancelled
        ? "cancelled"
        : waiting
          ? "t3code_needs_input"
          : failed && isT3ServerUnavailable(proc.stderr)
            ? "t3code_server_unavailable"
            : null,
    usageComplete: true,
    usageBasis: "per_run",
    costStatus: "unpriced",
    costUsd: null,
    billingType: "unknown",
    provider: provider || null,
    model: model || null,
    sessionId: threadId,
    sessionParams: threadId ? { threadId, cwd, ...(provider ? { provider, model } : {}) } : null,
    sessionDisplayId: threadId,
    clearSession: staleThreadReplaced && !threadId,
    summary: result?.reply ?? null,
    resultJson: {
      threadId,
      runId: result?.runId ?? null,
      status: result?.status ?? null,
      ...(failed ? { stderr: proc.stderr } : {}),
      ...(cancelled && !stopError ? cancellationAcknowledged() : {}),
    },
  };
}
