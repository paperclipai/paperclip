import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  buildInvocationEnvForLogs,
  joinPromptSections,
  parseObject,
  renderPaperclipWakePrompt,
  renderTemplate,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_MINIMAX_LOCAL_BASE_URL,
  DEFAULT_MINIMAX_LOCAL_MAX_COMPLETION_TOKENS,
  DEFAULT_MINIMAX_LOCAL_MODEL,
  DEFAULT_MINIMAX_LOCAL_STRIP_THINK,
  DEFAULT_MINIMAX_LOCAL_TEMPERATURE,
} from "../index.js";

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
}

function stripThinkBlocks(value: string): string {
  return value.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function resolveConfiguredCwd(config: Record<string, unknown>): string {
  return firstNonEmptyString(config.cwd, config.workingDirectory) ?? process.cwd();
}

async function readInstructionsPrefix(
  instructionsFilePath: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<string> {
  if (!instructionsFilePath) return "";
  try {
    const contents = await fs.readFile(instructionsFilePath, "utf8");
    const instructionsDir = `${path.dirname(instructionsFilePath)}/`;
    return [
      contents.trim(),
      "",
      `The above agent instructions were loaded from ${instructionsFilePath}. Resolve relative file references from ${instructionsDir}.`,
    ].join("\n");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await onLog(
      "stdout",
      `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
    );
    return "";
  }
}

async function resolveMiniMaxApiKey(config: Record<string, unknown>): Promise<string | null> {
  const env = parseObject(config.env);
  const explicit = firstNonEmptyString(env.MINIMAX_API_KEY, process.env.MINIMAX_API_KEY);
  if (explicit) return explicit;

  const keyFile = firstNonEmptyString(env.MINIMAX_API_KEY_FILE, process.env.MINIMAX_API_KEY_FILE);
  if (!keyFile) return null;
  try {
    const raw = await fs.readFile(keyFile, "utf8");
    return raw.trim() || null;
  } catch {
    return null;
  }
}

function extractAssistantText(payload: Record<string, unknown>): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) continue;
    const message = parseObject((choice as Record<string, unknown>).message);
    const content = message.content;
    if (typeof content === "string" && content.trim().length > 0) return content;
  }
  return "";
}

function buildErrorResult(
  message: string,
  status?: number,
  details?: Record<string, unknown>,
): AdapterExecutionResult {
  const transient = status === 429 || (typeof status === "number" && status >= 500);
  return {
    exitCode: status ?? 1,
    signal: null,
    timedOut: false,
    errorMessage: message,
    errorCode: typeof status === "number" ? `http_${status}` : "minimax_error",
    errorFamily: transient ? "transient_upstream" : null,
    ...(details ? { errorMeta: details } : {}),
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta } = ctx;
  const rawEnv = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const cwd = resolveConfiguredCwd(config);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsPrefix = await readInstructionsPrefix(instructionsFilePath, onLog);
  const model = firstNonEmptyString(config.primaryModel, config.model) ?? DEFAULT_MINIMAX_LOCAL_MODEL;
  const baseUrl = normalizeBaseUrl(
    firstNonEmptyString(config.baseUrl) ?? DEFAULT_MINIMAX_LOCAL_BASE_URL,
  );
  const temperature = asNumber(config.temperature, DEFAULT_MINIMAX_LOCAL_TEMPERATURE);
  const maxCompletionTokens = Math.max(
    1,
    Math.trunc(
      asNumber(
        config.max_completion_tokens,
        asNumber(config.maxTokens, DEFAULT_MINIMAX_LOCAL_MAX_COMPLETION_TOKENS),
      ),
    ),
  );
  const stripThink = config.stripThink === undefined
    ? DEFAULT_MINIMAX_LOCAL_STRIP_THINK
    : config.stripThink !== false;

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: false });
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const prompt = joinPromptSections([
    instructionsPrefix,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars: instructionsPrefix.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const apiKey = await resolveMiniMaxApiKey(config);
  if (!apiKey) {
    const message = "MiniMax API key is missing. Configure MINIMAX_API_KEY or MINIMAX_API_KEY_FILE.";
    await onLog("stderr", `${message}\n`);
    return buildErrorResult(message);
  }

  if (onMeta) {
    await onMeta({
      adapterType: "minimax_local",
      command: `POST ${baseUrl}/chat/completions`,
      cwd,
      commandNotes: [
        "MiniMax Local uses the MiniMax OpenAI-compatible HTTP API directly.",
        stripThink ? "Final output will strip <think>...</think> blocks." : "Final output keeps raw assistant text.",
      ],
      env: buildInvocationEnvForLogs(env, {
        includeRuntimeKeys: [],
        resolvedCommand: "fetch",
      }),
      prompt,
      promptMetrics,
      context,
    });
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature,
      max_tokens: maxCompletionTokens,
    }),
  }).catch((error) => error);

  if (response instanceof Error) {
    const message = `MiniMax request failed: ${redactSecrets(response.message)}`;
    await onLog("stderr", `${message}\n`);
    return buildErrorResult(message);
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const errorRecord = parseObject(payload.error);
    const rawMessage = firstNonEmptyString(
      errorRecord.message,
      payload.message,
      `MiniMax API returned HTTP ${response.status}.`,
    ) ?? `MiniMax API returned HTTP ${response.status}.`;
    const message = redactSecrets(rawMessage);
    await onLog("stderr", `${message}\n`);
    return buildErrorResult(message, response.status, {
      type: firstNonEmptyString(errorRecord.type, payload.type),
    });
  }

  const rawText = extractAssistantText(payload);
  const finalText = stripThink ? stripThinkBlocks(rawText) : rawText.trim();
  if (finalText) {
    await onLog("stdout", `${finalText}\n`);
  }

  const usageRecord = parseObject(payload.usage);
  const inputTokens = Math.max(
    0,
    Math.trunc(asNumber(usageRecord.prompt_tokens, asNumber(usageRecord.input_tokens, 0))),
  );
  const outputTokens = Math.max(
    0,
    Math.trunc(asNumber(usageRecord.completion_tokens, asNumber(usageRecord.output_tokens, 0))),
  );

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: "minimax",
    biller: "minimax",
    model,
    billingType: "api",
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens: Math.max(0, Math.trunc(asNumber(usageRecord.cached_tokens, 0))),
    },
    summary: finalText || null,
    resultJson: {
      id: firstNonEmptyString(payload.id),
      object: firstNonEmptyString(payload.object),
      finishReason: (() => {
        const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
        return firstNonEmptyString(parseObject(choice).finish_reason);
      })(),
      outputText: finalText,
    },
  };
}
