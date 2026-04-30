import fs from "node:fs/promises";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterInvocationMeta,
} from "@paperclipai/adapter-utils";
import {
  buildPaperclipEnv,
  joinPromptSections,
  parseObject,
  renderPaperclipWakePrompt,
  renderTemplate,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import { resolveOllamaConfig } from "./config.js";
import { applyContextOverflow } from "./context-overflow.js";
import {
  createOllamaHttpError,
  openOllamaChat,
  withOllamaRetry,
  type OllamaHttpError,
} from "./http.js";
import { parseOllamaChatStream } from "./parse.js";

interface BuiltTranscript {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  systemChars: number;
  userChars: number;
  instructionsChars: number;
  wakePromptChars: number;
  heartbeatPromptChars: number;
}

/**
 * v1 session codec is stateless: we rebuild the full transcript each heartbeat
 * from the current context. This simplifies compaction (nothing to resume)
 * and matches the plan guardrail "Session codec: stateless for v1".
 */
function buildTranscript(
  ctx: AdapterExecutionContext,
  cfg: ReturnType<typeof resolveOllamaConfig>,
  instructionsPrefix: string,
): BuiltTranscript {
  const { runId, agent, context } = ctx;
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" as const },
    context,
  };
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: false });
  const heartbeatPrompt = renderTemplate(cfg.promptTemplate, templateData);

  const systemParts: string[] = [];
  if (instructionsPrefix.length > 0) systemParts.push(instructionsPrefix);
  systemParts.push(
    [
      "You are running inside Paperclip via the ollama_local adapter.",
      "You respond with plain text. v1 has no tool-calling loop: emit a concise",
      "summary of what should happen next. A human or coding-agent teammate will",
      "execute actions on your behalf.",
    ].join(" "),
  );
  const systemContent = joinPromptSections(systemParts).trim();

  const userContent = joinPromptSections([wakePrompt, heartbeatPrompt]).trim();

  const messages: BuiltTranscript["messages"] = [];
  if (systemContent.length > 0) messages.push({ role: "system", content: systemContent });
  if (userContent.length > 0) messages.push({ role: "user", content: userContent });

  return {
    messages,
    systemChars: systemContent.length,
    userChars: userContent.length,
    instructionsChars: instructionsPrefix.length,
    wakePromptChars: wakePrompt.length,
    heartbeatPromptChars: heartbeatPrompt.length,
  };
}

async function readInstructions(path: string, onLog: AdapterExecutionContext["onLog"]): Promise<string> {
  if (!path) return "";
  try {
    const body = await fs.readFile(path, "utf8");
    return `${body}\n`;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await onLog(
      "stderr",
      `[paperclip] Warning: could not read agent instructions file "${path}": ${reason}\n`,
    );
    return "";
  }
}

function paperclipEnvExposure(agent: { id: string; companyId: string }, runId: string, ctx: AdapterExecutionContext): Record<string, string> {
  const env = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  const context = ctx.context;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    null;
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  if (ctx.authToken) env.PAPERCLIP_API_KEY = ctx.authToken;
  return env;
}

function toResultFromError(
  err: OllamaHttpError,
  cfg: ReturnType<typeof resolveOllamaConfig>,
  extras: { summary?: string | null } = {},
): AdapterExecutionResult {
  const code = err.code;
  const timedOut = code === "timeout";
  return {
    exitCode: 1,
    signal: null,
    timedOut,
    errorMessage: err.hint ? `${err.message} — ${err.hint}` : err.message,
    errorCode: `ollama_${code}`,
    provider: "ollama",
    biller: "ollama",
    model: cfg.model,
    billingType: "subscription_included",
    costUsd: 0,
    summary: extras.summary ?? null,
  };
}

/**
 * Strip userinfo and query string from a base URL so it is safe to log.
 * Falls back to an opaque marker if the URL is unparseable.
 */
function redactBaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.origin;
  } catch {
    return "<unparseable>";
  }
}

interface StructuredHeartbeatLog {
  adapter: "ollama_local";
  model: string;
  baseUrl: string;
  tokensIn: number;
  tokensOut: number;
  elapsedMs: number;
  compacted: boolean;
  status: "ok" | "error" | "timeout";
  errorCode?: string | null;
}

/**
 * Emit a single structured log line per heartbeat so CI integration tests can
 * assert on adapter telemetry without scraping free-form stderr. Stable prefix
 * `[paperclip] ollama_local event=` keeps greppability alongside the JSON payload.
 * Spec: GEM-9 M3 acceptance — structured logger fields on every heartbeat.
 */
async function emitStructuredHeartbeatLog(
  onLog: AdapterExecutionContext["onLog"],
  fields: StructuredHeartbeatLog,
): Promise<void> {
  try {
    const payload = JSON.stringify(fields);
    await onLog("stderr", `[paperclip] ollama_local event=${payload}\n`);
  } catch {
    // logging must never throw out of execute(); swallow and continue.
  }
}

