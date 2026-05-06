import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { parseObject } from "../utils.js";
import { rememberOllamaLocalModels } from "./models.js";
import { parseOllamaLocalConfig } from "./config.js";

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

export async function testOllamaLocalEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  let config;
  try {
    config = parseOllamaLocalConfig(ctx.config);
  } catch (error) {
    return {
      adapterType: ctx.adapterType,
      status: "fail",
      checks: [
        fail(
          "ollama_local_config_invalid",
          error instanceof Error ? error.message : "Invalid ollama_local configuration",
        ),
      ],
      testedAt: new Date().toISOString(),
    };
  }

  const checks: AdapterEnvironmentTestResult["checks"] = [
    info("ollama_local_base_url_configured", "Ollama base URL configured", config.baseUrl),
    info("ollama_local_model_configured", "Model configured", config.model),
  ];

  try {
    const response = await fetch(`${config.baseUrl}/api/tags`);
    if (!response.ok) {
      checks.push(
        warn(
          "ollama_local_tags_probe_non_success",
          "Ollama tags probe returned a non-success status",
          `${response.status} ${response.statusText}`,
        ),
      );
    } else {
      const payload = parseObject(await response.json());
      const models = Array.isArray(payload.models)
        ? payload.models
            .map((entry) => parseObject(entry))
            .map((entry) => (typeof entry.name === "string" ? entry.name : typeof entry.model === "string" ? entry.model : null))
            .filter((value): value is string => Boolean(value))
        : [];
      rememberOllamaLocalModels(config.baseUrl, models);
      checks.push(
        info(
          "ollama_local_tags_probe_ok",
          "Ollama responded to /api/tags",
          models.length > 0 ? `${models.length} models discovered` : "No models were reported",
        ),
      );
      if (!models.includes(config.model)) {
        checks.push(
          warn(
            "ollama_local_model_not_found",
            "Configured model was not reported by /api/tags",
            `Configured model: ${config.model}`,
          ),
        );
      }
    }
  } catch (error) {
    checks.push(
      warn(
        "ollama_local_tags_probe_failed",
        "Could not reach the Ollama tags endpoint",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  if (config.enableCommandExecution) {
    checks.push(
      info(
        "ollama_local_command_execution_enabled",
        "Command execution is enabled",
        `cwd=${config.commandCwd || "process.cwd()"}, timeout=${config.commandTimeoutSec}s, maxToolCalls=${config.maxToolCalls}`,
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
