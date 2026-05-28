import OpenAI from "openai";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  TranscriptEntry,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  renderTemplate,
  asString,
  buildPaperclipEnv,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_OPENROUTER_LOCAL_BASE_URL,
  DEFAULT_OPENROUTER_LOCAL_MAX_ITERATIONS,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_OPENROUTER_LIGHT_MODEL,
  DEFAULT_OPENROUTER_LOCAL_RUN_COMMAND_TIMEOUT_SEC,
  instructionsPathKey,
  type as ADAPTER_TYPE,
} from "../index.js";
import {
  loadInstructionFragments,
  joinInstructionFragments,
  type InstructionFragment,
} from "./instructions.js";
import {
  DEFAULT_TOOLS,
  buildToolMap,
  dispatchToolCall,
  serializeForModel,
  pruneEmpty,
  toOpenAiTools,
  type ToolContext,
  type ToolHandler,
} from "./tools.js";
import { PaperclipApi, PaperclipApiError } from "./paperclip-api.js";
import { buildPaperclipTools } from "./paperclip-tools.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

export interface ExecuteOptions {
  /** Override the OpenAI SDK constructor — used for tests. */
  openAiFactory?: (init: { apiKey: string; baseURL: string; defaultHeaders?: Record<string, string> }) => Pick<OpenAI, "chat">;
  /** Override the tool registry — used for tests. */
  tools?: ToolHandler[];
  /** Override the post-loop generation fetch delay in ms (default 800). Set to 0 in tests. */
  generationFetchDelayMs?: number;
}

interface RunState {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  provider: string | null;
  model: string;
  finalAssistantText: string;
  generationIds: string[];
  costUsd: number;
}

const DEFAULT_OPENROUTER_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://github.com/paperclipai/paperclip",
  "X-Title": "Paperclip (openrouter-agent adapter)",
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

async function fetchGenerationCost(
  id: string,
  apiKey: string,
): Promise<{ costUsd: number; providerName: string | null }> {
  try {
    const url = `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!res.ok) return { costUsd: 0, providerName: null };
    const json = await res.json() as { data?: { total_cost?: number; provider_name?: string } };
    return {
      costUsd: json.data?.total_cost ?? 0,
      providerName: json.data?.provider_name ?? null,
    };
  } catch {
    return { costUsd: 0, providerName: null };
  }
}

function resolveCurrentIssueId(context: Record<string, unknown>): string | null {
  const wake = context.paperclipWake as { issue?: { id?: string } } | null | undefined;
  if (wake?.issue?.id) return wake.issue.id;
  if (typeof context.taskId === "string" && context.taskId.trim().length > 0) return context.taskId;
  return null;
}

export async function execute(
  ctx: AdapterExecutionContext,
  options: ExecuteOptions = {},
): Promise<AdapterExecutionResult> {
  const { config, agent, context, onLog } = ctx;

  const baseUrl = asString(config.baseUrl, DEFAULT_OPENROUTER_LOCAL_BASE_URL);
  const isLightRun = config.isLightRun === true;
  const model = asString(
    config.model,
    isLightRun
      ? process.env.OPENROUTER_LIGHT_MODEL?.trim() ||
          process.env.OPENROUTER_MODEL?.trim() ||
          DEFAULT_OPENROUTER_LIGHT_MODEL
      : process.env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL,
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

  const skillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = new Set(resolvePaperclipDesiredSkillNames(config, skillEntries));
  const skillFragments: InstructionFragment[] = [];
  for (const entry of skillEntries.filter((e) => desiredSkillNames.has(e.key))) {
    try {
      const content = await fs.readFile(path.join(entry.source, "SKILL.md"), "utf-8");
      if (content.trim()) skillFragments.push({ source: entry.source, contents: content });
    } catch {
      // SKILL.md unreadable — skip silently
    }
  }

  const systemPrompt = joinInstructionFragments([...fragments, ...skillFragments]);

  const disabledTools = resolveDisabledTools(config.disabledTools);

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
  const autoApprove = config.autoApprove === true;
  const apiClient = ctx.authToken ? new PaperclipApi({ authToken: ctx.authToken }) : null;
  const currentIssueId = resolveCurrentIssueId(context);
  if (currentIssueId) paperclipEnv.PAPERCLIP_TASK_ID = currentIssueId;

  if (currentIssueId && apiClient) {
    try {
      await apiClient.checkoutIssue(currentIssueId, agent.id, ["in_progress", "todo", "backlog", "blocked"]);
    } catch (err) {
      if (err instanceof PaperclipApiError && err.status === 409) {
        await onLog("stdout", `[paperclip] Issue ${currentIssueId} is locked by another run. Aborting.\n`);
        return { exitCode: 1, signal: null, timedOut: false, errorMessage: "Issue run ownership conflict", errorCode: "issue_locked" };
      }
      await onLog("stderr", `[paperclip] Issue checkout warning: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  const toolCtx: ToolContext = {
    cwd,
    runCommandTimeoutSec,
    env: paperclipEnv,
    signal: controller?.signal,
    paperclipApi: apiClient ?? undefined,
    agentId: agent.id,
    companyId: agent.companyId,
    currentIssueId,
    autoApprove,
  };

  const paperclipTools = buildPaperclipTools(toolCtx);
  const tools = [...(options.tools ?? DEFAULT_TOOLS), ...paperclipTools].filter(
    (t) => !disabledTools.has(t.name),
  );
  const toolMap = buildToolMap(tools);

  const state: RunState = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    provider: null,
    model,
    finalAssistantText: "",
    generationIds: [],
    costUsd: 0,
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
      if (completion.id) state.generationIds.push(completion.id);

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
        const prunedContent = typeof outcome.content === "object" && outcome.content !== null
          ? pruneEmpty(outcome.content)
          : outcome.content;
        await onLog("stdout", `${JSON.stringify({
          kind: "tool_result",
          ts: new Date().toISOString(),
          toolUseId: call.id,
          toolName: call.function.name,
          content: prunedContent,
          isError: outcome.isError,
        })}\n`);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: serializeForModel(outcome.content),
        });
      }
    }

    if (isOpenRouter(baseUrl) && state.generationIds.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.generationFetchDelayMs ?? 800));
      const genResults = await Promise.all(
        state.generationIds.map((id) => fetchGenerationCost(id, apiKey)),
      );
      state.costUsd = genResults.reduce((sum, r) => sum + r.costUsd, 0);
      const lastProvider = genResults.at(-1)?.providerName ?? null;
      if (lastProvider) state.provider = lastProvider;
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
      costUsd: state.costUsd,
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
      costUsd: state.costUsd,
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
        usage: {
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
          ...(state.cachedInputTokens > 0 ? { cachedInputTokens: state.cachedInputTokens } : {}),
        },
        costUsd: state.costUsd,
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
      costUsd: state.costUsd,
      errorMessage: message,
      errorCode: "openrouter_agent_call_failed",
    };
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  }
}
