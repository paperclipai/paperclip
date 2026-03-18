import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  buildPaperclipEnv,
  joinPromptSections,
  parseObject,
  redactEnvForLogs,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_MISTRAL_MODEL } from "../index.js";

const MISTRAL_API_BASE = "https://api.mistral.ai/v1";

interface MistralUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface MistralChoice {
  message?: { content?: string };
  finish_reason?: string;
}

interface MistralResponse {
  id?: string;
  choices?: MistralChoice[];
  usage?: MistralUsage;
  model?: string;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const model = asString(config.model, DEFAULT_MISTRAL_MODEL).trim() || DEFAULT_MISTRAL_MODEL;
  const maxTokens = asNumber(config.maxTokens, 4096);
  const timeoutSec = asNumber(config.timeoutSec, 120);

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const mistralApiKey =
    (typeof envConfig.MISTRAL_API_KEY === "string" && envConfig.MISTRAL_API_KEY.trim()) ||
    (typeof process.env.MISTRAL_API_KEY === "string" && process.env.MISTRAL_API_KEY.trim()) ||
    "";

  if (!mistralApiKey) {
    const errMsg = "MISTRAL_API_KEY is not set. Set it in the adapter env config or in the process environment.";
    await onLog("stderr", `[paperclip] Error: ${errMsg}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: errMsg,
      model,
      provider: "mistral",
      biller: "mistral",
      billingType: "metered_api",
    };
  }

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };

  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const renderedBootstrapPrompt =
    bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([renderedBootstrapPrompt, sessionHandoffNote, renderedPrompt]);

  if (onMeta) {
    await onMeta({
      adapterType: "mistral_local",
      command: "mistral-api",
      commandArgs: [`POST ${MISTRAL_API_BASE}/chat/completions`, `model=${model}`],
      env: redactEnvForLogs(env),
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
        bootstrapPromptChars: renderedBootstrapPrompt.length,
        sessionHandoffChars: sessionHandoffNote.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      context,
    });
  }

  await onLog("stderr", `[paperclip] Calling Mistral API: model=${model}\n`);

  const controller = new AbortController();
  const timeoutHandle = timeoutSec > 0
    ? setTimeout(() => controller.abort(), timeoutSec * 1000)
    : null;

  let response: Response;
  try {
    response = await fetch(`${MISTRAL_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mistralApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const isAbort = err instanceof Error && err.name === "AbortError";
    const errMsg = isAbort
      ? `Mistral API request timed out after ${timeoutSec}s`
      : `Mistral API request failed: ${err instanceof Error ? err.message : String(err)}`;
    await onLog("stderr", `[paperclip] ${errMsg}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: isAbort,
      errorMessage: errMsg,
      model,
      provider: "mistral",
      biller: "mistral",
      billingType: "metered_api",
    };
  }
  if (timeoutHandle) clearTimeout(timeoutHandle);

  const rawBody = await response.text();

  if (!response.ok) {
    const errMsg = `Mistral API returned HTTP ${response.status}: ${rawBody.slice(0, 400)}`;
    await onLog("stderr", `[paperclip] ${errMsg}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: errMsg,
      model,
      provider: "mistral",
      biller: "mistral",
      billingType: "metered_api",
    };
  }

  let parsed: MistralResponse;
  try {
    parsed = JSON.parse(rawBody) as MistralResponse;
  } catch {
    const errMsg = `Mistral API returned non-JSON response: ${rawBody.slice(0, 200)}`;
    await onLog("stderr", `[paperclip] ${errMsg}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: errMsg,
      model,
      provider: "mistral",
      biller: "mistral",
      billingType: "metered_api",
    };
  }

  const content = parsed.choices?.[0]?.message?.content ?? "";
  const finishReason = parsed.choices?.[0]?.finish_reason ?? "unknown";
  const inputTokens = parsed.usage?.prompt_tokens ?? 0;
  const outputTokens = parsed.usage?.completion_tokens ?? 0;
  const resolvedModel = parsed.model ?? model;

  if (content) {
    await onLog("stdout", content + "\n");
  }
  await onLog(
    "stderr",
    `[paperclip] Mistral run complete: model=${resolvedModel} finish_reason=${finishReason} tokens=${inputTokens}+${outputTokens}\n`,
  );

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens: 0,
    },
    model: resolvedModel,
    provider: "mistral",
    biller: "mistral",
    billingType: "metered_api",
    summary: content.slice(0, 500).trim() || null,
    resultJson: {
      finishReason,
      responseId: parsed.id ?? null,
    },
  };
}
