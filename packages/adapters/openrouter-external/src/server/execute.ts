import fs from "node:fs/promises";
import OpenAI from "openai";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { renderTemplate, asString } from "@paperclipai/adapter-utils/server-utils";
import { instructionsPathKey } from "./index.js";

/**
 * Core execution. Pulls baseUrl/model/promptTemplate from agent config,
 * resolves the API key from the process env, hands the prompt to the OpenAI
 * SDK with `stream: true`, and pipes content deltas back through the
 * Paperclip onLog callback as stdout chunks.
 *
 * Support for Instructions Bundles:
 * If adapterConfig.instructionsFilePath is set, the adapter reads the file
 * and prepends its content as a system message.
 */
export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { config, agent, context, onLog } = ctx;

  const baseUrl = String(config.baseUrl ?? "https://openrouter.ai/api/v1");
  const model = String(config.model ?? "anthropic/claude-sonnet-4");
  const apiKey = String(
    process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
  );

  if (!apiKey) {
    await onLog(
      "stderr",
      "openai adapter: missing OPENROUTER_API_KEY (or OPENAI_API_KEY)\n",
    );
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Missing OPENROUTER_API_KEY (or OPENAI_API_KEY)",
      errorCode: "missing_api_key",
    };
  }

  const promptTemplate = String(
    config.promptTemplate ?? "Continue your work on issue {{taskTitle}}.",
  );
  const prompt = renderTemplate(promptTemplate, {
    agentId: agent.id,
    agentName: agent.name,
    companyId: agent.companyId,
    runId: ctx.runId,
    taskId: String(context.taskId ?? ""),
    taskTitle: String(context.taskTitle ?? ""),
  });

  // Handle Instructions Bundle
  let instructions: string | null = null;
  const instructionsFilePath = asString(config[instructionsPathKey], "");
  if (instructionsFilePath) {
    try {
      instructions = await fs.readFile(instructionsFilePath, "utf-8");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  const client = new OpenAI({ baseURL: baseUrl, apiKey });

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }
  messages.push({ role: "user", content: prompt });

  let inputTokens = 0;
  let outputTokens = 0;
  let provider: string | null = null;

  try {
    const stream = await client.chat.completions.create({
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) await onLog("stdout", delta);
      // Final chunk in OpenAI's SSE protocol carries `usage` when
      // include_usage is set.
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? 0;
        outputTokens = chunk.usage.completion_tokens ?? 0;
      }
      // OpenRouter exposes the underlying provider on a top-level `provider`
      // field; harmless to read on api.openai.com (will just be undefined).
      const maybeProvider = (chunk as unknown as { provider?: string })
        .provider;
      if (maybeProvider && !provider) provider = maybeProvider;
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      model,
      provider,
      usage: { inputTokens, outputTokens },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `openai adapter: call failed: ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
      errorCode: "openai_call_failed",
    };
  }
}
