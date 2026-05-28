import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  asString,
  asBoolean,
  asNumber,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  resolveCommandForLogs,
  renderTemplate,
  renderPaperclipWakePrompt,
  joinPromptSections,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";

const DEFAULT_TIMEOUT_SEC = 300;
const DEFAULT_GRACE_SEC = 20;

// ---------------------------------------------------------------------------
// Kimi stream-json message types
// ---------------------------------------------------------------------------

type KimiMessage =
  | {
      role: "assistant";
      content: string;
      tool_calls?: Array<{
        type: "function";
        id: string;
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string }
  | { role: "user"; content: string }
  | { role: "system"; content: string };

interface ParsedKimiOutput {
  messages: KimiMessage[];
  finalText: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  };
  model?: string;
  provider?: string;
}

function parseKimiStreamJson(stdout: string): ParsedKimiOutput {
  const messages: KimiMessage[] = [];
  let finalText = "";
  let model: string | undefined;
  let provider: string | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed) as KimiMessage & {
        model?: string;
        provider?: string;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
      };
      if (msg.role && typeof msg.role === "string") {
        messages.push(msg as KimiMessage);
        if (msg.role === "assistant" && typeof msg.content === "string") {
          finalText = msg.content;
        }
      }
      if (msg.model && typeof msg.model === "string") {
        model = msg.model;
      }
      if (msg.provider && typeof msg.provider === "string") {
        provider = msg.provider;
      }
    } catch {
      // Ignore non-JSON lines
    }
  }

  // If no structured messages were parsed, treat the whole stdout as text
  if (messages.length === 0 && stdout.trim().length > 0) {
    finalText = stdout.trim();
  }

  return { messages, finalText, model, provider };
}

// ---------------------------------------------------------------------------
// Build runtime config
// ---------------------------------------------------------------------------

interface KimiRuntimeConfig {
  command: string;
  resolvedCommand: string;
  cwd: string;
  env: Record<string, string>;
  loggedEnv: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}

async function buildKimiRuntimeConfig(
  ctx: AdapterExecutionContext,
): Promise<KimiRuntimeConfig> {
  const { runId, agent, config, context, authToken } = ctx;

  const command = asString(config.command, "kimi");
  const configuredCwd = asString(config.cwd, "");
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const effectiveCwd = workspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(effectiveCwd, { createIfMissing: true });

  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.KIMI_API_KEY === "string" && envConfig.KIMI_API_KEY.trim().length > 0;

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (!hasExplicitApiKey && authToken) {
    env.KIMI_API_KEY = authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, effectiveCwd, runtimeEnv);
  const resolvedCommand = await resolveCommandForLogs(command, effectiveCwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const graceSec = asNumber(config.graceSec, DEFAULT_GRACE_SEC);

  return {
    command,
    resolvedCommand,
    cwd: effectiveCwd,
    env,
    loggedEnv,
    timeoutSec,
    graceSec,
  };
}

// ---------------------------------------------------------------------------
// Main execute function
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, onSpawn } = ctx;

  const runtimeConfig = await buildKimiRuntimeConfig(ctx);
  const { command, resolvedCommand, cwd, env, loggedEnv, timeoutSec, graceSec } = runtimeConfig;

  // Agent preset selection — this is the "what powers the agent" field
  const agentPreset = asString(config.agentPreset, "default");
  const customAgentFile = asString(config.customAgentFile, "").trim();
  const model = asString(config.model, "").trim();
  const thinking = asBoolean(config.thinking, false);
  const noThinking = asBoolean(config.noThinking, false);

  if (agentPreset === "custom" && !customAgentFile) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage:
        "kimi_local: agentPreset is 'custom' but customAgentFile is empty. Provide an absolute path to a Kimi agent YAML file.",
    };
  }

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };

  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake);
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

  const prompt = joinPromptSections([wakePrompt, sessionHandoffNote, renderedPrompt]);

  // Build Kimi CLI arguments
  const args = [
    "--print",
    "--input-format",
    "text",
    "--output-format",
    "stream-json",
    "--verbose",
    "--work-dir",
    cwd,
  ];

  // Agent selection: the core "what powers the agent" configuration
  if (agentPreset === "custom" && customAgentFile) {
    args.push("--agent-file", customAgentFile);
  } else if (agentPreset === "okabe") {
    args.push("--agent", "okabe");
  } else {
    args.push("--agent", "default");
  }

  if (model) {
    args.push("--model", model);
  }

  if (thinking) {
    args.push("--thinking");
  } else if (noThinking) {
    args.push("--no-thinking");
  }

  const extraArgs = asString(config.extraArgs, "").trim();
  if (extraArgs) {
    args.push(...extraArgs.split(/\s+/).filter(Boolean));
  }

  if (onMeta) {
    await onMeta({
      adapterType: "kimi_local",
      command: resolvedCommand,
      cwd,
      commandArgs: args,
      env: loggedEnv,
      prompt,
      context,
    });
  }

  await onLog("stdout", `[kimi] Starting Kimi Code CLI with ${agentPreset} agent preset\n`);

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    stdin: prompt,
    timeoutSec,
    graceSec,
    onSpawn,
    onLog,
  });

  const parsed = parseKimiStreamJson(proc.stdout);

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      errorCode: "timeout",
      summary: parsed.finalText || undefined,
    };
  }

  // Extract the first meaningful stderr line for error reporting
  const stderrLine =
    proc.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";

  const hasErrors = (proc.exitCode ?? 0) !== 0;

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage: hasErrors
      ? (stderrLine
        ? `Kimi exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
        : `Kimi exited with code ${proc.exitCode ?? -1}`)
      : null,
    summary: parsed.finalText || "(no output from Kimi)",
    provider: parsed.provider || "kimi",
    model: parsed.model || model || "default",
    usage: parsed.usage,
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
  };
}
