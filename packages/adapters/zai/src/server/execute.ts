import type { AdapterBillingType, AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { resolveZaiConfig } from "../shared/config.js";
import type { ZaiChatRequest, ZaiChatResponse, ZaiStdoutEvent } from "../shared/types.js";
import { computeZaiCostUsd, isCodingPlanEndpoint } from "../shared/pricing.js";
import { encodeEvent, consumeSseStream } from "./streaming.js";
import { buildMessages } from "./prompt.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function redactBody(body: ZaiChatRequest): Record<string, unknown> {
  const { model, temperature, max_tokens, stream, tool_choice, response_format, tools, messages } = body;
  return {
    model,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(max_tokens !== undefined ? { max_tokens } : {}),
    ...(stream !== undefined ? { stream } : {}),
    ...(tool_choice !== undefined ? { tool_choice } : {}),
    ...(response_format !== undefined ? { response_format } : {}),
    tools_count: tools?.length ?? 0,
    messages_count: messages.length,
  };
}

function extractResultText(response: ZaiChatResponse): string | null {
  const choice = response.choices?.[0];
  if (!choice) return null;
  const content = choice.message?.content;
  if (typeof content === "string" && content.length > 0) return content;
  return null;
}

function buildUsage(response: ZaiChatResponse): AdapterExecutionResult["usage"] | undefined {
  const usage = response.usage;
  if (!usage) return undefined;
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const cachedInputTokens = usage.prompt_tokens_details?.cached_tokens;
  if (inputTokens <= 0 && outputTokens <= 0 && !cachedInputTokens) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens ? { cachedInputTokens } : {}),
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const resolved = resolveZaiConfig(ctx.config);

  if (!resolved.apiKey) {
    await ctx.onLog("stderr", "[zai] missing API key: set adapterConfig.apiKey or ZAI_API_KEY\n");
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Z.AI adapter missing API key (config.apiKey or ZAI_API_KEY).",
      errorCode: "zai_api_key_missing",
    };
  }

  const messages = buildMessages(ctx, resolved);

  const request: ZaiChatRequest = {
    model: resolved.model,
    messages,
    stream: resolved.stream,
  };
  if (resolved.temperature !== null) request.temperature = resolved.temperature;
  if (resolved.maxTokens !== null) request.max_tokens = resolved.maxTokens;
  if (resolved.tools.length > 0) {
    request.tools = resolved.tools;
    request.tool_choice = "auto";
  }
  if (resolved.responseFormat) request.response_format = { type: resolved.responseFormat };

  if (ctx.onMeta) {
    await ctx.onMeta({
      adapterType: "zai",
      command: "zai",
      commandArgs: ["POST", `${resolved.baseUrl}/chat/completions`],
      context: ctx.context,
    });
  }

  await ctx.onLog(
    "stdout",
    `[zai] request ${resolved.model} stream=${resolved.stream} tools=${resolved.tools.length} response_format=${resolved.responseFormat ?? "text"}\n`,
  );
  await ctx.onLog("stdout", `[zai] payload ${JSON.stringify(redactBody(request))}\n`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolved.timeoutMs);
  const onEvent = async (event: ZaiStdoutEvent) => {
    await ctx.onLog("stdout", encodeEvent(event));
  };

  let response: ZaiChatResponse;
  try {
    const res = await fetch(`${resolved.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resolved.apiKey}`,
        "Content-Type": "application/json",
        Accept: resolved.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      const message = `Z.AI HTTP ${res.status}: ${errorText.slice(0, 500)}`;
      await ctx.onLog("stderr", `[zai] ${message}\n`);
      await onEvent({ kind: "error", message });
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: message,
        errorCode: `zai_http_${res.status}`,
      };
    }

    if (resolved.stream && res.body) {
      response = await consumeSseStream(res.body, onEvent);
    } else {
      const json = (await res.json()) as ZaiChatResponse;
      response = json;
      // Non-streaming: emit deltas/tool_calls as a single batch so UI can render.
      const content = extractResultText(json);
      if (content) await onEvent({ kind: "assistant_delta", text: content });
      const choice = json.choices?.[0];
      const toolCalls = choice?.message?.tool_calls ?? [];
      for (const tc of toolCalls) {
        let input: unknown = {};
        if (tc.function.arguments && tc.function.arguments.length > 0) {
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            input = { _raw: tc.function.arguments };
          }
        }
        await onEvent({ kind: "tool_call", id: tc.id, name: tc.function.name, input });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const aborted = message.toLowerCase().includes("abort");
    await ctx.onLog("stderr", `[zai] request failed: ${message}\n`);
    await onEvent({ kind: "error", message });
    return {
      exitCode: 1,
      signal: null,
      timedOut: aborted,
      errorMessage: aborted ? `Z.AI request timed out after ${resolved.timeoutMs}ms` : message,
      errorCode: aborted ? "zai_timeout" : "zai_request_failed",
    };
  } finally {
    clearTimeout(timer);
  }

  const summary = extractResultText(response);
  const usage = buildUsage(response);
  const model = response.model ?? resolved.model;

  // Cost reference — always computed at Z.AI pay-as-you-go rates so that
  // management reporting has a consistent USD figure regardless of whether
  // the run was billed through the Coding Plan subscription or the general
  // credits API. billingType tells downstream consumers which of the two
  // actually paid for this run.
  const codingPlan = isCodingPlanEndpoint(resolved.baseUrl);
  const billingType: AdapterBillingType = codingPlan ? "subscription_included" : "api";
  const costUsd = usage ? computeZaiCostUsd(model, usage) : null;

  if (response.id) {
    await onEvent({ kind: "model", model, sessionId: response.id });
  }
  if (usage) {
    await onEvent({
      kind: "usage",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cachedInputTokens ? { cachedTokens: usage.cachedInputTokens } : {}),
      ...(costUsd !== null ? { costUsd } : {}),
      billingType,
    });
  }
  if (summary) {
    await onEvent({ kind: "assistant_final", text: summary });
  }

  await ctx.onLog(
    "stdout",
    `[zai] done model=${model} billing=${billingType}${costUsd !== null ? ` cost_usd_ref=${costUsd}` : ""}\n`,
  );

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: "z.ai",
    biller: "z.ai",
    model,
    billingType,
    ...(usage ? { usage } : {}),
    ...(costUsd !== null ? { costUsd } : {}),
    ...(summary ? { summary } : {}),
    resultJson: asRecord(response as unknown),
  };
}
