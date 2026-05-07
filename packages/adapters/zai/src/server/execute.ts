import type { AdapterBillingType, AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { resolveZaiConfig } from "../shared/config.js";
import type {
  ZaiChatRequest,
  ZaiChatResponse,
  ZaiMessage,
  ZaiStdoutEvent,
  ZaiToolDefinition,
} from "../shared/types.js";
import { computeZaiCostUsd, isCodingPlanEndpoint } from "../shared/pricing.js";
import { encodeEvent } from "./streaming.js";
import { buildMessages } from "./prompt.js";
import { buildPaperclipToolsCatalog } from "./tools-catalog.js";
import { buildZaiSkillInjection } from "./skills-content.js";
import { runZaiToolLoop, ZaiHttpError } from "./tool-loop.js";

const DEFAULT_MAX_TOOL_TURNS = 16;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readMaxToolTurns(config: Record<string, unknown>): number {
  const raw = config.maxToolTurns;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1 && raw <= 64) {
    return Math.floor(raw);
  }
  return DEFAULT_MAX_TOOL_TURNS;
}

function readPaperclipApiUrl(): string | null {
  const candidates = [process.env.PAPERCLIP_RUNTIME_API_URL, process.env.PAPERCLIP_API_URL];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      const trimmed = candidate.trim().replace(/\/+$/, "");
      return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
    }
  }
  const host = process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost";
  const port = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
  const normalizedHost = host && host !== "0.0.0.0" && host !== "::" ? host : "localhost";
  return `http://${normalizedHost}:${port}/api`;
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

function buildUsageFromAccumulator(usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number }) {
  if (usage.inputTokens <= 0 && usage.outputTokens <= 0 && usage.cachedInputTokens <= 0) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedInputTokens > 0 ? { cachedInputTokens: usage.cachedInputTokens } : {}),
  };
}

