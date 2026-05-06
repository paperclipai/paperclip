import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asNumber, asString, parseObject, renderTemplate } from "../utils.js";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
  renderPaperclipWakePrompt,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_CLOUDFLARE_WORKERS_AI_MODEL } from "./index.js";

const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com";
const CLOUDFLARE_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com";

type JsonObject = Record<string, unknown>;

function asStringHeaders(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(parseObject(value)).filter(
      (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
    ),
  );
}

function readApiToken(config: JsonObject): string {
  const explicit = asString(config.apiToken, "").trim();
  if (explicit) return explicit;

  const headers = asStringHeaders(config.headers);
  const candidates = [
    headers["cf-aig-authorization"],
    headers["CF-AIG-Authorization"],
    headers.Authorization,
    headers.authorization,
  ];
  for (const candidate of candidates) {
    const authorization = asString(candidate, "").trim();
    if (/^Bearer\s+/i.test(authorization)) {
      return authorization.replace(/^Bearer\s+/i, "").trim();
    }
  }
  return "";
}

function readSelectedModel(config: JsonObject): string {
  const configured = asString(config.model, "").trim();
  if (!configured || configured.toLowerCase() === "auto") {
    return DEFAULT_CLOUDFLARE_WORKERS_AI_MODEL;
  }
  return configured;
}

function encodeModelPath(model: string): string {
  return model
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildGatewayRequestModel(model: string): string {
  const trimmed = model.trim();
  if (/^[a-z0-9_-]+\//i.test(trimmed)) {
    return trimmed.startsWith("workers-ai/") ? trimmed : `workers-ai/${trimmed}`;
  }
  return `workers-ai/${trimmed}`;
}

function buildRunUrl(input: { accountId: string; gatewayId: string | null; model: string }): URL {
  const pathName = input.gatewayId
    ? `/v1/${encodeURIComponent(input.accountId)}/${encodeURIComponent(input.gatewayId)}/compat/chat/completions`
    : `/client/v4/accounts/${encodeURIComponent(input.accountId)}/ai/run/${encodeModelPath(input.model)}`;
  return new URL(pathName, input.gatewayId ? CLOUDFLARE_GATEWAY_BASE_URL : CLOUDFLARE_API_BASE_URL);
}

function readTextContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";

  const parts = value
    .map((entry) => {
      if (typeof entry === "string") return entry.trim();
      const record = parseObject(entry);
      return asString(record.text, asString(record.content, "")).trim();
    })
    .filter(Boolean);

  return parts.join("\n\n").trim();
}

function extractChoiceContent(value: unknown): string {
  if (!Array.isArray(value)) return "";

  for (const rawChoice of value) {
    const choice = parseObject(rawChoice);
    const message = parseObject(choice.message);
    const delta = parseObject(choice.delta);
    const content = [
      readTextContent(message.content),
      readTextContent(delta.content),
      asString(message.content, "").trim(),
      asString(delta.content, "").trim(),
      asString(choice.text, "").trim(),
    ].find(Boolean);
    if (content) return content;
  }

  return "";
}

function extractResponseError(value: unknown): string {
  const root = parseObject(value);
  const result = parseObject(root.result);

  const directError = asString(root.error, asString(result.error, "")).trim();
  if (directError) return directError;

  const errorLists = [root.errors, result.errors];
  for (const errorList of errorLists) {
    if (!Array.isArray(errorList)) continue;
    const messages = errorList
      .map((entry) => {
        const record = parseObject(entry);
        return asString(record.message, asString(record.error, "")).trim();
      })
      .filter(Boolean);
    if (messages.length > 0) return messages.join("; ");
  }

  return "";
}

function extractSummary(value: unknown): string {
  const root = parseObject(value);
  const result = parseObject(root.result);

  const candidates = [
    extractChoiceContent(root.choices),
    extractChoiceContent(result.choices),
    readTextContent(parseObject(root.message).content),
    readTextContent(parseObject(result.message).content),
    asString(parseObject(root.message).content, "").trim(),
    asString(parseObject(result.message).content, "").trim(),
    asString(root.response, asString(result.response, "")).trim(),
    asString(root.content, asString(result.content, "")).trim(),
  ];

  return candidates.find(Boolean) ?? "";
}

function extractUsage(value: unknown): AdapterExecutionResult["usage"] {
  const root = parseObject(value);
  const result = parseObject(root.result);
  const usage = parseObject(root.usage);
  const fallbackUsage = parseObject(result.usage);

  const inputTokens = Math.max(
    0,
    Math.floor(
      asNumber(usage.prompt_tokens, asNumber(fallbackUsage.prompt_tokens, 0)),
    ),
  );
  const outputTokens = Math.max(
    0,
    Math.floor(
      asNumber(usage.completion_tokens, asNumber(fallbackUsage.completion_tokens, 0)),
    ),
  );

  return { inputTokens, outputTokens };
}

