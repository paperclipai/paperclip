import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { AdapterExecutionContext, UsageSummary } from "@paperclipai/adapter-utils";
import {
  asString,
  ensurePathInEnv,
  parseObject,
  sanitizeInheritedPaperclipEnv,
} from "@paperclipai/adapter-utils/server-utils";
import { CodexAppServerError, CodexAppServerTransport } from "./transport.js";
import type { CodexAppServerRunResult, CodexGoalSnapshot, CodexGoalStatus } from "./types.js";

export const CODEX_APP_SERVER_RUNTIME = "app_server_experimental";

const TERMINAL_GOAL_STATUSES = new Set<CodexGoalStatus>([
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
  "cleared",
  "error",
]);

export interface CodexGoalConfig {
  runtime: "codex_exec" | typeof CODEX_APP_SERVER_RUNTIME;
  goal: {
    enabled: boolean;
    tokenBudget: number | null;
    timeoutSec: number | null;
    stopAfterTurn: boolean;
  };
}

export interface ExecuteCodexGoalRunInput {
  runId: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  model: string;
  reasoningEffort: string | null;
  objective: string;
  objectiveFingerprint: string;
  issueId: string | null;
  resumeThreadId: string | null;
  tokenBudget: number | null;
  timeoutSec: number;
  graceSec: number;
  stopAfterTurn: boolean;
  pauseOnExit: boolean;
  thread: Record<string, unknown>;
  onLog: AdapterExecutionContext["onLog"];
  onSpawn?: AdapterExecutionContext["onSpawn"];
}

export type CodexGoalChatCommandAction = "set" | "status" | "clear";

export interface ExecuteCodexGoalCommandInput {
  runId: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  action: CodexGoalChatCommandAction;
  objective: string | null;
  objectiveFingerprint: string | null;
  issueId: string | null;
  resumeThreadId: string | null;
  tokenBudget: number | null;
  graceSec: number;
  thread: Record<string, unknown>;
  onLog: AdapterExecutionContext["onLog"];
  onSpawn?: AdapterExecutionContext["onSpawn"];
}

