import {
  inferOpenAiCompatibleBiller,
  type AdapterExecutionContext,
  type AdapterExecutionResult,
  type AdapterInvocationMeta,
} from "@paperclipai/adapter-utils";
import {
  readAdapterExecutionTarget,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asNumber,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  joinPromptSections,
  redactCommandTextForLogs,
} from "@paperclipai/adapter-utils/server-utils";
import { SANDBOX_INSTALL_COMMAND, type } from "../index.js";
import {
  prepareQwenRuntimeConfig,
  QwenAdapterConfigError,
  resolveQwenConfig,
} from "./runtime-config.js";
import {
  aggregateUsage,
  collectText,
  findError,
  findSessionId,
  parseQwenStreamBuffer,
  type QwenStreamEvent,
} from "./parse.js";

const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_GRACE_SEC = 10;
const QWEN_COMMAND = "qwen";

// Minimal one-shot execute. Phase 2 v0.1 deliberately omits session resume,
// skill symlink sync, and the paperclip-bridge — those become Phase 2.5
// follow-ups once the happy path proves out against a real DGX vLLM.
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const startedAt = new Date().toISOString();

  let prepared;
  try {
    resolveQwenConfig(ctx.config); // fail-fast validation, throws on missing fields
    prepared = await prepareQwenRuntimeConfig({
      env: { ...process.env, ...buildPaperclipEnv(ctx.agent) } as Record<string, string>,
      config: ctx.config,
    });
  } catch (err) {
    if (err instanceof QwenAdapterConfigError) {
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: err.message,
        errorCode: "qwen_config_error",
      };
    }
    throw err;
  }

  const target = readAdapterExecutionTarget({ executionTarget: ctx.executionTarget });
  const prompt = readPrompt(ctx);
  const config = ctx.config;
  const args = buildArgs({ config, prompt });
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const graceSec = asNumber(config.graceSec, DEFAULT_GRACE_SEC);

  // Stream stdout into the parser as chunks arrive so cancellation, error
  // surfacing, and live UI logs stay responsive.
  let buffer = "";
  const events: QwenStreamEvent[] = [];

  const meta: AdapterInvocationMeta = {
    adapterType: type,
    command: QWEN_COMMAND,
    cwd: typeof config.cwd === "string" ? config.cwd : undefined,
    commandArgs: args,
    commandNotes: [...prepared.notes, `Install hint: ${SANDBOX_INSTALL_COMMAND}`],
    env: buildInvocationEnvForLogs(prepared.env, { includeRuntimeKeys: ["OPENAI_API_KEY"] }),
    prompt,
    promptMetrics: { promptChars: prompt.length },
  };
  if (ctx.onMeta) await ctx.onMeta(meta);

  try {
    const result = await runAdapterExecutionTargetProcess(ctx.runId, target, QWEN_COMMAND, args, {
      cwd: typeof config.cwd === "string" ? config.cwd : process.cwd(),
      env: prepared.env,
      timeoutSec,
      graceSec,
      onLog: async (stream, chunk) => {
        if (stream === "stdout") {
          buffer += chunk;
          const { events: parsed, remainder } = parseQwenStreamBuffer(buffer);
          buffer = remainder;
          events.push(...parsed);
        }
        await ctx.onLog(stream, chunk);
      },
      onSpawn: ctx.onSpawn,
    });

    // Drain any final non-newline-terminated event.
    if (buffer.length > 0) {
      const { events: tail } = parseQwenStreamBuffer(`${buffer}\n`);
      events.push(...tail);
    }

    const usage = aggregateUsage(events);
    const sessionId = findSessionId(events);
    const errorMessage = findError(events);
    const summary = collectText(events).slice(0, 4000) || null;

    const resolved = resolveQwenConfig(ctx.config);
    const biller = inferOpenAiCompatibleBiller(prepared.env, "vllm") ?? "vllm";

    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      errorMessage: errorMessage ?? (result.exitCode === 0 ? null : firstErrorLine(result.stderr)),
      usage: usage ?? undefined,
      sessionId,
      sessionParams: sessionId ? { sessionId, cwd: meta.cwd ?? null } : null,
      sessionDisplayId: sessionId,
      provider: "vllm",
      biller,
      model: resolved.model,
      billingType: "metered_api",
      costUsd: 0,
      summary,
    };
  } finally {
    await prepared.cleanup();
  }
}

function readPrompt(ctx: AdapterExecutionContext): string {
  const config = ctx.config;
  const sections: string[] = [];
  if (typeof config.systemPrompt === "string" && config.systemPrompt.trim()) {
    sections.push(config.systemPrompt.trim());
  }
  if (typeof ctx.context.prompt === "string" && ctx.context.prompt.trim()) {
    sections.push(ctx.context.prompt.trim());
  }
  if (typeof config.prompt === "string" && config.prompt.trim()) {
    sections.push(config.prompt.trim());
  }
  return joinPromptSections(sections);
}

function buildArgs(input: { config: Record<string, unknown>; prompt: string }): string[] {
  const { config, prompt } = input;
  const args: string[] = [];
  // Positional prompt (qwen 0.15.x default). `-p/--prompt` is deprecated.
  args.push(prompt);
  args.push("-o", "stream-json");
  args.push("--auth-type", "openai");
  args.push("--include-partial-messages");
  args.push("--bare");
  args.push("--channel", "SDK");
  // YOLO mode for unattended paperclip runs (override via approvalMode if set).
  const approvalMode = typeof config.approvalMode === "string" ? config.approvalMode : "yolo";
  if (approvalMode === "yolo") {
    args.push("-y");
  } else {
    args.push("--approval-mode", approvalMode);
  }
  // Model override. qwen also reads OPENAI_MODEL but explicit -m wins.
  if (typeof config.model === "string" && config.model.trim()) {
    args.push("-m", config.model.trim());
  }
  for (const extra of asStringArray(config.extraArgs)) {
    args.push(extra);
  }
  return args;
}

function firstErrorLine(stderr: string): string | null {
  const trimmed = redactCommandTextForLogs(stderr).trim();
  if (!trimmed) return null;
  return trimmed.split("\n").find((line) => line.trim().length > 0) ?? null;
}
