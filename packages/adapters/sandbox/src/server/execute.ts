import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AdapterBillingType,
  AdapterExecutionContext,
  AdapterExecutionResult,
  SandboxProvider,
} from "@paperclipai/adapter-utils";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  parseObject,
  redactEnvForLogs,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
  isClaudeUnknownSessionError,
} from "@paperclipai/adapter-claude-local/server";
import { parseCodexJsonl, isCodexUnknownSessionError } from "@paperclipai/adapter-codex-local/server";
import { parseCursorJsonl, isCursorUnknownSessionError } from "@paperclipai/adapter-cursor-local/server";
import { parseOpenCodeJsonl, isOpenCodeUnknownSessionError } from "@paperclipai/adapter-opencode-local/server";
import { parsePiJsonl, isPiUnknownSessionError } from "@paperclipai/adapter-pi-local/server";
import { wrapSandboxStdoutLine } from "../shared/protocol.js";
import { createSandboxProvider, setSandboxProviderFactoryForTests } from "./provider.js";

export { setSandboxProviderFactoryForTests };

type SandboxAgentType = "claude_local" | "codex_local" | "cursor" | "opencode_local" | "pi_local";

type ParsedRun = {
  sessionId: string | null;
  summary: string | null;
  errorMessage: string | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  };
  costUsd?: number | null;
};

function readSandboxAgentType(config: Record<string, unknown>): SandboxAgentType {
  const value = asString(config.sandboxAgentType, "claude_local").trim() || "claude_local";
  if (
    value !== "claude_local" &&
    value !== "codex_local" &&
    value !== "cursor" &&
    value !== "opencode_local" &&
    value !== "pi_local"
  ) {
    throw new Error(`Unsupported sandbox agent type "${value}"`);
  }
  return value;
}

function normalizeInnerSession(raw: unknown) {
  return parseObject(parseObject(raw).cliSession);
}