export interface CodexGoalCommandResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  rawStderr: string;
  sessionId: string | null;
  goal: CodexGoalSnapshot | null;
  summary: string;
  errorMessage: string | null;
  errorCode: string | null;
  clearSession?: boolean;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function floorPositive(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

export function readCodexGoalConfig(config: Record<string, unknown>): CodexGoalConfig {
  const goal = parseObject(config.goal);
  const legacyGoalRuntime = asString(config.goalRuntime, "").trim();
  const runtimeRaw = asString(config.runtime, legacyGoalRuntime === CODEX_APP_SERVER_RUNTIME ? CODEX_APP_SERVER_RUNTIME : "codex_exec").trim();
  const runtime = runtimeRaw === CODEX_APP_SERVER_RUNTIME ? CODEX_APP_SERVER_RUNTIME : "codex_exec";
  const goalEnabled =
    asBoolean(goal.enabled, false) ||
    legacyGoalRuntime === CODEX_APP_SERVER_RUNTIME ||
    runtime === CODEX_APP_SERVER_RUNTIME;
  return {
    runtime,
    goal: {
      enabled: goalEnabled,
      tokenBudget: floorPositive(goal.tokenBudget) ?? floorPositive(config.goalTokenBudget),
      timeoutSec: floorPositive(goal.timeoutSec) ?? floorPositive(config.goalTimeoutSec),
      stopAfterTurn: asBoolean(goal.stopAfterTurn, asBoolean(config.goalStopAfterTurn, false)),
    },
  };
}

export function fingerprintCodexGoalObjective(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function readContextIssueRef(context: Record<string, unknown>): {
  id: string | null;
  identifier: string | null;
  title: string | null;
} {
  const wake = parseObject(context.paperclipWake);
  const wakeIssue = parseObject(wake.issue);
  const issue = parseObject(context.paperclipIssue);
  const id =
    asString(context.taskId, "").trim() ||
    asString(context.issueId, "").trim() ||
    asString(wakeIssue.id, "").trim() ||
    asString(issue.id, "").trim() ||
    null;
  const identifier =
    asString(wakeIssue.identifier, "").trim() ||
    asString(issue.identifier, "").trim() ||
    null;
  const title =
    asString(wakeIssue.title, "").trim() ||
    asString(issue.title, "").trim() ||
    null;
  return { id, identifier, title };
}

export function buildCodexGoalObjective(context: Record<string, unknown>, prompt: string): string {
  const issue = readContextIssueRef(context);
  const label = [issue.identifier, issue.title].filter(Boolean).join(" ");
  if (label) return `Complete Paperclip issue ${label}.`;
  const firstPromptLine =
    prompt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  return firstPromptLine ? firstPromptLine.slice(0, 500) : "Complete the assigned Paperclip work.";
}

function threadIdFromResult(result: unknown): string | null {
  const rec = parseObject(result);
  const thread = parseObject(rec.thread);
  return asString(thread.id, "") || asString(thread.threadId, "") || asString(rec.threadId, "") || null;
}

function normalizeGoal(goalRaw: unknown, fallbackThreadId: string | null): CodexGoalSnapshot | null {
  const goal = parseObject(goalRaw);
  const status = asString(goal.status, "") as CodexGoalStatus;
  if (!status) return null;
  return {
    threadId: asString(goal.threadId, "") || fallbackThreadId,
    objective: asString(goal.objective, ""),
    status,
    tokenBudget:
      typeof goal.tokenBudget === "number" && Number.isFinite(goal.tokenBudget)
        ? goal.tokenBudget
        : null,
    tokensUsed: asNumber(goal.tokensUsed, 0),
    timeUsedSeconds: asNumber(goal.timeUsedSeconds, 0),
    createdAt:
      typeof goal.createdAt === "number" && Number.isFinite(goal.createdAt)
        ? goal.createdAt
        : null,
    updatedAt:
      typeof goal.updatedAt === "number" && Number.isFinite(goal.updatedAt)
        ? goal.updatedAt
        : Math.floor(Date.now() / 1000),
  };
}

function translateItem(itemRaw: unknown): unknown {
  const item = parseObject(itemRaw);
  if (Object.keys(item).length === 0) return itemRaw;
  const itemType = asString(item.type, "");
  if (itemType === "commandExecution") {
    return {
      ...item,
      type: "commandExecution",
      aggregated_output: item.aggregatedOutput ?? item.aggregated_output,
      exit_code: item.exitCode ?? item.exit_code,
    };
  }
  return item;
}

function goalErrorCode(status: CodexGoalStatus): string | null {
  if (status === "budgetLimited") return "codex_goal_budget_limited";
  if (status === "usageLimited") return "codex_goal_usage_limited";
  if (status === "blocked") return "codex_goal_blocked";
  return null;
}

async function readCodexCliVersion(command: string, cwd: string, env: Record<string, string>): Promise<string> {
  return await new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      cwd,
      env: ensurePathInEnv({ ...sanitizeInheritedPaperclipEnv(process.env), ...env }),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("unknown");
    }, 3_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(output.trim().split(/\r?\n/).find(Boolean) ?? "unknown");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("unknown");
    });
  });
}

