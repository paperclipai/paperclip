import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "kiro-cli");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({ code: "kiro_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
  } catch (err) {
    checks.push({
      code: "kiro_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({ code: "kiro_command_resolvable", level: "info", message: `Command is executable: ${command}` });
  } catch (err) {
    checks.push({
      code: "kiro_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const canProbe = checks.every(
    (c) => c.code !== "kiro_cwd_invalid" && c.code !== "kiro_command_unresolvable",
  );

  if (canProbe) {
    const probe = await runChildProcess(
      `kiro-envtest-${Date.now()}`,
      command,
      ["whoami", "--format", "json"],
      { cwd, env, timeoutSec: 15, graceSec: 5, onLog: async () => {} },
    );

    if (probe.timedOut) {
      checks.push({
        code: "kiro_whoami_timed_out",
        level: "warn",
        message: "Kiro CLI whoami probe timed out.",
        hint: "Retry the probe. If this persists, verify kiro-cli can run from this environment.",
      });
    } else if ((probe.exitCode ?? 1) === 0) {
      checks.push({
        code: "kiro_auth_ok",
        level: "info",
        message: "Kiro CLI is authenticated.",
      });
    } else {
      checks.push({
        code: "kiro_auth_required",
        level: "warn",
        message: "Kiro CLI is installed but login may be required.",
        hint: "Run `kiro-cli login` to authenticate, then retry.",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
