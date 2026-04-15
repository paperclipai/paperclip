import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_OPENROUTER_MODEL, OPENROUTER_API_BASE } from "../index.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const envConfig = parseObject(config.env);

  const configApiKey =
    asString(config.apiKey, "").trim() ||
    asString(envConfig.OPENROUTER_API_KEY, "").trim();
  const apiKey = configApiKey || process.env.OPENROUTER_API_KEY || "";

  if (apiKey) {
    const source = configApiKey ? "adapter config" : "server environment";
    checks.push({
      code: "openrouter_api_key_present",
      level: "info",
      message: "OpenRouter API key is configured.",
      detail: `Detected in ${source}.`,
    });
  } else {
    checks.push({
      code: "openrouter_api_key_missing",
      level: "error",
      message: "No OpenRouter API key found.",
      hint: "Set OPENROUTER_API_KEY in adapter env or server environment variables.",
    });
    return {
      adapterType: ctx.adapterType,
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  const model = asString(config.model, DEFAULT_OPENROUTER_MODEL).trim();
  const baseUrl = asString(config.baseUrl, OPENROUTER_API_BASE).replace(/\/$/, "");
  const timeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 15));

  checks.push({
    code: "openrouter_model_configured",
    level: "info",
    message: `Model configured: ${model}`,
  });

  try {
    const controller = new AbortController();
    const handle = setTimeout(() => controller.abort(), timeoutSec * 1000);

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://paperclip.ai",
        "X-Title": "Paperclip",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Respond with the single word: hello" }],
        max_tokens: 16,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    clearTimeout(handle);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const snippet = body.slice(0, 200);
      if (response.status === 401) {
        checks.push({
          code: "openrouter_probe_auth_failed",
          level: "error",
          message: "OpenRouter API key is invalid or unauthorized.",
          detail: snippet,
          hint: "Verify your OPENROUTER_API_KEY at openrouter.ai/keys.",
        });
      } else if (response.status === 402) {
        checks.push({
          code: "openrouter_probe_no_credits",
          level: "error",
          message: "OpenRouter account has no credits.",
          hint: "Add credits at openrouter.ai/credits.",
        });
      } else if (response.status === 429) {
        checks.push({
          code: "openrouter_probe_rate_limited",
          level: "warn",
          message: "OpenRouter rate limit hit during probe.",
          hint: "Try again in a moment.",
        });
      } else {
        checks.push({
          code: "openrouter_probe_http_error",
          level: "error",
          message: `OpenRouter probe returned HTTP ${response.status}.`,
          detail: snippet,
        });
      }
    } else {
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content ?? "";
      const hasHello = /\bhello\b/i.test(content);
      checks.push({
        code: hasHello ? "openrouter_probe_passed" : "openrouter_probe_unexpected_output",
        level: hasHello ? "info" : "warn",
        message: hasHello
          ? "OpenRouter hello probe succeeded."
          : "OpenRouter probe ran but did not return `hello` as expected.",
        detail: content.slice(0, 200) || undefined,
        hint: hasHello ? undefined : "The model responded but not with 'hello'. This is a warning only — the adapter should still work.",
      });
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      checks.push({
        code: "openrouter_probe_timed_out",
        level: "warn",
        message: `OpenRouter probe timed out after ${timeoutSec}s.`,
        hint: "Check your network connection and try again.",
      });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      checks.push({
        code: "openrouter_probe_fetch_error",
        level: "error",
        message: "OpenRouter probe failed with a network error.",
        detail: message,
        hint: "Verify network reachability to openrouter.ai from the Paperclip server.",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