export async function executeCodexAppServerGoalRun(input: ExecuteCodexGoalRunInput): Promise<CodexAppServerRunResult> {
  const stdoutEvents: string[] = [];
  const emitEvent = (event: Record<string, unknown>) => {
    const line = JSON.stringify(event);
    stdoutEvents.push(line);
    void input.onLog("stdout", `${line}\n`).catch(() => undefined);
  };
  let threadId: string | null = null;
  let activeTurnId: string | null = null;
  let lastGoal: CodexGoalSnapshot | null = null;
  let turnCompleted = false;
  let summary = "";
  const usage: UsageSummary = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

  const transport = new CodexAppServerTransport({
    runId: input.runId,
    command: input.command,
    args: ["app-server", "--listen", "stdio://", "--enable", "goals"],
    cwd: input.cwd,
    env: input.env,
    onLog: input.onLog,
    onSpawn: input.onSpawn,
    onStdoutEvent: (message) => {
      const method = asString(message.method, "");
      const params = parseObject(message.params);
      if (method === "thread/started") {
        const thread = parseObject(params.thread);
        threadId = asString(thread.id, threadId ?? "") || threadId;
        emitEvent({ type: "thread.started", thread_id: threadId, model: input.model || "codex" });
        return;
      }
      if (method === "thread/goal/updated") {
        const goal = normalizeGoal(params.goal, threadId);
        if (goal) {
          lastGoal = goal;
          emitEvent({ type: "goal.updated", thread_id: goal.threadId, turn_id: params.turnId ?? null, goal });
        }
        return;
      }
      if (method === "thread/goal/cleared") {
        lastGoal = lastGoal
          ? { ...lastGoal, status: "cleared", reason: "Goal cleared" }
          : {
              threadId,
              objective: "",
              status: "cleared",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: null,
              updatedAt: Math.floor(Date.now() / 1000),
              reason: "Goal cleared",
            };
        emitEvent({ type: "goal.cleared", thread_id: params.threadId ?? threadId, reason: "Goal cleared" });
        return;
      }
      if (method === "turn/started") {
        const turn = parseObject(params.turn);
        activeTurnId = asString(turn.id, activeTurnId ?? "") || activeTurnId;
        emitEvent({ type: "turn.started", thread_id: params.threadId ?? threadId, turn_id: activeTurnId });
        return;
      }
      if (method === "turn/completed") {
        turnCompleted = true;
        activeTurnId = null;
        const turn = parseObject(params.turn);
        const usageObj = parseObject(params.usage ?? turn.usage);
        usage.inputTokens = asNumber(usageObj.input_tokens, usage.inputTokens);
        usage.cachedInputTokens = asNumber(usageObj.cached_input_tokens, usage.cachedInputTokens ?? 0);
        usage.outputTokens = asNumber(usageObj.output_tokens, usage.outputTokens);
        emitEvent({
          type: "turn.completed",
          thread_id: params.threadId ?? threadId,
          turn_id: asString(turn.id, "") || null,
          usage: {
            input_tokens: usage.inputTokens,
            cached_input_tokens: usage.cachedInputTokens ?? 0,
            output_tokens: usage.outputTokens,
          },
        });
        return;
      }
      if (method === "item/started" || method === "item/completed") {
        const item = translateItem(params.item);
        if (method === "item/completed") {
          const itemRec = parseObject(item);
          const type = asString(itemRec.type, "");
          if (type === "agent_message" || type === "agentMessage") {
            const text = asString(itemRec.text, "");
            if (text) summary = text;
          }
        }
        emitEvent({
          type: method === "item/started" ? "item.started" : "item.completed",
          thread_id: params.threadId ?? threadId,
          turn_id: params.turnId ?? null,
          item,
        });
        return;
      }
      if (method === "thread/tokenUsage/updated") {
        emitEvent({ type: "token_usage.updated", thread_id: params.threadId ?? threadId, usage: params });
        return;
      }
      if (method === "error") {
        emitEvent({ type: "error", message: asString(params.message ?? params.error, "Codex app-server error") });
      }
    },
  });

  let errorMessage: string | null = null;
  let exitCode: number | null = 0;
  let timedOut = false;

  try {
    await transport.start();
    await transport.request("initialize", {
      clientInfo: { name: "paperclip", title: "Paperclip", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    transport.notify("initialized");

    if (input.resumeThreadId) {
      const resumed = await transport.request("thread/resume", { ...input.thread, threadId: input.resumeThreadId });
      threadId = threadIdFromResult(resumed);
      const got = await transport.request("thread/goal/get", { threadId }, 5_000).catch(() => null);
      const goal = normalizeGoal(parseObject(got).goal, threadId);
      if (!goal || fingerprintCodexGoalObjective(goal.objective) !== input.objectiveFingerprint) {
        await transport.request("thread/goal/clear", { threadId }, 5_000).catch(() => undefined);
        threadId = null;
      } else {
        lastGoal = goal;
        emitEvent({ type: "goal.updated", thread_id: goal.threadId, goal });
      }
    }

    if (!threadId) {
      const started = await transport.request("thread/start", { ...input.thread, ephemeral: false });
      threadId = threadIdFromResult(started);
    }
    if (!threadId) throw new Error("Codex app-server did not return a thread id");

    if (input.prompt) {
      await transport.request("turn/start", {
        threadId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        cwd: input.cwd,
        model: input.model || null,
        effort: input.reasoningEffort,
      });
    }

    const setGoalParams = {
      threadId,
      objective: input.objective,
      status: "active",
      tokenBudget: input.tokenBudget,
    };
    let setGoalResult: unknown;
    try {
      setGoalResult = await transport.request("thread/goal/set", setGoalParams);
    } catch (error) {
      if (error instanceof CodexAppServerError && (error.code === -32601 || error.code === "-32601")) {
        const version = await readCodexCliVersion(input.command, input.cwd, input.env);
        throw new CodexAppServerError(
          `Codex CLI ${version} does not support thread/goal/set; enable a Codex CLI with the goals app-server RPC.`,
          { code: "codex_goal_unsupported_cli" },
        );
      }
      throw error;
    }
    const initialGoal = normalizeGoal(parseObject(setGoalResult).goal, threadId);
    if (initialGoal) {
      lastGoal = initialGoal;
      emitEvent({ type: "goal.updated", thread_id: threadId, goal: initialGoal });
    }

    const timeoutMs = input.timeoutSec > 0 ? input.timeoutSec * 1000 : 0;
    await transport.waitUntil(() => {
      if (lastGoal && TERMINAL_GOAL_STATUSES.has(lastGoal.status)) return true;
      return input.stopAfterTurn && turnCompleted;
    }, timeoutMs);

    if (input.pauseOnExit && lastGoal?.status === "active") {
      await transport.request("thread/goal/set", { threadId, status: "paused" }, Math.max(1, input.graceSec) * 1000).catch(() => undefined);
    }
  } catch (error) {
    exitCode = 1;
    errorMessage = error instanceof Error ? error.message : String(error);
    if (/timed out/i.test(errorMessage)) timedOut = true;
    const errorCode =
      error instanceof CodexAppServerError && typeof error.code === "string"
        ? error.code
        : null;
    emitEvent({
      type: "error",
      message: errorMessage,
      ...(errorCode ? { errorCode } : {}),
    });
  } finally {
    await transport.stopWithGrace(Math.max(1, input.graceSec) * 1000).catch(() => undefined);
  }

  const goalStatusCode = lastGoal ? goalErrorCode(lastGoal.status) : null;
  if (goalStatusCode && exitCode === 0) {
    errorMessage = lastGoal?.status === "budgetLimited"
      ? "Codex goal token budget was exhausted."
      : `Codex goal ended with status ${lastGoal?.status}.`;
    emitEvent({ type: "error", message: errorMessage, errorCode: goalStatusCode });
  }

  return {
    exitCode,
    signal: transport.signal,
    timedOut,
    stdout: stdoutEvents.join("\n") + (stdoutEvents.length > 0 ? "\n" : ""),
    stderr: transport.capturedStderr,
    rawStderr: transport.capturedStderr,
    sessionId: threadId,
    summary,
    usage,
    errorMessage,
  };
}

export async function executeCodexAppServerGoalCommand(
  input: ExecuteCodexGoalCommandInput,
): Promise<CodexGoalCommandResult> {
  const stdoutEvents: string[] = [];
  const emitEvent = (event: Record<string, unknown>) => {
    const line = JSON.stringify(event);
    stdoutEvents.push(line);
    void input.onLog("stdout", `${line}\n`).catch(() => undefined);
  };

  let threadId: string | null = null;
  let lastGoal: CodexGoalSnapshot | null = null;
  let errorMessage: string | null = null;
  let errorCode: string | null = null;
  let exitCode: number | null = 0;
  let timedOut = false;

  const transport = new CodexAppServerTransport({
    runId: input.runId,
    command: input.command,
    args: ["app-server", "--listen", "stdio://", "--enable", "goals"],
    cwd: input.cwd,
    env: input.env,
    onLog: input.onLog,
    onSpawn: input.onSpawn,
    onStdoutEvent: (message) => {
      const method = asString(message.method, "");
      const params = parseObject(message.params);
      if (method === "thread/started") {
        const thread = parseObject(params.thread);
        threadId = asString(thread.id, threadId ?? "") || threadId;
        emitEvent({ type: "thread.started", thread_id: threadId, model: "codex" });
        return;
      }
      if (method === "thread/goal/updated") {
        const goal = normalizeGoal(params.goal, threadId);
        if (goal) {
          lastGoal = goal;
          emitEvent({ type: "goal.updated", thread_id: goal.threadId, goal });
        }
        return;
      }
      if (method === "thread/goal/cleared") {
        lastGoal = lastGoal
          ? { ...lastGoal, status: "cleared", reason: "Goal cleared" }
          : {
              threadId,
              objective: "",
              status: "cleared",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: null,
              updatedAt: Math.floor(Date.now() / 1000),
              reason: "Goal cleared",
            };
        emitEvent({ type: "goal.cleared", thread_id: params.threadId ?? threadId, reason: "Goal cleared" });
      }
    },
  });

  try {
    await transport.start();
    await transport.request("initialize", {
      clientInfo: { name: "paperclip", title: "Paperclip", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    transport.notify("initialized");

    if (input.resumeThreadId) {
      const resumed = await transport.request("thread/resume", { ...input.thread, threadId: input.resumeThreadId });
      threadId = threadIdFromResult(resumed);
    }

    if (!threadId && input.action === "set") {
      const started = await transport.request("thread/start", { ...input.thread, ephemeral: false });
      threadId = threadIdFromResult(started);
    }

    if (!threadId) {
      const message = input.action === "status" ? "No active Codex goal is stored for this issue." : "No Codex goal is stored for this issue.";
      return {
        exitCode: 0,
        signal: transport.signal,
        timedOut: false,
        stdout: stdoutEvents.join("\n") + (stdoutEvents.length > 0 ? "\n" : ""),
        stderr: transport.capturedStderr,
        rawStderr: transport.capturedStderr,
        sessionId: null,
        goal: null,
        summary: message,
        errorMessage: null,
        errorCode: null,
        clearSession: input.action === "clear",
      };
    }

    if (input.action === "set") {
      if (!input.objective || !input.objectiveFingerprint) {
        throw new Error("`/goal` needs an objective, or use `/goal status` / `/goal clear`.");
      }
      let setGoalResult: unknown;
      try {
        setGoalResult = await transport.request("thread/goal/set", {
          threadId,
          objective: input.objective,
          status: "active",
          tokenBudget: input.tokenBudget,
        });
      } catch (error) {
        if (error instanceof CodexAppServerError && (error.code === -32601 || error.code === "-32601")) {
          const version = await readCodexCliVersion(input.command, input.cwd, input.env);
          throw new CodexAppServerError(
            `Codex CLI ${version} does not support thread/goal/set; enable a Codex CLI with the goals app-server RPC.`,
            { code: "codex_goal_unsupported_cli" },
          );
        }
        throw error;
      }
      const goal = normalizeGoal(parseObject(setGoalResult).goal, threadId);
      if (goal) {
        lastGoal = goal;
        emitEvent({ type: "goal.updated", thread_id: threadId, goal });
      }
    } else if (input.action === "status") {
      const got = await transport.request("thread/goal/get", { threadId }, 5_000).catch(() => null);
      lastGoal = normalizeGoal(parseObject(got).goal, threadId);
      if (lastGoal) emitEvent({ type: "goal.updated", thread_id: threadId, goal: lastGoal });
    } else {
      await transport.request("thread/goal/clear", { threadId }, 5_000);
      const previousGoal = lastGoal as CodexGoalSnapshot | null;
      lastGoal = previousGoal
        ? { ...previousGoal, status: "cleared", reason: "Goal cleared" }
        : {
            threadId,
            objective: "",
            status: "cleared",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: null,
            updatedAt: Math.floor(Date.now() / 1000),
            reason: "Goal cleared",
          };
      emitEvent({ type: "goal.cleared", thread_id: threadId, reason: "Goal cleared" });
    }
  } catch (error) {
    exitCode = 1;
    errorMessage = error instanceof Error ? error.message : String(error);
    if (/timed out/i.test(errorMessage)) timedOut = true;
    errorCode =
      error instanceof CodexAppServerError && typeof error.code === "string"
        ? error.code
        : "codex_goal_command_failed";
    emitEvent({
      type: "error",
      message: errorMessage,
      errorCode,
    });
  } finally {
    await transport.stopWithGrace(Math.max(1, input.graceSec) * 1000).catch(() => undefined);
  }

  const summary = formatCodexGoalCommandSummary(input.action, lastGoal, errorMessage);
  return {
    exitCode,
    signal: transport.signal,
    timedOut,
    stdout: stdoutEvents.join("\n") + (stdoutEvents.length > 0 ? "\n" : ""),
    stderr: transport.capturedStderr,
    rawStderr: transport.capturedStderr,
    sessionId: threadId,
    goal: lastGoal,
    summary,
    errorMessage,
    errorCode,
    clearSession: input.action === "clear",
  };
}

function formatCodexGoalCommandSummary(
  action: CodexGoalChatCommandAction,
  goal: CodexGoalSnapshot | null,
  errorMessage: string | null,
): string {
  if (errorMessage) return errorMessage;
  if (action === "clear") return "Goal cleared.";
  if (!goal) return "No active Codex goal is stored for this issue.";
  if (action === "set") {
    const budget = goal.tokenBudget == null ? "" : ` - budget ${goal.tokenBudget.toLocaleString()} tokens`;
    return `Goal set: ${goal.objective}${budget}`;
  }
  const budget = goal.tokenBudget == null ? "unbounded" : `${goal.tokenBudget.toLocaleString()} tokens`;
  return `Goal status: ${goal.status}; ${goal.tokensUsed.toLocaleString()} tokens used of ${budget}.`;
}
