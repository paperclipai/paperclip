import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { parseCustomLlmLocalConfig } from "./config.js";

function summarizeStatus(
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function info(code: string, message: string, detail?: string): AdapterEnvironmentCheck {
  return { code, level: "info", message, detail };
}

function warn(code: string, message: string, detail?: string): AdapterEnvironmentCheck {
  return { code, level: "warn", message, detail };
}

function fail(code: string, message: string, detail?: string): AdapterEnvironmentCheck {
  return { code, level: "error", message, detail };
}

export async function testCustomLlmLocalEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  let config;
  try {
    config = parseCustomLlmLocalConfig(ctx.config);
  } catch (error) {
    return {
      adapterType: ctx.adapterType,
      status: "fail",
      checks: [
        fail(
          "custom_llm_local_config_invalid",
          error instanceof Error ? error.message : "Invalid custom_llm_local configuration",
        ),
      ],
      testedAt: new Date().toISOString(),
    };
  }

  const checks: AdapterEnvironmentTestResult["checks"] = [
    info(
      "custom_llm_local_endpoint_configured",
      "Custom LLM endpoint configured",
      `${config.transport} → ${config.baseUrl}`,
    ),
    info("custom_llm_local_model_configured", "Model configured", config.model),
  ];

  if (config.apiKeyEnv) {
    if (process.env[config.apiKeyEnv]) {
      checks.push(
        info("custom_llm_local_api_key_env_present", "API key env var is present", config.apiKeyEnv),
      );
    } else {
      checks.push(
        warn(
          "custom_llm_local_api_key_env_missing",
          "API key env var is not set on the Paperclip server",
          `Set ${config.apiKeyEnv} before running this adapter if the endpoint requires authentication.`,
        ),
      );
    }
  }

  if (config.instructionsFilePath) {
    checks.push(
      info(
        "custom_llm_local_instructions_path_configured",
        "Instructions file path configured",
        config.instructionsFilePath,
      ),
    );
  }

  try {
    const response = await fetch(config.baseUrl, { method: "OPTIONS" });
    checks.push(
      info(
        "custom_llm_local_endpoint_reachable",
        "Endpoint is reachable",
        `${response.status} ${response.statusText || ""}`.trim(),
      ),
    );
  } catch (error) {
    checks.push(
      warn(
        "custom_llm_local_endpoint_probe_failed",
        "Could not probe the base URL directly",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
