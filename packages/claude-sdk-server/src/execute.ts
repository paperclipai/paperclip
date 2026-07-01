import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildClaudeExecutionPermissionArgs } from "./permissions.js";
import {
  buildResultUsage,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  isClaudeMaxTurnsResult,
  isClaudeTransientUpstreamError,
  isClaudeUnknownSessionError,
  parseClaudeStreamJson,
  parsedIsError,
} from "./parse-claude.js";
import type { ClaudeBridgeExecutionContext, ClaudeBridgeExecutionResult } from "./types.js";
import { asBoolean, asNumber, asString, joinPromptSections, nonEmptyString, parseObject, renderTemplate } from "./utils.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE = [
  "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  "",
  "Execution contract:",
  "- Start actionable work in this heartbeat; do not stop at a plan unless the issue asks for planning.",
  "- Leave durable progress in comments, documents, or work products, then update the issue to a clear final disposition before ending the heartbeat.",
  "- If blocked, mark the issue blocked and name the unblock owner and action.",
  "- Respect budget, pause/cancel, approval gates, and company boundaries.",
].join("\n");

function isBedrockAuth(env: Record<string, string>): boolean {
  return (
    env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    Boolean(nonEmptyString(env.ANTHROPIC_BEDROCK_BASE_URL))
  );
}

function isBedrockModelId(model: string): boolean {
  return /^\w+\.anthropic\./.test(model) || model.startsWith("arn:aws:bedrock:");
}

function resolveBillingType(env: Record<string, string>): "api" | "subscription" | "metered_api" {
  if (isBedrockAuth(env)) return "metered_api";
  return nonEmptyString(env.ANTHROPIC_API_KEY) ? "api" : "subscription";
}

function buildWakePrompt(value: unknown, resumedSession: boolean): string {
  if (!value) return "";
  try {
    const pretty = JSON.stringify(value, null, 2);
    return resumedSession
      ? `## Paperclip Resume Delta\n\nYou are resuming an existing Paperclip session. Focus on this new wake payload first.\n\n${pretty}`
      : `## Paperclip Wake Payload\n\nTreat this wake payload as the highest-priority change for the current heartbeat.\n\n${pretty}`;
  } catch {
    return "";
  }
}

function ensureStringEnv(input: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function mergeRuntimeEnv(env: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") merged[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    merged[key] = value;
  }
  return merged;
}

