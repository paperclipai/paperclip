import {
  asBoolean,
  asNumber,
  asString,
  parseObject,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { DEFAULT_OLLAMA_ENDPOINT, DEFAULT_OLLAMA_MODEL } from "../index.js";

interface OllamaChatRequest {
  model: string;
  stream: false;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  options?: Record<string, unknown>;
}

interface OllamaChatResponse {
  model?: string;
  created_at?: string;
  message?: { role?: string; content?: string };
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

function normalizeEndpoint(raw: unknown): string {
  const value = asString(raw, DEFAULT_OLLAMA_ENDPOINT).trim();
  const candidate = value.length > 0 ? value : DEFAULT_OLLAMA_ENDPOINT;
  return candidate.replace(/\/+$/, "");
}

function buildPrompt(ctx: AdapterExecutionContext, promptTemplate: string): string {
  const sections: string[] = [];
  if (promptTemplate.trim().length > 0) {
    sections.push(promptTemplate.trim());
  }
  const wakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake);
  if (wakePrompt) sections.push(wakePrompt);
  const wakeJson = stringifyPaperclipWakePayload(ctx.context.paperclipWake);
  if (wakeJson) {
    sections.push(`Structured wake payload JSON:\n\`\`\`json\n${wakeJson}\n\`\`\``);
  }
  if (sections.length === 0) {
    sections.push("You are a Paperclip agent. Continue your assigned work.");
  }
  return sections.join("\n\n");
}

async function postCommentToIssue(input: {
  apiUrl: string;
  authToken: string;
  runId: string;
  issueId: string;
  body: string;
}): Promise<{ ok: boolean; errorMessage?: string }> {
  try {
    const res = await fetch(`${input.apiUrl.replace(/\/+$/, "")}/api/issues/${input.issueId}/comments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.authToken}`,
        "x-paperclip-run-id": input.runId,
      },
      body: JSON.stringify({ body: input.body }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, errorMessage: `comment POST returned ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = parseObject(ctx.config);
  const endpoint = normalizeEndpoint(config.endpoint);
  const model = asString(config.model, DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL;
  const options = parseObject(config.options);
  const timeoutSec = Math.max(1, Math.floor(asNumber(config.timeoutSec, 300)));
  const promptTemplate = asString(config.promptTemplate, "");
  const postComment = asBoolean(config.postCommentToIssue, true);

  const prompt = buildPrompt(ctx, promptTemplate);
  const messages: OllamaChatRequest["messages"] = [{ role: "user", content: prompt }];

  await ctx.onLog(
    "stdout",
    `[ollama-local] POST ${endpoint}/api/chat model=${model} promptChars=${prompt.length}\n`,
  );

  if (ctx.onMeta) {
    await ctx.onMeta({
      adapterType: "ollama_local",
      command: "ollama",
      commandArgs: ["http", endpoint, "/api/chat"],
      context: ctx.context,
      prompt,
      promptMetrics: { promptChars: prompt.length },
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

  let responseJson: OllamaChatResponse;
  try {
    const requestBody: OllamaChatRequest = {
      model,
      stream: false,
      messages,
      ...(Object.keys(options).length > 0 ? { options } : {}),
    };
    const res = await fetch(`${endpoint}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const trimmed = text.slice(0, 400);
      await ctx.onLog("stderr", `[ollama-local] HTTP ${res.status}: ${trimmed}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Ollama /api/chat returned ${res.status}: ${trimmed}`,
        errorCode: res.status === 404 ? "ollama_model_not_found" : "ollama_http_error",
      };
    }
    responseJson = (await res.json()) as OllamaChatResponse;
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    const message = err instanceof Error ? err.message : String(err);
    await ctx.onLog("stderr", `[ollama-local] request failed: ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: aborted,
      errorMessage: aborted
        ? `Ollama request timed out after ${timeoutSec}s`
        : `Ollama request failed: ${message}`,
      errorCode: aborted ? "ollama_timeout" : "ollama_request_failed",
    };
  } finally {
    clearTimeout(timer);
  }

  const content = (responseJson.message?.content ?? "").trim();
  const tokensIn = Math.max(0, Math.floor(responseJson.prompt_eval_count ?? 0));
  const tokensOut = Math.max(0, Math.floor(responseJson.eval_count ?? 0));

  await ctx.onLog(
    "stdout",
    `[ollama-local] response done=${responseJson.done ?? false} tokensIn=${tokensIn} tokensOut=${tokensOut} responseChars=${content.length}\n`,
  );

  const issueId =
    asString(ctx.context.issueId, "").trim() || asString(ctx.context.taskId, "").trim();
  let commentPostError: string | null = null;
  if (postComment && issueId && ctx.authToken && content.length > 0) {
    const apiUrl =
      asString(ctx.context.paperclipApiUrl, "").trim() ||
      asString(process.env.PAPERCLIP_API_URL, "").trim();
    if (apiUrl) {
      const commentResult = await postCommentToIssue({
        apiUrl,
        authToken: ctx.authToken,
        runId: ctx.runId,
        issueId,
        body: content,
      });
      if (!commentResult.ok) {
        commentPostError = commentResult.errorMessage ?? "unknown error";
        await ctx.onLog(
          "stderr",
          `[ollama-local] failed to post issue comment: ${commentPostError}\n`,
        );
      } else {
        await ctx.onLog("stdout", `[ollama-local] posted issue comment to ${issueId}\n`);
      }
    } else {
      await ctx.onLog(
        "stderr",
        "[ollama-local] postCommentToIssue requested but no PAPERCLIP_API_URL is set; skipping\n",
      );
    }
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: "ollama",
    biller: "ollama_local",
    model,
    billingType: "subscription",
    usage: tokensIn > 0 || tokensOut > 0
      ? { inputTokens: tokensIn, outputTokens: tokensOut }
      : undefined,
    costUsd: 0,
    summary: content.length > 0 ? content : null,
    resultJson: {
      done: responseJson.done ?? false,
      done_reason: responseJson.done_reason ?? null,
      total_duration_ns: responseJson.total_duration ?? null,
      load_duration_ns: responseJson.load_duration ?? null,
      prompt_eval_count: tokensIn,
      eval_count: tokensOut,
      ...(commentPostError ? { commentPostError } : {}),
    },
  };
}
