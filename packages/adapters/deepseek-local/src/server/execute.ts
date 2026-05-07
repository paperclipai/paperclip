import fs from "node:fs/promises";
import path from "node:path";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  joinPromptSections,
  parseObject,
  renderPaperclipWakePrompt,
  renderTemplate,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { DEEPSEEK_DEFAULT_BASE_URL, DEEPSEEK_DEFAULT_MODEL } from "../index.js";

const SECRET_REDACTION = "***REDACTED***";

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveDeepseekApiKey(input: {
  config: Record<string, unknown>;
  processEnv?: NodeJS.ProcessEnv;
}): string | null {
  const direct = nonEmpty(input.config.apiKey);
  if (direct) return direct;

  const configEnv = parseObject(input.config.env);
  for (const [key, value] of Object.entries(configEnv)) {
    if (key !== "DEEPSEEK_API_KEY") continue;
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const inner = (value as Record<string, unknown>).value;
      if (typeof inner === "string" && inner.trim().length > 0) return inner.trim();
    }
  }

  const envValue = input.processEnv?.DEEPSEEK_API_KEY;
  if (typeof envValue === "string" && envValue.trim().length > 0) return envValue.trim();

  return null;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveBaseUrl(config: Record<string, unknown>): string {
  const configured = nonEmpty(config.baseUrl) ?? nonEmpty(config.apiBaseUrl);
  return trimTrailingSlash(configured ?? DEEPSEEK_DEFAULT_BASE_URL);
}

function resolveModel(config: Record<string, unknown>): string {
  return nonEmpty(config.model) ?? DEEPSEEK_DEFAULT_MODEL;
}