function buildRuntimeEnv(input: AdapterExecutionContext, cwd: string): Record<string, string> {
  const { runId, agent, context, authToken, config } = input;
  const env = {
    ...buildPaperclipEnv(agent),
    PAPERCLIP_RUN_ID: runId,
    PAPERCLIP_WORKSPACE_CWD: cwd,
  } as Record<string, string>;

  const taskId =
    asString(context.taskId, "").trim() ||
    asString(context.issueId, "").trim();
  const wakeReason = asString(context.wakeReason, "").trim();
  const wakeCommentId =
    asString(context.wakeCommentId, "").trim() ||
    asString(context.commentId, "").trim();
  const workspace = parseObject(context.paperclipWorkspace);
  const repoUrl = asString(workspace.repoUrl, "").trim();
  const repoRef = asString(workspace.repoRef, "").trim();
  const configEnv = parseObject(config.env);

  if (taskId) env.PAPERCLIP_TASK_ID = taskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (repoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = repoUrl;
  if (repoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = repoRef;

  for (const [key, value] of Object.entries(configEnv)) {
    if (typeof value === "string") env[key] = value;
  }

  if (!env.PAPERCLIP_API_KEY && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  return env;
}

async function readInstructionsPrefix(config: Record<string, unknown>): Promise<{ prefix: string; notes: string[] }> {
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  if (!instructionsFilePath) {
    return { prefix: "", notes: [] };
  }

  try {
    const contents = await fs.readFile(instructionsFilePath, "utf-8");
    const instructionsDir = `${path.dirname(instructionsFilePath)}/`;
    return {
      prefix:
        `${contents.trim()}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve relative references from ${instructionsDir}.\n\n`,
      notes: [`Loaded agent instructions from ${instructionsFilePath}`],
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      prefix: "",
      notes: [`Failed to read instructionsFilePath ${instructionsFilePath}: ${reason}`],
    };
  }
}

function buildPrompt(ctx: AdapterExecutionContext, config: Record<string, unknown>, isFirstRun: boolean, instructionsPrefix: string) {
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const bootstrapPrompt = asString(config.bootstrapPromptTemplate, "").trim();
  const renderedPrompt = renderTemplate(promptTemplate, {
    agentId: ctx.agent.id,
    companyId: ctx.agent.companyId,
    runId: ctx.runId,
    company: { id: ctx.agent.companyId },
    agent: ctx.agent,
    run: { id: ctx.runId, source: "on_demand" },
    context: ctx.context,
  });

  return `${instructionsPrefix}${isFirstRun && bootstrapPrompt ? `${bootstrapPrompt}\n\n` : ""}${renderedPrompt}`;
}

function parseAgentOutput(agentType: SandboxAgentType, stdout: string): ParsedRun {
  if (agentType === "claude_local") {
    const parsed = parseClaudeStreamJson(stdout);
    const claudeSubtype = asString(parsed.resultJson?.subtype, "").trim().toLowerCase();
    return {
      sessionId: asString(parsed.resultJson?.session_id, "").trim() || parsed.sessionId || null,
      summary: parsed.summary ?? null,
      errorMessage:
        parsed.resultJson && claudeSubtype !== "success"
          ? describeClaudeFailure(parsed.resultJson)
          : null,
      usage: parsed.usage ?? undefined,
      costUsd: parsed.costUsd ?? null,
    };
  }
  if (agentType === "codex_local") {
    const parsed = parseCodexJsonl(stdout);
    return {
      sessionId: parsed.sessionId,
      summary: parsed.summary || null,
      errorMessage: parsed.errorMessage,
      usage: parsed.usage,
    };
  }
  if (agentType === "cursor") {
    const parsed = parseCursorJsonl(stdout);
    return {
      sessionId: parsed.sessionId,
      summary: parsed.summary || null,
      errorMessage: parsed.errorMessage,
      usage: parsed.usage,
      costUsd: parsed.costUsd ?? null,
    };
  }
  if (agentType === "opencode_local") {
    const parsed = parseOpenCodeJsonl(stdout);
    return {
      sessionId: parsed.sessionId,
      summary: parsed.summary || null,
      errorMessage: parsed.errorMessage,
      usage: {
        inputTokens: parsed.usage.inputTokens,
        outputTokens: parsed.usage.outputTokens,
        cachedInputTokens: parsed.usage.cachedInputTokens,
      },
      costUsd: parsed.costUsd,
    };
  }
  const parsed = parsePiJsonl(stdout);
  return {
    sessionId: parsed.sessionId,
    summary: parsed.finalMessage || parsed.messages.join("\n\n") || null,
    errorMessage: parsed.errors.length > 0 ? parsed.errors.join("\n") : null,
    usage: parsed.usage,
    costUsd: parsed.usage.costUsd,
  };
}

function isUnknownSession(agentType: SandboxAgentType, stdout: string, stderr: string) {
  if (agentType === "claude_local") {
    const parsed = parseClaudeStreamJson(stdout);
    return parsed.resultJson ? isClaudeUnknownSessionError(parsed.resultJson) : false;
  }
  if (agentType === "codex_local") return isCodexUnknownSessionError(stdout, stderr);
  if (agentType === "cursor") return isCursorUnknownSessionError(stdout, stderr);
  if (agentType === "opencode_local") return isOpenCodeUnknownSessionError(stdout, stderr);
  return isPiUnknownSessionError(stdout, stderr);
}

function defaultCommandFor(agentType: SandboxAgentType): string {
  if (agentType === "codex_local") return "codex";
  if (agentType === "cursor") return "agent";
  if (agentType === "opencode_local") return "opencode";
  if (agentType === "pi_local") return "pi";
  return "claude";
}

function buildCliInvocation(input: {
  agentType: SandboxAgentType;
  config: Record<string, unknown>;
  cwd: string;
  resumeSessionId: string | null;
  prompt: string;
}) {
  const { agentType, config, cwd, resumeSessionId, prompt } = input;
  const command = asString(config.command, defaultCommandFor(agentType)).trim() || defaultCommandFor(agentType);
  const extraArgs = asStringArray(config.extraArgs);
  const model = asString(config.model, "").trim();

  if (agentType === "claude_local") {
    const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (asBoolean(config.dangerouslySkipPermissions, false)) args.push("--dangerously-skip-permissions");
    if (asBoolean(config.chrome, false)) args.push("--chrome");
    if (model) args.push("--model", model);
    const effort = asString(config.effort, "").trim();
    if (effort) args.push("--effort", effort);
    const maxTurns = asNumber(config.maxTurnsPerRun, 0);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    if (extraArgs.length > 0) args.push(...extraArgs);
    return { command, args, stdin: prompt };
  }

  if (agentType === "codex_local") {
    const args = ["exec", "--json"];
    if (asBoolean(config.search, false)) args.unshift("--search");
    if (asBoolean(config.dangerouslyBypassApprovalsAndSandbox, asBoolean(config.dangerouslyBypassSandbox, false))) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    if (model) args.push("--model", model);
    const reasoning = asString(config.modelReasoningEffort, "").trim();
    if (reasoning) args.push("-c", `model_reasoning_effort=${JSON.stringify(reasoning)}`);
    if (extraArgs.length > 0) args.push(...extraArgs);
    if (resumeSessionId) args.push("resume", resumeSessionId, "-");
    else args.push("-");
    return { command, args, stdin: prompt };
  }

  if (agentType === "cursor") {
    const args = ["-p", "--output-format", "stream-json", "--workspace", cwd];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (model) args.push("--model", model);
    const mode = asString(config.mode, "").trim();
    if (mode) args.push("--mode", mode);
    if (asBoolean(config.autoTrust, false)) args.push("--yolo");
    if (extraArgs.length > 0) args.push(...extraArgs);
    return { command, args, stdin: prompt };
  }

  if (agentType === "opencode_local") {
    const args = ["run", "--format", "json"];
    if (resumeSessionId) args.push("--session", resumeSessionId);
    if (model) args.push("--model", model);
    const variant = asString(config.variant, "").trim();
    if (variant) args.push("--variant", variant);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return { command, args, stdin: prompt };
  }

  const sessionFile = resumeSessionId || `${cwd}/.paperclip/pi-session.json`;
  const args = ["--mode", "rpc", "--append-system-prompt", "Operate inside Paperclip.", "--session", sessionFile];
  const provider = asString(config.provider, "").trim();
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  const thinking = asString(config.thinking, "").trim();
  if (thinking) args.push("--thinking", thinking);
  args.push("--tools", "read,bash,edit,write,grep,find,ls");
  if (extraArgs.length > 0) args.push(...extraArgs);
  return {
    command,
    args,
    stdin: `${JSON.stringify({ type: "prompt", message: prompt })}\n`,
  };
}

function billingTypeFor(agentType: SandboxAgentType, env: Record<string, string>): AdapterBillingType {
  if (agentType === "cursor") return "subscription";
  if (agentType === "claude_local") {
    return typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim() ? "api" : "subscription";
  }
  return "api";
}

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function defaultCwdForProvider(config: Record<string, unknown>) {
  return asString(config.providerType, "cloudflare").trim() === "e2b"
    ? "/home/user/workspace"
    : "/workspace";
}

async function syncRepoIfNeeded(
  instance: Awaited<ReturnType<SandboxProvider["create"]>>,
  ctx: AdapterExecutionContext,
  cwd: string,
) {
  const workspace = parseObject(ctx.context.paperclipWorkspace);
  const repoUrl = asString(workspace.repoUrl, "").trim();
  if (!repoUrl) return;

  const repoRef = asString(workspace.repoRef, "main").trim() || "main";
  const cloneCommand =
    "sh -lc " +
    shellEscape(
      `if [ ! -d ${shellEscape(cwd)}/.git ]; then ` +
        `mkdir -p ${shellEscape(path.posix.dirname(cwd))} && git clone --depth 1 --branch ${shellEscape(repoRef)} ${shellEscape(repoUrl)} ${shellEscape(cwd)}; ` +
      `fi`,
    );

  try {
    await instance.exec(cloneCommand, { timeoutSec: 120 });
  } catch (err) {
    await ctx.onLog(
      "stderr",
      `[paperclip] Warning: failed to clone workspace repo into sandbox: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

async function ensureWorkspaceDir(
  instance: Awaited<ReturnType<SandboxProvider["create"]>>,
  cwd: string,
) {
  await instance.exec(`sh -lc ${shellEscape(`mkdir -p ${shellEscape(cwd)}`)}`, {
    timeoutSec: 30,
  });
}

async function runBootstrapCommandIfNeeded(input: {
  ctx: AdapterExecutionContext;
  instance: Awaited<ReturnType<SandboxProvider["create"]>>;
  config: Record<string, unknown>;
  cwd: string;
  env: Record<string, string>;
}) {
  const bootstrapCommand = asString(input.config.bootstrapCommand, "").trim();
  if (!bootstrapCommand) return;

  await input.ctx.onLog("stderr", "[paperclip] Running sandbox bootstrap command.\n");
  const result = await input.instance.exec(bootstrapCommand, {
    cwd: input.cwd,
    env: input.env,
    timeoutSec: asNumber(input.config.timeoutSec, 0) || 120,
    onStdout: async (chunk) => {
      await input.ctx.onLog("stdout", chunk);
    },
    onStderr: async (chunk) => {
      await input.ctx.onLog("stderr", chunk);
    },
  });

  if (result.timedOut) {
    throw new Error("Sandbox bootstrap command timed out");
  }
  if (typeof result.exitCode === "number" && result.exitCode !== 0) {
    throw new Error(`Sandbox bootstrap command failed with exit code ${result.exitCode}`);
  }
}

async function runInnerAgent(input: {
  ctx: AdapterExecutionContext;
  instance: Awaited<ReturnType<SandboxProvider["create"]>>;
  agentType: SandboxAgentType;
  config: Record<string, unknown>;
  cwd: string;
  env: Record<string, string>;
  cliSessionId: string | null;
}) {
  const { ctx, instance, agentType, config, cwd, env, cliSessionId } = input;
  const instructions = await readInstructionsPrefix(config);
  const prompt = buildPrompt(ctx, config, !cliSessionId, instructions.prefix);
  const invocation = buildCliInvocation({
    agentType,
    config,
    cwd,
    resumeSessionId: cliSessionId,
    prompt,
  });

  if (ctx.onMeta) {
    await ctx.onMeta({
      adapterType: "sandbox",
      command: invocation.command,
      cwd,
      commandArgs: invocation.args,
      commandNotes: [
        `Sandbox provider: ${asString(config.providerType, "cloudflare") || "cloudflare"}`,
        `Sandbox runtime: ${agentType}`,
        ...instructions.notes,
      ],
      env: redactEnvForLogs(env),
      prompt,
      context: {
        providerType: asString(config.providerType, "cloudflare") || "cloudflare",
        sandboxAgentType: agentType,
        keepAlive: asBoolean(config.keepAlive, false),
      },
    });
  }

  let rawStdout = "";
  let rawStderr = "";
  let stdoutBuffer = "";

  const result = await instance.exec([invocation.command, ...invocation.args].map(shellEscape).join(" "), {
    cwd,
    env,
    stdin: invocation.stdin,
    timeoutSec: asNumber(config.timeoutSec, 0),
    onStdout: async (chunk) => {
      rawStdout += chunk;
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        await ctx.onLog("stdout", `${wrapSandboxStdoutLine(agentType, line)}\n`);
      }
    },
    onStderr: async (chunk) => {
      rawStderr += chunk;
      await ctx.onLog("stderr", chunk);
    },
  });

  if (stdoutBuffer.trim()) {
    rawStdout += "\n";
    await ctx.onLog("stdout", `${wrapSandboxStdoutLine(agentType, stdoutBuffer.trim())}\n`);
  }

  return {
    execResult: result,
    stdout: rawStdout,
    stderr: rawStderr,
    parsed: parseAgentOutput(agentType, rawStdout),
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = ctx.config;
  const agentType = readSandboxAgentType(config);
  const keepAlive = asBoolean(config.keepAlive, false);
  const provider = createSandboxProvider(config);
  const runtimeSession = parseObject(ctx.runtime.sessionParams);
  const savedSandboxId = asString(runtimeSession.sandboxId, "").trim() || null;
  const cliSession = normalizeInnerSession(runtimeSession);
  const cliSessionId = asString(cliSession.sessionId, "").trim() || null;
  const cwd = asString(config.cwd, defaultCwdForProvider(config)).trim() || defaultCwdForProvider(config);
  const env = buildRuntimeEnv(ctx, cwd);

  let instance = keepAlive && savedSandboxId
    ? await provider.reconnect(savedSandboxId)
    : await provider.create({
        sandboxId: savedSandboxId ?? randomUUID(),
        env,
        image: asString(parseObject(config.providerConfig).image, "").trim() || undefined,
        instanceType: asString(parseObject(config.providerConfig).instanceType, "").trim() || undefined,
        timeoutSec: asNumber(config.timeoutSec, 0),
        metadata: {
          agentId: ctx.agent.id,
          companyId: ctx.agent.companyId,
          runId: ctx.runId,
        },
      });

  await ensureWorkspaceDir(instance, cwd);
  await syncRepoIfNeeded(instance, ctx, cwd);
  await runBootstrapCommandIfNeeded({
    ctx,
    instance,
    config,
    cwd,
    env,
  });

  let attempt = await runInnerAgent({
    ctx,
    instance,
    agentType,
    config,
    cwd,
    env,
    cliSessionId,
  });

  if (cliSessionId && isUnknownSession(agentType, attempt.stdout, attempt.stderr)) {
    await ctx.onLog(
      "stderr",
      `[paperclip] Saved ${agentType} session "${cliSessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    attempt = await runInnerAgent({
      ctx,
      instance,
      agentType,
      config,
      cwd,
      env,
      cliSessionId: null,
    });
  }

  if (!keepAlive) {
    await instance.destroy().catch(() => undefined);
  }

  const nextSessionParams =
    keepAlive
      ? {
          sandboxId: instance.id,
          agentType,
          ...(attempt.parsed.sessionId ? { cliSession: { sessionId: attempt.parsed.sessionId } } : {}),
        }
      : null;

  return {
    exitCode: attempt.execResult.exitCode,
    signal: attempt.execResult.signal,
    timedOut: attempt.execResult.timedOut,
    errorMessage:
      attempt.execResult.timedOut
        ? `Timed out after ${asNumber(config.timeoutSec, 0)}s`
        : attempt.parsed.errorMessage,
    usage: attempt.parsed.usage,
    provider: asString(config.providerType, "cloudflare") || "cloudflare",
    model: asString(config.model, "").trim() || null,
    billingType: billingTypeFor(agentType, env),
    costUsd: attempt.parsed.costUsd ?? null,
    resultJson: {
      sandboxId: instance.id,
      sandboxAgentType: agentType,
    },
    summary: attempt.parsed.summary,
    sessionParams: nextSessionParams,
    sessionDisplayId:
      asString(parseObject(nextSessionParams?.cliSession).sessionId, "").trim() ||
      instance.id,
    clearSession: !keepAlive,
  };
}
