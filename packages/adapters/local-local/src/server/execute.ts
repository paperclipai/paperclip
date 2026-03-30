import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asString, asNumber, renderTemplate, buildPaperclipEnv, joinPromptSections, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { execute as claudeExecute } from "@paperclipai/adapter-claude-local/server";
import { isClaudeModel, models as staticModels } from "../index.js";
import { executeLocalModel, resolveBaseUrl } from "./lmstudio.js";

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

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config } = ctx;
  const model = asString(config.model, "");
  const fallbackModel = asString(config.fallbackModel, firstLocalModelId());

  if (!model) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "No model configured. Set a model in adapterConfig.",
      errorCode: "missing_model",
    };
  }

  if (isClaudeModel(model)) {
    return executeClaudeWithFallback(ctx, model, fallbackModel);
  }

  return executeLMStudio(ctx, model);
}

async function executeClaudeWithFallback(
  ctx: AdapterExecutionContext,
  _model: string,
  fallbackModel: string,
): Promise<AdapterExecutionResult> {
  const { onLog } = ctx;

  // Delegate to claude_local execute — it handles all Claude-specific logic
  // (sessions, skills, quota probing, stream parsing, etc.)
  const claudeResult = await claudeExecute(ctx);

  // If Claude succeeded or failed for non-quota reasons, return as-is
  if ((claudeResult.exitCode === 0 && !claudeResult.errorMessage) || !isClaudeQuotaOrAuthError(claudeResult)) {
    return claudeResult;
  }

  // Claude failed due to quota/auth — fall back to local model
  await onLog(
    "stdout",
    `[paperclip] Claude unavailable (${claudeResult.errorCode ?? claudeResult.errorMessage}). Falling back to local model: ${fallbackModel}\n`,
  );

  return executeLMStudio(ctx, fallbackModel);
}

async function executeLMStudio(
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
      adapterType: "local_local",
      command: `LM Studio @ ${localBaseUrl}`,
      cwd: asString(config.cwd, process.cwd()),
      commandArgs: [`model=${model}`],
      prompt,
      context,
    });
  }

  try {
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
      provider: "lmstudio",
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
      // LM Studio runs are stateless — no session to resume
      clearSession: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = message.includes("aborted") || message.includes("timeout");

    return {
      exitCode: 1,
      signal: null,
      timedOut: isTimeout,
      errorMessage: isTimeout
        ? `LM Studio timed out after ${timeoutSec}s`
        : `LM Studio error: ${message}`,
      errorCode: isTimeout ? "timeout" : "lmstudio_error",
      clearSession: true,
    };
  }
}
