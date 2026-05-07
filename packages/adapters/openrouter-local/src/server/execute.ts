import OpenAI from "openai";
import path from "node:path";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  TranscriptEntry,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import { renderTemplate, asString, buildPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_OPENROUTER_LOCAL_BASE_URL,
  DEFAULT_OPENROUTER_LOCAL_MAX_ITERATIONS,
  DEFAULT_OPENROUTER_LOCAL_MODEL,
  DEFAULT_OPENROUTER_LOCAL_RUN_COMMAND_TIMEOUT_SEC,
  instructionsPathKey,
  type as ADAPTER_TYPE,
} from "../index.js";
import {
  loadInstructionFragments,
  joinInstructionFragments,
} from "./instructions.js";
import {
  DEFAULT_TOOLS,
  buildToolMap,
  dispatchToolCall,
  toOpenAiTools,
  type ToolContext,
  type ToolHandler,
} from "./tools.js";

export interface ExecuteOptions {
  /** Override the OpenAI SDK constructor — used for tests. */
  openAiFactory?: (init: { apiKey: string; baseURL: string; defaultHeaders?: Record<string, string> }) => Pick<OpenAI, "chat">;
  /** Override the tool registry — used for tests. */
  tools?: ToolHandler[];
}

interface RunState {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  provider: string | null;
  model: string;
  finalAssistantText: string;
}

const DEFAULT_OPENROUTER_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://github.com/paperclipai/paperclip",
  "X-Title": "Paperclip (openrouter-local adapter)",
};

function isOpenRouter(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname.endsWith("openrouter.ai");
  } catch {
    return false;
  }
}

function resolveCwd(configCwd: unknown, ctx: AdapterExecutionContext): string {
  if (typeof configCwd === "string" && configCwd.trim().length > 0) return configCwd;
  // Workspace-backed agents: executionTarget carries the resolved cwd
  const targetCwd = (ctx.executionTarget as { cwd?: string } | null | undefined)?.cwd;
  if (targetCwd && targetCwd.trim().length > 0) return targetCwd;
  // Context snapshot carries the workspace cwd from paperclipWorkspace
  const workspaceCwd = (ctx.context.paperclipWorkspace as { cwd?: string } | null | undefined)?.cwd;
  if (workspaceCwd && workspaceCwd.trim().length > 0) return workspaceCwd;
  // Derive agent data directory from PAPERCLIP_HOME (set in Docker; avoids per-agent manual config)
  const home = process.env.PAPERCLIP_HOME;
  if (home) {
    return path.join(home, "instances", "default", "companies", ctx.agent.companyId, "agents", ctx.agent.id);
  }
  return process.cwd();
}

function resolveExtraHeaders(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length === 0 ? null : out;
}

function resolveDisabledTools(value: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(value)) return out;
  for (const v of value) if (typeof v === "string") out.add(v);
  return out;
}

function asInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  return fallback;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

function extractReasoningText(message: unknown): string | null {
  const msg = message as Record<string, unknown>;
  const details = msg.reasoning_details;
  if (Array.isArray(details) && details.length > 0) {
    const readable = details
      .filter((d): d is Record<string, unknown> =>
        typeof d === "object" && d !== null &&
        (d.type === "reasoning.text" || d.type === "reasoning.summary")
      )
      .map((d) => String(d.text ?? d.content ?? ""))
      .filter(Boolean);
    if (readable.length > 0) return readable.join("\n\n");
  }
  const reasoning = msg.reasoning;
  if (typeof reasoning === "string" && reasoning.trim().length > 0) {
    return reasoning;
  }
  return null;
}