async function readSystemPrompt(input: {
  config: Record<string, unknown>;
  cwd: string;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{ text: string; readFailed: boolean }> {
  const direct = nonEmpty(input.config.systemPrompt);
  if (direct) return { text: direct, readFailed: false };

  const filePath = nonEmpty(input.config.instructionsFilePath);
  if (!filePath) return { text: "", readFailed: false };

  const resolved = path.resolve(input.cwd, filePath);
  try {
    const text = await fs.readFile(resolved, "utf8");
    const dir = `${path.dirname(filePath)}/`;
    return {
      text: `${text.trim()}\n\nThe above agent instructions were loaded from ${resolved}. Resolve any relative file references from ${dir}.`,
      readFailed: false,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await input.onLog(
      "stderr",
      `[deepseek] Warning: could not read instructions file "${resolved}": ${reason}\n`,
    );
    return { text: "", readFailed: true };
  }
}

interface DeepseekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

interface DeepseekCompletionMessage {
  role: string;
  content?: string | null;
  reasoning_content?: string | null;
}

interface DeepseekCompletionChoice {
  index?: number;
  message?: DeepseekCompletionMessage;
  finish_reason?: string;
}

interface DeepseekCompletionResponse {
  id?: string;
  model?: string;
  created?: number;
  choices?: DeepseekCompletionChoice[];
  usage?: DeepseekUsage;
  error?: { message?: string; type?: string; code?: string };
}

function mapUsage(usage: DeepseekUsage | undefined): UsageSummary | undefined {
  if (!usage) return undefined;
  const inputTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  const cachedInputTokens =
    typeof usage.prompt_cache_hit_tokens === "number" ? usage.prompt_cache_hit_tokens : 0;
  if (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  };
}

export interface CallDeepseekChatInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export interface CallDeepseekChatOutput {
  text: string;
  reasoning: string;
  finishReason: string | null;
  usage: UsageSummary | undefined;
  modelEcho: string | null;
  rawJson: Record<string, unknown> | null;
}

export class DeepseekHttpError extends Error {
  status: number;
  body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "DeepseekHttpError";
    this.status = status;
    this.body = body;
  }
}

export async function callDeepseekChat(input: CallDeepseekChatInput): Promise<CallDeepseekChatOutput> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = `${trimTrailingSlash(input.baseUrl)}/chat/completions`;
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (input.systemPrompt.trim().length > 0) {
    messages.push({ role: "system", content: input.systemPrompt });
  }
  messages.push({ role: "user", content: input.userPrompt });

  const body = {
    model: input.model,
    messages,
    temperature: input.temperature,
    max_tokens: input.maxTokens,
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const rawText = await response.text();
  if (!response.ok) {
    throw new DeepseekHttpError(
      `DeepSeek API request failed (HTTP ${response.status})`,
      response.status,
      rawText,
    );
  }

  let parsed: DeepseekCompletionResponse;
  try {
    parsed = JSON.parse(rawText) as DeepseekCompletionResponse;
  } catch {
    throw new DeepseekHttpError("DeepSeek API returned non-JSON response", response.status, rawText);
  }

  if (parsed.error?.message) {
    throw new DeepseekHttpError(`DeepSeek API error: ${parsed.error.message}`, response.status, rawText);
  }

  const choice = parsed.choices?.[0];
  const message = choice?.message ?? null;
  const text = typeof message?.content === "string" ? message.content : "";
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content : "";

  return {
    text,
    reasoning,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    usage: mapUsage(parsed.usage),
    modelEcho: nonEmpty(parsed.model),
    rawJson: parsed as unknown as Record<string, unknown>,
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta } = ctx;
  const apiKey = resolveDeepseekApiKey({ config, processEnv: process.env });
  if (!apiKey) {
    const message =
      "DeepSeek API key missing. Set adapter config.apiKey, env.DEEPSEEK_API_KEY, or the DEEPSEEK_API_KEY environment variable.";
    await onLog("stderr", `[deepseek] ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
      errorCode: "DEEPSEEK_API_KEY_MISSING",
    };
  }

  const baseUrl = resolveBaseUrl(config);
  const model = resolveModel(config);
  const temperature = asNumber(config.temperature, 0.2);
  const maxTokens = Math.max(1, Math.floor(asNumber(config.maxTokens, 4096)));
  const timeoutSec = Math.max(5, Math.floor(asNumber(config.timeoutSec, 120)));

  const cwd = asString(config.cwd, process.cwd());
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);

  const { text: systemPrompt } = await readSystemPrompt({ config, cwd, onLog });

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedTemplate = renderTemplate(promptTemplate, templateData);
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake);
  const userPrompt = joinPromptSections([wakePrompt, renderedTemplate]);

  if (onMeta) {
    await onMeta({
      adapterType: "deepseek_local",
      command: `POST ${baseUrl}/chat/completions`,
      cwd,
      env: { DEEPSEEK_API_KEY: SECRET_REDACTION },
      prompt: userPrompt,
      promptMetrics: {
        systemPromptChars: systemPrompt.length,
        userPromptChars: userPrompt.length,
        wakePromptChars: wakePrompt.length,
      },
      context: { model, baseUrl, temperature, maxTokens, timeoutSec },
    });
  }

  const startedAt = Date.now();
  await onLog(
    "stdout",
    `[deepseek] Calling ${baseUrl}/chat/completions model=${model} temperature=${temperature} max_tokens=${maxTokens}\n`,
  );

  try {
    const result = await callDeepseekChat({
      baseUrl,
      apiKey,
      model,
      systemPrompt,
      userPrompt,
      temperature,
      maxTokens,
      timeoutMs: timeoutSec * 1000,
    });

    if (result.reasoning.trim().length > 0) {
      await onLog("stdout", `[deepseek] reasoning:\n${result.reasoning}\n`);
    }
    await onLog("stdout", `${result.text}\n`);

    const elapsedMs = Date.now() - startedAt;
    await onLog(
      "stderr",
      `[deepseek] completed model=${result.modelEcho ?? model} finish_reason=${result.finishReason ?? "unknown"} elapsedMs=${elapsedMs}\n`,
    );

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "deepseek",
      biller: "deepseek",
      model: result.modelEcho ?? model,
      billingType: "metered_api",
      ...(result.usage ? { usage: result.usage } : {}),
      summary: result.text.length > 0 ? result.text.slice(0, 280) : null,
      resultJson: {
        finishReason: result.finishReason,
        reasoningChars: result.reasoning.length,
        textChars: result.text.length,
      },
    };
  } catch (err) {
    if (err instanceof DeepseekHttpError) {
      await onLog("stderr", `[deepseek] ${err.message}\n${err.body}\n`);
      const transient = err.status === 429 || err.status >= 500;
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: err.message,
        errorCode: `DEEPSEEK_HTTP_${err.status}`,
        ...(transient ? { errorFamily: "transient_upstream" as const } : {}),
        errorMeta: { status: err.status, body: err.body.slice(0, 4000) },
      };
    }
    if ((err as { name?: string } | null)?.name === "AbortError") {
      const message = `DeepSeek API request timed out after ${timeoutSec}s`;
      await onLog("stderr", `[deepseek] ${message}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: true,
        errorMessage: message,
        errorCode: "DEEPSEEK_TIMEOUT",
      };
    }
    const reason = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[deepseek] Unexpected error: ${reason}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: reason,
      errorCode: "DEEPSEEK_UNEXPECTED_ERROR",
    };
  }
}
