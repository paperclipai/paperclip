/**
 * Environment test for the Hermes Agent adapter.
 *
 * Verifies that Hermes Agent is installed, accessible, and configured
 * before allowing the adapter to be used.
 */

import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

import { HERMES_CLI, DEFAULT_MODEL, ADAPTER_TYPE, VALID_PROVIDERS } from "../shared/constants.js";
import { detectModel, resolveProvider, inferProviderFromModel } from "./detect-model.js";
import { resolveHermesCommand } from "./execute.js";

const execFileAsync = promisify(execFile);

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkCliInstalled(
  command: string,
): Promise<AdapterEnvironmentCheck | null> {
  try {
    // Try to run the command to see if it exists
    await execFileAsync(command, ["--version"], { timeout: 10_000 });
    return null; // OK — it ran successfully
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return {
        level: "error",
        message: `Hermes CLI "${command}" not found in PATH`,
        hint: "Install Hermes Agent: pip install hermes-agent",
        code: "hermes_cli_not_found",
      };
    }
    // Command exists but --version might have failed for some reason
    // Still consider it installed
    return null;
  }
}

async function checkCliVersion(
  command: string,
): Promise<AdapterEnvironmentCheck | null> {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], {
      timeout: 10_000,
    });
    const version = stdout.trim();
    if (version) {
      return {
        level: "info",
        message: `Hermes Agent version: ${version}`,
        code: "hermes_version",
      };
    }
    return {
      level: "warn",
      message: "Could not determine Hermes Agent version",
      code: "hermes_version_unknown",
    };
  } catch {
    return {
      level: "warn",
      message:
        "Could not determine Hermes Agent version (hermes --version failed)",
      hint: "Make sure the hermes CLI is properly installed and functional",
      code: "hermes_version_failed",
    };
  }
}

async function checkPython(): Promise<AdapterEnvironmentCheck | null> {
  try {
    const { stdout } = await execFileAsync("python3", ["--version"], {
      timeout: 5_000,
    });
    const version = stdout.trim();
    const match = version.match(/(\d+)\.(\d+)/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      if (major < 3 || (major === 3 && minor < 10)) {
        return {
          level: "error",
          message: `Python ${version} found — Hermes requires Python 3.10+`,
          hint: "Upgrade Python to 3.10 or later",
          code: "hermes_python_old",
        };
      }
    }
    return null; // OK
  } catch {
    return {
      level: "warn",
      message: "python3 not found in PATH",
      hint: "Hermes Agent requires Python 3.10+. Install it from python.org",
      code: "hermes_python_missing",
    };
  }
}

function checkModel(
  config: Record<string, unknown>,
): AdapterEnvironmentCheck | null {
  const model = asString(config.model);
  if (!model) {
    return {
      level: "info",
      message: "No model specified — Hermes will use its configured default model",
      hint: "Set a model explicitly in Paperclip only if you want to override your local Hermes configuration.",
      code: "hermes_configured_default_model",
    };
  }
  return {
    level: "info",
    message: `Model: ${model}`,
    code: "hermes_model_configured",
  };
}