function resolveReasoningParam(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (value === true) return { enabled: true };
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export async function execute(
  ctx: AdapterExecutionContext,
  options: ExecuteOptions = {},
): Promise<AdapterExecutionResult> {
  const { config, agent, context, onLog } = ctx;

  const baseUrl = asString(config.baseUrl, DEFAULT_OPENROUTER_LOCAL_BASE_URL);
  const model = asString(
    config.model,
    process.env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_LOCAL_MODEL,
  );
  const maxIterations = asInt(config.maxIterations, DEFAULT_OPENROUTER_LOCAL_MAX_ITERATIONS);
  const runCommandTimeoutSec = asInt(
    config.maxRunCommandTimeoutSec,
    DEFAULT_OPENROUTER_LOCAL_RUN_COMMAND_TIMEOUT_SEC,
  );
  const cwd = resolveCwd(config.cwd, ctx);
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  const paperclipEnv: Record<string, string> = buildPaperclipEnv(agent);
  if (ctx.authToken) paperclipEnv.PAPERCLIP_API_KEY = ctx.authToken;

  const emit = async (entry: TranscriptEntry) => {
    await onLog("stdout", `${JSON.stringify(entry)}\n`);
  };

  if (!apiKey) {
    await onLog(
      "stderr",
      `${ADAPTER_TYPE}: missing OPENROUTER_API_KEY (or OPENAI_API_KEY)\n`,
    );
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Missing OPENROUTER_API_KEY (or OPENAI_API_KEY)",
      errorCode: "missing_api_key",
    };
  }

  const promptTemplate = asString(
    config.promptTemplate,
    "Continue your work on issue {{taskTitle}}.",
  );
  const issueTitle =
    (context.paperclipWake as { issue?: { title?: string } } | null | undefined)?.issue?.title ??
    "";
  const promptIntro = renderTemplate(promptTemplate, {
    agentId: agent.id,
    agentName: agent.name,
    companyId: agent.companyId,
    runId: ctx.runId,
    taskId: String(context.taskId ?? ""),
    taskTitle: issueTitle,
  });
  const taskMarkdown = typeof context.paperclipTaskMarkdown === "string" ? context.paperclipTaskMarkdown : null;
  const prompt = taskMarkdown ? `${promptIntro}\n\n${taskMarkdown}` : promptIntro;

  const instructionsFilePath = asString(config[instructionsPathKey], "");
  const fragments = await loadInstructionFragments({
    cwd,
    instructionsFilePath: instructionsFilePath || null,
  });
  const systemPrompt = joinInstructionFragments(fragments);

  const disabledTools = resolveDisabledTools(config.disabledTools);
  const tools = (options.tools ?? DEFAULT_TOOLS).filter(
    (t) => !disabledTools.has(t.name),
  );
  const toolMap = buildToolMap(tools);

  const extraHeaders = resolveExtraHeaders(config.extraHeaders);
  const headers: Record<string, string> = {
    ...(isOpenRouter(baseUrl) ? DEFAULT_OPENROUTER_HEADERS : {}),
    ...(extraHeaders ?? {}),
  };

  const factory = options.openAiFactory ?? ((init) => new OpenAI(init));
  const client = factory({
    apiKey,
    baseURL: baseUrl,
    ...(Object.keys(headers).length > 0 ? { defaultHeaders: headers } : {}),
  });

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  const timeoutSec = asInt(config.timeoutSec, 0);
  const controller = timeoutSec > 0 ? new AbortController() : null;
  const timeoutHandle = controller
    ? setTimeout(() => controller.abort(), timeoutSec * 1000)
    : null;

  const reasoningParam = resolveReasoningParam(config.reasoning);
  const toolCtx: ToolContext = { cwd, runCommandTimeoutSec, env: paperclipEnv, signal: controller?.signal };
  const state: RunState = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    provider: null,
    model,
    finalAssistantText: "",
  };

  await emit({
    kind: "init",
    ts: new Date().toISOString(),
    model,
    sessionId: ctx.runId,
  });
  if (systemPrompt) {
    await emit({
      kind: "system",
      ts: new Date().toISOString(),
      text: `loaded ${fragments.length} instruction fragment(s)`,
    });
  }

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const completion = await client.chat.completions.create({
        model,
        messages,
        tools: tools.length > 0 ? toOpenAiTools(tools) : undefined,
        tool_choice: tools.length > 0 ? "auto" : undefined,
        ...(controller ? { signal: controller.signal } : {}),
        ...(reasoningParam ? { reasoning: reasoningParam } : {}),
      });

      const usage = (completion as unknown as { usage?: OpenAI.Completions.CompletionUsage })
        .usage;
      if (usage) {
        state.inputTokens += usage.prompt_tokens ?? 0;
        state.outputTokens += usage.completion_tokens ?? 0;
        const cached =
          (usage as unknown as { prompt_tokens_details?: { cached_tokens?: number } })
            .prompt_tokens_details?.cached_tokens ?? 0;
        state.cachedInputTokens += cached;
      }
      const provider = (completion as unknown as { provider?: string }).provider;
      if (provider && !state.provider) state.provider = provider;

      const choice = completion.choices?.[0];
      if (!choice) {
        throw new Error("model returned no choices");
      }
      const message = choice.message;
      if (!message) {
        throw new Error("model returned no message");
      }

      messages.push(message);

      const reasoningText = extractReasoningText(message);
      if (reasoningText) {
        await emit({
          kind: "thinking",
          ts: new Date().toISOString(),
          text: reasoningText,
        });
      }

      if (message.content) {
        await emit({
          kind: "assistant",
          ts: new Date().toISOString(),
          text: message.content,
        });
        state.finalAssistantText = message.content;
      }

      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        // Final assistant turn — no further tools requested.
        break;
      }

      for (const call of toolCalls) {
        if (call.type !== "function") continue;
        let parsedInput: unknown;
        try {
          parsedInput = JSON.parse(call.function.arguments || "{}");
        } catch {
          parsedInput = call.function.arguments;
        }
        await emit({
          kind: "tool_call",
          ts: new Date().toISOString(),
          name: call.function.name,
          input: parsedInput,
          toolUseId: call.id,
        });
        const outcome = await dispatchToolCall(call, toolMap, toolCtx);
        await emit({
          kind: "tool_result",
          ts: new Date().toISOString(),
          toolUseId: call.id,
          toolName: call.function.name,
          content: outcome.content,
          isError: outcome.isError,
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: outcome.content,
        });
      }
    }

    const usageSummary: UsageSummary = {
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      ...(state.cachedInputTokens > 0
        ? { cachedInputTokens: state.cachedInputTokens }
        : {}),
    };

    await emit({
      kind: "result",
      ts: new Date().toISOString(),
      text: state.finalAssistantText,
      inputTokens: usageSummary.inputTokens,
      outputTokens: usageSummary.outputTokens,
      cachedTokens: state.cachedInputTokens,
      costUsd: 0,
      subtype: "ok",
      isError: false,
      errors: [],
    });

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      model: state.model,
      provider: state.provider,
      usage: usageSummary,
      summary: state.finalAssistantText || null,
    };
  } catch (err) {
    if (isAbortError(err) || controller?.signal.aborted) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: true,
        model: state.model,
        provider: state.provider,
        usage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens },
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `${ADAPTER_TYPE}: ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      model: state.model,
      provider: state.provider,
      usage: {
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        ...(state.cachedInputTokens > 0
          ? { cachedInputTokens: state.cachedInputTokens }
          : {}),
      },
      errorMessage: message,
      errorCode: "openrouter_local_call_failed",
    };
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  }
}
