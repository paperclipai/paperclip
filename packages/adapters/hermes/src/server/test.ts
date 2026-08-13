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
import { detectModel, resolveHermesHomePaths, resolveProvider } from "./detect-model.js";
import { validateHermesAdapterConfig } from "./execute.js";

const execFileAsync = promisify(execFile);

export type SubprocessRunner = (
  command: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const realSubprocessRunner: SubprocessRunner = async (command, args, options) =>
  execFileAsync(command, [...args], options);

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkCliInstalled(
  command: string,
  runner: SubprocessRunner,
): Promise<AdapterEnvironmentCheck | null> {
  try {
    // Try to run the command to see if it exists
    await runner(command, ["--version"], { timeout: 10_000 });
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
  runner: SubprocessRunner,
): Promise<AdapterEnvironmentCheck | null> {
  try {
    const { stdout } = await runner(command, ["--version"], {
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

async function checkPython(runner: SubprocessRunner): Promise<AdapterEnvironmentCheck | null> {
  try {
    const { stdout } = await runner("python3", ["--version"], {
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

async function checkProfile(
  profile: string | undefined,
  runner: SubprocessRunner,
): Promise<AdapterEnvironmentCheck | null> {
  if (!profile) return null;
  try {
    await runner(HERMES_CLI, ["profile", "show", profile], { timeout: 10_000 });
    return {
      level: "info",
      message: `Hermes profile "${profile}" is available`,
      code: "hermes_profile_available",
    };
  } catch {
    return {
      level: "error",
      message: `Hermes profile "${profile}" is not available or could not be loaded`,
      hint: "Create the profile with Hermes or select an existing profile before using this adapter.",
      code: "hermes_profile_unavailable",
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
  selectedEnvPath: string,
): Promise<AdapterEnvironmentCheck | null> {
  // The server resolves secret refs into config.env before calling testEnvironment,
  // so we check config.env first (adapter-configured secrets), then fall back to
  // process.env (server/host environment), then the selected Hermes profile/root
  // .env file that Hermes itself would load.
  const envConfig = (config.env ?? {}) as Record<string, unknown>;
  const resolvedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string" && value.length > 0) resolvedEnv[key] = value;
  }

  // Also read the selected Hermes .env. Hermes stores API keys there by default
  // and does not export them to the parent process, so Paperclip's process.env
  // won't contain them.
  const hermesEnvKeys: Record<string, string> = {};
  try {
    const content = readFileSync(selectedEnvPath, "utf-8");
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
    // The selected Hermes .env may not exist — that's fine.
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
        message: "Selected Hermes profile/config includes an API key for the requested model without an explicit provider",
        hint: "Skipping the built-in API-key warning because Hermes can use model.api_key from the selected profile/config.",
        code: "hermes_api_key_in_config",
      };
    }

    if (!supportedProviders.includes(providerLabel)) {
      return {
        level: "info",
        message: `Selected Hermes profile/config includes runtime settings for unsupported adapter provider "${providerLabel}"`,
        hint: "Skipping the built-in API-key warning because Hermes can resolve this provider at runtime.",
        code: "hermes_custom_provider_config",
      };
    }

    return {
      level: "info",
      message: `Selected Hermes profile/config includes an API key for provider "${providerLabel}"`,
      hint: "Skipping the built-in API-key warning because Hermes can use model.api_key from the selected profile/config.",
      code: "hermes_api_key_in_config",
    };
  }

  return {
    level: "warn",
    message: "No LLM API keys found in environment",
    hint: "Set API keys in the agent's env secrets, process environment, or selected Hermes profile/config. Hermes supports: ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, ZAI_API_KEY, KIMI_API_KEY, MINIMAX_API_KEY",
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
  const providerOverride = explicitProvider && explicitProvider !== "auto"
    ? explicitProvider
    : undefined;

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
  if (providerOverride && detectedConfig?.provider && providerOverride !== detectedConfig.provider) {
    return {
      level: "warn",
      message: `Provider mismatch: adapterConfig has "${providerOverride}" but selected Hermes profile/config has "${detectedConfig.provider}". Using adapterConfig value.`,
      hint: `Model "${model}" may not work correctly with provider "${providerOverride}". Consider aligning with your Hermes config or removing the explicit provider to use auto-detection.`,
      code: "hermes_provider_mismatch",
    };
  }

  // If Hermes config matches the requested model but uses an adapter-unsupported
  // provider such as "custom", do not report a false provider inference.
  if (!providerOverride && resolvedFrom.startsWith("hermesConfigUnsupported:")) {
    const unsupportedProvider = resolvedFrom.split(":", 2)[1] || detectedConfig?.provider || "unknown";
    return {
      level: "info",
      message: `Hermes config uses unsupported adapter provider "${unsupportedProvider}" for model "${model}" — deferring to Hermes auto-detection`,
      hint: "Paperclip will avoid model-name provider inference here and let Hermes resolve the provider from the selected profile/config at runtime.",
      code: "hermes_provider_unsupported",
    };
  }

  // If matching Hermes config provides runtime signals without an explicit provider,
  // also defer to Hermes rather than inventing a provider from the model name.
  if (!providerOverride && resolvedFrom === "hermesConfigRuntime") {
    return {
      level: "info",
      message: `Hermes config provides runtime settings for model "${model}" without an explicit adapter provider — deferring to Hermes auto-detection`,
      hint: "Paperclip will avoid model-name provider inference here and let Hermes resolve the provider from the selected profile/config at runtime.",
      code: "hermes_provider_runtime_config",
    };
  }

  // If provider was auto-detected (not explicitly set), log what was resolved
  if (!providerOverride && resolvedFrom !== "auto") {
    return {
      level: "info",
      message: `Provider auto-detected as "${resolved}" (from ${resolvedFrom}) for model "${model}"`,
      code: "hermes_provider_detected",
    };
  }

  // If we couldn't resolve any provider, warn
  if (resolvedFrom === "auto" && !providerOverride) {
    return {
      level: "warn",
      message: `Could not determine provider for model "${model}" — will use Hermes auto-detection`,
      hint: "Set an explicit provider in the agent config or ensure the selected Hermes profile/config has a matching provider for this model.",
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
  return createHermesEnvironmentTester({ runner: realSubprocessRunner })(ctx);
}

export function createHermesEnvironmentTester(options: {
  runner: SubprocessRunner;
}) {
  return async function testHermesEnvironment(
    ctx: AdapterEnvironmentTestContext,
  ): Promise<AdapterEnvironmentTestResult> {
    const config = (ctx.config ?? {}) as Record<string, unknown>;
    let validatedConfig: ReturnType<typeof validateHermesAdapterConfig>;
    try {
      validatedConfig = validateHermesAdapterConfig(config);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        adapterType: ADAPTER_TYPE,
        status: "fail",
        checks: [{
          level: "error",
          message: reason,
          code: "hermes_invalid_config",
        }],
        testedAt: new Date().toISOString(),
      };
    }
    const command = validatedConfig.command;
    let hermesPaths: ReturnType<typeof resolveHermesHomePaths>;
    try {
      hermesPaths = resolveHermesHomePaths(validatedConfig.profile, {
        validateSelectedHome: !validatedConfig.profile,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        adapterType: ADAPTER_TYPE,
        status: "fail",
        checks: [{
          level: "error",
          message: reason,
          code: "hermes_profile_resolution_failed",
        }],
        testedAt: new Date().toISOString(),
      };
    }
    const checks: AdapterEnvironmentCheck[] = [];

    // 1. CLI installed?
    const cliCheck = await checkCliInstalled(command, options.runner);
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
    const versionCheck = await checkCliVersion(command, options.runner);
    if (versionCheck) checks.push(versionCheck);

    // 3. Python available?
    const pythonCheck = await checkPython(options.runner);
    if (pythonCheck) checks.push(pythonCheck);

    // 4. Named profile available?
    const profileCheck = await checkProfile(validatedConfig.profile, options.runner);
    if (profileCheck) {
      checks.push(profileCheck);
      if (profileCheck.level === "error") {
        return {
          adapterType: ADAPTER_TYPE,
          status: "fail",
          checks,
          testedAt: new Date().toISOString(),
        };
      }
    }

    // 5. Model config
    const modelCheck = checkModel(config);
    if (modelCheck) checks.push(modelCheck);

    // 6. Detect Hermes config once for the remaining checks.
    let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
    try {
      detectedConfig = await detectModel(hermesPaths.configPath);
    } catch {
      // Non-fatal
    }

    // 7. API keys (check config.env — server resolves secrets before calling us)
    const apiKeyCheck = await checkApiKeys(config, detectedConfig, hermesPaths.envPath);
    if (apiKeyCheck) checks.push(apiKeyCheck);

    // 8. Provider/model consistency
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
  };
}
