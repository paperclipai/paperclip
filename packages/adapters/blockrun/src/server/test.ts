import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { validateWalletKey } from "./x402.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);

  // ---- check wallet key ----
  const walletKey = asString(config.walletPrivateKey, "");
  if (!walletKey) {
    checks.push({
      code: "blockrun_wallet_missing",
      level: "error",
      message: "BlockRun adapter requires a walletPrivateKey.",
      hint: "Set adapterConfig.walletPrivateKey to your Base chain wallet private key, or use a Paperclip secret reference.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  // Validate key format
  const walletValidation = validateWalletKey(walletKey);
  if (!walletValidation.valid) {
    checks.push({
      code: "blockrun_wallet_invalid",
      level: "error",
      message: `Invalid wallet private key: ${walletValidation.error}`,
      hint: "Provide a valid hex private key starting with 0x.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  checks.push({
    code: "blockrun_wallet_valid",
    level: "info",
    message: `Wallet address: ${walletValidation.address}`,
  });

  // ---- check API URL ----
  const apiUrl = asString(config.apiUrl, "https://blockrun.ai").replace(/\/+$/, "");
  checks.push({
    code: "blockrun_api_url",
    level: "info",
    message: `API endpoint: ${apiUrl}`,
  });

  // ---- check model config ----
  const model = asString(config.model, "");
  const routingMode = asString(config.routingMode, "balanced");

  if (model) {
    checks.push({
      code: "blockrun_model_configured",
      level: "info",
      message: `Model: ${model}`,
    });
  } else {
    checks.push({
      code: "blockrun_routing_mode",
      level: "info",
      message: `Smart routing mode: ${routingMode} (model auto-selected per task)`,
    });
  }

  // ---- check tuning params ----
  const maxTokens = asNumber(config.maxTokens, 4096);
  const temperature = asNumber(config.temperature, 0.7);
  checks.push({
    code: "blockrun_params",
    level: "info",
    message: `maxTokens=${maxTokens}, temperature=${temperature}`,
  });

  // ---- probe BlockRun API ----
  const modelsUrl = `${apiUrl}/api/v1/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(modelsUrl, {
      method: "GET",
      signal: controller.signal,
    });
    if (response.ok) {
      checks.push({
        code: "blockrun_api_reachable",
        level: "info",
        message: "BlockRun API is reachable.",
      });

      // Validate model exists if explicitly configured
      if (model) {
        const data = (await response.json()) as { data?: Array<{ id: string }> };
        const modelIds = data.data?.map((m) => m.id) ?? [];
        if (modelIds.length > 0 && !modelIds.includes(model)) {
          checks.push({
            code: "blockrun_model_not_found",
            level: "warn",
            message: `Model "${model}" not found in available models.`,
            hint: `Available models include: ${modelIds.slice(0, 5).join(", ")}... See ${apiUrl}/models for full list.`,
          });
        }
      }
    } else {
      checks.push({
        code: "blockrun_api_error",
        level: "warn",
        message: `BlockRun API returned HTTP ${response.status}.`,
        hint: "Check the API URL and network connectivity.",
      });
    }
  } catch (err) {
    checks.push({
      code: "blockrun_api_unreachable",
      level: "warn",
      message: err instanceof Error ? err.message : "BlockRun API probe failed.",
      hint: "Verify network connectivity to blockrun.ai from this host.",
    });
  } finally {
    clearTimeout(timeout);
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
