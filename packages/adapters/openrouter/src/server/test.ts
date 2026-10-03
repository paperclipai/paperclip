// ─────────────────────────────────────────────────────────────────
// @paperclipai/adapter-openrouter — Server Test (Environment Check)
// Matches real Paperclip AdapterEnvironmentTestContext / Result
// ─────────────────────────────────────────────────────────────────

import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";
import {
  OPENROUTER_MODELS_ENDPOINT,
  type OpenRouterConfig,
  type OpenRouterModel,
} from "../index.js";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = ctx.config as unknown as OpenRouterConfig;

  // ── 1. Check API key ──────────────────────────────────────────
  const apiKey =
    config.apiKey ||
    process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    checks.push({
      code: "openrouter_api_key_missing",
      level: "error",
      message: "No OpenRouter API key found",
      detail: "Set adapterConfig.apiKey or OPENROUTER_API_KEY environment variable.",
      hint: "Get a key at https://openrouter.ai/keys",
    });
    return {
      adapterType: "openrouter",
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  if (!apiKey.startsWith("sk-or-")) {
    checks.push({
      code: "openrouter_api_key_format",
      level: "warn",
      message: "API key does not start with \"sk-or-\"",
      hint: "Ensure this is a valid OpenRouter key.",
    });
  }

  checks.push({
    code: "openrouter_api_key_found",
    level: "info",
    message: `API key found: ${apiKey.slice(0, 12)}...${apiKey.slice(-4)}`,
  });

  // ── 2. Test API connectivity & fetch models ───────────────────
  try {
    const res = await fetch(OPENROUTER_MODELS_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const errText = await res.text();
      checks.push({
        code: "openrouter_api_error",
        level: "error",
        message: `OpenRouter API returned ${res.status}`,
        detail: errText.slice(0, 200),
      });
      return {
        adapterType: "openrouter",
        status: "fail",
        checks,
        testedAt: new Date().toISOString(),
      };
    }

    const data = (await res.json()) as { data: OpenRouterModel[] };
    const allModels = data.data || [];

    const freeModels = allModels.filter(
      (m) =>
        m.id.endsWith(":free") ||
        (m.pricing?.prompt === "0" && m.pricing?.completion === "0")
    );

    checks.push({
      code: "openrouter_connected",
      level: "info",
      message: `Connected — ${allModels.length} models available (${freeModels.length} free)`,
    });

    // ── 3. Validate selected model ──────────────────────────────
    const selectedModel = config.model || "openrouter/auto";

    if (selectedModel === "openrouter/auto") {
      checks.push({
        code: "openrouter_model_auto",
        level: "info",
        message: "Using auto-routing — OpenRouter selects the best model per request",
      });
    } else {
      const model = allModels.find((m) => m.id === selectedModel);
      if (model) {
        const promptCost = parseFloat(model.pricing?.prompt || "0") * 1_000_000;
        const completionCost = parseFloat(model.pricing?.completion || "0") * 1_000_000;
        checks.push({
          code: "openrouter_model_found",
          level: "info",
          message: `Model "${selectedModel}" — $${promptCost.toFixed(2)}/$${completionCost.toFixed(2)} per 1M tokens, ${model.context_length?.toLocaleString()} ctx`,
        });
      } else {
        checks.push({
          code: "openrouter_model_not_found",
          level: "warn",
          message: `Model "${selectedModel}" not found — may be deprecated or misspelled`,
        });
      }
    }

    const hasErrors = checks.some((c) => c.level === "error");
    const hasWarnings = checks.some((c) => c.level === "warn");

    return {
      adapterType: "openrouter",
      status: hasErrors ? "fail" : hasWarnings ? "warn" : "pass",
      checks,
      testedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    checks.push({
      code: "openrouter_connection_failed",
      level: "error",
      message: `Failed to connect to OpenRouter: ${err.message || err}`,
    });
    return {
      adapterType: "openrouter",
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }
}

/**
 * Fetch all models from OpenRouter — used by listModels() for dynamic model picker.
 */
export async function listOpenRouterModels(): Promise<{ id: string; label: string }[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return [];

  try {
    const res = await fetch(OPENROUTER_MODELS_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];

    const data = (await res.json()) as { data: OpenRouterModel[] };
    return (data.data || [])
      .sort((a, b) => {
        const aFree = a.id.endsWith(":free") || (a.pricing?.prompt === "0" && a.pricing?.completion === "0");
        const bFree = b.id.endsWith(":free") || (b.pricing?.prompt === "0" && b.pricing?.completion === "0");
        if (aFree && !bFree) return -1;
        if (!aFree && bFree) return 1;
        return (a.name || a.id).localeCompare(b.name || b.id);
      })
      .map((m) => ({
        id: m.id,
        label: m.name || m.id,
      }));
  } catch {
    return [];
  }
}
