import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { callBlockRunAPI } from "./x402.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";

interface ChatMessage {
  role: string;
  content: string;
}

/**
 * Smart model selection based on routing mode.
 * Maps routing modes to sensible default models.
 */
function resolveModelFromRoutingMode(mode: string): string {
  switch (mode) {
    case "fast":
      return "google/gemini-2.5-flash";
    case "cheap":
      return "deepseek/deepseek-chat";
    case "powerful":
      return "anthropic/claude-opus-4-6";
    case "reasoning":
      return "openai/o3";
    case "balanced":
    default:
      return "openai/gpt-4o";
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context, runtime, onLog, onMeta } = ctx;

  // ---- extract config ----
  const walletKey = asString(config.walletPrivateKey, "");
  const modelExplicit = asString(config.model, "");
  const routingMode = asString(config.routingMode, "balanced");
  const maxTokens = Math.max(1, asNumber(config.maxTokens, 4096));
  const temperature = Math.max(0, Math.min(2, asNumber(config.temperature, 0.7)));
  const apiUrl = asString(config.apiUrl, "https://blockrun.ai").replace(/\/+$/, "");
  const customSystemPrompt = asString(config.systemPrompt, "");
  const timeoutSec = Math.max(5, asNumber(config.timeoutSec, 120));
  const maxHistoryMessages = Math.max(0, asNumber(config.maxHistoryMessages, 20));

  // ---- validate ----
  if (!walletKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "BlockRun adapter requires walletPrivateKey in adapterConfig. Use a Paperclip secret reference.",
      errorCode: "blockrun_wallet_missing",
    };
  }

  const model = modelExplicit || resolveModelFromRoutingMode(routingMode);

  if (onMeta) {
    await onMeta({
      adapterType: "blockrun",
      command: "chat/completions",
      commandArgs: [model, apiUrl],
      context,
    });
  }

  await onLog("stdout", `[blockrun] model=${model} maxTokens=${maxTokens} temp=${temperature}\n`);

  // ---- build messages ----
  const systemPrompt = buildSystemPrompt(agent, context, customSystemPrompt);
  const userPrompt = buildUserPrompt(context);

  // Load conversation history from session for continuity across heartbeats
  const sessionState = parseObject(runtime.sessionParams);
  const prevMessages = Array.isArray(sessionState.messages)
    ? (sessionState.messages as ChatMessage[]).filter(
        (m) => typeof m.role === "string" && typeof m.content === "string",
      )
    : [];

  // Trim history to maxHistoryMessages (pairs of user+assistant)
  const trimmedHistory =
    maxHistoryMessages > 0 && prevMessages.length > maxHistoryMessages * 2
      ? prevMessages.slice(-maxHistoryMessages * 2)
      : prevMessages;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...trimmedHistory,
    { role: "user", content: userPrompt },
  ];

  await onLog("stdout", `[blockrun] sending ${messages.length} messages (${trimmedHistory.length} from history)\n`);

  // ---- call BlockRun API ----
  try {
    const { response, costUsd } = await callBlockRunAPI(walletKey, apiUrl, {
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }, timeoutSec, onLog);

    const responseText = response.choices?.[0]?.message?.content ?? "";
    const responseModel = response.model || model;
    const inputTokens = response.usage?.prompt_tokens ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? 0;

    await onLog("stdout", `[blockrun] response received: model=${responseModel} tokens=${inputTokens}+${outputTokens} cost=$${costUsd.toFixed(6)}\n`);

    if (responseText.length > 0) {
      await onLog("stdout", `[blockrun] --- agent output ---\n${responseText}\n[blockrun] --- end output ---\n`);
    }

    // Persist conversation for next heartbeat
    const nextMessages: ChatMessage[] = [
      ...trimmedHistory,
      { role: "user", content: userPrompt },
      { role: "assistant", content: responseText },
    ];

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      usage: { inputTokens, outputTokens },
      provider: "blockrun",
      model: responseModel,
      billingType: "api",
      costUsd,
      sessionParams: {
        messages: nextMessages,
        lastModel: responseModel,
      },
      sessionDisplayId: responseModel,
      resultJson: {
        response: responseText,
        model: responseModel,
        inputTokens,
        outputTokens,
        costUsd,
      },
      summary: `BlockRun ${responseModel}: ${responseText.slice(0, 120)}${responseText.length > 120 ? "..." : ""}`,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      await onLog("stderr", `[blockrun] request timed out after ${timeoutSec}s\n`);
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        provider: "blockrun",
        model,
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[blockrun] error: ${message}\n`);

    // Detect specific error types
    let errorCode = "blockrun_request_failed";
    if (message.includes("402") || message.includes("payment") || message.includes("insufficient")) {
      errorCode = "blockrun_payment_failed";
    } else if (message.includes("Invalid private key") || message.includes("wallet")) {
      errorCode = "blockrun_wallet_invalid";
    }

    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
      errorCode,
      provider: "blockrun",
      model,
    };
  }
}
