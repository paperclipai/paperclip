/**
 * OpenRouter adapter execute() — multi-turn tool loop.
 *
 * Responsibilities:
 *   - Build messages from Paperclip wake context + skills
 *   - Run a tool-calling loop against OpenRouter's chat/completions endpoint
 *   - Manage issue state (in_progress at start, done/blocked at end)
 *   - Post the final assistant output as an issue comment
 *   - Emit typed TranscriptEntry lines so the run viewer renders properly
 *   - Track usage and cost via OpenRouter's /generation endpoint
 *
 * Out of scope for v1 (deferred to v3):
 *   - Token streaming inside the tool loop (non-streaming is more reliable
 *     for tool calls on free models)
 *   - Approval gate handling (we route hire_agent through approvals, but we
 *     don't yet pause-and-resume runs on async approval callbacks)
 *   - Workspace runtime env vars (we have no child process to pass them to)
 *   - Attachment / multimodal handling
 */

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import fs from "node:fs/promises";
import {
  renderPaperclipWakePrompt,
} from "@paperclipai/adapter-utils/server-utils";

import {
  OPENROUTER_CHAT_ENDPOINT,
  OPENROUTER_GENERATION_ENDPOINT,
  type OpenRouterConfig,
} from "../index.js";
import { PaperclipApi } from "./paperclip-api.js";
import { buildTools, toolSchemas, findTool, type Tool } from "./tools.js";
import { loadSkills, renderSkillsForPrompt } from "./skills.js";
import {
  emitInit,
  emitAssistant,
  emitThinking,
  emitToolCall,
  emitToolResult,
  emitResult,
  emitSystem,
  writeRawStderr,
  type OnLog,
} from "./transcript.js";

// ----- types matching OpenRouter / OpenAI chat completions -----

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    finish_reason: string | null;
    message: {
      role: "assistant";
      content: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

// ----- helpers -----

const DEFAULT_MAX_TURNS = 25;
const DEFAULT_SYSTEM_PROMPT =
  "You are an AI agent working inside Paperclip, an autonomous company orchestration system. " +
  "When you receive a wake payload, your job is to EXECUTE the assigned task — not describe it. " +
  "Use the tools available to you to read context, post comments, update status, and delegate work. " +
  "When finished, call update_issue_status with status='done' and post a summary comment.";

/**
 * Resolve the OpenRouter API key. The Paperclip agent JWT (ctx.authToken) is
 * NEVER a valid OpenRouter key — it is used only for Paperclip API calls via
 * PaperclipApi. This guard fails loudly if the resolved key ever equals the
 * agent JWT or looks like a JWT, so a misconfigured adapterConfig cannot leak
 * the JWT to OpenRouter.
 */
function resolveApiKey(config: OpenRouterConfig, authToken?: string): string {
  const key = config.apiKey || process.env.OPENROUTER_API_KEY || "";
  if (!key) {
    throw new Error(
      "OpenRouter API key not found. Set adapterConfig.apiKey or OPENROUTER_API_KEY env var.",
    );
  }
  // A Paperclip agent JWT is a 3-segment base64url token. Never send it to
  // OpenRouter: a matching value in adapterConfig would be a misconfiguration.
  if (authToken && key === authToken) {
    throw new Error(
      "Refusing to use the Paperclip agent JWT as the OpenRouter API key. Set adapterConfig.apiKey or OPENROUTER_API_KEY to a real OpenRouter key (sk-or-...).",
    );
  }
  if (key.split(".").length === 3 && key.split(".").every((seg) => /^[A-Za-z0-9_-]+$/.test(seg))) {
    throw new Error(
      "Resolved OpenRouter API key looks like a JWT. Refusing to send the Paperclip agent JWT to OpenRouter — set a real OpenRouter key (sk-or-...) in adapterConfig.apiKey or OPENROUTER_API_KEY.",
    );
  }
  return key;
}

function resolveBillingType(config: OpenRouterConfig): "api" | "subscription" {
  // OpenRouter is always API-key based.
  if (config.apiKey || process.env.OPENROUTER_API_KEY) return "api";
  return "api";
}

function buildHeaders(apiKey: string, config: OpenRouterConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": config.httpReferer || "https://paperclip.ing",
    "X-Title": config.xTitle || "Paperclip",
  };
}

