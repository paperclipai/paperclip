import fs from "node:fs/promises";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_MINIMAX_LOCAL_BASE_URL, DEFAULT_MINIMAX_LOCAL_MODEL } from "../index.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

async function resolveMiniMaxApiKey(config: Record<string, unknown>): Promise<{
  key: string | null;
  source: string | null;
}> {
  const env = parseObject(config.env);
  const explicit = firstNonEmptyString(env.MINIMAX_API_KEY, process.env.MINIMAX_API_KEY);
  if (explicit) {
    return {
      key: explicit,
      source: typeof env.MINIMAX_API_KEY === "string" ? "adapter config env" : "server environment",
    };
  }

  const keyFile = firstNonEmptyString(env.MINIMAX_API_KEY_FILE, process.env.MINIMAX_API_KEY_FILE);
  if (!keyFile) return { key: null, source: null };
  try {
    const raw = await fs.readFile(keyFile, "utf8");
    return {
      key: raw.trim() || null,
      source: typeof env.MINIMAX_API_KEY_FILE === "string" ? "adapter config key file" : "server key file",
    };
  } catch {
    return { key: null, source: null };
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const baseUrl = normalizeBaseUrl(
    firstNonEmptyString(config.baseUrl) ?? DEFAULT_MINIMAX_LOCAL_BASE_URL,
  );
  const model = firstNonEmptyString(config.primaryModel, config.model) ?? DEFAULT_MINIMAX_LOCAL_MODEL;
  const { key, source } = await resolveMiniMaxApiKey(config);

  if (key) {
    checks.push({
      code: "minimax_api_key_present",
      level: "info",
      message: "MiniMax API credentials are configured.",
      ...(source ? { detail: `Detected in ${source}.` } : {}),
    });
  } else {
    checks.push({
      code: "minimax_api_key_missing",
      level: "error",
      message: "MiniMax API credentials are missing.",
      hint: "Set env.MINIMAX_API_KEY or env.MINIMAX_API_KEY_FILE for this agent.",
    });
  }

  if (!key) {
    return {
      adapterType: "minimax_local",
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        temperature: 0,
        max_tokens: 8,
      }),
    });
  } catch (error) {
    checks.push({
      code: "minimax_probe_failed",
      level: "error",
      message: error instanceof Error ? error.message : "MiniMax probe failed.",
      hint: `Verify connectivity to ${baseUrl}.`,
    });
    return {
      adapterType: "minimax_local",
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const errorRecord = parseObject(payload.error);
    const message = firstNonEmptyString(
      errorRecord.message,
      payload.message,
      `MiniMax API returned HTTP ${response.status}.`,
    ) ?? `MiniMax API returned HTTP ${response.status}.`;
    checks.push({
      code: "minimax_probe_http_error",
      level: "error",
      message,
      detail: `HTTP ${response.status}`,
    });
    return {
      adapterType: "minimax_local",
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const content = asString(parseObject(parseObject(choice).message).content, "").trim();
  if (content === "OK") {
    checks.push({
      code: "minimax_probe_passed",
      level: "info",
      message: "MiniMax hello probe succeeded.",
      detail: `Model ${model} responded with OK.`,
    });
  } else {
    checks.push({
      code: "minimax_probe_unexpected_output",
      level: "error",
      message: "MiniMax probe returned unexpected output.",
      detail: content.slice(0, 120) || "Empty response",
    });
  }

  return {
    adapterType: "minimax_local",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
