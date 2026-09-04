import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  ensurePathInEnv,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
} from "@paperclipai/adapter-utils/execution-target";
import { DEFAULT_AGY_LOCAL_MODEL } from "../index.js";
import { parseAgyJsonl } from "./parse.js";

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

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "agy");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `agy-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "agy_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    checks.push({
      code: "agy_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "agy_cwd_invalid",
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
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({
      code: "agy_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "agy_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const canRunProbe = checks.every(
    (check) => check.code !== "agy_cwd_invalid" && check.code !== "agy_command_unresolvable",
  );

  if (canRunProbe) {
    const model = asString(config.model, DEFAULT_AGY_LOCAL_MODEL).trim();
    const effort = asString(config.effort, "").trim();
    const mode = asString(config.mode, "plan").trim();
    const agentPersona = asString(config.agent ?? config.agentPersona, "").trim();
    const sandbox = Boolean(config.sandbox);
    const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
    const helloProbeTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 60));
    const extraArgs = asStringArray(config.extraArgs);

    const args = [
      "--print",
      "Respond with hello.",
      "--output-format",
      "stream-json",
      "--input-format",
      "text",
    ];
    if (sandbox) args.push("--sandbox");
    if (agentPersona) args.push("--agent", agentPersona);
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (mode) args.push("--mode", mode);
    if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    if (extraArgs.length > 0) args.push(...extraArgs);

    const probe = await runAdapterExecutionTargetProcess(
      runId,
      target,
      command,
      args,
      {
        cwd,
        env,
        timeoutSec: helloProbeTimeoutSec,
        graceSec: 5,
        onLog: async () => {},
      },
    );

    const parsed = parseAgyJsonl(probe.stdout);
    const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);

    if (probe.timedOut) {
      checks.push({
        code: "agy_hello_probe_timed_out",
        level: "warn",
        message: "Antigravity hello probe timed out.",
        hint: "Verify agy can run `agy --print \"hello\"` from this directory manually.",
      });
    } else if ((probe.exitCode ?? 1) === 0) {
      const summary = parsed.summary.trim();
      const hasHello = /\bhello\b/i.test(summary);
      checks.push({
        code: hasHello ? "agy_hello_probe_passed" : "agy_hello_probe_unexpected_output",
        level: hasHello ? "info" : "warn",
        message: hasHello
          ? "Antigravity hello probe succeeded."
          : "Antigravity probe ran but did not return `hello` as expected.",
        ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
      });
    } else {
      checks.push({
        code: "agy_hello_probe_failed",
        level: "error",
        message: "Antigravity hello probe failed.",
        ...(detail ? { detail } : {}),
        hint: "Run `agy --print \"hello\" --output-format stream-json` in this working directory to debug.",
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
