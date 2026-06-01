import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  parseObject,
  renderPaperclipWakePrompt,
} from "@paperclipai/adapter-utils/server-utils";

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_TIMEOUT_SEC = 600;

// DeepSeek-direct list prices, USD per 1M tokens (api-docs.deepseek.com, mid-2026).
// `inHit` = cached input token (prompt_cache_hit_tokens), `inMiss` = uncached
// input token, `out` = output token. DeepSeek's HTTP API returns only token
// counts (no dollar figure), so we price runs here; the value rides out on
// AdapterExecutionResult.costUsd and the heartbeat converts it to costCents.
// deepseek-chat / deepseek-reasoner are deprecated aliases billed at flash rates.
// NOTE: correct only for DeepSeek-direct; a reseller (e.g. OpenRouter) prices
// differently and would over/under-state cost.
const DEEPSEEK_PRICES_PER_MILLION: Record<string, { inHit: number; inMiss: number; out: number }> = {
  "deepseek-v4-pro": { inHit: 0.003625, inMiss: 0.435, out: 0.87 },
  "deepseek-v4-flash": { inHit: 0.0028, inMiss: 0.14, out: 0.28 },
  "deepseek-chat": { inHit: 0.0028, inMiss: 0.14, out: 0.28 },
  "deepseek-reasoner": { inHit: 0.0028, inMiss: 0.14, out: 0.28 },
};

type DeepSeekUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

/**
 * Price a DeepSeek run from its token split. Returns null for an unknown model
 * id so the run records correct tokens with 0 cost (the same safe default as
 * before this table existed) rather than crashing or guessing.
 */
function computeDeepSeekCostUsd(model: string, usage: DeepSeekUsage): number | null {
  const price = DEEPSEEK_PRICES_PER_MILLION[model];
  if (!price) return null;
  const cachedInput = usage.cachedInputTokens;
  const uncachedInput = Math.max(0, usage.inputTokens - cachedInput);
  return (
    (cachedInput * price.inHit + uncachedInput * price.inMiss + usage.outputTokens * price.out) /
    1_000_000
  );
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function resolveApiKey(config: Record<string, unknown>): string | null {
  const env = parseObject(config.env);
  const fromEnv = nonEmpty(env.DEEPSEEK_API_KEY);
  if (fromEnv) return fromEnv;
  return nonEmpty(config.apiKey);
}

/**
 * Translate a Retry-After header (delta-seconds or HTTP-date) into an ISO
 * timestamp the heartbeat rotator can use as the credential cooldown deadline.
 */
function computeRetryNotBefore(retryAfter: string | null | undefined): string | null {
  if (!retryAfter) return null;
  const trimmed = retryAfter.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return new Date(Date.now() + seconds * 1000).toISOString();
    }
  }
  const date = new Date(trimmed);
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return null;
}

function resolveTemperature(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function resolveMaxTokens(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, Math.floor(value));
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return Math.max(1, parsed);
  }
  return null;
}

function buildUserPrompt(ctx: AdapterExecutionContext): string {
  const wakeBody = renderPaperclipWakePrompt(ctx.context.paperclipWake);
  if (wakeBody.trim().length > 0) return wakeBody;

  const reason = nonEmpty(ctx.context.wakeReason);
  const issueId = nonEmpty(ctx.context.issueId);
  const lines = [
    `Paperclip wake event for run ${ctx.runId} (agent ${ctx.agent.name}).`,
  ];
  if (issueId) lines.push(`Issue: ${issueId}`);
  if (reason) lines.push(`Wake reason: ${reason}`);
  lines.push(
    "",
    "Respond with your next action for this task. The reply is captured as the run output.",
  );
  return lines.join("\n");
}