/**
 * Run the Ollama /api/chat request for this heartbeat.
 *
 * Success path:
 *   - POST /api/chat with stream:true, NDJSON parsed incrementally.
 *   - Each token piece is forwarded to onLog("stdout", …) so transcript
 *     watchers see streaming output.
 *   - Final frame populates usage + truncation detection.
 *
 * Error mapping (spec):
 *   - model 404              → errorCode: ollama_model_not_found, hint: ollama pull <model>
 *   - connection refused     → errorCode: ollama_connection_refused, hint: install docs
 *   - context overflow       → warning event + usage, not a fail
 *   - timeout                → timedOut:true, retriable failure
 */
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { agent, runId, onLog, onMeta, config: rawConfig, context } = ctx;
  const cfg = resolveOllamaConfig(rawConfig);
  const startMs = Date.now();
  const redactedBaseUrl = redactBaseUrl(cfg.baseUrl);
  const finalize = async (
    result: AdapterExecutionResult,
    extras: { compacted?: boolean } = {},
  ): Promise<AdapterExecutionResult> => {
    const status: StructuredHeartbeatLog["status"] = result.timedOut
      ? "timeout"
      : result.exitCode === 0
        ? "ok"
        : "error";
    await emitStructuredHeartbeatLog(onLog, {
      adapter: "ollama_local",
      model: cfg.model,
      baseUrl: redactedBaseUrl,
      tokensIn: result.usage?.inputTokens ?? 0,
      tokensOut: result.usage?.outputTokens ?? 0,
      elapsedMs: Date.now() - startMs,
      compacted: extras.compacted ?? false,
      status,
      errorCode: result.errorCode ?? null,
    });
    return result;
  };

  const instructionsPrefix = await readInstructions(cfg.instructionsFilePath, onLog);
  const transcript = buildTranscript(ctx, cfg, instructionsPrefix);

  // Pre-send context-overflow detection. Ollama silently drops earlier tokens
  // when the prompt exceeds num_ctx, so we estimate up front, truncate the
  // trailing user message when needed, and emit a telemetry event regardless
  // of whether truncation succeeded. Post-facto `parsed.truncated` is still
  // surfaced separately through the structured heartbeat log.
  const overflow = applyContextOverflow(transcript.messages, cfg.contextWindow, {
    maxOutputTokens: cfg.maxOutputTokens ?? undefined,
  });
  if (overflow.triggered) {
    const eventPayload = JSON.stringify({
      adapter: "ollama_local",
      contextWindow: cfg.contextWindow,
      budgetTokens: overflow.budgetTokens,
      preTokens: overflow.preTokens,
      postTokens: overflow.postTokens,
      droppedChars: overflow.droppedChars,
      strategy: overflow.strategy,
      phase: "pre_send",
    });
    await onLog(
      "stderr",
      `[paperclip] ollama_local context_overflow event=${eventPayload}\n`,
    );
    transcript.messages = overflow.messages;
    // Keep promptMetrics consistent with what actually goes over the wire.
    const userMsg = overflow.messages.find((m) => m.role === "user");
    if (userMsg) transcript.userChars = userMsg.content.length;
  }

  // Build a non-streaming fallback hint for proxied environments (OPENCLAW_GATEWAY).
  // The gateway adapter sets context.paperclipProxyMode = "openclaw_gateway" when
  // it cannot stream. We honour that by sending stream:false.
  const proxyMode = typeof context.paperclipProxyMode === "string" ? context.paperclipProxyMode : "";
  const disableStream =
    proxyMode === "openclaw_gateway" ||
    parseObject(rawConfig).streamingDisabled === true;
  const stream = !disableStream;

  const displayEnv = paperclipEnvExposure(agent, runId, ctx);
  const invocation: AdapterInvocationMeta = {
    adapterType: "ollama_local",
    command: `POST ${cfg.baseUrl}/api/chat`,
    commandNotes: [
      `Model: ${cfg.model}`,
      `Context window (num_ctx): ${cfg.contextWindow}`,
      `Streaming: ${stream ? "on" : "off (proxy/override)"}`,
      `Keep-alive: ${cfg.keepAliveSec}s`,
      `Request timeout: ${cfg.requestTimeoutSec}s`,
    ],
    commandArgs: [
      "--model", cfg.model,
      "--num-ctx", String(cfg.contextWindow),
      "--stream", stream ? "true" : "false",
    ],
    env: displayEnv,
    prompt: transcript.messages.map((m) => `[${m.role}] ${m.content}`).join("\n\n"),
    promptMetrics: {
      systemChars: transcript.systemChars,
      userChars: transcript.userChars,
      instructionsChars: transcript.instructionsChars,
      wakePromptChars: transcript.wakePromptChars,
      heartbeatPromptChars: transcript.heartbeatPromptChars,
    },
    context,
  };
  if (onMeta) await onMeta(invocation);

  if (transcript.messages.length === 0) {
    const err = createOllamaHttpError(
      "bad_response",
      "No transcript content to send to Ollama (empty system + user).",
      {
        hint: "Check that the agent has a promptTemplate and/or a valid wake payload.",
      },
    );
    return finalize(toResultFromError(err, cfg));
  }

  // Open the chat request. Transient network failures (connection_refused,
  // dns_failure, network_error, timeout, 5xx) retry with exponential backoff.
  // Non-retriable errors (model_not_found, bad_response, aborted, 4xx) surface
  // immediately so the caller/operator can act.
  let opened: Awaited<ReturnType<typeof openOllamaChat>>;
  try {
    opened = await withOllamaRetry(
      () =>
        openOllamaChat(
          cfg.baseUrl,
          {
            model: cfg.model,
            messages: transcript.messages,
            stream,
            keepAliveSec: cfg.keepAliveSec,
            options: {
              num_ctx: cfg.contextWindow,
              temperature: cfg.temperature,
              top_p: cfg.topP,
              ...(cfg.maxOutputTokens ? { num_predict: cfg.maxOutputTokens } : {}),
            },
          },
          cfg.requestTimeoutSec,
        ),
      {
        maxAttempts: 3,
        onRetry: async ({ attempt, delayMs, error }) => {
          await onLog(
            "stderr",
            `[paperclip] ollama_local retry attempt=${attempt} delayMs=${delayMs} code=${error.code}` +
              (error.status ? ` status=${error.status}` : "") +
              `\n`,
          );
        },
      },
    );
  } catch (err) {
    return finalize(toResultFromError(err as OllamaHttpError, cfg));
  }

  try {
    if (!opened.response.body) {
      throw createOllamaHttpError("bad_response", "Ollama returned a response with no body.", {});
    }
    const parsed = stream
      ? await parseOllamaChatStream(opened.response.body, {
          contextWindow: cfg.contextWindow,
          onDelta: async (piece) => {
            await onLog("stdout", piece);
          },
        })
      : await consumeNonStreamingChat(opened.response, cfg, onLog);

    if (parsed.truncated) {
      await onLog(
        "stderr",
        `[paperclip] ollama_local: context truncated (prompt_eval_count >= num_ctx=${cfg.contextWindow}). ` +
          `Ollama does not emit an overflow frame; this warning is synthesised by the adapter.\n`,
      );
    }
    if (parsed.parseErrorCount > 0) {
      await onLog(
        "stderr",
        `[paperclip] ollama_local: dropped ${parsed.parseErrorCount} non-JSON NDJSON line(s).\n`,
      );
    }

    const summary = parsed.assistantText.trim();
    return finalize(
      {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        errorCode: null,
        provider: "ollama",
        biller: "ollama",
        model: cfg.model,
        billingType: "subscription_included",
        costUsd: 0,
        usage: parsed.usage,
        summary: summary.length > 0 ? summary : null,
        resultJson: {
          model: cfg.model,
          contextWindow: cfg.contextWindow,
          doneReason: parsed.finalFrame?.done_reason ?? null,
          truncated: parsed.truncated,
          frameCount: parsed.frameCount,
          parseErrorCount: parsed.parseErrorCount,
        },
      },
      { compacted: parsed.truncated || overflow.triggered },
    );
  } catch (err) {
    if (isOllamaHttpError(err)) {
      return finalize(toResultFromError(err, cfg));
    }
    const message = err instanceof Error ? err.message : String(err);
    return finalize({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Ollama stream failed: ${message}`,
      errorCode: "ollama_stream_error",
      provider: "ollama",
      biller: "ollama",
      model: cfg.model,
      billingType: "subscription_included",
      costUsd: 0,
    });
  } finally {
    opened.cleanupTimer();
  }
}

async function consumeNonStreamingChat(
  response: Response,
  cfg: ReturnType<typeof resolveOllamaConfig>,
  onLog: AdapterExecutionContext["onLog"],
): Promise<import("./parse.js").ParsedOllamaStream> {
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    await onLog(
      "stderr",
      "[paperclip] ollama_local non-streaming response was not valid JSON; treating as empty output.\n",
    );
    return { assistantText: "", finalFrame: null, frameCount: 0, parseErrorCount: 1, truncated: false };
  }
  const obj = json as {
    message?: { content?: string };
    done?: boolean;
    done_reason?: string;
    prompt_eval_count?: number;
    eval_count?: number;
  };
  const assistantText = obj.message?.content ?? "";
  await onLog("stdout", assistantText);
  const promptEvalCount = obj.prompt_eval_count ?? 0;
  const truncated = promptEvalCount >= cfg.contextWindow;
  return {
    assistantText,
    finalFrame: {
      done: true,
      done_reason: obj.done_reason,
      prompt_eval_count: promptEvalCount,
      eval_count: obj.eval_count,
      message: { role: "assistant", content: assistantText },
    },
    frameCount: 1,
    parseErrorCount: 0,
    truncated,
    usage:
      promptEvalCount > 0 || (obj.eval_count ?? 0) > 0
        ? { inputTokens: promptEvalCount, outputTokens: obj.eval_count ?? 0 }
        : undefined,
  };
}

function isOllamaHttpError(err: unknown): err is OllamaHttpError {
  return err instanceof Error && err.name === "OllamaHttpError";
}
