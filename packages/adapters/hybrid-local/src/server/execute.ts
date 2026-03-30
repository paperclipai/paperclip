import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asString, asNumber, renderTemplate, joinPromptSections } from "@paperclipai/adapter-utils/server-utils";
import { execute as claudeExecute } from "@paperclipai/adapter-claude-local/server";
import { isClaudeModel, models as staticModels } from "../index.js";
import { executeLocalModel, resolveBaseUrl, testLMStudioAvailability } from "./lmstudio.js";
import { getQuotaWindows } from "./quota.js";

// --- Helpers ---

function firstLocalModelId(): string {
  const local = staticModels.find((m) => !isClaudeModel(m.id));
  return local?.id ?? "qwen/qwen3.5-9b";
}

function isClaudeQuotaOrAuthError(result: AdapterExecutionResult): boolean {
  if (result.errorCode === "claude_auth_required") return true;
  if (result.errorMeta && "loginUrl" in result.errorMeta) return true;
  const msg = (result.errorMessage ?? "").toLowerCase();
  return msg.includes("rate limit") || msg.includes("quota") || msg.includes("not logged in");
}

function isLocalResourceError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("socket hang up") ||
    lower.includes("aborted") ||
    lower.includes("timeout") ||
    lower.includes("503") ||
    lower.includes("502") ||
    lower.includes("out of memory") ||
    lower.includes("gpu") ||
    lower.includes("no model loaded") ||
    lower.includes("context size has been exceeded") ||
    lower.includes("context length exceeded") ||
    lower.includes("maximum context length")
  );
}

const DEFAULT_QUOTA_THRESHOLD_PERCENT = 80;

/**
 * Proactive Claude quota check. Returns true if any quota window exceeds
 * the threshold, meaning Claude is likely to reject the request.
 * Threshold is configurable via adapterConfig.quotaThresholdPercent (default: 80).
 * Set to 0 to disable proactive quota checking.
 */
async function isClaudeQuotaNearExhausted(
  threshold: number,
  onLog: AdapterExecutionContext["onLog"],
): Promise<boolean> {
  if (threshold <= 0) return false;
  try {
    const quota = await getQuotaWindows();
    if (!quota.ok || quota.windows.length === 0) return false;

    const exhausted = quota.windows.find(
      (w) => w.usedPercent != null && w.usedPercent >= threshold,
    );
    if (exhausted) {
      await onLog(
        "stdout",
        `[hybrid] Claude quota pre-check: "${exhausted.label}" at ${exhausted.usedPercent}% (threshold: ${threshold}%)\n`,
      );
      return true;
    }
    return false;
  } catch {
    // Quota check failed — don't block execution, proceed normally
    return false;
  }
}

/**
 * Proactive local endpoint health check. Returns true if the endpoint
 * responds to GET /v1/models within 3 seconds.
 */
async function isLocalEndpointHealthy(baseUrl: string): Promise<boolean> {
  const result = await testLMStudioAvailability(baseUrl);
  return result.available;
}

// --- Routing metadata ---

interface RoutingMeta {
  primaryModel: string;
  primaryBackend: "claude_cli" | "openai_compatible";
  fallbackModel: string | null;
  fallbackBackend: "claude_cli" | "openai_compatible" | null;
  fallbackTriggered: boolean;
  fallbackReason: string | null;
  preCheckTriggered: boolean;
  preCheckReason: string | null;
}

function attachRoutingMeta(
  result: AdapterExecutionResult,
  meta: RoutingMeta,
): AdapterExecutionResult {
  return {
    ...result,
    resultJson: {
      ...(result.resultJson ?? {}),
      _hybrid: meta,
    },
  };
}

// --- Main execute ---

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, onLog } = ctx;
  const model = asString(config.model, "");
  const fallbackModel = asString(config.fallbackModel, "");
  const localBaseUrl = resolveBaseUrl(config.localBaseUrl);

  if (!model) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "No model configured. Set a model in adapterConfig.",
      errorCode: "missing_model",
    };
  }

  const quotaThreshold = asNumber(config.quotaThresholdPercent, DEFAULT_QUOTA_THRESHOLD_PERCENT);

  if (isClaudeModel(model)) {
    const effectiveFallback = fallbackModel || firstLocalModelId();

    // Pre-check: is Claude quota near exhausted? Skip straight to local.
    if (effectiveFallback) {
      const nearExhausted = await isClaudeQuotaNearExhausted(quotaThreshold, onLog);
      if (nearExhausted) {
        await onLog(
          "stdout",
          `[hybrid] Claude quota near limit — skipping to local model: ${effectiveFallback}\n`,
        );
        const result = await executeLocal(ctx, effectiveFallback);
        return attachRoutingMeta(result, {
          primaryModel: model,
          primaryBackend: "claude_cli",
          fallbackModel: effectiveFallback,
          fallbackBackend: "openai_compatible",
          fallbackTriggered: true,
          fallbackReason: "claude_quota_precheck",
          preCheckTriggered: true,
          preCheckReason: `Claude quota >= ${quotaThreshold}%`,
        });
      }
    }

    return executeClaudeWithFallback(ctx, model, effectiveFallback);
  }

  // Local model as primary
  // Pre-check: is the local endpoint reachable?
  if (fallbackModel && isClaudeModel(fallbackModel)) {
    const healthy = await isLocalEndpointHealthy(localBaseUrl);
    if (!healthy) {
      await onLog(
        "stdout",
        `[hybrid] Local endpoint not reachable at ${localBaseUrl} — skipping to Claude: ${fallbackModel}\n`,
      );
      const claudeCtx: AdapterExecutionContext = {
        ...ctx,
        config: { ...ctx.config, model: fallbackModel },
      };
      const result = await claudeExecute(claudeCtx);
      return attachRoutingMeta(result, {
        primaryModel: model,
        primaryBackend: "openai_compatible",
        fallbackModel,
        fallbackBackend: "claude_cli",
        fallbackTriggered: true,
        fallbackReason: "local_endpoint_precheck",
        preCheckTriggered: true,
        preCheckReason: `Local endpoint unreachable at ${localBaseUrl}`,
      });
    }
  }

  return executeLocalWithFallback(ctx, model, fallbackModel);
}

