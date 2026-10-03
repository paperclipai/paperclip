import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber } from "../utils.js";
import {
  renderPaperclipWakePrompt,
  selectPaperclipTaskMarkdown,
} from "@paperclipai/adapter-utils/server-utils";
import { guardedHttpAdapterFetch } from "../http/remote-fetch.js";

function joinPrompt(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}

// When the adapter is configured with no request timeout (timeoutMs = 0), the
// guarded fetch still applies a 30s response ceiling by default. Pass this large
// value instead so a long generation is not truncated while the operator asked
// for no timeout.
const NO_RESPONSE_TIMEOUT_MS = 3_600_000;

// Drives an AgentBridge OpenAI-compatible server (Graphene-Lab/AgentBridge)
// through POST /v1/chat/completions. Paperclip renders the task/wake prompt and
// sends it as a single user message; the AgentBridge session_id is carried in the
// run session params so multi-turn heartbeats resume the same conversation.
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runtime, context, onLog } = ctx;
  const baseUrl = asString(config.url, "http://localhost:5290").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("AgentBridge adapter missing url");

  const model = asString(config.model, "default-agent");
  const llmProvider = asString(config.llmProvider, "");
  const apiKey = asString(config.apiKey, "");
  const timeoutMs = asNumber(config.timeoutMs, 0);

  const sessionId =
    (runtime?.sessionParams?.session_id as string | undefined) ??
    runtime?.sessionId ??
    undefined;

  const taskMarkdown = selectPaperclipTaskMarkdown(context, {
    resumedSession: Boolean(sessionId),
    includeCommunicationGuidance: false,
  });
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    includeExecutionContract: true,
    conversationMode: context.conversationMode === true,
  });
  const prompt = joinPrompt([wakePrompt, taskMarkdown]);
  if (!prompt) throw new Error("AgentBridge adapter received an empty prompt");

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
  };
  if (sessionId) body.session_id = sessionId;
  if (llmProvider) body.llm_provider = llmProvider;
  // invocation_context delivery: forward the run-scoped connection tools
  // (endpoint + token) in the request body, matching the generic HTTP adapter.
  if (ctx.runtimeTools) body.paperclipRuntimeTools = ctx.runtimeTools;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  let timedOutByTimer = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOutByTimer = true;
          controller.abort();
        }, timeoutMs)
      : null;
  // Honor the run-scoped operator cancellation so stopping a run tears down the
  // in-flight request instead of leaving remote work running until the timeout.
  const onRunAbort = () => controller.abort();
  if (ctx.signal) {
    if (ctx.signal.aborted) controller.abort();
    else ctx.signal.addEventListener("abort", onRunAbort, { once: true });
  }

  try {
    // No child process to spawn: signal the dispatch boundary before the request.
    ctx.onDispatch?.();
    const res = await guardedHttpAdapterFetch(
      `${baseUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      },
      { responseTimeoutMs: timeoutMs > 0 ? timeoutMs : NO_RESPONSE_TIMEOUT_MS },
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `AgentBridge chat failed with status ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
      );
    }

    const json = (await res.json()) as Record<string, any>;
    const content: string = json?.choices?.[0]?.message?.content ?? "";
    const usage = (json?.usage ?? {}) as Record<string, any>;
    const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const returnedSession: string | null = json?.session_id ?? sessionId ?? null;

    if (!content.trim()) {
      // A 200 with no assistant text (empty choices, or a tool-call-only message
      // this adapter does not execute) is an incomplete turn, not a success.
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "AgentBridge returned an empty reply with no assistant content",
        errorCode: "empty_response",
        provider: "agentbridge",
        model: json?.model ?? model,
        sessionParams: { session_id: returnedSession },
        sessionDisplayId: returnedSession,
      };
    }

    if (content) {
      await onLog("stdout", content.endsWith("\n") ? content : `${content}\n`);
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "agentbridge",
      model: json?.model ?? model,
      summary: `AgentBridge ${model}`,
      usage: {
        inputTokens: Number(usage.prompt_tokens ?? 0),
        outputTokens: Number(usage.completion_tokens ?? 0),
        cachedInputTokens: Number(cachedTokens ?? 0),
      },
      usageBasis: "per_run",
      sessionParams: { session_id: returnedSession },
      sessionDisplayId: returnedSession,
      resultJson: { content },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      if (timedOutByTimer) {
        return {
          exitCode: null,
          signal: null,
          timedOut: true,
          errorMessage: `AgentBridge chat timed out after ${timeoutMs}ms`,
          errorCode: "timeout",
        };
      }
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: "AgentBridge chat cancelled before it finished",
        errorCode: "cancelled",
      };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (ctx.signal) ctx.signal.removeEventListener("abort", onRunAbort);
  }
}
