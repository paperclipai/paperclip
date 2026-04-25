import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  renderPaperclipWakePrompt,
  renderTemplate,
  joinPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import { parseConfig } from "../schema.js";
import { loadInstructions } from "../instructions.js";
import { buildErrorResult, type CustomLlmError } from "../errors.js";
import { callOpenAiChatCompletions } from "../transports/openai-chat-completions.js";
import { callAnthropicMessages } from "../transports/anthropic-messages.js";

const DEFAULT_PROMPT_TEMPLATE =
  "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime: _runtime, config: rawConfig, context, onLog, onMeta } = ctx;

  let config;
  try {
    config = parseConfig(rawConfig as Record<string, unknown>);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return buildErrorResult({ code: "CONFIG_INVALID", message: msg });
  }

  let apiKey = "";
  if (config.apiKeyEnv) {
    apiKey = process.env[config.apiKeyEnv] ?? "";
    if (!apiKey) {
      return buildErrorResult({
        code: "AUTH_FAILED",
        message: `apiKeyEnv "${config.apiKeyEnv}" is not set or empty in server process environment`,
        meta: { apiKeyEnv: config.apiKeyEnv },
      });
    }
  }

  let systemPrompt: string | null = null;
  if (config.instructionsFilePath) {
    try {
      systemPrompt = await loadInstructions(config.instructionsFilePath);
    } catch (err) {
      const e = err as CustomLlmError;
      return buildErrorResult(e);
    }
  }

  const promptTemplate = asString(rawConfig.promptTemplate, DEFAULT_PROMPT_TEMPLATE);
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake);
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const userPrompt = joinPromptSections([wakePrompt, sessionHandoffNote, renderedPrompt]);

  if (onMeta) {
    await onMeta({
      adapterType: "custom_llm_local",
      command: config.baseUrl,
      cwd: undefined,
      commandNotes: [
        `transport=${config.transport}`,
        `model=${config.model}`,
        ...(config.modelAlias ? [`modelAlias=${config.modelAlias}`] : []),
        ...(config.instructionsFilePath ? [`instructions=${config.instructionsFilePath}`] : []),
        ...(config.apiKeyEnv ? [`apiKeyEnv=${config.apiKeyEnv}`] : []),
      ],
      context,
    });
  }

  const controller = new AbortController();
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutTimer = setTimeout(() => {
    graceTimer = setTimeout(() => controller.abort(), config.graceSec * 1000);
  }, config.timeoutSec * 1000);

  try {
    const callInput = {
      config,
      apiKey,
      systemPrompt,
      userPrompt,
      onLog,
      signal: controller.signal,
    };

    if (config.transport === "openai_chat_completions") {
      return await callOpenAiChatCompletions(callInput);
    }
    return await callAnthropicMessages(callInput);
  } finally {
    clearTimeout(timeoutTimer);
    if (graceTimer) clearTimeout(graceTimer);
  }
}