async function fetchJson(input: {
  url: URL;
  method?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown> | null;
  timeoutMs: number;
}) {
  const controller = new AbortController();
  const timer = input.timeoutMs > 0 ? setTimeout(() => controller.abort(), input.timeoutMs) : null;
  try {
    const response = await fetch(input.url, {
      method: input.method ?? "GET",
      headers: input.body
        ? {
            accept: "application/json",
            "content-type": "application/json",
            ...(input.headers ?? {}),
          }
        : {
            accept: "application/json",
            ...(input.headers ?? {}),
          },
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    let json: unknown = null;
    if (text.trim().length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      text,
      json,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request to ${input.url.toString()} timed out after ${input.timeoutMs}ms.`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
        `[paperclip] Warning: could not read Cloudflare Workers AI instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
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
  const config = parseObject(ctx.config);
  const accountId = asString(config.accountId, "").trim();
  if (!accountId) {
    throw new Error("Cloudflare Workers AI adapter requires adapterConfig.accountId.");
  }

  const apiToken = readApiToken(config);
  if (!apiToken) {
    throw new Error("Cloudflare Workers AI adapter requires adapterConfig.apiToken (or Authorization header).");
  }

  const gatewayId = asString(config.gatewayId, "").trim() || null;
  const model = readSelectedModel(config);
  const timeoutSec = Math.max(0, asNumber(config.timeoutSec, 120));
  const timeoutMs = Math.max(0, asNumber(config.timeoutMs, timeoutSec > 0 ? timeoutSec * 1000 : 0));
  const headers = asStringHeaders(config.headers);
  const runUrl = buildRunUrl({ accountId, gatewayId, model });
  const requestModel = gatewayId ? buildGatewayRequestModel(model) : model;
  const prompt = await buildPrompt(ctx);

  if (ctx.onMeta) {
    await ctx.onMeta({
      adapterType: "cloudflare_workers_ai",
      command: `POST ${runUrl.toString()}`,
      cwd: asString(parseObject(ctx.context.paperclipWorkspace).cwd, asString(config.cwd, process.cwd())),
      commandNotes: [
        gatewayId
          ? `Routing through Cloudflare AI Gateway "${gatewayId}" via the OpenAI-compatible compat endpoint.`
          : "Routing directly to the Cloudflare Workers AI REST API.",
        `Using model ${requestModel}.`,
      ],
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
      },
      context: ctx.context,
    });
  }

  const requestBody: Record<string, unknown> = {
    ...(gatewayId ? { model: requestModel } : {}),
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    stream: false,
  };

  const temperature = asNumber(config.temperature, Number.NaN);
  if (Number.isFinite(temperature)) {
    requestBody.temperature = temperature;
  }

  const maxCompletionTokens = Math.floor(asNumber(config.maxCompletionTokens, asNumber(config.maxTokens, 0)));
  if (Number.isFinite(maxCompletionTokens) && maxCompletionTokens > 0) {
    if (gatewayId) {
      requestBody.max_tokens = maxCompletionTokens;
    } else {
      requestBody.max_completion_tokens = maxCompletionTokens;
    }
  }

  try {
    const response = await fetchJson({
      url: runUrl,
      method: "POST",
      headers: {
        ...headers,
        ...(gatewayId
          ? { "cf-aig-authorization": `Bearer ${apiToken}` }
          : { Authorization: `Bearer ${apiToken}` }),
      },
      body: requestBody,
      timeoutMs,
    });

    const responseJson = parseObject(response.json);
    const responseError = extractResponseError(responseJson);
    const success = responseJson.success;
    if (!response.ok || success === false || responseError) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "cloudflare_workers_ai_request_failed",
        errorMessage: responseError || `Cloudflare Workers AI request failed with HTTP ${response.status}.`,
        provider: "cloudflare",
        biller: "cloudflare",
        model,
        resultJson: {
          ...responseJson,
          runUrl: runUrl.toString(),
          gatewayId,
          selectedModel: model,
          requestModel,
          status: response.status,
          responseText: response.text,
        },
      };
    }

    const summary = extractSummary(responseJson);
    if (!summary) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "cloudflare_workers_ai_response_invalid",
        errorMessage: "Cloudflare Workers AI returned no message content.",
        provider: "cloudflare",
        biller: "cloudflare",
        model,
        resultJson: {
          ...responseJson,
          runUrl: runUrl.toString(),
          gatewayId,
          selectedModel: model,
          requestModel,
        },
      };
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "cloudflare",
      biller: "cloudflare",
      model,
      billingType: "metered_api",
      usage: extractUsage(responseJson),
      summary,
      resultJson: {
        ...responseJson,
        runUrl: runUrl.toString(),
        gatewayId,
        selectedModel: model,
        requestModel,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = /timed out/i.test(message);
    return {
      exitCode: timedOut ? null : 1,
      signal: null,
      timedOut,
      errorCode: timedOut ? "timeout" : "cloudflare_workers_ai_request_failed",
      errorMessage: message,
      provider: "cloudflare",
      biller: "cloudflare",
      model,
      resultJson: {
        runUrl: runUrl.toString(),
        gatewayId,
        selectedModel: model,
        requestModel,
      },
    };
  }
}
