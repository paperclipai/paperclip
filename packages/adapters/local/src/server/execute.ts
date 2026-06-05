import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  joinPromptSections,
  renderPaperclipWakePrompt,
  renderTemplate,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_LOCAL_MODEL } from "../index.js";
import { normalizeLocalBaseUrl, resolveLocalBaseUrl } from "./health.js";

const DEFAULT_COMPLETION_TIMEOUT_MS = 120_000;
const MS_PER_SECOND = 1_000;

interface ChatChoice {
  message?: { content?: unknown };
}

interface ChatCompletionResponse {
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
}

function timeoutMs(timeoutSec: number): number {
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) return DEFAULT_COMPLETION_TIMEOUT_MS;
  return Math.trunc(timeoutSec * MS_PER_SECOND);
}

async function readInstructions(filePath: string, onLog: AdapterExecutionContext["onLog"]) {
  if (!filePath) return "";
  try {
    const contents = await fs.readFile(filePath, "utf8");
    const baseDir = `${path.dirname(filePath)}/`;
    return `${contents}\n\nThe above agent instructions were loaded from ${filePath}. Resolve any relative file references from ${baseDir}.`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await onLog("stderr", `[paperclip] Warning: could not read local adapter instructions file "${filePath}": ${reason}\n`);
    return "";
  }
}

function usageFromResponse(response: ChatCompletionResponse): AdapterExecutionResult["usage"] {
  const usage = response.usage ?? {};
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
  };
}

function asChatResponse(payload: unknown): ChatCompletionResponse {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return {};
  return payload as ChatCompletionResponse;
}

function buildPrompt(ctx: AdapterExecutionContext, instructions: string): string {
  const template = asString(ctx.config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const wakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake);
  const taskContext = asString(ctx.context.paperclipTaskMarkdown, "").trim();
  const templateData = {
    agentId: ctx.agent.id,
    companyId: ctx.agent.companyId,
    runId: ctx.runId,
    company: { id: ctx.agent.companyId },
    agent: ctx.agent,
    run: { id: ctx.runId, source: "on_demand" },
    context: ctx.context,
  };
  return joinPromptSections([
    "Your response will be saved as this heartbeat run's issue-thread update. Be concise and factual.",
    instructions,
    wakePrompt,
    taskContext,
    renderTemplate(template, templateData),
  ]);
}

function contentFromResponse(payload: unknown): string {
  const parsed = asChatResponse(payload);
  const content = parsed.choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim() : "";
}

async function postChatCompletion(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  timeoutMs: number;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`;
  try {
    return await fetch(`${input.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: input.prompt }],
      }),
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const model = asString(ctx.config.model, DEFAULT_LOCAL_MODEL).trim() || DEFAULT_LOCAL_MODEL;
  const baseUrl = normalizeLocalBaseUrl(resolveLocalBaseUrl(asString(ctx.config.baseUrl, "")));
  const apiKey = asString(ctx.config.apiKey, "");
  const instructions = await readInstructions(asString(ctx.config.instructionsFilePath, ""), ctx.onLog);
  const prompt = buildPrompt(ctx, instructions);

  await ctx.onMeta?.({
    adapterType: "local",
    command: `${baseUrl}/chat/completions`,
    commandNotes: ["OpenAI-compatible local inference request"],
    prompt,
    promptMetrics: { promptChars: prompt.length, instructionsChars: instructions.length },
    context: ctx.context,
  });

  try {
    const response = await postChatCompletion({
      baseUrl,
      apiKey,
      model,
      prompt,
      timeoutMs: timeoutMs(asNumber(ctx.config.timeoutSec, 0)),
    });
    const payload = await response.json();
    const summary = contentFromResponse(payload);
    if (!response.ok || !summary) return failedResponse(response.status, payload, summary);
    await ctx.onLog("stdout", `assistant: ${summary}\n`);
    return succeededResponse(model, payload, summary);
  } catch (error) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "local_inference_request_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function failedResponse(status: number, payload: unknown, summary: string): AdapterExecutionResult {
  const httpFailed = status >= 400;
  const errorCode = httpFailed ? `local_http_${status}` : "local_empty_response";
  const errorMessage = summary || (
    httpFailed ? `Local inference returned HTTP ${status}` : "Local inference returned an empty response"
  );
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode,
    errorMessage,
    resultJson: { response: payload },
  };
}

function succeededResponse(
  model: string,
  payload: unknown,
  summary: string,
): AdapterExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: "local",
    biller: "local",
    billingType: "fixed",
    costUsd: 0,
    model,
    usage: usageFromResponse(asChatResponse(payload)),
    summary,
    resultJson: { result: summary },
  };
}
