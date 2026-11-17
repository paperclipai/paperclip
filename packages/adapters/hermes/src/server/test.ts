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

import { buildAgentChildBaseEnv } from "@paperclipai/adapter-utils/agent-child-env";
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { HERMES_CLI, ADAPTER_TYPE, VALID_PROVIDERS } from "../shared/constants.js";
import { detectModel, resolveEffectiveRunConfig, type EffectiveRunConfig } from "./detect-model.js";
import { normalizeConfiguredModel } from "./model-arg.js";
import { resolveHermesCommand, buildRouterProbeLaunchEnv } from "./execute.js";
import { resolveHostHermesDir } from "./skills.js";
import {
  getHermesCommandScanMode,
  type HermesCommandScanMode,
  resolveTrustedHermesLauncher,
} from "./command-scan-policy.js";
import { hermesHostIsolationEnabled } from "./isolation.js";
import {
  RAMP_ROUTER_API_KEY_ENV,
  ROUTER_EXTRA_ARGS_UNSUPPORTED_MESSAGE,
  ROUTER_FRESH_PROFILE_NOTE,
  ROUTER_KEY_MISSING_MESSAGE,
  ROUTER_REMOTE_TARGET_UNSUPPORTED_MESSAGE,
  isRemoteExecutionTarget,
  isRouterEndpointOverrideEnvName,
  probeHermesRouterSupport,
  readRouterApiKey,
  resolveRouterLaunchPlan,
  type RouterLaunchPlanResult,
} from "./router-readiness.js";
import dotenv from "dotenv";
import { testRemoteEnvironment } from "./test-sandbox.js";

const execFileAsync = promisify(execFile);

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * How the preliminary `--version` checks launch Hermes. A Router config passes its bound launcher,
 * cwd and credential-free launch env (see buildRouterReadinessLaunchEnv); `label` is the configured
 * command shown to the operator.
 */
interface CliLaunch {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  label: string;
}

/**
 * Verifies the directory the preliminary `--version` checks would run in.
 *
 * `execFile` reports a missing (or non-directory) working directory with ENOENT, the same code it
 * uses for a missing binary, so launching first would blame the install for a bad workspace path.
 * Callers report this as its own check and launch nothing.
 */
function checkWorkingDirectory(cwd: string): AdapterEnvironmentCheck | null {
  const resolved = path.resolve(cwd);
  const hint = "Point the agent's cwd or workspaceDir at an existing directory.";
  try {
    if (statSync(resolved).isDirectory()) return null;
    return {
      level: "error",
      message: `Hermes working directory "${resolved}" is not a directory`,
      hint,
      code: "hermes_cwd_invalid",
    };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      return {
        level: "error",
        message: `Hermes working directory "${resolved}" could not be read (${code ?? "unknown error"})`,
        hint,
        code: "hermes_cwd_invalid",
      };
    }
    return {
      level: "error",
      message: `Hermes working directory "${resolved}" does not exist`,
      hint,
      code: "hermes_cwd_invalid",
    };
  }
}

async function checkCliInstalled(launch: CliLaunch): Promise<AdapterEnvironmentCheck | null> {
  const { command, cwd, env } = launch;
  try {
    // Try to run the command to see if it exists
    await execFileAsync(command, ["--version"], { cwd, timeout: 10_000, ...(env ? { env } : {}) });
    return null; // OK — it ran successfully
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return {
        level: "error",
        message: `Hermes CLI "${launch.label}" not found in PATH`,
        hint: "Install Hermes Agent: pip install 'hermes-agent[mcp,anthropic]==0.19.0'",
        code: "hermes_cli_not_found",
      };
    }
    // Command exists but --version might have failed for some reason
    // Still consider it installed
    return null;
  }
}

