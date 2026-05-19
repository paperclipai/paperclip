import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";
import {
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";

export function normalizeAtomicAgentBaseUrl(raw: string): string {
  let s = raw.trim().replace(/\/+$/, "");
  if (s.endsWith("/v1")) {
    s = s.slice(0, -3).replace(/\/+$/, "");
  }
  return s;
}

function readOpenAiMessageContent(message: Record<string, unknown> | null): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part !== "object" || part === null) return "";
        const rec = part as Record<string, unknown>;
        if (rec.type === "text" && typeof rec.text === "string") return rec.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

async function fetchFirstModelId(
  baseUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<string | null> {
  const url = `${baseUrl}/v1/models`;
  const res = await fetch(url, { method: "GET", headers, signal });
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  const first = body.data?.find((m) => typeof m.id === "string" && m.id.trim().length > 0);
  return first?.id?.trim() ?? null;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const baseUrl = normalizeAtomicAgentBaseUrl(asString(ctx.config.baseUrl, ""));
  if (!baseUrl) {
    throw new Error("atomic_agent_http adapter missing baseUrl (e.g. http://127.0.0.1:8787)");
  }

  const apiKey = asString(ctx.config.apiKey, "").trim();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };

  const configuredTimeout = asNumber(ctx.config.timeoutMs, 0);
  const timeoutMs = configuredTimeout > 0 ? configuredTimeout : 600_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let model = asString(ctx.config.model, "").trim();
  if (!model) {
    try {
      model = (await fetchFirstModelId(baseUrl, headers, controller.signal)) ?? "";
    } catch {
      model = "";
    }
  }
  if (!model) {
    clearTimeout(timer);
    throw new Error(
      "atomic_agent_http: set adapterConfig.model to an id from `atomic-agent serve` (GET /v1/models), or ensure /v1/models is reachable.",
    );
  }

  const maxTokens = asNumber(ctx.config.maxTokens, 0);
  const systemExtra = asString(ctx.config.systemPromptAppend, "").trim();
  const defaultSystem = [
    "You are a Paperclip agent: you receive wake payloads for a single issue and should act as the assigned operator.",
    "Follow the execution contract in the user message. When you finish, reply with a concise summary suitable as an issue comment (plain text, no JSON wrapper).",
    ...(systemExtra ? [systemExtra] : []),
  ].join("\n");

  const structuredWakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake);
  const structuredWakeJson = stringifyPaperclipWakePayload(ctx.context.paperclipWake);
  const wakeLines = [
    structuredWakePrompt.trim() || "(empty structured wake; use JSON below if present.)",
    structuredWakeJson ? `\n## paperclipWake JSON\n${structuredWakeJson}` : "",
    `\n## Paperclip run\n- runId: ${ctx.runId}\n- agentId: ${ctx.agent.id}\n- agentName: ${ctx.agent.name}`,
  ];
  const userContent = wakeLines.join("\n");

  const url = `${baseUrl}/v1/chat/completions`;
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: defaultSystem },
      { role: "user", content: userContent },
    ],
  };
  if (maxTokens > 0) {
    body.max_tokens = maxTokens;
  }

  await ctx.onMeta?.({
    adapterType: "atomic_agent_http",
    command: "fetch",
    commandArgs: [url],
    context: ctx.context,
  });

  await ctx.onLog("stdout", `[paperclip] atomic_agent_http POST ${url} model=${model}\n`);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const rawText = await res.text();
    if (!res.ok) {
      const detail = rawText.length > 800 ? `${rawText.slice(0, 800)}…` : rawText;
      await ctx.onLog("stderr", `[paperclip] atomic_agent_http HTTP ${res.status}: ${detail}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `atomic_agent_http: HTTP ${res.status}`,
        errorCode: "adapter_failed",
        provider: "atomic-agent",
        biller: "llama_local",
        model,
        billingType: "fixed",
      };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      await ctx.onLog("stderr", "[paperclip] atomic_agent_http: response was not JSON\n");
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "atomic_agent_http: invalid JSON from /v1/chat/completions",
        errorCode: "adapter_failed",
        provider: "atomic-agent",
        biller: "llama_local",
        model,
        billingType: "fixed",
      };
    }

    const choices = parsed.choices;
    const first =
      Array.isArray(choices) && choices.length > 0 && typeof choices[0] === "object" && choices[0] !== null
        ? (choices[0] as Record<string, unknown>)
        : null;
    const message =
      first && typeof first.message === "object" && first.message !== null
        ? (first.message as Record<string, unknown>)
        : null;
    const assistantText = readOpenAiMessageContent(message).trim();

    if (!assistantText) {
      await ctx.onLog("stderr", "[paperclip] atomic_agent_http: empty assistant message\n");
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "atomic_agent_http: model returned no assistant text",
        errorCode: "adapter_failed",
        provider: "atomic-agent",
        biller: "llama_local",
        model,
        billingType: "fixed",
      };
    }

    const usageRaw = parsed.usage && typeof parsed.usage === "object" ? (parsed.usage as Record<string, unknown>) : null;
    const usage =
      usageRaw
        ? {
            inputTokens: asNumber(usageRaw.prompt_tokens, 0) || asNumber(usageRaw.input_tokens, 0),
            outputTokens: asNumber(usageRaw.completion_tokens, 0) || asNumber(usageRaw.output_tokens, 0),
            cachedInputTokens: asNumber(usageRaw.cached_prompt_tokens, 0) || undefined,
          }
        : undefined;

    await ctx.onLog("stdout", `${assistantText}\n`);

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: assistantText,
      resultJson: {
        summary: assistantText,
        result: assistantText,
      },
      usage,
      provider: "atomic-agent",
      biller: "llama_local",
      model,
      billingType: "fixed",
      costUsd: null,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `atomic_agent_http: timed out after ${timeoutMs}ms`,
        errorCode: "timeout",
        provider: "atomic-agent",
        biller: "llama_local",
        model,
        billingType: "fixed",
      };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
