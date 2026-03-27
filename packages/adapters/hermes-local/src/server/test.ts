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
import { promisify } from "node:util";

import { HERMES_CLI, DEFAULT_MODEL, ADAPTER_TYPE } from "../shared/constants.js";

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
      message: `No model specified — will use default: ${DEFAULT_MODEL}`,
      code: "hermes_default_model",
    };
  }
  return {
    level: "info",
    message: `Model: ${model}`,
    code: "hermes_model_configured",
  };
}

function checkApiKeys(
  config: Record<string, unknown>,
): AdapterEnvironmentCheck | null {
  // The server resolves secret refs into config.env before calling testEnvironment,
  // so we check config.env first (adapter-configured secrets), then fall back to
  // process.env (server/host environment). This mirrors how the Claude adapter does it.
  const envConfig = (config.env ?? {}) as Record<string, unknown>;
  const resolvedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string" && value.length > 0) resolvedEnv[key] = value;
  }

  const has = (key: string): boolean =>
    !!(resolvedEnv[key] ?? process.env[key]);

  const hasAnthropic = has("ANTHROPIC_API_KEY");
  const hasOpenRouter = has("OPENROUTER_API_KEY");
  const hasOpenAI = has("OPENAI_API_KEY");
  const hasZai = has("ZAI_API_KEY");

  if (!hasAnthropic && !hasOpenRouter && !hasOpenAI && !hasZai) {
    return {
      level: "warn",
      message: "No LLM API keys found in environment",
      hint: "Set ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, or ZAI_API_KEY in the agent's env secrets. Hermes may also have keys configured in ~/.hermes/.env",
      code: "hermes_no_api_keys",
    };
  }

  const providers: string[] = [];
  if (hasAnthropic) providers.push("Anthropic");
  if (hasOpenRouter) providers.push("OpenRouter");
  if (hasOpenAI) providers.push("OpenAI");
  if (hasZai) providers.push("Z.AI");

  return {
    level: "info",
    message: `API keys found: ${providers.join(", ")}`,
    code: "hermes_api_keys_found",
  };
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const command = asString(config.hermesCommand) || HERMES_CLI;
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

  // 5. API keys (check config.env — server resolves secrets before calling us)
  const apiKeyCheck = checkApiKeys(config);
  if (apiKeyCheck) checks.push(apiKeyCheck);

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
