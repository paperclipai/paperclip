import { randomUUID } from "crypto";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { fetchWithTimeout } from "./utils.js";

export async function executeMistralRequest(
  ctx: AdapterExecutionContext
): Promise<AdapterExecutionResult> {
  const config = ctx.config as {
    apiKey: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    safePrompt?: boolean;
    randomSeed?: number;
    timeoutSec?: number;
    retries?: number;
  };
  
  const apiKey = config.apiKey;
  if (!apiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Mistral API key is required",
      errorCode: "MISTRAL_API_KEY_MISSING",
    };
  }

  const model = config.model || "mistral-small";
  const temperature = config.temperature ?? 0.7;
  const maxTokens = config.maxTokens;
  const topP = config.topP;
  const safePrompt = config.safePrompt ?? true;
  const randomSeed = config.randomSeed;
  const timeoutMs = (config.timeoutSec ?? 30) * 1000;
  const retries = config.retries ?? 3;

  // Extract messages from context - check various possible locations
  let messages = [];
  
  // Try to get messages from context (following pattern from other adapters)
  if (ctx.context.messages && Array.isArray(ctx.context.messages)) {
    messages = ctx.context.messages.map((msg) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content,
    }));
  } else if (ctx.context.prompt) {
    // Fallback to single prompt if no message array
    messages = [{ role: "user", content: ctx.context.prompt }];
  } else if (ctx.context.input) {
    // Another fallback pattern
    messages = [{ role: "user", content: ctx.context.input }];
  } else {
    // Final fallback
    messages = [{ role: "user", content: "Hello" }];
  }

  const payload = {
    model,
    messages,
    temperature,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(topP ? { top_p: topP } : {}),
    safe_prompt: safePrompt,
    ...(randomSeed ? { random_seed: randomSeed } : {}),
    stream: true,
  };

  let lastError: unknown = null;
  let usage = { inputTokens: 0, outputTokens: 0 };
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetchWithTimeout(
        "https://api.mistral.ai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "Accept": "application/json",
          },
          body: JSON.stringify(payload),
          timeout: timeoutMs,
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: `Mistral API error: ${response.status} ${response.statusText}${
            errorData.message ? ` - ${errorData.message}` : ""
          }`,
          errorCode: "MISTRAL_API_ERROR",
        };
      }

      const sessionId = randomUUID();
      let fullContent = "";
      
      // Handle streaming response
      const reader = response.body?.getReader();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = new TextDecoder().decode(value);
          const lines = chunk.split("\n").filter((line) => line.trim().startsWith("data:"));
          
          for (const line of lines) {
            const data = line.replace("data: ", "").trim();
            if (data === "[DONE]") continue;
            
            try {
              const parsed = JSON.parse(data);
              if (parsed.choices?.[0]?.delta?.content) {
                fullContent += parsed.choices[0].delta.content;
                // Output to logs
                await ctx.onLog("stdout", parsed.choices[0].delta.content);
              }
              // Capture usage from final chunk (Mistral sends usage in last message)
              if (parsed.usage) {
                usage = {
                  inputTokens: parsed.usage.prompt_tokens || 0,
                  outputTokens: parsed.usage.completion_tokens || 0
                };
              }
            } catch (e) {
              console.warn("Failed to parse Mistral stream chunk:", e);
            }
          }
        }
      }

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        usage: usage,
      };
    } catch (error) {
      lastError = error;
      if (attempt < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
      }
    }
  }

  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: `Mistral API request failed after ${retries} attempts: ${String(lastError)}`,
    errorCode: "MISTRAL_API_REQUEST_FAILED",
  };
}