// --- Claude primary with local fallback ---

async function executeClaudeWithFallback(
  ctx: AdapterExecutionContext,
  model: string,
  fallbackModel: string,
): Promise<AdapterExecutionResult> {
  const { onLog } = ctx;

  const claudeResult = await claudeExecute(ctx);

  // Success or non-quota error — return as-is
  if ((claudeResult.exitCode === 0 && !claudeResult.errorMessage) || !isClaudeQuotaOrAuthError(claudeResult)) {
    return attachRoutingMeta(claudeResult, {
      primaryModel: model,
      primaryBackend: "claude_cli",
      fallbackModel: fallbackModel || null,
      fallbackBackend: fallbackModel ? "openai_compatible" : null,
      fallbackTriggered: false,
      fallbackReason: null,
      preCheckTriggered: false,
      preCheckReason: null,
    });
  }

  // No fallback configured
  if (!fallbackModel) {
    return claudeResult;
  }

  const reason = claudeResult.errorCode ?? claudeResult.errorMessage ?? "unknown";
  await onLog(
    "stdout",
    `[hybrid] Claude unavailable (${reason}). Falling back to local model: ${fallbackModel}\n`,
  );

  const result = await executeLocal(ctx, fallbackModel);
  return attachRoutingMeta(result, {
    primaryModel: model,
    primaryBackend: "claude_cli",
    fallbackModel,
    fallbackBackend: "openai_compatible",
    fallbackTriggered: true,
    fallbackReason: reason,
    preCheckTriggered: false,
    preCheckReason: null,
  });
}

// --- Local primary with Claude fallback ---

async function executeLocalWithFallback(
  ctx: AdapterExecutionContext,
  model: string,
  fallbackModel: string,
): Promise<AdapterExecutionResult> {
  const { onLog } = ctx;

  try {
    const result = await executeLocal(ctx, model);
    return attachRoutingMeta(result, {
      primaryModel: model,
      primaryBackend: "openai_compatible",
      fallbackModel: fallbackModel || null,
      fallbackBackend: fallbackModel && isClaudeModel(fallbackModel) ? "claude_cli" : fallbackModel ? "openai_compatible" : null,
      fallbackTriggered: false,
      fallbackReason: null,
      preCheckTriggered: false,
      preCheckReason: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // No viable Claude fallback
    if (!fallbackModel || !isClaudeModel(fallbackModel)) {
      const isTimeout = message.toLowerCase().includes("aborted") || message.toLowerCase().includes("timeout");
      return {
        exitCode: 1,
        signal: null,
        timedOut: isTimeout,
        errorMessage: `Local model error: ${message}`,
        errorCode: isTimeout ? "timeout" : "local_error",
        clearSession: true,
      };
    }

    // Not a resource error — real failure, don't fall back
    if (!isLocalResourceError(error)) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Local model error: ${message}`,
        errorCode: "local_error",
        clearSession: true,
      };
    }

    await onLog(
      "stdout",
      `[hybrid] Local model unavailable (${message}). Falling back to Claude: ${fallbackModel}\n`,
    );

    const claudeCtx: AdapterExecutionContext = {
      ...ctx,
      config: { ...ctx.config, model: fallbackModel },
    };
    const result = await claudeExecute(claudeCtx);
    return attachRoutingMeta(result, {
      primaryModel: model,
      primaryBackend: "openai_compatible",
      fallbackModel,
      fallbackBackend: "claude_cli",
      fallbackTriggered: true,
      fallbackReason: message,
      preCheckTriggered: false,
      preCheckReason: null,
    });
  }
}

// --- Local execution ---

async function executeLocal(
  ctx: AdapterExecutionContext,
  model: string,
): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta } = ctx;

  const localBaseUrl = resolveBaseUrl(config.localBaseUrl);
  const timeoutSec = asNumber(config.timeoutSec, 300);
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
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

  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrap = bootstrapPromptTemplate.trim().length > 0
    ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
    : "";
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([renderedBootstrap, sessionHandoffNote, renderedPrompt]);

  if (onMeta) {
    await onMeta({
      adapterType: "hybrid_local",
      command: `OpenAI-compatible @ ${localBaseUrl}`,
      cwd: asString(config.cwd, process.cwd()),
      commandArgs: [`model=${model}`],
      prompt,
      context,
    });
  }

  const result = await executeLocalModel({
    baseUrl: localBaseUrl,
    model,
    prompt,
    timeoutMs: timeoutSec * 1000,
    onLog,
  });

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    usage: result.usage,
    provider: "openai_compatible",
    biller: "local",
    model: result.model,
    billingType: "subscription",
    costUsd: 0,
    summary: result.summary,
    resultJson: {
      result: result.summary,
      model: result.model,
      finish_reason: result.finishReason,
      usage: {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
      },
    },
    clearSession: true,
  };
}
