import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asNumber, asString, parseObject, renderTemplate } from "../utils.js";
import {
  chooseBestOllamaModel,
  fetchOllamaJson,
  parseOllamaTagEntries,
  rankOllamaModels,
  readOllamaHttpAgentRole,
  resolveOllamaHttpDiscoveryConfig,
  type OllamaTagEntry,
} from "./model-discovery.js";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
  renderPaperclipWakePrompt,
} from "@paperclipai/adapter-utils/server-utils";

const AUTO_MODEL_ATTEMPT_LIMIT = 3;
const OLLAMA_TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 524]);

type OllamaHttpAttempt = {
  model: string;
  ok?: boolean;
  status?: number;
  timedOut?: boolean;
  error?: string | null;
};

function shouldRetryModelAttempt(input: {
  attemptIndex: number;
  candidateCount: number;
  explicitModel: boolean;
  timedOut?: boolean;
  status?: number;
}) {
  if (input.explicitModel) return false;
  if (input.attemptIndex >= input.candidateCount - 1) return false;
  if (input.timedOut) return true;
  if (typeof input.status === "number") {
    return input.status === 408 || input.status === 429 || input.status >= 500;
  }
  return false;
}

function isTransientOllamaHttpStatus(status: number) {
  return OLLAMA_TRANSIENT_HTTP_STATUSES.has(status) || status >= 500;
}

function readRetryNotBeforeFromResponse(input: {
  responseJson: unknown;
  responseText?: string | null;
  now?: Date;
}) {
  const parsed = parseObject(input.responseJson);
  const retryAfterSec = asNumber(parsed.retry_after, 0);
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    const now = input.now ?? new Date();
    return new Date(now.getTime() + Math.ceil(retryAfterSec) * 1000).toISOString();
  }

  const retryAfterMs = asNumber(parsed.retry_after_ms, 0);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    const now = input.now ?? new Date();
    return new Date(now.getTime() + Math.ceil(retryAfterMs)).toISOString();
  }

  return null;
}

function readOllamaHttpStreamFlag(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
  }
  return true;
}

function parseOllamaStreamingChatText(text: string) {
  const lines = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const contentChunks: string[] = [];
  let parsedChunkCount = 0;
  let responseError = "";
  let finalChunk: Record<string, unknown> = {};

  for (const line of lines) {
    let chunk: Record<string, unknown>;
    try {
      chunk = parseObject(JSON.parse(line));
    } catch {
      continue;
    }

    parsedChunkCount += 1;
    finalChunk = {
      ...finalChunk,
      ...chunk,
    };

    const message = parseObject(chunk.message);
    const content = asString(message.content, asString(chunk.response, ""));
    if (content) contentChunks.push(content);

    const chunkError = asString(chunk.error, "").trim();
    if (chunkError) responseError = chunkError;
  }

  const content = contentChunks.join("").trim();
  return {
    parsedChunkCount,
    responseJson: parsedChunkCount > 0
      ? {
          ...finalChunk,
          stream: true,
          streamChunkCount: parsedChunkCount,
          response: content,
          message: {
            ...parseObject(finalChunk.message),
            content,
          },
        }
      : {},
    content,
    responseError,
  };
}

function parseOllamaChatResponse(input: {
  responseJson: unknown;
  responseText: string;
  streamed: boolean;
}) {
  if (input.streamed) {
    const streamed = parseOllamaStreamingChatText(input.responseText);
    if (streamed.parsedChunkCount > 0) return streamed;
  }

  const responseJson = parseObject(input.responseJson);
  const message = parseObject(responseJson.message);
  const content = asString(message.content, asString(responseJson.response, "")).trim();
  const responseError = asString(responseJson.error, "").trim();
  return {
    parsedChunkCount: 0,
    responseJson,
    content,
    responseError,
  };
}

function buildTransientOllamaMetadata(input: {
  status?: number | null;
  timedOut?: boolean;
  responseJson?: unknown;
}) {
  const isTransient = input.timedOut || (typeof input.status === "number" && isTransientOllamaHttpStatus(input.status));
  if (!isTransient) return null;

  return {
    errorFamily: "transient_upstream" as const,
    retryNotBefore: input.responseJson
      ? readRetryNotBeforeFromResponse({ responseJson: input.responseJson })
      : null,
  };
}

