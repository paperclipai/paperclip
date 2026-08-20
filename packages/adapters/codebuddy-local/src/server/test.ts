import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import { asNumber, asString, ensurePathInEnv, parseObject } from "@paperclipai/adapter-utils/server-utils";

function status(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "codebuddy");
  const target = ctx.executionTarget ?? null;
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const runId = `codebuddy-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  if (target?.kind === "remote") {
    checks.push({
      code: "codebuddy_environment_target",
      level: "info",
      message: `Probing inside environment: ${ctx.environmentName ?? describeAdapterExecutionTarget(target)}`,
    });
  }
  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    checks.push({ code: "codebuddy_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
  } catch (error) {
    checks.push({
      code: "codebuddy_cwd_invalid",
      level: "error",
      message: error instanceof Error ? error.message : "Invalid working directory",
    });
  }
  const env = Object.fromEntries(
    Object.entries(parseObject(config.env)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  try {
    await ensureAdapterExecutionTargetCommandResolvable(
      command,
      target,
      cwd,
      ensurePathInEnv({ ...process.env, ...env }),
    );
    checks.push({ code: "codebuddy_command_resolvable", level: "info", message: `Command is executable: ${command}` });
    const version = await runAdapterExecutionTargetProcess(runId, target, command, ["--version"], {
      cwd,
      env,
      timeoutSec: Math.max(1, asNumber(config.helloProbeTimeoutSec, 15)),
      graceSec: 5,
      onLog: async () => {},
    });
    const detail = `${version.stdout}\n${version.stderr}`.trim().replace(/\s+/g, " ").slice(0, 240);
    checks.push({
      code: version.exitCode === 0 ? "codebuddy_version_probe_passed" : "codebuddy_version_probe_failed",
      level: version.exitCode === 0 ? "info" : "warn",
      message: version.exitCode === 0 ? "CodeBuddy CLI version probe succeeded." : "CodeBuddy CLI version probe failed.",
      ...(detail ? { detail } : {}),
    });
    if (version.exitCode === 0) {
      const authProbe = await runAdapterExecutionTargetProcess(
        runId,
        target,
        command,
        ["--print", "-", "--output-format", "stream-json", "--permission-mode", "bypassPermissions"],
        {
          cwd,
          env,
          stdin: "Reply with exactly: ok",
          timeoutSec: Math.max(5, asNumber(config.helloProbeTimeoutSec, 20)),
          graceSec: 5,
          onLog: async () => {},
        },
      );
      const authCombined = `${authProbe.stdout}\n${authProbe.stderr}`;
      if (/authentication\s+required|please\s+(?:use\s+)?\/login|not\s+logged\s+in/i.test(authCombined)) {
        checks.push({
          code: "codebuddy_auth_required",
          level: "error",
          message: "CodeBuddy CLI is not authenticated.",
          detail: "Authentication required. Please use /login to sign in.",
          hint: "On the Paperclip host, run `codebuddy login`, complete browser auth, then retry the agent.",
        });
      } else {
        checks.push({
          code: "codebuddy_auth_probe_passed",
          level: "info",
          message: "CodeBuddy authentication probe did not report a login requirement.",
        });
      }
    }
  } catch (error) {
    checks.push({
      code: "codebuddy_command_unresolvable",
      level: "error",
      message: error instanceof Error ? error.message : "Command is not executable",
      detail: command,
      hint: "Install Tencent CodeBuddy CLI and ensure `codebuddy` is on PATH.",
    });
  }
  return {
    adapterType: "codebuddy_local",
    status: status(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
