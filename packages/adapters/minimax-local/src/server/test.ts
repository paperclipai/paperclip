import { readFile } from "node:fs/promises";
import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";

const DEFAULT_BASE_URL = "https://api.minimax.io/v1";
const DEFAULT_MODEL = "MiniMax-M3";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function adapterValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const record = asRecord(value);
  if (typeof record.value === "string") return record.value.trim();
  if (typeof record.secretValue === "string") return record.secretValue.trim();
  return "";
}

function envValue(env: Record<string, unknown>, key: string): string {
  return adapterValue(env[key]);
}

function firstNonEmpty(...values: string[]): string {
  return values.map((value) => value.trim()).find(Boolean) ?? "";
}

function stripThink(text: unknown): string {
  return String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .trim();
}

function truncate(text: unknown, limit = 500): string {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

async function resolveApiKey(config: Record<string, unknown>) {
  const env = asRecord(config.env);
  const explicit = firstNonEmpty(
    envValue(env, "MINIMAX_API_KEY"),
    process.env.MINIMAX_API_KEY ?? "",
  );

  if (explicit) {
    return {
      ok: true as const,
      key: explicit,
      source: envValue(env, "MINIMAX_API_KEY") ? "adapter config env" : "server environment",
    };
  }

  const keyFile = firstNonEmpty(
    envValue(env, "MINIMAX_API_KEY_FILE"),
    process.env.MINIMAX_API_KEY_FILE ?? "",
  );

  if (!keyFile) {
    return {
      ok: false as const,
      error: "MiniMax API credentials are missing.",
      hint: "Set env.MINIMAX_API_KEY or env.MINIMAX_API_KEY_FILE, or provide server-level MINIMAX_API_KEY_FILE.",
    };
  }

  try {
    const key = (await readFile(keyFile, "utf8")).trim();
    if (!key) {
      return {
        ok: false as const,
        error: "MiniMax API key file is empty.",
        hint: "Replace the MiniMax key file with the funded MiniMax Token Plan key.",
      };
    }

    return {
      ok: true as const,
      key,
      source: envValue(env, "MINIMAX_API_KEY_FILE") ? "adapter config key file" : "server key file",
    };
  } catch (error) {
    return {
      ok: false as const,
      error: `Could not read MiniMax API key file: ${error instanceof Error ? error.message : String(error)}`,
      hint: "Verify the key file exists and is readable by the server container.",
    };
  }
}

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const testedAt = new Date().toISOString();
  const config = asRecord(ctx.config);
  const credential = await resolveApiKey(config);

  if (!credential.ok) {
    return {
      adapterType: "minimax_local",
      status: "fail",
      testedAt,
      checks: [
        {
          code: "minimax_credentials",
          level: "error",
          message: credential.error,
          hint: credential.hint ?? null,
        },
      ],
    };
  }

  const model = firstNonEmpty(adapterValue(config.model), adapterValue(config.primaryModel), DEFAULT_MODEL);
  const baseUrl = firstNonEmpty(adapterValue(config.baseUrl), process.env.MINIMAX_BASE_URL ?? "", DEFAULT_BASE_URL).replace(/\/+$/, "");
  const endpoint = `${baseUrl}/chat/completions`;

  const checks: AdapterEnvironmentTestResult["checks"] = [
    {
      code: "minimax_credentials",
      level: "info",
      message: "MiniMax API credentials are configured.",
      detail: `Detected in ${credential.source}.`,
    },
  ];

  const body = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are responding to a Paperclip adapter health check. Do not include reasoning, markdown, XML, or <think> tags. Return exactly the two letters OK.",
      },
      {
        role: "user",
        content: "Return exactly: OK",
      },
    ],
    temperature: 0,
    max_tokens: 128,
    max_completion_tokens: 128,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();

    if (!response.ok) {
      checks.push({
        code: "minimax_completion",
        level: "error",
        message: `MiniMax API probe failed with HTTP ${response.status}.`,
        detail: truncate(text),
      });

      return {
        adapterType: "minimax_local",
        status: "fail",
        testedAt,
        checks,
      };
    }

    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      checks.push({
        code: "minimax_completion",
        level: "error",
        message: "MiniMax API returned non-JSON output.",
        detail: truncate(text),
      });

      return {
        adapterType: "minimax_local",
        status: "fail",
        testedAt,
        checks,
      };
    }

    const raw = json?.choices?.[0]?.message?.content ?? "";
    const cleaned = stripThink(raw);
    const exactOk = /^OK[.!]?$/i.test(cleaned);

    checks.push({
      code: "minimax_completion",
      level: "info",
      message: exactOk
        ? "MiniMax API completion probe succeeded."
        : "MiniMax API authenticated and returned a completion response.",
      detail: exactOk
        ? `Model: ${model}`
        : `Probe response was non-OK after stripping reasoning; not treated as credential failure. Sanitized response: ${truncate(cleaned || raw)}`,
    });

    return {
      adapterType: "minimax_local",
      status: "pass",
      testedAt,
      checks,
    };
  } catch (error) {
    checks.push({
      code: "minimax_completion",
      level: "error",
      message: "MiniMax API probe failed.",
      detail: error instanceof Error ? error.message : String(error),
    });

    return {
      adapterType: "minimax_local",
      status: "fail",
      testedAt,
      checks,
    };
  } finally {
    clearTimeout(timeout);
  }
}
