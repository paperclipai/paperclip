import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  ensurePathInEnv,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import { buildCopilotArgs } from "./copilot-args.js";
import { isCopilotAuthRequiredError, parseCopilotJsonl } from "./parse.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

async function probeNodeVersion(runId: string, target: AdapterEnvironmentTestContext["executionTarget"], cwd: string, env: Record<string, string>): Promise<AdapterEnvironmentCheck> {
  const probe = await runAdapterExecutionTargetProcess(runId, target ?? null, "node", ["--version"], {
    cwd,
    env,
    timeoutSec: 10,
    graceSec: 2,
    onLog: async () => {},
  });
  const version = firstNonEmptyLine(probe.stdout || probe.stderr);
  if ((probe.exitCode ?? 1) !== 0 || !version) {
    return {
      code: "copilot_node_version_unknown",
      level: "warn",
      message: "Could not detect Node.js version for Copilot CLI.",
      hint: "Install Node.js 20+ before installing GitHub Copilot CLI.",
    };
  }
  return {
    code: "copilot_node_version",
    level: "info",
    message: `Node.js detected: ${version}`,
  };
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "copilot");
  const target = ctx.executionTarget ?? null;
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const runId = `copilot-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: runtimeEnv,
      createIfMissing: true,
    });
    checks.push({
      code: "copilot_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "copilot_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  checks.push(await probeNodeVersion(runId, target, cwd, runtimeEnv));

  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({
      code: "copilot_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "copilot_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  if (
    hasNonEmptyEnvValue(runtimeEnv, "COPILOT_GITHUB_TOKEN") ||
    hasNonEmptyEnvValue(runtimeEnv, "GH_TOKEN") ||
    hasNonEmptyEnvValue(runtimeEnv, "GITHUB_TOKEN")
  ) {
    checks.push({
      code: "copilot_token_present",
      level: "info",
      message: "Copilot auth token env is present.",
      detail: "Detected COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN.",
    });
  } else {
    checks.push({
      code: "copilot_auth_hint",
      level: "warn",
      message: "No Copilot auth token env detected.",
      hint: "Run `copilot login`, or set COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN with Copilot Requests permission.",
    });
  }

  const canProbe = checks.every((check) => check.code !== "copilot_cwd_invalid" && check.code !== "copilot_command_unresolvable");
  if (canProbe && path.basename(command).toLowerCase().startsWith("copilot")) {
    const args = buildCopilotArgs(config, "Respond with hello.").args;
    const probe = await runAdapterExecutionTargetProcess(runId, target, command, args, {
      cwd,
      env,
      timeoutSec: 45,
      graceSec: 5,
      onLog: async () => {},
    });
    const parsed = parseCopilotJsonl(probe.stdout);
    const detail = parsed.errorMessage ?? firstNonEmptyLine(probe.stderr) ?? firstNonEmptyLine(probe.stdout);
    if (probe.timedOut) {
      checks.push({
        code: "copilot_hello_probe_timed_out",
        level: "warn",
        message: "Copilot hello probe timed out.",
      });
    } else if ((probe.exitCode ?? 1) === 0) {
      checks.push({
        code: "copilot_hello_probe_passed",
        level: "info",
        message: "Copilot hello probe succeeded.",
        ...(parsed.summary ? { detail: parsed.summary.slice(0, 240) } : {}),
      });
    } else if (isCopilotAuthRequiredError({ stdout: probe.stdout, stderr: probe.stderr, errorMessage: parsed.errorMessage })) {
      checks.push({
        code: "copilot_hello_probe_auth_required",
        level: "warn",
        message: "Copilot CLI is installed, but authentication is not ready.",
        ...(detail ? { detail: detail.slice(0, 240) } : {}),
        hint: "Run `copilot login`, or set COPILOT_GITHUB_TOKEN with a fine-grained token that has Copilot Requests permission.",
      });
    } else {
      checks.push({
        code: "copilot_hello_probe_failed",
        level: "error",
        message: "Copilot hello probe failed.",
        ...(detail ? { detail: detail.slice(0, 240) } : {}),
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
