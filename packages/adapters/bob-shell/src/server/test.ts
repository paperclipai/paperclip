import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  parseObject,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

/**
 * Test environment for Bob Shell adapter.
 * Verifies that the bob command is available in PATH.
 */
export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const testedAt = new Date().toISOString();
  const config = parseObject(ctx.config);
  const command = asString(config.command, "bob");
  const cwd = asString(config.cwd, process.cwd());

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const rawEnv = ensurePathInEnv({ ...process.env, ...env });
  const runtimeEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value === "string") runtimeEnv[key] = value;
  }

  // Check if bob command is available
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "bob_command_resolvable",
      level: "info",
      message: `Bob Shell command is available: ${command}`,
    });
  } catch (error) {
    checks.push({
      code: "bob_command_unresolvable",
      level: "error",
      message: `Bob Shell command not found in PATH`,
      detail: error instanceof Error ? error.message : String(error),
      hint: "Please install Bob Shell and ensure it's available in your system PATH.",
    });
    
    return {
      adapterType: "bob_shell",
      status: "fail",
      checks,
      testedAt,
    };
  }

  // Try to get version
  try {
    const result = await runChildProcess(
      "bob-version-check",
      command,
      ["--version"],
      {
        cwd,
        env: runtimeEnv,
        timeoutSec: 5,
        graceSec: 2,
        onLog: async () => {},
      },
    );

    if (result.exitCode === 0 && result.stdout.trim()) {
      checks.push({
        code: "bob_version_check",
        level: "info",
        message: `Bob Shell version: ${result.stdout.trim()}`,
      });
    } else {
      checks.push({
        code: "bob_version_unexpected",
        level: "warn",
        message: "Bob Shell is available but version check returned unexpected output",
        detail: result.stderr || result.stdout || "(no output)",
      });
    }
  } catch (error) {
    checks.push({
      code: "bob_version_failed",
      level: "warn",
      message: "Bob Shell is available but version check failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    adapterType: "bob_shell",
    status: summarizeStatus(checks),
    checks,
    testedAt,
  };
}
