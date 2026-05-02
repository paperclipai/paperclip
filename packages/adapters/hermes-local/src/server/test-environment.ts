import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { detectModel, resolveProvider } from "./detect-model.js";

const execFileAsync = promisify(execFile);

const ADAPTER_TYPE = "hermes_local";
const HERMES_CLI = "hermes";

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

async function checkCliInstalled(command: string): Promise<{ level: string; message: string; hint?: string; code: string } | null> {
  try {
    await execFileAsync(command, ["--version"], { timeout: 10_000 });
    return null;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return {
        level: "error",
        message: `Hermes CLI "${command}" not found in PATH`,
        hint: "Install Hermes Agent: pip install hermes-agent",
        code: "hermes_cli_not_found",
      };
    }
    return null;
  }
}

async function checkCliVersion(command: string): Promise<{ level: string; message: string; hint?: string; code: string }> {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], { timeout: 10_000 });
    const version = stdout.trim();
    if (version) {
      return { level: "info", message: `Hermes Agent version: ${version}`, code: "hermes_version" };
    }
    return { level: "warn", message: "Could not determine Hermes Agent version", code: "hermes_version_unknown" };
  } catch {
    return {
      level: "warn",
      message: "Could not determine Hermes Agent version (hermes --version failed)",
      hint: "Make sure the hermes CLI is properly installed and functional",
      code: "hermes_version_failed",
    };
  }
}

async function checkPython(): Promise<{ level: string; message: string; hint?: string; code: string } | null> {
  try {
    const { stdout } = await execFileAsync("python3", ["--version"], { timeout: 5_000 });
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
    return null;
  } catch {
    return {
      level: "warn",
      message: "python3 not found in PATH",
      hint: "Hermes Agent requires Python 3.10+. Install it from python.org",
      code: "hermes_python_missing",
    };
  }
}

function checkModel(config: Record<string, unknown>): { level: string; message: string; hint?: string; code: string } {
  const model = asString(config.model);
  if (!model) {
    return {
      level: "info",
      message: "No model specified — Hermes will use its configured default model",
      hint: "Set a model explicitly in Paperclip only if you want to override your local Hermes configuration.",
      code: "hermes_configured_default_model",
    };
  }
  return { level: "info", message: `Model: ${model}`, code: "hermes_model_configured" };
}

function checkApiKeys(config: Record<string, unknown>): { level: string; message: string; hint?: string; code: string } {
  const envConfig = (config.env ?? {}) as Record<string, string>;
  const resolvedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string" && value.length > 0) resolvedEnv[key] = value;
  }
  const has = (key: string) => !!(resolvedEnv[key] ?? process.env[key]);
  const hasAnthropic = has("ANTHROPIC_API_KEY");
  const hasOpenRouter = has("OPENROUTER_API_KEY");
  const hasOpenAI = has("OPENAI_API_KEY");
  const hasZai = has("ZAI_API_KEY");
  const hasKimi = has("KIMI_API_KEY");
  const hasMiniMax = has("MINIMAX_API_KEY");
  if (!hasAnthropic && !hasOpenRouter && !hasOpenAI && !hasZai && !hasKimi && !hasMiniMax) {
    return {
      level: "warn",
      message: "No LLM API keys found in environment",
      hint: "Set API keys in the agent's env secrets or ~/.hermes/.env. Hermes supports: ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, ZAI_API_KEY, KIMI_API_KEY, MINIMAX_API_KEY",
      code: "hermes_no_api_keys",
    };
  }
  const providers: string[] = [];
  if (hasAnthropic) providers.push("Anthropic");
  if (hasOpenRouter) providers.push("OpenRouter");
  if (hasOpenAI) providers.push("OpenAI");
  if (hasZai) providers.push("Z.AI");
  if (hasKimi) providers.push("Kimi");
  if (hasMiniMax) providers.push("MiniMax");
  return { level: "info", message: `API keys found: ${providers.join(", ")}`, code: "hermes_api_keys_found" };
}

async function checkProviderConsistency(config: Record<string, unknown>): Promise<{ level: string; message: string; hint?: string; code: string } | null> {
  const model = asString(config.model);
  if (!model) return null;
  const explicitProvider = asString(config.provider);
  let detectedConfig = null;
  try {
    detectedConfig = await detectModel();
  } catch {
    // Non-fatal
  }
  const { provider: resolved, resolvedFrom } = resolveProvider({
    explicitProvider,
    detectedProvider: detectedConfig?.provider,
    detectedModel: detectedConfig?.model,
    model,
  });
  if (explicitProvider && detectedConfig?.provider && explicitProvider !== detectedConfig.provider) {
    return {
      level: "warn",
      message: `Provider mismatch: adapterConfig has "${explicitProvider}" but ~/.hermes/config.yaml has "${detectedConfig.provider}". Using adapterConfig value.`,
      hint: `Model "${model}" may not work correctly with provider "${explicitProvider}". Consider aligning with your Hermes config or removing the explicit provider to use auto-detection.`,
      code: "hermes_provider_mismatch",
    };
  }
  if (!explicitProvider && resolvedFrom !== "auto") {
    return {
      level: "info",
      message: `Provider auto-detected as "${resolved}" (from ${resolvedFrom}) for model "${model}"`,
      code: "hermes_provider_detected",
    };
  }
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

export async function testEnvironment(ctx: { config?: unknown }): Promise<AdapterEnvironmentTestResult> {
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const command = asString(config.hermesCommand) || HERMES_CLI;
  const checks: AdapterEnvironmentTestResult["checks"] = [];

  const cliCheck = await checkCliInstalled(command);
  if (cliCheck) {
    checks.push(cliCheck as AdapterEnvironmentTestResult["checks"][number]);
    if (cliCheck.level === "error") {
      return { adapterType: ADAPTER_TYPE, status: "fail", checks, testedAt: new Date().toISOString() };
    }
  }

  const versionCheck = await checkCliVersion(command);
  checks.push(versionCheck as AdapterEnvironmentTestResult["checks"][number]);

  const pythonCheck = await checkPython();
  if (pythonCheck) checks.push(pythonCheck as AdapterEnvironmentTestResult["checks"][number]);

  const modelCheck = checkModel(config);
  checks.push(modelCheck as AdapterEnvironmentTestResult["checks"][number]);

  const apiKeyCheck = checkApiKeys(config);
  checks.push(apiKeyCheck as AdapterEnvironmentTestResult["checks"][number]);

  const providerCheck = await checkProviderConsistency(config);
  if (providerCheck) checks.push(providerCheck as AdapterEnvironmentTestResult["checks"][number]);

  const hasErrors = checks.some((c) => c.level === "error");
  const hasWarnings = checks.some((c) => c.level === "warn");
  return {
    adapterType: ADAPTER_TYPE,
    status: hasErrors ? "fail" : hasWarnings ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
