import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";
import {
  asString,
  parseObject,
  ensureCommandResolvable,
  ensurePathInEnv,
} from "@paperclipai/adapter-utils/server-utils";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config?.command, "kimi");

  // Check 1: Verify kimi command exists
  try {
    const env = ensurePathInEnv({ ...process.env });
    await ensureCommandResolvable(command, process.cwd(), env);
    checks.push({
      code: "kimi_command_found",
      level: "info",
      message: `Kimi CLI command "${command}" is available`,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    checks.push({
      code: "kimi_command_not_found",
      level: "error",
      message: `Kimi CLI command "${command}" not found`,
      detail: reason,
      hint: "Install Kimi CLI: https://moonshotai.github.io/kimi-cli/",
    });
    return {
      adapterType: "kimi_local",
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  // Check 2: Test kimi login status
  try {
    const { execSync } = await import("child_process");
    const env = ensurePathInEnv({ ...process.env });
    const result = execSync(`${command} info`, {
      encoding: "utf-8",
      timeout: 10000,
      env,
    });
    
    // If info command succeeds, user is logged in
    checks.push({
      code: "kimi_logged_in",
      level: "info",
      message: "Kimi CLI authentication verified",
      detail: result.trim().substring(0, 200),
    });
  } catch (err) {
    const stderr = String((err as Error & { stderr?: string })?.stderr || "");
    const stdout = String((err as Error & { stdout?: string })?.stdout || "");
    const output = `${stdout}\n${stderr}`.toLowerCase();

    if (
      output.includes("not logged in") ||
      output.includes("please log in") ||
      output.includes("unauthorized") ||
      output.includes("login required")
    ) {
      checks.push({
        code: "kimi_not_logged_in",
        level: "error",
        message: "Kimi CLI is not authenticated",
        detail: "Run 'kimi login' to authenticate",
        hint: "Execute: kimi login",
      });
    } else {
      // Command exists but info failed for other reasons
      checks.push({
        code: "kimi_info_failed",
        level: "warn",
        message: "Could not verify Kimi CLI status",
        detail: String(err).substring(0, 200),
        hint: "Ensure Kimi CLI is properly installed and try 'kimi login'",
      });
    }
  }

  // Check 3: Validate cwd if provided
  const cwd = asString(config?.cwd, "");
  if (cwd) {
    try {
      const { statSync } = await import("fs");
      const stats = statSync(cwd);
      if (stats.isDirectory()) {
        checks.push({
          code: "cwd_valid",
          level: "info",
          message: `Working directory exists: ${cwd}`,
        });
      } else {
        checks.push({
          code: "cwd_not_directory",
          level: "error",
          message: `Path is not a directory: ${cwd}`,
        });
      }
    } catch (err) {
      checks.push({
        code: "cwd_not_found",
        level: "warn",
        message: `Working directory does not exist: ${cwd}`,
        detail: err instanceof Error ? err.message : String(err),
        hint: "The directory will be created if possible during execution",
      });
    }
  }

  // Check 4: Validate model if provided
  const model = asString(config?.model, "");
  if (model) {
    const validModels = [
      "kimi-k2-0713",
      "kimi-k2-0713-thinking",
      "kimi-k2-0713-lite",
      "default",
    ];
    if (validModels.includes(model) || model.startsWith("kimi-")) {
      checks.push({
        code: "model_valid",
        level: "info",
        message: `Model appears valid: ${model}`,
      });
    } else {
      checks.push({
        code: "model_unrecognized",
        level: "warn",
        message: `Model may not be recognized: ${model}`,
        hint: "Common models: kimi-k2-0713, kimi-k2-0713-thinking",
      });
    }
  }

  // Determine overall status
  const hasError = checks.some((c) => c.level === "error");
  const hasWarn = checks.some((c) => c.level === "warn");

  return {
    adapterType: "kimi_local",
    status: hasError ? "fail" : hasWarn ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