async function checkApiKeys(
  config: Record<string, unknown>,
  detectedConfig: Awaited<ReturnType<typeof detectModel>> | null,
): Promise<AdapterEnvironmentCheck | null> {
  // The server resolves secret refs into config.env before calling testEnvironment,
  // so we check config.env first (adapter-configured secrets), then fall back to
  // process.env (server/host environment), then ~/.hermes/.env (Hermes local config).
  const envConfig = (config.env ?? {}) as Record<string, unknown>;
  const resolvedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string" && value.length > 0) resolvedEnv[key] = value;
  }

  // Also read ~/.hermes/.env — Hermes stores API keys there by default and does
  // not export them to the parent process, so Paperclip's process.env won't
  // contain them.  Parsing this file ensures the environment test reports
  // accurate results for keys that Hermes already knows about.
  const hermesEnvKeys: Record<string, string> = {};
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "/root";
    const hermesEnvPath = `${homeDir}/.hermes/.env`;
    const content = readFileSync(hermesEnvPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim();
        if (value.length > 0) hermesEnvKeys[key] = value;
      }
    }
  } catch {
    // ~/.hermes/.env may not exist — that's fine
  }

  const has = (key: string): boolean =>
    !!(resolvedEnv[key] ?? process.env[key] ?? hermesEnvKeys[key]);

  const hasAnthropic = has("ANTHROPIC_API_KEY");
  const hasOpenRouter = has("OPENROUTER_API_KEY");
  const hasOpenAI = has("OPENAI_API_KEY");
  const hasZai = has("ZAI_API_KEY");
  const hasKimi = has("KIMI_API_KEY");
  const hasMiniMax = has("MINIMAX_API_KEY");

  const providers: string[] = [];
  if (hasAnthropic) providers.push("Anthropic");
  if (hasOpenRouter) providers.push("OpenRouter");
  if (hasOpenAI) providers.push("OpenAI");
  if (hasZai) providers.push("Z.AI");
  if (hasKimi) providers.push("Kimi");
  if (hasMiniMax) providers.push("MiniMax");

  if (providers.length > 0) {
    return {
      level: "info",
      message: `API keys found: ${providers.join(", ")}`,
      code: "hermes_api_keys_found",
    };
  }

  const requestedModel = asString(config.model);

  const supportedProviders = VALID_PROVIDERS as readonly string[];
  const modelMatchesRequested =
    !!detectedConfig?.model &&
    (!requestedModel || detectedConfig.model.toLowerCase() === requestedModel.toLowerCase());

  const matchingHermesConfigApiKey =
    !!detectedConfig?.hasApiKey &&
    modelMatchesRequested;

  if (matchingHermesConfigApiKey && detectedConfig) {
    const providerLabel = detectedConfig.provider.trim();

    if (!providerLabel) {
      return {
        level: "info",
        message: "Hermes config includes an API key for the requested model via ~/.hermes/config.yaml without an explicit provider",
        hint: "Skipping the built-in API-key warning because Hermes can use model.api_key from the local Hermes config.",
        code: "hermes_api_key_in_config",
      };
    }

    if (!supportedProviders.includes(providerLabel)) {
      return {
        level: "info",
        message: `Hermes config includes runtime settings for unsupported adapter provider "${providerLabel}" via ~/.hermes/config.yaml`,
        hint: "Skipping the built-in API-key warning because Hermes can resolve this provider at runtime.",
        code: "hermes_custom_provider_config",
      };
    }

    return {
      level: "info",
      message: `Hermes config includes an API key for provider "${providerLabel}" via ~/.hermes/config.yaml`,
      hint: "Skipping the built-in API-key warning because Hermes can use model.api_key from the local Hermes config.",
      code: "hermes_api_key_in_config",
    };
  }

  return {
    level: "warn",
    message: "No LLM API keys found in environment",
    hint: "Set API keys in the agent's env secrets or ~/.hermes/.env. Hermes supports: ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, ZAI_API_KEY, KIMI_API_KEY, MINIMAX_API_KEY",
    code: "hermes_no_api_keys",
  };
}

/**
 * Check provider/model consistency.
 * Warns if the configured provider might be wrong for the model.
 */
