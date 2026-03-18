import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_MISTRAL_MODEL } from "../index.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

const MISTRAL_API_BASE = "https://api.mistral.ai/v1";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const envConfig = parseObject(config.env);

  const mistralApiKey =
    (typeof envConfig.MISTRAL_API_KEY === "string" && envConfig.MISTRAL_API_KEY.trim()) ||
    (typeof process.env.MISTRAL_API_KEY === "string" && process.env.MISTRAL_API_KEY.trim()) ||
    "";

  if (!mistralApiKey) {
    checks.push({
      code: "mistral_api_key_missing",
      level: "error",
      message: "MISTRAL_API_KEY is not set.",
      hint: "Set MISTRAL_API_KEY in the adapter env config or in the process environment.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  checks.push({
    code: "mistral_api_key_present",
    level: "info",
    message: "MISTRAL_API_KEY is set.",
  });

  const model = asString(config.model, DEFAULT_MISTRAL_MODEL).trim() || DEFAULT_MISTRAL_MODEL;

  try {
    const response = await fetch(`${MISTRAL_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mistralApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Respond with: hello" }],
        max_tokens: 16,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const rawBody = await response.text();

    if (response.status === 401) {
      checks.push({
        code: "mistral_api_key_invalid",
        level: "error",
        message: "Mistral API returned 401 Unauthorized. The API key may be invalid.",
        hint: "Check your MISTRAL_API_KEY value at console.mistral.ai.",
      });
    } else if (response.status === 422 || response.status === 400) {
      checks.push({
        code: "mistral_model_invalid",
        level: "error",
        message: `Mistral API rejected the request (HTTP ${response.status}). The model may be invalid.`,
        detail: rawBody.slice(0, 240),
        hint: `Check that "${model}" is a valid Mistral model ID.`,
      });
    } else if (!response.ok) {
      checks.push({
        code: "mistral_api_probe_failed",
        level: "error",
        message: `Mistral API returned HTTP ${response.status}.`,
        detail: rawBody.slice(0, 240),
      });
    } else {
      let parsed: { choices?: Array<{ message?: { content?: string } }> } = {};
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        checks.push({
          code: "mistral_api_probe_bad_json",
          level: "warn",
          message: "Mistral API returned a non-JSON response.",
          detail: rawBody.slice(0, 240),
        });
      }

      const content = parsed.choices?.[0]?.message?.content ?? "";
      const hasHello = /\bhello\b/i.test(content);
      checks.push({
        code: hasHello ? "mistral_api_probe_passed" : "mistral_api_probe_unexpected_output",
        level: hasHello ? "info" : "warn",
        message: hasHello
          ? `Mistral API probe succeeded with model ${model}.`
          : "Mistral API probe ran but response did not contain 'hello'.",
        ...(content ? { detail: content.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    checks.push({
      code: "mistral_api_probe_failed",
      level: "error",
      message: "Mistral API probe failed.",
      detail: errMsg,
      hint: "Check your network connection and MISTRAL_API_KEY.",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
