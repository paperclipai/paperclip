import { resolveZaiModelsEndpoint } from "@paperclipai/shared";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";

export async function llmCheck(config: PaperclipConfig): Promise<CheckResult> {
  if (!config.llm) {
    return {
      name: "LLM provider",
      status: "pass",
      message: "No LLM provider configured (optional)",
    };
  }

  let apiKey = config.llm.apiKey;
  if (config.llm.provider === "zai" && process.env.ZAI_API_KEY?.trim()) {
    apiKey = process.env.ZAI_API_KEY.trim();
  } else if (config.llm.provider === "openai" && process.env.OPENAI_API_KEY?.trim()) {
    apiKey = process.env.OPENAI_API_KEY.trim();
  }

  if (!apiKey) {
    return {
      name: "LLM provider",
      status: "pass",
      message: `${config.llm.provider} configured but no API key set (optional)`,
    };
  }

  try {
    if (config.llm.provider === "claude") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5-20250929",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
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
    } else if (config.llm.provider === "zai") {
      const endpoint = resolveZaiModelsEndpoint(process.env.ZAI_BASE_URL);
      const res = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        return { name: "LLM provider", status: "pass", message: "Z.AI API key is valid" };
      }
      if (res.status === 401) {
        return {
          name: "LLM provider",
          status: "fail",
          message: "Z.AI API key is invalid (401)",
          canRepair: false,
          repairHint: "Run `paperclipai configure --section llm`",
        };
      }
      return {
        name: "LLM provider",
        status: "warn",
        message: `Z.AI API returned status ${res.status}`,
      };
    } else if (config.llm.provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
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

  return {
    name: "LLM provider",
    status: "warn",
    message: `Unknown LLM provider: ${config.llm.provider}`,
  };
}
