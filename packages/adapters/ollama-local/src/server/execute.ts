import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  buildPaperclipEnv,
  parseObject,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL } from "../index.js";

export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaChunkLine {
  type: "chunk";
  content: string;
}

export interface OllamaDoneLine {
  type: "done";
  model: string;
  prompt_eval_count: number;
  eval_count: number;
  total_duration_ns: number;
}

export interface OllamaErrorLine {
  type: "error";
  message: string;
}

export type OllamaStdoutLine = OllamaChunkLine | OllamaDoneLine | OllamaErrorLine;

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant integrated into the Paperclip control plane. Respond concisely and helpfully.";

function buildContextNote(context: Record<string, unknown>): string {
  const parts: string[] = [];
  const taskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim()
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim()
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim()
      ? context.approvalStatus.trim()
      : null;
  if (taskId) parts.push(`Task ID: ${taskId}`);
  if (wakeReason) parts.push(`Wake reason: ${wakeReason}`);
  if (wakeCommentId) parts.push(`Wake comment ID: ${wakeCommentId}`);
  if (approvalId) parts.push(`Approval ID: ${approvalId}`);
  if (approvalStatus) parts.push(`Approval status: ${approvalStatus}`);
  return parts.join("\n");
}

/**
 * Try to resolve a possibly-untagged model name (e.g. "llama3.2") to the exact
 * name Ollama has installed (e.g. "llama3.2:3b").  Falls back to the original
 * name if the tags API is unavailable or no match is found.
 */