async function checkCliVersion(launch: CliLaunch): Promise<AdapterEnvironmentCheck | null> {
  const { command, cwd, env } = launch;
  try {
    const { stdout } = await execFileAsync(command, ["--version"], {
      cwd,
      timeout: 10_000,
      ...(env ? { env } : {}),
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

/**
 * Supplemental readiness check for ambient python3.
 *
 * Rationale:
 * Ambient python3 on the host or runner is supplemental readiness only;
 * the resolved Hermes CLI may execute in its own venv (such as /opt/hermes/bin/hermes
 * with its own sealed Python 3.13 runtime in Docker) that does not depend on ambient
 * python3 in PATH. Reverting ambient Python checks (missing, spawn failure, malformed,
 * unsupported version) to warnings prevents rejecting valid Hermes venv execution,
 * while still alerting operators where Hermes relies on ambient python3.
 * Actual Hermes CLI resolution failure remains a hard error (hermes_cli_not_found),
 * and production Docker static and live tests enforce the exact Python 3.13 runtime.
 */
export const PYTHON_VERSION_LINE_RE =
  /^Python\s+(\d+)\.(\d+)(?:\.(\d+))?(?:((?:a|b|rc|alpha|beta|c|dev|post)\d+[0-9a-zA-Z.+_-]*|\+[0-9a-zA-Z.+_-]*))?$/;

export function evaluatePythonVersion(
  versionOutput: string,
): AdapterEnvironmentCheck | null {
  const lines = versionOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let matchedLine: string | null = null;
  let major = 0;
  let minor = 0;

  for (const line of lines) {
    const match = line.match(PYTHON_VERSION_LINE_RE);
    if (match) {
      matchedLine = line;
      major = parseInt(match[1], 10);
      minor = parseInt(match[2], 10);
    }
  }

  if (!matchedLine) {
    return {
      level: "warn",
      message: `Could not parse Python version from "${versionOutput.trim()}" - Hermes requires Python >=3.11,<3.14`,
      hint: "Ensure python3 --version outputs a valid version string (e.g. Python 3.13.5)",
      code: "hermes_python_malformed",
    };
  }

  if (major < 3 || (major === 3 && minor < 11)) {
    return {
      level: "warn",
      message: `${matchedLine} found - Hermes requires Python >=3.11,<3.14`,
      hint: "Upgrade Python to 3.11, 3.12, or 3.13",
      code: "hermes_python_old",
    };
  }

  if (major > 3 || (major === 3 && minor >= 14)) {
    return {
      level: "warn",
      message: `${matchedLine} found - Hermes requires Python >=3.11,<3.14`,
      hint: "Use Python 3.11, 3.12, or 3.13 (Python 3.14+ is not yet supported)",
      code: "hermes_python_unsupported",
    };
  }

  return null; // OK
}

export async function checkPython(
  command = "python3",
  execFileFn: typeof execFileAsync = execFileAsync,
): Promise<AdapterEnvironmentCheck | null> {
  try {
    const { stdout, stderr } = await execFileFn(command, ["--version"], {
      timeout: 5_000,
    });
    const output = [stdout, stderr].filter(Boolean).join("\n");
    return evaluatePythonVersion(output);
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error?.code === "ENOENT") {
      return {
        level: "warn",
        message: `${command} not found in PATH`,
        hint: "Hermes Agent requires Python >=3.11,<3.14. Install it from python.org",
        code: "hermes_python_missing",
      };
    }
    return {
      level: "warn",
      message: `Failed to execute ${command}: ${error?.message || String(error)}`,
      hint: "Ensure python3 is executable and accessible",
      code: "hermes_python_spawn_failed",
    };
  }
}

/**
 * TECH-7895: the provider, source and `-m` decision a run would resolve for this config — the same
 * shared resolver execute.ts uses. A hosted (isolated) deployment never reads the host Hermes config,
 * so host-detected signals are dropped there exactly as the run drops them.
 */
export function resolveTestRunConfig(
  config: Record<string, unknown>,
  detectedConfig: Awaited<ReturnType<typeof detectModel>> | null,
): EffectiveRunConfig {
  return resolveEffectiveRunConfig({
    explicitProvider: asString(config.provider),
    configuredModel: asString(config.model),
    detected: hermesHostIsolationEnabled() ? null : detectedConfig,
  });
}

export function checkModel(
  config: Record<string, unknown>,
  detectedConfig: Awaited<ReturnType<typeof detectModel>> | null,
  effective: EffectiveRunConfig = resolveTestRunConfig(config, detectedConfig),
): AdapterEnvironmentCheck | null {
  if (!effective.ok) {
    return {
      level: "error",
      message: effective.message,
      hint: "Hermes cannot be started with a provider but no model. Pick a model for this agent.",
      code: "hermes_model_required",
    };
  }
  // Reports the `-m` the run actually passes (a Router run pins its Hermes default explicitly).
  if (effective.modelArg) {
    return {
      level: "info",
      message: `Model: ${effective.modelArg}`,
      code: "hermes_model_configured",
    };
  }
  if (effective.effectiveModel) {
    return {
      level: "info",
      message: `No model specified — Hermes will use its configured default model (${effective.effectiveModel})`,
      hint: "Set a model explicitly in Paperclip only if you want to override your local Hermes configuration.",
      code: "hermes_configured_default_model",
    };
  }
  return {
    level: "warn",
    message: "No model specified and no default model found in the Hermes config",
    hint: "Set a model on the agent or model.default in the Hermes config; Hermes will otherwise decide on its own.",
    code: "hermes_no_default_model",
  };
}

/**
 * TECH-7895: the credential-free env a Router config's readiness subprocesses (`--version` and the
 * registry probe) launch with — the run's own construction without credentials: the strict base env
 * plus the agent's env, filtered through the same strict allowlist (no keys or app tokens survive),
 * with the command-scan Python protections applied when scanning is required and the Router run's
 * stripped Python module-resolution names removed (buildRouterProbeLaunchEnv, shared with execute.ts).
 */
function buildRouterReadinessLaunchEnv(
  configEnv: Record<string, unknown>,
  scanMode: HermesCommandScanMode,
): Record<string, string> {
  const merged: Record<string, string> = { ...(buildAgentChildBaseEnv(process.env) as Record<string, string>) };
  for (const [name, value] of Object.entries(configEnv)) {
    if (typeof value === "string") merged[name] = value;
  }
  if (scanMode === "required") {
    for (const name of Object.keys(merged)) {
      if (name.toUpperCase().startsWith("PYTHON")) delete merged[name];
    }
    merged.PYTHONNOUSERSITE = "1";
  }
  return buildRouterProbeLaunchEnv(merged);
}

/**
 * TECH-7895: Ramp Router readiness, mirroring the run-time gates exactly: the canonical
 * RAMP_ROUTER_API_KEY with the same precedence as a run (an agent binding — even blank — wins; local
 * runs may otherwise use the host Hermes .env key; another provider's key never counts), local
 * topology only, and the same sandboxed registry probe against the same launcher (after command-scan
 * policy) and PATH the run would use, in a fresh probe home.
 */
async function checkRouterReadiness(
  ctx: AdapterEnvironmentTestContext,
  config: Record<string, unknown>,
  command: string,
  launchEnv: Record<string, string>,
  bound: RouterLaunchPlanResult,
): Promise<AdapterEnvironmentCheck[]> {
  if (isRemoteExecutionTarget(ctx)) {
    return [{ level: "error", message: ROUTER_REMOTE_TARGET_UNSUPPORTED_MESSAGE, code: "hermes_router_remote_unsupported" }];
  }
  const checks: AdapterEnvironmentCheck[] = [];
  const configEnv = (config.env && typeof config.env === "object" ? config.env : {}) as Record<string, unknown>;
  if (Array.isArray(config.extraArgs) && config.extraArgs.length > 0) {
    checks.push({ level: "error", message: ROUTER_EXTRA_ARGS_UNSUPPORTED_MESSAGE, code: "hermes_router_extra_args" });
  }
  let hostEnv: Record<string, string> = {};
  if (!hermesHostIsolationEnabled()) {
    try {
      hostEnv = dotenv.parse(readFileSync(path.join(resolveHostHermesDir(config), ".env"), "utf-8"));
    } catch {
      // No host .env.
    }
  }
  const agentBindsKey = Object.prototype.hasOwnProperty.call(configEnv, RAMP_ROUTER_API_KEY_ENV);
  const effectiveKey = agentBindsKey ? readRouterApiKey(configEnv) : readRouterApiKey(hostEnv);
  checks.push(
    effectiveKey
      ? { level: "info", message: "Ramp Router API key found (RAMP_ROUTER_API_KEY)", code: "hermes_router_key_found" }
      : { level: "error", message: ROUTER_KEY_MISSING_MESSAGE, code: "hermes_router_key_missing" },
  );
  const overrides = [...new Set([...Object.keys(configEnv), ...Object.keys(hostEnv)].filter(isRouterEndpointOverrideEnvName))];
  checks.push({
    level: overrides.length > 0 ? "warn" : "info",
    message:
      overrides.length > 0
        ? `Ignored for Ramp Router runs: ${overrides.join(", ")}. ${ROUTER_FRESH_PROFILE_NOTE}`
        : ROUTER_FRESH_PROFILE_NOTE,
    code: overrides.length > 0 ? "hermes_router_endpoint_override_ignored" : "hermes_router_fresh_profile",
  });
  // The probe inspects the launcher bound once for this test (the same one the `--version` checks
  // ran), with the same credential-free launch env and normalized PATH; nothing is re-resolved.
  const capability = bound.ok
    ? await probeHermesRouterSupport({ command, env: launchEnv, cwd: bound.plan.cwd, launch: bound.plan })
    : { supported: false as const, reason: bound.reason, message: bound.message };
  checks.push(
    capability.supported
      ? { level: "info", message: `Hermes at "${command}" provides the native Ramp Router provider`, code: "hermes_router_supported" }
      : { level: "error", message: capability.message, code: `hermes_router_${capability.reason}` },
  );
  return checks;
}

async function checkApiKeys(
  config: Record<string, unknown>,
  detectedConfig: Awaited<ReturnType<typeof detectModel>> | null,
  effective: EffectiveRunConfig,
): Promise<AdapterEnvironmentCheck | null> {
  // Router readiness is checked by checkRouterReadiness: an unrelated provider key must not count,
  // and the generic warning is suppressed for exactly the configs the run treats as Router.
  if (effective.isRouter) return null;
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

  // RAMP_ROUTER_API_KEY is deliberately absent: it is only a credential for a Router config, and a
  // Router config returns above. On any other config it satisfies no provider, so it must not count
  // as "API keys found" here (it would otherwise silence the warning for a config with no usable key).
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

  const requestedModel = normalizeConfiguredModel(asString(config.model));

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
  effective: EffectiveRunConfig,
): Promise<AdapterEnvironmentCheck | null> {
  const model = normalizeConfiguredModel(asString(config.model));
  if (!model) return null;

  const explicitProvider = asString(config.provider);

  const { provider: resolved, resolvedFrom } = effective;

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
  // 0. Validate parent command scan mode FIRST before resolving command or running any CLI probe
  let scanMode: HermesCommandScanMode;
  try {
    scanMode = getHermesCommandScanMode();
  } catch (err: unknown) {
    return {
      adapterType: ADAPTER_TYPE,
      status: "fail",
      checks: [
        {
          code: "hermes_command_scan_mode_invalid",
          level: "error",
          message: err instanceof Error ? err.message : String(err),
        },
      ],
      testedAt: new Date().toISOString(),
    };
  }

  const config = (ctx.config ?? {}) as Record<string, unknown>;
  // TECH-8174: a remote target is tested inside the target, mirroring the sandbox run path; nothing on
  // this host (its ~/.hermes, its Hermes install, its launcher) is consulted. Local targets continue
  // below unchanged.
  if (isRemoteExecutionTarget(ctx)) {
    return testRemoteEnvironment(ctx, config, scanMode);
  }
  // Match execute.ts: non-empty strings only, no trimming or absolute-path normalization.
  const cwd = asString(config.cwd) || asString(config.workspaceDir) || ".";
  let command = resolveHermesCommand(config);
  if (scanMode === "required") {
    try {
      command = resolveTrustedHermesLauncher(command);
    } catch (err: unknown) {
      return {
        adapterType: ADAPTER_TYPE,
        status: "fail",
        checks: [
          {
            code: "hermes_untrusted_launcher",
            level: "error",
            message: err instanceof Error ? err.message : String(err),
          },
        ],
        testedAt: new Date().toISOString(),
      };
    }
  }
  const checks: AdapterEnvironmentCheck[] = [];

  // Managed connections must prove the selected destination with the isolated
  // runtime environment. Host credentials and ~/.hermes are not evidence. (Remote targets were
  // answered by testRemoteEnvironment above.)
  if (config.managedAiRouting) {
    // TECH-7076: strict allowlist base, never the full server environment.
    const env: NodeJS.ProcessEnv = buildAgentChildBaseEnv(process.env);
    for (const [key, value] of Object.entries((config.env ?? {}) as Record<string, unknown>)) {
      if (typeof value === "string") env[key] = value;
    }
    const args = ["chat", "-Q", "-q", "Respond with hello. Do not use tools.", "--max-turns", "1"];
    if (asString(config.model)) args.push("-m", asString(config.model)!);
    const provider = asString(config.provider);
    if (provider && provider !== "auto") args.push("--provider", provider);
    try {
      const { stdout } = await execFileAsync(command, args, {
        env, cwd: asString(config.cwd), timeout: 45_000, maxBuffer: 1024 * 1024,
      });
      if (!/\bhello\b/i.test(stdout)) throw new Error("No hello response");
      checks.push({ level: "info", code: "hermes_hello_probe_passed", message: "Hermes responded through the selected connection." });
    } catch {
      checks.push({ level: "error", code: "hermes_hello_probe_failed", message: "Hermes could not complete a request through this connection.", hint: "Check the Hermes installation, endpoint, credential, and model, then test again." });
    }
    return { adapterType: ADAPTER_TYPE, status: checks.some(check => check.level === "error") ? "fail" : "pass", checks, testedAt: new Date().toISOString() };
  }

  // Detect the Hermes config once and classify the config exactly as a run would, BEFORE launching
  // anything, so a Router config's preliminary checks already use its bound launcher. Discovery uses
  // the run's own predicate (execute.ts): a hosted (isolated) deployment never reads the host, and an
  // explicit non-"auto" provider with an explicit model never consults the host config.
  let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
  const explicitProvider = asString(config.provider);
  const configuredModel = normalizeConfiguredModel(asString(config.model));
  if (!hermesHostIsolationEnabled() && (!explicitProvider || explicitProvider === "auto" || !configuredModel)) {
    try {
      detectedConfig = await detectModel(path.join(resolveHostHermesDir(config), "config.yaml"));
    } catch {
      // Non-fatal
    }
  }
  const effective = resolveTestRunConfig(config, detectedConfig);

  // TECH-7895: a Router config on a remote target was already answered (refused) by
  // testRemoteEnvironment above, before ANY preliminary CLI or Python subprocess.

  // TECH-7895: a Router config binds its launcher once (absolute cwd, normalized PATH, credential-free
  // launch env); the `--version` checks and the registry probe all use that binding. When it cannot
  // be bound, NO Hermes subprocess runs at all: the binding failure is reported (with the model and
  // key diagnostics, which need no subprocess) and readiness fails.
  let cliLaunch: CliLaunch = { command, cwd, label: command };
  let routerLaunch: { env: Record<string, string>; bound: RouterLaunchPlanResult } | null = null;
  if (effective.isRouter) {
    const configEnv = (config.env && typeof config.env === "object" ? config.env : {}) as Record<string, unknown>;
    const launchEnv = buildRouterReadinessLaunchEnv(configEnv, scanMode);
    const bound = resolveRouterLaunchPlan({ command, pathEnv: launchEnv.PATH, cwd });
    if (bound.ok && launchEnv.PATH !== undefined) launchEnv.PATH = bound.plan.path;
    routerLaunch = { env: launchEnv, bound };
    if (bound.ok) cliLaunch = { command: bound.plan.executable, cwd: bound.plan.cwd, env: launchEnv, label: command };
  }
  const routerBindingFailed = !!routerLaunch && !routerLaunch.bound.ok;

  // 0. Working directory. The `--version` checks run in the run's cwd (for a Router config, the bound
  // plan's cwd), and execFile reports a missing directory as ENOENT — the same code as a missing
  // binary. Check it before the Router-binding gate too, so a bad workspace path is always diagnosed
  // on its own — never misreported as `hermes_cli_not_found` or a binding failure — and no
  // subprocess is spawned.
  const cwdCheck = checkWorkingDirectory(cliLaunch.cwd);
  if (cwdCheck) {
    checks.push(cwdCheck);
    return {
      adapterType: ADAPTER_TYPE,
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  if (!routerBindingFailed) {
    // 1. CLI installed?
    const cliCheck = await checkCliInstalled(cliLaunch);
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
    const versionCheck = await checkCliVersion(cliLaunch);
    if (versionCheck) checks.push(versionCheck);

    // 3. Python available?
    const pythonCheck = await checkPython();
    if (pythonCheck) checks.push(pythonCheck);
  }

  // 4. Model config (the `-m` the run would pass)
  const modelCheck = checkModel(config, detectedConfig, effective);
  if (modelCheck) checks.push(modelCheck);

  // 5. API keys (check config.env — server resolves secrets before calling us)
  const apiKeyCheck = await checkApiKeys(config, detectedConfig, effective);
  if (apiKeyCheck) checks.push(apiKeyCheck);

  // 6. Provider/model consistency
  const providerCheck = await checkProviderConsistency(config, detectedConfig, effective);
  if (providerCheck) checks.push(providerCheck);

  // 7. Ramp Router readiness (TECH-7895). A remote target was already rejected above, so only a
  // locally bound launcher reaches the probe.
  if (effective.isRouter && routerLaunch) {
    checks.push(...(await checkRouterReadiness(ctx, config, command, routerLaunch.env, routerLaunch.bound)));
  }

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
