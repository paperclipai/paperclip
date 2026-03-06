import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  renderTemplate,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { AUTH_ENV_VARS } from "../index.js";
import { parseCopilotOutput, isCopilotSessionNotFoundError } from "./parse.js";

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveAuthToken(env: Record<string, string>): { token: string; source: string } | null {
  for (const key of AUTH_ENV_VARS) {
    if (hasNonEmptyEnvValue(env, key)) return { token: env[key], source: key };
  }
  return null;
}

function buildArgs(prompt: string, sessionId: string | null, extraArgs: string[]): string[] {
  const args: string[] = ["-p", prompt];
  if (sessionId) args.push("--resume", sessionId);
  args.push("--yolo");
  if (extraArgs.length > 0) args.push(...extraArgs);
  return args;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const configuredCwd = asString(config.cwd, "");
  const cwd = configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  const auth = resolveAuthToken(env as Record<string, string>);
  if (!auth) {
    const hostAuth = resolveAuthToken(process.env as Record<string, string>);
    if (hostAuth) {
      env.COPILOT_GITHUB_TOKEN = hostAuth.token;
    } else {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage:
          "No GitHub auth token found. Set COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN in adapter environment, or run `gh auth login`.",
        errorCode: "copilot_auth_required",
      };
    }
  }

  const command = "copilot";
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
  } catch {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage:
        "GitHub Copilot CLI not found in PATH. Install: npm install -g @github/copilot, brew install copilot-cli, or curl -fsSL https://gh.io/copilot-install | bash",
      errorCode: "copilot_not_found",
    };
  }

  const timeoutSec = asNumber(config.timeoutSec, 120);
  const graceSec = asNumber(config.graceSec, 10);
  const extraArgs = asStringArray(config.extraArgs);

  // Copilot CLI --resume is cwd-agnostic (session state is server-side, not directory-bound),
  // so we intentionally skip cwd validation on resume unlike some other adapters.
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const sessionId = runtimeSessionId || null;

  const prompt = renderTemplate(promptTemplate, {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  });

  const fullArgs = buildArgs(prompt, sessionId, extraArgs);

  if (onMeta) {
    await onMeta({
      adapterType: "copilot_local",
      command,
      cwd,
      commandArgs: fullArgs,
      env: redactEnvForLogs(env),
      prompt,
      context,
    });
  }

  let proc = await runChildProcess(runId, command, fullArgs, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog,
  });

  const isRetry = !proc.timedOut && (proc.exitCode ?? 0) !== 0 && sessionId !== null && isCopilotSessionNotFoundError(proc.stderr);
  if (isRetry) {
    await onLog("stderr", `[paperclip] Copilot session "${sessionId}" not found — retrying with fresh session.\n`);
    const retryArgs = buildArgs(prompt, null, extraArgs);
    proc = await runChildProcess(`${runId}-retry`, command, retryArgs, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onLog,
    });
  }

  const parsed = parseCopilotOutput(proc.stdout, proc.stderr);
  const resolvedSessionId = isRetry
    ? (parsed.sessionId ?? null)
    : (parsed.sessionId ?? sessionId);

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      errorCode: "timeout",
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionId ? { sessionId: resolvedSessionId, cwd } : null,
      sessionDisplayId: resolvedSessionId,
    };
  }

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage:
      (proc.exitCode ?? 0) === 0
        ? null
        : `Copilot exited with code ${proc.exitCode ?? -1}`,
    sessionId: resolvedSessionId,
    sessionParams: resolvedSessionId ? { sessionId: resolvedSessionId, cwd } : null,
    sessionDisplayId: resolvedSessionId,
    provider: "github",
    billingType: "subscription",
    summary: parsed.summary,
    clearSession: isRetry && !resolvedSessionId,
  };
}