function readDesiredToolNames(config: Record<string, unknown>): Set<string> | null {
  const raw = config.tools;
  if (!Array.isArray(raw)) return null;
  const names = new Set<string>();
  for (const entry of raw) {
    const fn = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).function : null;
    const name = fn && typeof fn === "object" ? (fn as Record<string, unknown>).name : null;
    if (typeof name === "string" && name.length > 0) names.add(name);
  }
  return names.size > 0 ? names : null;
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

  // Resolve and load any "desired" Paperclip skills as a system-prompt addendum.
  // This gives the model the SKILL.md content at run time (Z.AI has no FS to
  // materialize skills onto, so we inject the markdown directly).
  const skillInjection = await buildZaiSkillInjection(ctx.config);
  if (skillInjection.injectedKeys.length > 0) {
    await ctx.onLog(
      "stdout",
      `[zai/skills] injected=${skillInjection.injectedKeys.length} keys=${JSON.stringify(skillInjection.injectedKeys)}\n`,
    );
  }
  for (const warning of skillInjection.warnings) {
    await ctx.onLog("stderr", `[zai/skills] ${warning}\n`);
  }

  const messages = buildMessages(ctx, resolved, { skillsAddendum: skillInjection.systemPromptAddendum });
  const onEvent = async (event: ZaiStdoutEvent) => {
    await ctx.onLog("stdout", encodeEvent(event));
  };

  // -----------------------------------------------------------------
  // Tool catalog: connect to the Paperclip API via the agent's JWT.
  // Without ctx.authToken we still proceed, but with no tools — the
  // agent runs as a pure chat completion (back-compat with prior runs).
  // -----------------------------------------------------------------
  const apiUrl = readPaperclipApiUrl();
  const agentJwt = typeof ctx.authToken === "string" && ctx.authToken.length > 0 ? ctx.authToken : null;

  let zaiToolDefinitions: ZaiToolDefinition[] = resolved.tools;
  let toolsByName: Awaited<ReturnType<typeof buildPaperclipToolsCatalog>>["toolsByName"] | null = null;
  if (agentJwt && apiUrl) {
    try {
      const allowed = readDesiredToolNames(ctx.config);
      const catalog = buildPaperclipToolsCatalog({
        apiUrl,
        agentJwt,
        companyId: ctx.agent.companyId ?? null,
        agentId: ctx.agent.id ?? null,
        runId: ctx.runId,
        allowedToolNames: allowed ?? undefined,
      });
      // If the user already provided explicit tools, honor that and skip Paperclip.
      // Otherwise inject the full Paperclip MCP catalog so the agent can post
      // comments, update issues, etc.
      if (resolved.tools.length === 0) {
        zaiToolDefinitions = catalog.zaiToolDefinitions;
        toolsByName = catalog.toolsByName;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.onLog("stderr", `[zai] failed to build Paperclip tools catalog: ${message}\n`);
    }
  } else if (!agentJwt) {
    await ctx.onLog(
      "stderr",
      "[zai] no agent JWT (ctx.authToken) — Paperclip tool catalog disabled; agent will run without API tools\n",
    );
  }

  const baseRequest: Omit<ZaiChatRequest, "stream" | "messages"> = {
    model: resolved.model,
    ...(resolved.temperature !== null ? { temperature: resolved.temperature } : {}),
    ...(resolved.maxTokens !== null ? { max_tokens: resolved.maxTokens } : {}),
    ...(zaiToolDefinitions.length > 0
      ? { tools: zaiToolDefinitions, tool_choice: "auto" as const }
      : {}),
    ...(resolved.responseFormat ? { response_format: { type: resolved.responseFormat } } : {}),
  };

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
    `[zai] request ${resolved.model} stream=${resolved.stream} tools=${zaiToolDefinitions.length} response_format=${resolved.responseFormat ?? "text"}\n`,
  );
  await ctx.onLog(
    "stdout",
    `[zai] payload ${JSON.stringify(redactBody({ ...baseRequest, stream: resolved.stream, messages }))}\n`,
  );

  const maxTurns = toolsByName ? readMaxToolTurns(ctx.config) : 1;

  // Run the agentic loop. Even when no Paperclip tools are wired (toolsByName
  // is null), we still go through runZaiToolLoop with maxTurns=1; the loop
  // simply does one HTTP call and returns the response — equivalent to the
  // prior single-shot path but with consistent error handling.
  let loopResult: Awaited<ReturnType<typeof runZaiToolLoop>>;
  try {
    loopResult = await runZaiToolLoop({
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      baseRequest,
      initialMessages: messages,
      maxTurns,
      timeoutMs: resolved.timeoutMs,
      toolsByName: toolsByName ?? new Map(),
      streamFinalTurn: resolved.stream,
      onEvent,
      onLog: ctx.onLog,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof ZaiHttpError ? err.status : null;
    const aborted = message.toLowerCase().includes("abort");
    await ctx.onLog("stderr", `[zai] request failed: ${message}\n`);
    await onEvent({ kind: "error", message });
    return {
      exitCode: 1,
      signal: null,
      timedOut: aborted,
      errorMessage: aborted ? `Z.AI request timed out after ${resolved.timeoutMs}ms` : message,
      errorCode: status !== null ? `zai_http_${status}` : aborted ? "zai_timeout" : "zai_request_failed",
    };
  }

  const finalResponse = loopResult.finalResponse;
  const summary = extractResultText(finalResponse);
  const usage = buildUsageFromAccumulator(loopResult.totalUsage);
  const model = finalResponse.model ?? resolved.model;

  // Cost reference — always computed at Z.AI pay-as-you-go rates so that
  // management reporting has a consistent USD figure regardless of whether
  // the run was billed through the Coding Plan subscription or the general
  // credits API. billingType tells downstream consumers which of the two
  // actually paid for this run.
  const codingPlan = isCodingPlanEndpoint(resolved.baseUrl);
  const billingType: AdapterBillingType = codingPlan ? "subscription_included" : "api";
  const costUsd = usage ? computeZaiCostUsd(model, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens }) : null;

  if (finalResponse.id) {
    await onEvent({ kind: "model", model, sessionId: finalResponse.id });
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

  // Only emit the final assistant text if the loop terminated cleanly.
  // If exhausted (out of tool turns), emit an error so the run doesn't show
  // a partial-looking final message.
  if (loopResult.exhausted) {
    const message = `Z.AI tool loop exhausted ${maxTurns} turns without producing a final response (still emitting tool_calls).`;
    await ctx.onLog("stderr", `[zai] ${message}\n`);
    await onEvent({ kind: "error", message });
    if (summary) await onEvent({ kind: "assistant_delta", text: summary });
    await ctx.onLog(
      "stdout",
      `[zai] done model=${model} billing=${billingType} turns=${loopResult.turns} exhausted=true\n`,
    );
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      provider: "z.ai",
      biller: "z.ai",
      model,
      billingType,
      ...(usage ? { usage } : {}),
      ...(costUsd !== null ? { costUsd } : {}),
      errorMessage: message,
      errorCode: "zai_tool_loop_exhausted",
      resultJson: asRecord(finalResponse as unknown),
    };
  }

  // Stream the final assistant text as deltas so the UI sees incremental output
  // even though the loop itself ran non-streamed. (We could also stream the
  // last turn directly, but doing it post-hoc keeps the loop logic simple and
  // the user-visible result identical.)
  if (summary) {
    if (resolved.stream) {
      await onEvent({ kind: "assistant_delta", text: summary });
    }
    await onEvent({ kind: "assistant_final", text: summary });
  }

  await ctx.onLog(
    "stdout",
    `[zai] done model=${model} billing=${billingType} turns=${loopResult.turns}${costUsd !== null ? ` cost_usd_ref=${costUsd}` : ""}\n`,
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
    resultJson: asRecord(finalResponse as unknown),
  };
}