async function buildPrompt(ctx: AdapterExecutionContext): Promise<string> {
  const { runId, agent, config, context, runtime, onLog } = ctx;
  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const configuredCwd = asString(config.cwd, "");
  const cwd = workspaceCwd || configuredCwd || process.cwd();
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const resolvedInstructionsFilePath = instructionsFilePath
    ? path.resolve(cwd, instructionsFilePath)
    : "";
  const instructionsDir = resolvedInstructionsFilePath ? `${path.dirname(resolvedInstructionsFilePath)}/` : "";

  let instructionsPrefix = "";
  if (resolvedInstructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read Ollama fallback instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
      );
    }
  }

  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const resumedSession = Boolean(runtime.sessionId || runtime.sessionDisplayId || runtime.sessionParams);
  const renderedBootstrapPrompt =
    !resumedSession && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession });
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const taskContextNote = asString(context.paperclipTaskMarkdown, "").trim();
  const renderedPrompt = renderTemplate(promptTemplate, templateData);

  return joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
    renderedPrompt,
  ]);
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { agent, config, onLog, onMeta } = ctx;
  const {
    chatUrl,
    explicitModel,
    headers,
    modelPreference,
    tagsUrl,
    timeoutMs,
  } = resolveOllamaHttpDiscoveryConfig(config, {
    agentRole: readOllamaHttpAgentRole(agent as unknown as { role?: unknown }),
  });
  const prompt = await buildPrompt(ctx);

  const hasExplicitModel = Boolean(explicitModel && explicitModel.toLowerCase() !== "auto");
  let selectedModel = hasExplicitModel ? explicitModel : "";
  let discoveredModels: OllamaTagEntry[] = [];
  let candidateModels: string[] = [];
  const attemptedModels: OllamaHttpAttempt[] = [];

  if (!selectedModel) {
    const tagsResponse = await fetchOllamaJson({
      url: tagsUrl,
      headers,
      timeoutMs,
    });
    if (!tagsResponse.ok) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "ollama_model_discovery_failed",
        errorMessage: `Ollama model discovery failed with HTTP ${tagsResponse.status}.`,
        resultJson: {
          tagsUrl: tagsUrl.toString(),
          status: tagsResponse.status,
          responseText: tagsResponse.text,
        },
      };
    }

    discoveredModels = parseOllamaTagEntries(tagsResponse.json);
    const rankedCandidates = rankOllamaModels(discoveredModels, modelPreference)
      .map((entry) => entry.name || entry.model)
      .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
    const chosen = chooseBestOllamaModel(discoveredModels, modelPreference);
    if (!chosen) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "ollama_model_unavailable",
        errorMessage: "Ollama model discovery returned no usable models.",
        resultJson: {
          tagsUrl: tagsUrl.toString(),
          modelPreference,
          discoveredModelCount: discoveredModels.length,
        },
      };
    }
    selectedModel = chosen.name || chosen.model;
    candidateModels = rankedCandidates.slice(0, AUTO_MODEL_ATTEMPT_LIMIT);
  }

  if (candidateModels.length === 0 && selectedModel) {
    candidateModels = [selectedModel];
  }

  if (onMeta) {
    await onMeta({
      adapterType: "ollama_http",
      command: `POST ${chatUrl.toString()}`,
      cwd: asString(parseObject(ctx.context.paperclipWorkspace).cwd, asString(config.cwd, process.cwd())),
      commandNotes: [
        hasExplicitModel
          ? `Using configured Ollama model ${selectedModel}.`
          : `Auto-selected Ollama model ${selectedModel} using ${modelPreference} preference.`,
        !hasExplicitModel && candidateModels.length > 1
          ? `If a retryable timeout or upstream failure occurs, Paperclip will try up to ${candidateModels.length} ranked Ollama models automatically.`
          : null,
        `Model discovery endpoint: ${tagsUrl.toString()}`,
      ].filter((note): note is string => typeof note === "string" && note.length > 0),
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
      },
      context: ctx.context,
    });
  }

  const temperature = config.temperature;
  const keepAlive = asString(config.keepAlive, "").trim();
  const streamed = readOllamaHttpStreamFlag(config.stream);

  for (const [attemptIndex, candidateModel] of candidateModels.entries()) {
    selectedModel = candidateModel;
    const requestBody: Record<string, unknown> = {
      model: candidateModel,
      stream: streamed,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    };
    if (typeof temperature === "number" && Number.isFinite(temperature)) {
      requestBody.options = {
        temperature,
      };
    }
    if (keepAlive) requestBody.keep_alive = keepAlive;

    try {
      const response = await fetchOllamaJson({
        url: chatUrl,
        method: "POST",
        headers,
        body: requestBody,
        timeoutMs,
      });
      if (!response.ok) {
        const transient = buildTransientOllamaMetadata({
          status: response.status,
          responseJson: response.json,
        });
        attemptedModels.push({
          model: candidateModel,
          ok: false,
          status: response.status,
          error: `HTTP ${response.status}`,
        });

        const shouldRetry = shouldRetryModelAttempt({
          attemptIndex,
          candidateCount: candidateModels.length,
          explicitModel: hasExplicitModel,
          status: response.status,
        });
        if (shouldRetry) {
          await onLog(
            "stdout",
            `[paperclip] Ollama model ${candidateModel} failed with HTTP ${response.status}; retrying with the next ranked model.\n`,
          );
          continue;
        }

        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: "ollama_http_request_failed",
          errorMessage: `Ollama chat request failed with HTTP ${response.status}.`,
          errorFamily: transient?.errorFamily,
          retryNotBefore: transient?.retryNotBefore ?? undefined,
          provider: "ollama",
          biller: "ollama",
          model: candidateModel,
          resultJson: {
            chatUrl: chatUrl.toString(),
            status: response.status,
            responseText: response.text,
            selectedModel: candidateModel,
            modelPreference,
            ...(transient?.errorFamily ? { errorFamily: transient.errorFamily } : {}),
            ...(transient?.retryNotBefore ? { retryNotBefore: transient.retryNotBefore } : {}),
            attemptedModels,
            candidateModels: hasExplicitModel ? undefined : candidateModels,
          },
        };
      }

      const parsedChat = parseOllamaChatResponse({
        responseJson: response.json,
        responseText: response.text,
        streamed,
      });
      const responseJson = parseObject(parsedChat.responseJson);
      const content = parsedChat.content;
      const responseError = parsedChat.responseError;
      attemptedModels.push({
        model: candidateModel,
        ok: responseError.length === 0 && content.length > 0,
        status: response.status,
        error: responseError || null,
      });
      if (responseError) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: "ollama_http_request_failed",
          errorMessage: responseError,
          provider: "ollama",
          biller: "ollama",
          model: candidateModel,
          resultJson: {
            ...responseJson,
            selectedModel: candidateModel,
            modelPreference,
            attemptedModels,
            candidateModels: hasExplicitModel ? undefined : candidateModels,
          },
        };
      }
      if (!content) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: "ollama_http_response_invalid",
          errorMessage: "Ollama returned no message content.",
          provider: "ollama",
          biller: "ollama",
          model: candidateModel,
          resultJson: {
            ...responseJson,
            selectedModel: candidateModel,
            modelPreference,
            attemptedModels,
            candidateModels: hasExplicitModel ? undefined : candidateModels,
          },
        };
      }

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider: "ollama",
        biller: "ollama",
        model: candidateModel,
        billingType: "unknown",
        usage: {
          inputTokens: Math.max(0, Math.floor(asNumber(responseJson.prompt_eval_count, 0))),
          outputTokens: Math.max(0, Math.floor(asNumber(responseJson.eval_count, 0))),
        },
        summary: content,
        resultJson: {
          ...responseJson,
          selectedModel: candidateModel,
          modelPreference,
          attemptedModels,
          candidateModels: hasExplicitModel ? undefined : candidateModels,
          discoveredModelCount: discoveredModels.length || undefined,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const timedOut = /timed out/i.test(message);
      const transient = buildTransientOllamaMetadata({ timedOut });
      attemptedModels.push({
        model: candidateModel,
        ok: false,
        timedOut,
        error: message,
      });

      const shouldRetry = shouldRetryModelAttempt({
        attemptIndex,
        candidateCount: candidateModels.length,
        explicitModel: hasExplicitModel,
        timedOut,
      });
      if (shouldRetry) {
        await onLog(
          "stdout",
          `[paperclip] Ollama model ${candidateModel} timed out; retrying with the next ranked model.\n`,
        );
        continue;
      }

      return {
        exitCode: timedOut ? null : 1,
        signal: null,
        timedOut,
        errorCode: timedOut ? "timeout" : "ollama_http_request_failed",
        errorMessage: message,
        errorFamily: transient?.errorFamily,
        retryNotBefore: transient?.retryNotBefore ?? undefined,
        provider: "ollama",
        biller: "ollama",
        model: candidateModel,
        resultJson: {
          chatUrl: chatUrl.toString(),
          selectedModel: candidateModel,
          modelPreference,
          ...(transient?.errorFamily ? { errorFamily: transient.errorFamily } : {}),
          ...(transient?.retryNotBefore ? { retryNotBefore: transient.retryNotBefore } : {}),
          attemptedModels,
          candidateModels: hasExplicitModel ? undefined : candidateModels,
        },
      };
    }
  }

  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: "ollama_model_unavailable",
    errorMessage: "Ollama model discovery returned no usable models.",
    resultJson: {
      tagsUrl: tagsUrl.toString(),
      modelPreference,
      discoveredModelCount: discoveredModels.length,
    },
  };
}