async function streamChatCompletion(params: {
  baseUrl: string;
  apiKey: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{
  text: string;
  usage: DeepSeekUsage | null;
  model: string | null;
}> {
  const url = `${params.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({ ...params.body, stream: true }),
    signal: params.signal,
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => "");
    const err = new Error(
      `DeepSeek API ${response.status} ${response.statusText}${errText ? `: ${errText.slice(0, 500)}` : ""}`,
    ) as Error & { status?: number; retryAfter?: string | null };
    err.status = response.status;
    err.retryAfter = response.headers.get("retry-after");
    throw err;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffered = "";
  let assembled = "";
  let usage: DeepSeekUsage | null = null;
  let model: string | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = buffered.indexOf("\n")) !== -1) {
      const rawLine = buffered.slice(0, newlineIdx).replace(/\r$/, "");
      buffered = buffered.slice(newlineIdx + 1);
      if (!rawLine.startsWith("data:")) continue;
      const payload = rawLine.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;

      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }

      const frameModel = nonEmpty(frame.model);
      if (frameModel) model = frameModel;

      const choices = Array.isArray(frame.choices) ? frame.choices : [];
      for (const choice of choices) {
        const choiceRec = asRecord(choice);
        const delta = asRecord(choiceRec?.delta);
        const contentChunk = nonEmpty(delta?.content);
        const reasoningChunk = nonEmpty(delta?.reasoning_content);
        if (reasoningChunk) {
          await params.onLog("stdout", reasoningChunk);
        }
        if (contentChunk) {
          assembled += contentChunk;
          await params.onLog("stdout", contentChunk);
        }
      }

      const usageRec = asRecord(frame.usage);
      if (usageRec) {
        // DeepSeek's prompt_tokens INCLUDES the cache-hit tokens, so derive the
        // cache-miss bucket by subtraction rather than adding the two together.
        const promptTokens = asNumber(usageRec.prompt_tokens, 0);
        const cacheHit = asNumber(usageRec.prompt_cache_hit_tokens, 0);
        usage = {
          inputTokens: promptTokens,
          cachedInputTokens: Math.max(0, Math.min(cacheHit, promptTokens)),
          outputTokens: asNumber(usageRec.completion_tokens, 0),
        };
      }
    }
  }

  return { text: assembled.trim(), usage, model };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  // Read the fully-resolved runtime config (ctx.config), not the static
  // agent.adapterConfig record. ctx.config is built from the agent's adapter
  // config and then has project env, secrets, and resolved provider
  // credentials merged in (see resolveAllCredentialEnv in heartbeat). Reading
  // it here is what lets a managed `deepseek_api_key` credential inject
  // DEEPSEEK_API_KEY into env. Every other in-process adapter reads ctx.config.
  const config = parseObject(ctx.config);
  const apiKey = resolveApiKey(config);
  if (!apiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage:
        "DeepSeek adapter missing API key. Set adapterConfig.env.DEEPSEEK_API_KEY (or adapterConfig.apiKey).",
      errorCode: "deepseek_api_key_missing",
    };
  }

  const baseUrl = asString(config.baseUrl, DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  const model = asString(config.model, DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const systemPrompt = nonEmpty(config.systemPrompt);
  const temperature = resolveTemperature(config.temperature);
  const maxTokens = resolveMaxTokens(config.maxTokens);
  const timeoutSec = Math.max(1, Math.floor(asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC)));

  const userPrompt = buildUserPrompt(ctx);

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: userPrompt });

  const body: Record<string, unknown> = { model, messages };
  if (temperature !== null) body.temperature = temperature;
  if (maxTokens !== null) body.max_tokens = maxTokens;

  if (ctx.onMeta) {
    await ctx.onMeta({
      adapterType: "deepseek_api",
      command: "deepseek",
      commandArgs: ["POST", `${baseUrl.replace(/\/$/, "")}/chat/completions`, model],
      context: ctx.context,
    });
  }

  await ctx.onLog(
    "stdout",
    `[deepseek-api] model=${model} base=${baseUrl} promptChars=${userPrompt.length}\n`,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

  try {
    const { text, usage, model: respondedModel } = await streamChatCompletion({
      baseUrl,
      apiKey,
      body,
      signal: controller.signal,
      onLog: ctx.onLog,
    });

    await ctx.onLog("stdout", "\n");

    const billedModel = respondedModel ?? model;
    const costUsd = usage ? computeDeepSeekCostUsd(billedModel, usage) : null;
    if (usage && costUsd === null) {
      // Unknown model id — record tokens but no price. Surface it so the silent
      // $0 is visible and the price table can be extended.
      await ctx.onLog(
        "stderr",
        `[deepseek-api] no price entry for model "${billedModel}"; cost recorded as $0\n`,
      );
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "deepseek",
      model: billedModel,
      billingType: "api",
      ...(usage ? { usage } : {}),
      ...(costUsd != null ? { costUsd } : {}),
      ...(text ? { summary: text.slice(0, 2000) } : {}),
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `DeepSeek API request timed out after ${timeoutSec}s`,
        errorCode: "deepseek_api_timeout",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    await ctx.onLog("stderr", `[deepseek-api] ${message}\n`);
    const status =
      typeof (err as { status?: unknown }).status === "number"
        ? (err as { status: number }).status
        : null;
    // 429 (rate limit), 503/529 (overloaded) → mark transient so the heartbeat
    // rotator cools this credential down and swaps to the next bound one.
    if (status === 429 || status === 503 || status === 529) {
      const retryNotBefore = computeRetryNotBefore((err as { retryAfter?: string | null }).retryAfter);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: message,
        errorCode: "deepseek_transient_upstream",
        errorFamily: "transient_upstream",
        ...(retryNotBefore ? { retryNotBefore } : {}),
      };
    }
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
      errorCode: "deepseek_api_request_failed",
    };
  } finally {
    clearTimeout(timer);
  }
}