async function resolveModelName(baseUrl: string, requested: string): Promise<string> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return requested;
    const body = (await res.json()) as Record<string, unknown>;
    if (!Array.isArray(body.models)) return requested;
    const names: string[] = (body.models as Record<string, unknown>[])
      .filter((m) => typeof m.name === "string")
      .map((m) => m.name as string);

    // 1. Exact match
    if (names.includes(requested)) return requested;

    // 2. Exact match ignoring case
    const lower = requested.toLowerCase();
    const exact = names.find((n) => n.toLowerCase() === lower);
    if (exact) return exact;

    // 3. Base-name match (strip tag from both sides)
    const requestedBase = requested.split(":")[0].toLowerCase();
    const baseMatch = names.find(
      (n) => n.split(":")[0].toLowerCase() === requestedBase,
    );
    if (baseMatch) return baseMatch;
  } catch {
    // network error / timeout — continue with original name
  }
  return requested;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta } = ctx;

  const baseUrl = asString(config.baseUrl, DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, "");
  const rawModel = asString(config.model, DEFAULT_OLLAMA_MODEL).trim();
  const timeoutSec = asNumber(config.timeoutSec, 300);
  const temperature =
    typeof config.temperature === "number" && Number.isFinite(config.temperature)
      ? config.temperature
      : undefined;
  const systemPrompt = asString(config.system, DEFAULT_SYSTEM_PROMPT);

  // Resolve the model name against what Ollama actually has installed.
  // e.g. config says "llama3.2" but Ollama stores it as "llama3.2:3b".
  const model = await resolveModelName(baseUrl, rawModel);

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId },
    context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);

  // Annotate user message with Paperclip context
  const contextNote = buildContextNote(context);
  const userContent = contextNote.length > 0 ? `${contextNote}\n\n${renderedPrompt}` : renderedPrompt;

  // Rehydrate prior conversation history from session
  const sessionParams = parseObject(runtime.sessionParams);
  const priorMessages: OllamaMessage[] = (() => {
    if (!Array.isArray(sessionParams.messages)) return [];
    return (sessionParams.messages as unknown[]).filter(
      (m): m is OllamaMessage =>
        typeof m === "object" &&
        m !== null &&
        !Array.isArray(m) &&
        (typeof (m as Record<string, unknown>).role === "string") &&
        (typeof (m as Record<string, unknown>).content === "string"),
    );
  })();

  const messages: OllamaMessage[] = [
    { role: "system", content: systemPrompt },
    ...priorMessages,
    { role: "user", content: userContent },
  ];

  // Emit Paperclip-standard env vars for logging/meta (no subprocess, but agent needs context)
  const paperclipEnv = buildPaperclipEnv(agent);

  if (onMeta) {
    await onMeta({
      adapterType: "ollama_local",
      command: `POST ${baseUrl}/api/chat`,
      cwd: process.cwd(),
      commandNotes: [
        `Model: ${model}`,
        `Prior conversation turns: ${Math.floor(priorMessages.length / 2)}`,
        `Streaming: true`,
      ],
      commandArgs: [],
      env: {
        PAPERCLIP_AGENT_ID: paperclipEnv.PAPERCLIP_AGENT_ID ?? agent.id,
        PAPERCLIP_COMPANY_ID: paperclipEnv.PAPERCLIP_COMPANY_ID ?? agent.companyId,
      },
      prompt: userContent,
      promptMetrics: {
        promptChars: userContent.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      context,
    });
  }

  // Set up AbortController for timeout
  const controller = new AbortController();
  let timedOut = false;
  const timeoutHandle =
    timeoutSec > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutSec * 1000)
      : null;

  let assistantContent = "";
  let promptEvalCount = 0;
  let evalCount = 0;
  let exitCode: number | null = null;
  let errorMessage: string | null = null;

  try {
    const requestBody: Record<string, unknown> = {
      model,
      messages,
      stream: true,
    };
    if (temperature !== undefined) {
      requestBody.options = { temperature };
    }

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const errMsg = bodyText.trim() || `HTTP ${response.status} ${response.statusText}`;
      const errLine: OllamaErrorLine = { type: "error", message: errMsg };
      await onLog("stderr", JSON.stringify(errLine) + "\n");
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Ollama returned ${response.status}: ${errMsg}`,
        provider: "ollama",
        model,
        resultJson: { error: errMsg },
      };
    }

    if (!response.body) {
      throw new Error("Ollama response has no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          await onLog("stdout", line + "\n");
          continue;
        }

        const isDone = parsed.done === true;
        const messageObj =
          typeof parsed.message === "object" && parsed.message !== null
            ? (parsed.message as Record<string, unknown>)
            : null;
        const contentChunk =
          typeof messageObj?.content === "string" ? messageObj.content : "";

        if (!isDone && contentChunk) {
          assistantContent += contentChunk;
          const chunkLine: OllamaChunkLine = { type: "chunk", content: contentChunk };
          await onLog("stdout", JSON.stringify(chunkLine) + "\n");
        }

        if (isDone) {
          promptEvalCount =
            typeof parsed.prompt_eval_count === "number" ? parsed.prompt_eval_count : 0;
          evalCount = typeof parsed.eval_count === "number" ? parsed.eval_count : 0;
          const totalDurationNs =
            typeof parsed.total_duration === "number" ? parsed.total_duration : 0;
          const doneLine: OllamaDoneLine = {
            type: "done",
            model: typeof parsed.model === "string" ? parsed.model : model,
            prompt_eval_count: promptEvalCount,
            eval_count: evalCount,
            total_duration_ns: totalDurationNs,
          };
          await onLog("stdout", JSON.stringify(doneLine) + "\n");
        }
      }
    }

    exitCode = 0;
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (timedOut) {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        provider: "ollama",
        model,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("ECONNREFUSED") ||
      msg.includes("fetch failed") ||
      msg.includes("connect EREFUSED") ||
      msg.includes("Failed to fetch")
    ) {
      const errLine: OllamaErrorLine = {
        type: "error",
        message: `Cannot reach Ollama at ${baseUrl}: ${msg}`,
      };
      await onLog("stderr", JSON.stringify(errLine) + "\n");
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Cannot reach Ollama at ${baseUrl}. Is Ollama running? Run: ollama serve`,
        errorCode: "ollama_not_running",
        provider: "ollama",
        model,
      };
    }
    const errLine: OllamaErrorLine = { type: "error", message: msg };
    await onLog("stderr", JSON.stringify(errLine) + "\n");
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: msg,
      provider: "ollama",
      model,
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  // Build updated session params with appended message history
  const updatedMessages: OllamaMessage[] = [
    ...priorMessages,
    { role: "user", content: userContent },
    ...(assistantContent ? [{ role: "assistant" as const, content: assistantContent }] : []),
  ];

  return {
    exitCode,
    signal: null,
    timedOut: false,
    errorMessage: exitCode === 0 ? null : (errorMessage ?? `Ollama exited with code ${exitCode}`),
    usage:
      promptEvalCount || evalCount
        ? { inputTokens: promptEvalCount, outputTokens: evalCount }
        : undefined,
    provider: "ollama",
    model,
    billingType: "subscription",
    sessionParams: updatedMessages.length > 0 ? { messages: updatedMessages } : null,
    summary: assistantContent.trim() || null,
  };
}