async function readInstructionsFile(pathname: string, onLog: ClaudeBridgeExecutionContext["onLog"]): Promise<string | null> {
  try {
    const content = await fs.readFile(pathname, "utf8");
    const dir = `${path.dirname(pathname)}/`;
    return (
      content +
      `\nThe above agent instructions were loaded from ${pathname}. Resolve any relative file references from ${dir}.`
    );
  } catch (err) {
    await onLog(
      "stderr",
      `[paperclip] Warning: could not read agent instructions file "${pathname}": ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

function normalizeResolvedInstructions(
  value: ClaudeBridgeExecutionContext["resolvedInstructions"],
): { sourcePath: string; contents: string } | null {
  if (!value || typeof value !== "object") return null;
  const sourcePath = nonEmptyString(value.sourcePath);
  const contents = nonEmptyString(value.contents);
  if (!sourcePath || !contents) return null;
  return { sourcePath, contents };
}

async function writeTempInstructionsFile(runId: string, contents: string): Promise<string> {
  const dir = path.join(process.cwd(), ".tmp-claude-sdk-server");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${runId}-instructions.md`);
  await fs.writeFile(file, contents, "utf8");
  return file;
}

async function runClaudeAttempt(input: {
  ctx: ClaudeBridgeExecutionContext;
  command: string;
  cwd: string;
  env: Record<string, string>;
  args: string[];
  prompt: string;
  timeoutSec: number;
  graceSec: number;
}) {
  const { ctx, command, cwd, env, args, prompt, timeoutSec, graceSec } = input;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const startedAt = new Date().toISOString();
  await ctx.onSpawn?.({
    pid: child.pid ?? -1,
    processGroupId: child.pid ?? null,
    startedAt,
  });
  child.stdin.write(prompt);
  child.stdin.end();
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdoutChunks.push(text);
    void ctx.onLog("stdout", text);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderrChunks.push(text);
    void ctx.onLog("stderr", text);
  });

  let timedOut = false;
  const timer =
    timeoutSec > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), graceSec * 1000).unref?.();
        }, timeoutSec * 1000)
      : null;

  const result = await new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ exitCode: code, signal }));
  });
  if (timer) clearTimeout(timer);
  return {
    ...result,
    timedOut,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

function buildPrompt(ctx: ClaudeBridgeExecutionContext, sessionId: string | null): string {
  const promptTemplate = asString(ctx.config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const templateData = {
    agent: ctx.agent,
    agentId: ctx.agent.id,
    companyId: ctx.agent.companyId,
    company: { id: ctx.agent.companyId },
    runId: ctx.runId,
    run: { id: ctx.runId, source: "on_demand" },
    context: ctx.context,
  };
  const wakePrompt = buildWakePrompt(ctx.context.paperclipWake, Boolean(sessionId));
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const handoff = asString(ctx.context.paperclipSessionHandoffMarkdown, "").trim();
  const task = asString(ctx.context.paperclipTaskMarkdown, "").trim();
  return joinPromptSections([wakePrompt, handoff, task, renderedPrompt]);
}

export async function readClaudeAuthStatus(): Promise<{
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
} | null> {
  try {
    const { stdout } = await execFileAsync("claude", ["auth", "status"], {
      env: process.env,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return {
      loggedIn: parsed.loggedIn === true,
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : null,
      subscriptionType: typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : null,
    };
  } catch {
    return null;
  }
}

export function resolveClaudeBridgeTimeoutSec(config: Record<string, unknown>): number {
  const configured = asNumber(config.timeoutSec, 0);
  return configured > 0 ? Math.max(1, configured) : 0;
}

export function resolveClaudeBridgeCwd(
  config: Record<string, unknown>,
  context: Record<string, unknown>,
  fallbackCwd = process.cwd(),
): string {
  const configured = asString(config.cwd, "").trim();
  if (configured) return configured;
  // `paperclipWorkspace.cwd` describes the Paperclip-side execution workspace.
  // On a remote bridge host that path is often meaningless, so only an
  // explicit adapterConfig.cwd should steer the remote Claude process.
  void context;
  return fallbackCwd;
}

export async function executeClaude(ctx: ClaudeBridgeExecutionContext): Promise<ClaudeBridgeExecutionResult> {
  const config = ctx.config;
  const command = asString(config.command, "claude");
  const cwd = resolveClaudeBridgeCwd(config, ctx.context);
  await fs.mkdir(cwd, { recursive: true });

  const env = ensureStringEnv(parseObject(config.env));
  env.PAPERCLIP_RUN_ID = ctx.runId;
  if (!nonEmptyString(env.PAPERCLIP_API_KEY) && ctx.authToken) {
    env.PAPERCLIP_API_KEY = ctx.authToken;
  }

  const model = asString(config.model, "").trim();
  const effort = asString(config.effort, "").trim();
  const chrome = asBoolean(config.chrome, false);
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const timeoutSec = resolveClaudeBridgeTimeoutSec(config);
  const graceSec = Math.max(1, asNumber(config.graceSec, 20));
  const extraArgs = Array.isArray(config.extraArgs)
    ? config.extraArgs.filter((value): value is string => typeof value === "string")
    : Array.isArray(config.args)
    ? config.args.filter((value): value is string => typeof value === "string")
    : [];

  const runtimeSessionParams = parseObject(ctx.runtime.sessionParams);
  const savedSessionId = asString(runtimeSessionParams.sessionId, ctx.runtime.sessionId ?? "");
  const mergedEnv = mergeRuntimeEnv(env);
  const billingType = resolveBillingType(mergedEnv);
  await ctx.onLog(
    "stdout",
    `[paperclip] bridge run config: cwd=${cwd} timeoutSec=${timeoutSec} model=${model || "(default)"} resumeSession=${savedSessionId || "(none)"}\n`,
  );

  const prompt = buildPrompt(ctx, savedSessionId || null);
  const buildArgs = (sessionId: string | null, instructionsPath?: string) => {
    const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    if (sessionId) args.push("--resume", sessionId);
    args.push(...buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions }));
    if (chrome) args.push("--chrome");
    if (model && (!isBedrockAuth(mergedEnv) || isBedrockModelId(model))) {
      args.push("--model", model);
    }
    if (effort) args.push("--effort", effort);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    if (instructionsPath && !sessionId) args.push("--append-system-prompt-file", instructionsPath);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const resolvedInstructions = normalizeResolvedInstructions(ctx.resolvedInstructions);
  const instructionsFilePath = nonEmptyString(config.instructionsFilePath);
  const instructionContents =
    resolvedInstructions?.contents ??
    (instructionsFilePath ? await readInstructionsFile(instructionsFilePath, ctx.onLog) : null);
  const tempInstructionsPath = instructionContents ? await writeTempInstructionsFile(ctx.runId, instructionContents) : undefined;

  if (resolvedInstructions) {
    await ctx.onLog(
      "stdout",
      `[paperclip] Using forwarded agent instructions from "${resolvedInstructions.sourcePath}" supplied by Paperclip.\n`,
    );
  }

  const attempt = async (sessionId: string | null) => {
    const args = buildArgs(sessionId, tempInstructionsPath);
    return runClaudeAttempt({ ctx, command, cwd, env, args, prompt, timeoutSec, graceSec });
  };

  const toResult = (
    proc: Awaited<ReturnType<typeof runClaudeAttempt>>,
    parsedStream: ReturnType<typeof parseClaudeStreamJson>,
    parsed: Record<string, unknown> | null,
    clearSessionOnMissingSession = false,
  ): ClaudeBridgeExecutionResult => {
    const loginMeta = detectClaudeLoginRequired({
      parsed,
      stdout: proc.stdout,
      stderr: proc.stderr,
    });
    const errorMeta = loginMeta.loginUrl ? { loginUrl: loginMeta.loginUrl } : undefined;

    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode ?? 1,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        errorMeta,
        clearSession: clearSessionOnMissingSession,
      };
    }

    if (!parsed) {
      const fallbackErrorMessage =
        (proc.exitCode ?? 0) === 0
          ? "Failed to parse claude JSON output"
          : `Claude exited with code ${proc.exitCode ?? -1}`;
      const transientUpstream =
        !loginMeta.requiresLogin &&
        (proc.exitCode ?? 0) !== 0 &&
        isClaudeTransientUpstreamError({ parsed: null, stdout: proc.stdout, stderr: proc.stderr, errorMessage: fallbackErrorMessage });
      return {
        exitCode: proc.exitCode ?? 1,
        signal: proc.signal,
        timedOut: false,
        errorMessage: fallbackErrorMessage,
        errorCode: loginMeta.requiresLogin ? "claude_auth_required" : transientUpstream ? "claude_transient_upstream" : null,
        errorFamily: transientUpstream ? "transient_upstream" : null,
        errorMeta,
        resultJson: { stdout: proc.stdout, stderr: proc.stderr },
        clearSession: clearSessionOnMissingSession,
      };
    }

    const usage = buildResultUsage(parsedStream, parsed);
    const resolvedSessionId = parsedStream.sessionId ?? (asString(parsed.session_id, savedSessionId ?? "") || savedSessionId || null);
    const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);
    const failed = (proc.exitCode ?? 0) !== 0 || parsedIsError(parsed);
    const errorMessage = failed ? describeClaudeFailure(parsed) ?? `Claude exited with code ${proc.exitCode ?? -1}` : null;
    const transientUpstream =
      failed &&
      !loginMeta.requiresLogin &&
      !clearSessionForMaxTurns &&
      isClaudeTransientUpstreamError({ parsed, stdout: proc.stdout, stderr: proc.stderr, errorMessage });

    return {
      exitCode: proc.exitCode ?? 0,
      signal: proc.signal,
      timedOut: false,
      errorMessage,
      errorCode: loginMeta.requiresLogin ? "claude_auth_required" : clearSessionForMaxTurns ? "max_turns_exhausted" : transientUpstream ? "claude_transient_upstream" : null,
      errorFamily: transientUpstream ? "transient_upstream" : null,
      errorMeta,
      usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionId ? { sessionId: resolvedSessionId, cwd } : null,
      sessionDisplayId: resolvedSessionId,
      provider: "anthropic",
      biller: isBedrockAuth(mergedEnv) ? "aws_bedrock" : "anthropic",
      model: parsedStream.model || asString(parsed.model, model),
      billingType,
      costUsd: parsedStream.costUsd,
      resultJson: parsed,
      summary: parsedStream.summary || asString(parsed.result, ""),
      clearSession: clearSessionForMaxTurns || Boolean(clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  try {
    const initialProc = await attempt(savedSessionId || null);
    const initialParsedStream = parseClaudeStreamJson(initialProc.stdout);
    const initialParsed = initialParsedStream.resultJson;
    if (
      savedSessionId &&
      !initialProc.timedOut &&
      (initialProc.exitCode ?? 0) !== 0 &&
      initialParsed &&
      isClaudeUnknownSessionError(initialParsed)
    ) {
      await ctx.onLog("stdout", `[paperclip] Claude resume session "${savedSessionId}" is unavailable; retrying with a fresh session.\n`);
      const retryProc = await attempt(null);
      const retryParsedStream = parseClaudeStreamJson(retryProc.stdout);
      return toResult(retryProc, retryParsedStream, retryParsedStream.resultJson, true);
    }
    return toResult(initialProc, initialParsedStream, initialParsed);
  } finally {
    if (tempInstructionsPath) {
      await fs.rm(tempInstructionsPath, { force: true }).catch(() => {});
    }
  }
}
