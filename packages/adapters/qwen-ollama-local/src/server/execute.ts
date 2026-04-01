import {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { parseQwenOutput } from "./parse.js";

export async function execute(
  ctx: AdapterExecutionContext
): Promise<AdapterExecutionResult> {
  const { onLog, agent, runtime, config } = ctx;

  const ollamaUrl =
    (config.ollama_url as string) || "http://localhost:11434";
  const modelName = (config.model as string) || "qwen3.5";

  try {
    // Test Ollama connectivity first
    const testResponse = await fetch(`${ollamaUrl}/api/tags`);
    if (!testResponse.ok) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Failed to connect to Ollama at ${ollamaUrl}. Is Ollama running?`,
      };
    }

    // Prepare prompt - extract from context or use default
    const systemPrompt =
      "You are a helpful AI agent. Be concise and direct in your responses.";
    const userPrompt =
      (ctx.context?.prompt as string) || "Respond with hello.";

    onLog("stdout", `[ollama] Requesting ${modelName} from ${ollamaUrl}\n`);

    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName,
        prompt: userPrompt,
        system: systemPrompt,
        stream: false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      onLog(
        "stderr",
        `[ollama] Error from Ollama: ${response.status} ${error}\n`
      );
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Ollama returned ${response.status}`,
      };
    }

    const result = await response.json();
    const responseText = (result.response as string) || "";

    onLog("stdout", `${responseText}\n`);

    // Parse the response to extract structured data
    const parsed = parseQwenOutput(responseText);

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      model: modelName,
      provider: "ollama",
      summary: `Generated response via ${modelName}`,
      resultJson: {
        text: responseText,
        ...parsed,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onLog("stderr", `[ollama] Error: ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
    };
  }
}
