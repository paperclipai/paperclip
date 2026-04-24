import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asString, asNumber } from "@paperclipai/adapter-utils/server-utils";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, config, context, onLog, onMeta } = ctx;

  const url = asString(config.url, "http://localhost:8080/v1/chat/completions");
  const apiKey = asString(config.apiKey, "");
  const model = asString(config.model, "anthropic/claude-3-5-sonnet-20241022");
  
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work."
  );

  const prompt = promptTemplate
    .replace("{{agent.id}}", ctx.agent.id)
    .replace("{{agent.name}}", ctx.agent.name);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // Record meta for debugging/UI
  if (onMeta) {
    await onMeta({
      adapterType: "hermes_gateway",
      command: `fetch ${url}`,
      commandArgs: ["--model", model],
      prompt,
    });
  }

  try {
    const startTime = Date.now();
    await onLog("stdout", `[paperclip] Invoking Hermes Agent at ${url}\n`);

    const requestBody = {
      model,
      messages: [
        { role: "system", content: "You are an autonomous agent orchestrated by Paperclip." },
        { role: "user", content: prompt }
      ],
      stream: false
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      await onLog("stderr", `[paperclip] Hermes API Error: ${response.status} - ${errorText}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Hermes API Error: ${response.status}`,
        errorCode: "hermes_api_error",
        clearSession: true,
      };
    }

    const data = await response.json() as any;
    const summary = data.choices?.[0]?.message?.content || "[No content returned]";
    const costUsd = data.usage?.total_cost_usd ?? 0;

    await onLog("stdout", `[paperclip] Hermes replied successfully in ${Date.now() - startTime}ms.\n`);

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      errorCode: null,
      provider: "hermes",
      model: data.model || model,
      resultJson: data,
      summary,
      costUsd,
      clearSession: false,
    };
  } catch (error: any) {
    await onLog("stderr", `[paperclip] Failed to invoke Hermes: ${error.message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Failed to invoke Hermes: ${error.message}`,
      errorCode: "hermes_invoke_failed",
      clearSession: true,
    };
  }
}
