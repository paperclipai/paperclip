import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";

const CLAUDE_KEY_CHECK_MODEL = "claude-sonnet-5-5";

export function requestClaudeKeyCheck(apiKey: string): Promise<Response> {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_KEY_CHECK_MODEL,
      max_tokens: 1,
      thinking: { type: "between_tools" },
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}

export async function llmCheck(config: PaperclipConfig): Promise<CheckResult> {
  if (!config.llm) {
    return {
      name: "LLM provider",
      status: "pass",
      message: "No LLM provider configured (optional)",
    };
  }

  if (!config.llm.apiKey) {
    return {
      name: "LLM provider",
      status: "pass",
      message: `${config.llm.provider} configured but no API key set (optional)`,
    };
  }

  try {
    if (config.llm.provider === "claude") {
      const res = await requestClaudeKeyCheck(config.llm.apiKey);
      if (res.ok || res.status === 400) {
        return { name: "LLM provider", status: "pass", message: "Claude API key is valid" };
      }
      if (res.status === 401) {
        return {
          name: "LLM provider",
          status: "fail",
          message: "Claude API key is invalid (401)",
          canRepair: false,
          repairHint: "Run `paperclipai configure --section llm`",
        };
      }
      return {
        name: "LLM provider",
        status: "warn",
        message: `Claude API returned status ${res.status}`,
      };
    } else {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${config.llm.apiKey}` },
      });
      if (res.ok) {
        return { name: "LLM provider", status: "pass", message: "OpenAI API key is valid" };
      }
      if (res.status === 401) {
        return {
          name: "LLM provider",
          status: "fail",
          message: "OpenAI API key is invalid (401)",
          canRepair: false,
          repairHint: "Run `paperclipai configure --section llm`",
        };
      }
      return {
        name: "LLM provider",
        status: "warn",
        message: `OpenAI API returned status ${res.status}`,
      };
    }
  } catch {
    return {
      name: "LLM provider",
      status: "warn",
      message: "Could not reach API to validate key",
    };
  }
}
