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

  if (!config.llm.apiKey) {
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
          "x-api-key": config.llm.apiKey,
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
    } else {
      // OPENAI_BASE_URL support for proxies (e.g. OmniRoute, LiteLLM).
      // Custom base URLs must include the /v1 prefix (e.g. http://127.0.0.1:20128/v1)
      // so that we can safely append /models and get a working endpoint.
      // The default hardcodes the full official path for the same reason.
      const baseUrl = process.env.OPENAI_BASE_URL
        ? process.env.OPENAI_BASE_URL.replace(/\/$/, "")
        : "https://api.openai.com/v1";
      const res = await fetch(`${baseUrl}/models`, {
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
