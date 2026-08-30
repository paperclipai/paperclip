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
      const baseUrls: Record<string, string> = {
        openai: "https://api.openai.com/v1",
        deepseek: "https://api.deepseek.com/v1",
        glm: "https://open.bigmodel.cn/api/paas/v4",
        kimi: "https://api.moonshot.cn/v1",
      };
      const labels: Record<string, string> = {
        openai: "OpenAI",
        deepseek: "DeepSeek",
        glm: "Zhipu GLM",
        kimi: "Moonshot Kimi",
      };
      const provider = config.llm.provider;
      const baseUrl = baseUrls[provider] ?? "https://api.openai.com/v1";
      const label = labels[provider] ?? provider;
      const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${config.llm.apiKey}` },
      });
      if (res.ok) {
        return { name: "LLM provider", status: "pass", message: `${label} API key is valid` };
      }
      if (res.status === 401) {
        return {
          name: "LLM provider",
          status: "fail",
          message: `${label} API key is invalid (401)`,
          canRepair: false,
          repairHint: "Run `paperclipai configure --section llm`",
        };
      }
      return {
        name: "LLM provider",
        status: "warn",
        message: `${label} API returned status ${res.status}`,
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