function extractCurrentIssueId(context: Record<string, unknown>): string | null {
  const candidates = [
    context.taskId,
    context.issueId,
    context.wakeTaskId,
    (context.paperclipWake as Record<string, unknown> | undefined)?.taskId,
    (context.paperclipWake as Record<string, unknown> | undefined)?.issueId,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return null;
}

function safeParseToolArgs(raw: string): Record<string, unknown> {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function callOpenRouter(
  apiKey: string,
  config: OpenRouterConfig,
  messages: ChatMessage[],
  tools: Tool[],
): Promise<ChatCompletionResponse> {
  const body: Record<string, unknown> = {
    model: config.model || "openrouter/auto",
    messages,
    max_tokens: config.maxTokens ?? 4096,
    temperature: config.temperature ?? 0.7,
    top_p: config.topP ?? 1,
    stream: false,
  };
  if (tools.length > 0) {
    body.tools = toolSchemas(tools);
    body.tool_choice = "auto";
  }
  if (config.reasoning) body.reasoning = { effort: "high" };
  if (config.transforms?.length) body.transforms = config.transforms;
  if (config.route) body.route = config.route;

  const response = await fetch(OPENROUTER_CHAT_ENDPOINT, {
    method: "POST",
    headers: buildHeaders(apiKey, config),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`OpenRouter API error (${response.status}): ${errText}`);
  }

  const json = (await response.json()) as ChatCompletionResponse;
  return json;
}

async function fetchGenerationCost(
  generationId: string,
  apiKey: string,
): Promise<{ costUsd: number | null; inputTokens: number; outputTokens: number }> {
  const fallback = { costUsd: null as number | null, inputTokens: 0, outputTokens: 0 };
  try {
    // OpenRouter's /generation endpoint takes a moment to populate.
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch(`${OPENROUTER_GENERATION_ENDPOINT}?id=${encodeURIComponent(generationId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as { data?: Record<string, unknown> };
    const d = data.data ?? {};
    return {
      costUsd: typeof d.total_cost === "number" ? d.total_cost : null,
      inputTokens: typeof d.tokens_prompt === "number" ? d.tokens_prompt : 0,
      outputTokens: typeof d.tokens_completion === "number" ? d.tokens_completion : 0,
    };
  } catch {
    return fallback;
  }
}

// ----- main -----

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = (ctx.agent.adapterConfig ?? ctx.config) as unknown as OpenRouterConfig & {
    maxTurns?: number;
    autoApprove?: boolean;
  };
  const { context, onLog, agent, authToken } = ctx;

  const model = config.model || "openrouter/auto";
  const maxTurns = typeof config.maxTurns === "number" && config.maxTurns > 0 ? config.maxTurns : DEFAULT_MAX_TURNS;
  const autoApprove = config.autoApprove === true;

  // Tool handlers need a Paperclip API client. If we have no authToken,
  // tools are disabled (model can still respond, just can't act).
  let api: PaperclipApi | null = null;
  let tools: Tool[] = [];
  const currentIssueId = extractCurrentIssueId(context);
  const companyId = agent.companyId;

  if (authToken) {
    api = new PaperclipApi({ authToken });
    tools = buildTools({
      api,
      agentId: agent.id,
      companyId,
      currentIssueId,
      autoApprove,
    });
  } else {
    await writeRawStderr(
      onLog,
      "[openrouter] No authToken on context — tool calls disabled. Agent can only generate text.",
    );
  }

  // Emit init early so the run viewer renders the header.
  await emitInit(onLog, { model, sessionId: ctx.runId });

  // ----- build messages -----

  const messages: ChatMessage[] = [];

  // System prompt = base + skills + optional instructions file
  let systemContent = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

  // If instructionsFilePath is set, read the file and use it as the base.
  // This mirrors the behavior of claude-local / codex-local / etc., letting
  // operators version-control long agent instructions in a markdown file
  // instead of pasting them into the inline systemPrompt field.
  const instructionsFilePath = (config as unknown as Record<string, unknown>).instructionsFilePath;
  if (typeof instructionsFilePath === "string" && instructionsFilePath.trim().length > 0) {
    try {
      const fileContent = await fs.readFile(instructionsFilePath.trim(), "utf8");
      if (fileContent.trim().length > 0) {
        systemContent = fileContent.trim();
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(
        onLog,
        `[openrouter] could not read instructionsFilePath ${instructionsFilePath}: ${reason}. Falling back to systemPrompt.`,
      );
    }
  }
  try {
    const skills = await loadSkills({ agentConfig: config as unknown as Record<string, unknown>, onLog });
    if (skills.length > 0) {
      systemContent = `${systemContent}\n\n${renderSkillsForPrompt(skills)}`;
      await emitSystem(onLog, `Loaded ${skills.length} skill(s): ${skills.map((s) => s.name).join(", ")}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await writeRawStderr(onLog, `[openrouter] skill loading error (continuing): ${reason}`);
  }
  messages.push({ role: "system", content: systemContent });

  // User prompt = Paperclip wake payload rendered as text
  const resumedSession = !!ctx.runtime.sessionId;
  let wakePrompt = "";
  const wakePayload =
    (context.paperclipWake as Record<string, unknown> | undefined) ?? context;
  try {
    wakePrompt = renderPaperclipWakePrompt(wakePayload, { resumedSession }) || "";
  } catch {
    wakePrompt = "";
  }
  messages.push({
    role: "user",
    content: wakePrompt || JSON.stringify(context),
  });

  // ----- check out issue (acquire run lock) -----
  //
  // Paperclip's sameRunLock check rejects any write to an issue (comments,
  // status changes, etc.) unless the issue's checkoutRunId matches the
  // calling run id. The CLI adapters get this for free because Paperclip's
  // wake handler pre-checks-out the issue for them; pure-HTTP adapters
  // don't, so we have to do it ourselves before any tool can mutate state.
  //
  // If checkout fails (issue locked by another live run, project paused,
  // etc.), we log and proceed without tools — same graceful degradation
  // we apply when authToken is missing.

  // If Paperclip's heartbeat dispatcher already stamped this run as the
  // issue's executionRunId, the lock is effectively held by us already and
  // an explicit checkout call would be redundant (and on some Paperclip
  // versions, return a validation error). Detect that and skip.
  const preLocked = (() => {
    const wakeIssue = (context.paperclipWake as Record<string, unknown> | undefined)?.issue as
      | Record<string, unknown>
      | undefined;
    const ctxIssue = (context.issue as Record<string, unknown> | undefined) ?? wakeIssue;
    const execRunId =
      typeof ctxIssue?.executionRunId === "string" ? ctxIssue.executionRunId : null;
    return !!execRunId && execRunId === ctx.runId;
  })();

  let issueLocked = preLocked;
  if (api && currentIssueId && !preLocked) {
    try {
      await api.checkoutIssue(currentIssueId, agent.id);
      issueLocked = true;
    } catch (err) {
      // Best-effort: many runs are dispatched by the heartbeat which already
      // holds the lock for us, so a checkout failure is not necessarily
      // fatal. We try the writes anyway and let Paperclip enforce the real
      // ownership check at write time.
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(
        onLog,
        `[openrouter] checkout call failed for ${currentIssueId}: ${reason}. Continuing — Paperclip may still accept writes if the heartbeat pre-locked the issue.`,
      );
      issueLocked = true;
    }
  }

  // ----- mark issue in_progress -----

  if (api && currentIssueId && issueLocked) {
    try {
      await api.updateIssue(currentIssueId, { status: "in_progress" });
    } catch (err) {
      // Don't fail the run for status updates.
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(onLog, `[openrouter] could not set issue in_progress: ${reason}`);
    }
  }

  // ----- tool loop -----

  let apiKey: string;
  try {
    apiKey = resolveApiKey(config, authToken);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await writeRawStderr(onLog, `[openrouter] ${reason}\n`);
    if (api && currentIssueId) {
      await api
        .updateIssue(currentIssueId, { status: "blocked", statusReason: reason })
        .catch(() => undefined);
    }
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: reason,
      errorCode: "missing_api_key",
      usage: { inputTokens: 0, outputTokens: 0 },
      model,
      provider: "openrouter",
      biller: "openrouter",
      billingType: resolveBillingType(config),
    };
  }

  let lastGenerationId: string | undefined;
  let totalUsage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
  let finalAssistantText = "";
  let turn = 0;
  let stoppedReason: "completed" | "max_turns" | "error" | "repeat_loop" = "completed";
  let runError: { message: string; code: string } | null = null;
  // Repeat-call detection: if the model calls the same tool with the same args
  // three times in a row, break the loop. Prevents 20+ retries when the model
  // misreads an error message and keeps "fixing" it the same wrong way.
  const recentCalls: string[] = [];
  const REPEAT_THRESHOLD = 3;

  try {
    while (turn < maxTurns) {
      turn += 1;

      let response: ChatCompletionResponse;
      try {
        response = await callOpenRouter(apiKey, config, messages, tools);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        runError = { message: reason, code: "openrouter_request_failed" };
        stoppedReason = "error";
        break;
      }

      lastGenerationId = response.id || lastGenerationId;
      if (response.usage) {
        totalUsage = {
          inputTokens: totalUsage.inputTokens + (response.usage.prompt_tokens ?? 0),
          outputTokens: totalUsage.outputTokens + (response.usage.completion_tokens ?? 0),
        };
      }

      const choice = response.choices?.[0];
      if (!choice) {
        runError = { message: "OpenRouter returned no choices", code: "openrouter_empty_response" };
        stoppedReason = "error";
        break;
      }

      const msg = choice.message;
      const reasoning = typeof msg.reasoning === "string" ? msg.reasoning : "";
      const text = typeof msg.content === "string" ? msg.content : "";
      const toolCalls = msg.tool_calls ?? [];

      if (reasoning) {
        await emitThinking(onLog, reasoning);
      }
      if (text) {
        await emitAssistant(onLog, text);
        finalAssistantText = text;
      }

      // No tool calls => model is done.
      if (toolCalls.length === 0) {
        stoppedReason = "completed";
        break;
      }

      // Add the assistant message (with tool_calls) so the model sees its own request.
      messages.push({
        role: "assistant",
        content: text,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      });

      // Execute each tool call and append the results.
      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        const args = safeParseToolArgs(tc.function.arguments);
        await emitToolCall(onLog, { name: toolName, input: args, toolUseId: tc.id });

        const tool = findTool(tools, toolName);
        let resultContent: string;
        let isError: boolean;
        if (!tool) {
          resultContent = JSON.stringify({ error: `Unknown tool: ${toolName}` });
          isError = true;
        } else {
          try {
            const out = await tool.execute(args);
            resultContent = out.content;
            isError = out.isError;
          } catch (err) {
            resultContent = JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            });
            isError = true;
          }
        }

        await emitToolResult(onLog, {
          toolUseId: tc.id,
          toolName,
          content: resultContent,
          isError,
        });

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: resultContent,
        });

        // Track repeat calls
        const callSig = `${toolName}::${JSON.stringify(args)}`;
        recentCalls.push(callSig);
        if (recentCalls.length > REPEAT_THRESHOLD) recentCalls.shift();
        if (
          recentCalls.length === REPEAT_THRESHOLD &&
          recentCalls.every((s) => s === callSig)
        ) {
          await writeRawStderr(
            onLog,
            `[openrouter] Tool "${toolName}" called ${REPEAT_THRESHOLD}x with identical args — breaking loop.`,
          );
          runError = {
            message: `Tool "${toolName}" was called ${REPEAT_THRESHOLD} times in a row with identical arguments. The model is stuck in a retry loop.`,
            code: "tool_repeat_loop",
          };
          stoppedReason = "repeat_loop";
          break;
        }
      }
      if (stoppedReason === "repeat_loop") break;
    }

    if (turn >= maxTurns && stoppedReason !== "error") {
      stoppedReason = "max_turns";
      await writeRawStderr(onLog, `[openrouter] hit max_turns (${maxTurns}), stopping`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    runError = { message: reason, code: "openrouter_loop_failed" };
    stoppedReason = "error";
  }

  // ----- post-loop: cost, comment, status -----

  let costUsd: number | null = null;
  if (lastGenerationId) {
    const cost = await fetchGenerationCost(lastGenerationId, apiKey);
    costUsd = cost.costUsd;
    // Prefer the generation endpoint's token counts when present (more accurate).
    if (cost.inputTokens > 0 || cost.outputTokens > 0) {
      totalUsage = { inputTokens: cost.inputTokens, outputTokens: cost.outputTokens };
    }
  }

  // Post the final assistant text as a comment so other agents can see it.
  if (api && currentIssueId && finalAssistantText.trim().length > 0) {
    try {
      await api.addIssueComment(currentIssueId, { body: finalAssistantText });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await writeRawStderr(onLog, `[openrouter] could not post final comment: ${reason}`);
    }
  }

  // Update issue status based on outcome.
  if (api && currentIssueId) {
    let nextStatus: string | null = null;
    let statusReason: string | null = null;
    if (stoppedReason === "completed") {
      nextStatus = "done";
    } else if (stoppedReason === "max_turns") {
      nextStatus = "blocked";
      statusReason = `Hit max_turns (${maxTurns}) without completing`;
    } else if (stoppedReason === "repeat_loop" && runError) {
      nextStatus = "blocked";
      statusReason = runError.message;
    } else if (stoppedReason === "error" && runError) {
      nextStatus = "blocked";
      statusReason = runError.message;
    }
    if (nextStatus) {
      try {
        await api.updateIssue(currentIssueId, { status: nextStatus, statusReason });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await writeRawStderr(onLog, `[openrouter] could not update final status: ${reason}`);
      }
    }
  }

  // Emit the final result transcript entry.
  await emitResult(onLog, {
    text: finalAssistantText,
    inputTokens: totalUsage.inputTokens,
    outputTokens: totalUsage.outputTokens,
    costUsd: costUsd ?? 0,
    subtype: stoppedReason,
    isError: stoppedReason === "error",
    errors: runError ? [runError.message] : [],
  });

  if (stoppedReason === "error" && runError) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: runError.message,
      errorCode: runError.code,
      usage: totalUsage,
      model,
      provider: "openrouter",
      biller: "openrouter",
      billingType: resolveBillingType(config),
      costUsd,
      sessionId: lastGenerationId ?? null,
      sessionDisplayId: lastGenerationId ?? null,
      sessionParams: lastGenerationId ? { lastGenerationId } : null,
    };
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    usage: totalUsage,
    model,
    provider: "openrouter",
    biller: "openrouter",
    billingType: resolveBillingType(config),
    costUsd,
    sessionId: lastGenerationId ?? null,
    sessionDisplayId: lastGenerationId ?? null,
    sessionParams: lastGenerationId ? { lastGenerationId } : null,
    summary: finalAssistantText.slice(0, 500),
  };
}