async function checkProviderConsistency(
  config: Record<string, unknown>,
  detectedConfig: Awaited<ReturnType<typeof detectModel>> | null,
): Promise<AdapterEnvironmentCheck | null> {
  const model = asString(config.model);
  if (!model) return null;

  const explicitProvider = asString(config.provider);

  const { provider: resolved, resolvedFrom } = resolveProvider({
    explicitProvider,
    detectedProvider: detectedConfig?.provider,
    detectedModel: detectedConfig?.model,
    detectedBaseUrl: detectedConfig?.baseUrl,
    detectedHasApiKey: detectedConfig?.hasApiKey,
    detectedApiMode: detectedConfig?.apiMode,
    model,
  });

  // If provider was explicitly set but doesn't match what Hermes config says,
  // that's worth flagging.
  if (explicitProvider && detectedConfig?.provider && explicitProvider !== detectedConfig.provider) {
    return {
      level: "warn",
      message: `Provider mismatch: adapterConfig has "${explicitProvider}" but ~/.hermes/config.yaml has "${detectedConfig.provider}". Using adapterConfig value.`,
      hint: `Model "${model}" may not work correctly with provider "${explicitProvider}". Consider aligning with your Hermes config or removing the explicit provider to use auto-detection.`,
      code: "hermes_provider_mismatch",
    };
  }

  // If Hermes config matches the requested model but uses an adapter-unsupported
  // provider such as "custom", do not report a false provider inference.
  if (!explicitProvider && resolvedFrom.startsWith("hermesConfigUnsupported:")) {
    const unsupportedProvider = resolvedFrom.split(":", 2)[1] || detectedConfig?.provider || "unknown";
    return {
      level: "info",
      message: `Hermes config uses unsupported adapter provider "${unsupportedProvider}" for model "${model}" — deferring to Hermes auto-detection`,
      hint: "Paperclip will avoid model-name provider inference here and let Hermes resolve the provider from ~/.hermes/config.yaml at runtime.",
      code: "hermes_provider_unsupported",
    };
  }

  // If matching Hermes config provides runtime signals without an explicit provider,
  // also defer to Hermes rather than inventing a provider from the model name.
  if (!explicitProvider && resolvedFrom === "hermesConfigRuntime") {
    return {
      level: "info",
      message: `Hermes config provides runtime settings for model "${model}" without an explicit adapter provider — deferring to Hermes auto-detection`,
      hint: "Paperclip will avoid model-name provider inference here and let Hermes resolve the provider from ~/.hermes/config.yaml at runtime.",
      code: "hermes_provider_runtime_config",
    };
  }

  // If provider was auto-detected (not explicitly set), log what was resolved
  if (!explicitProvider && resolvedFrom !== "auto") {
    return {
      level: "info",
      message: `Provider auto-detected as "${resolved}" (from ${resolvedFrom}) for model "${model}"`,
      code: "hermes_provider_detected",
    };
  }

  // If we couldn't resolve any provider, warn
  if (resolvedFrom === "auto" && !explicitProvider) {
    return {
      level: "warn",
      message: `Could not determine provider for model "${model}" — will use Hermes auto-detection`,
      hint: "Set an explicit provider in the agent config or ensure ~/.hermes/config.yaml has a matching provider for this model.",
      code: "hermes_provider_unknown",
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const command = resolveHermesCommand(config);
  const checks: AdapterEnvironmentCheck[] = [];

  // 1. CLI installed?
  const cliCheck = await checkCliInstalled(command);
  if (cliCheck) {
    checks.push(cliCheck);
    if (cliCheck.level === "error") {
      return {
        adapterType: ADAPTER_TYPE,
        status: "fail",
        checks,
        testedAt: new Date().toISOString(),
      };
    }
  }

  // 2. CLI version
  const versionCheck = await checkCliVersion(command);
  if (versionCheck) checks.push(versionCheck);

  // 3. Python available?
  const pythonCheck = await checkPython();
  if (pythonCheck) checks.push(pythonCheck);

  // 4. Model config
  const modelCheck = checkModel(config);
  if (modelCheck) checks.push(modelCheck);

  // 5. Detect Hermes config once for the remaining checks.
  let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
  try {
    detectedConfig = await detectModel();
  } catch {
    // Non-fatal
  }

  // 6. API keys (check config.env — server resolves secrets before calling us)
  const apiKeyCheck = await checkApiKeys(config, detectedConfig);
  if (apiKeyCheck) checks.push(apiKeyCheck);

  // 7. Provider/model consistency
  const providerCheck = await checkProviderConsistency(config, detectedConfig);
  if (providerCheck) checks.push(providerCheck);

  // Determine overall status
  const hasErrors = checks.some((c) => c.level === "error");
  const hasWarnings = checks.some((c) => c.level === "warn");

  return {
    adapterType: ADAPTER_TYPE,
    status: hasErrors ? "fail" : hasWarnings ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
