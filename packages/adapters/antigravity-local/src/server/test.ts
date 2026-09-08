// Environment diagnostic testing for Antigravity local adapter

import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asBoolean,
  asString,
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
import { detectAntigravityAuthRequired, parseAntigravityJsonl } from "./parse.js";
import { firstNonEmptyLine } from "./utils.js";
import { DEFAULT_ANTIGRAVITY_LOCAL_MODEL } from "../index.js";

// Computes overall pass/warn/fail status from a list of diagnostic checks
function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

// Cleans and truncates probe output for concise diagnostic display
function summarizeProbeDetail(stdout: string, stderr: string, extra?: string | null): string | null {
  const raw = extra || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// Tests the host or remote execution environment for Antigravity readiness
export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "agy");
  const model = asString(config.model, DEFAULT_ANTIGRAVITY_LOCAL_MODEL).trim();
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `antigravity-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "antigravity_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  // Check 1: Working directory accessibility
  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    checks.push({
      code: "antigravity_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "antigravity_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  // Check 2: Environment variables and command resolution
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const hostEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const runtimeEnv: Record<string, string> = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...hostEnv, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  let commandResolvable = false;
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({
      code: "antigravity_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
    commandResolvable = true;
  } catch (err) {
    checks.push({
      code: "antigravity_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "Ensure Antigravity CLI ('agy') is installed and on the system PATH, or provide an absolute path in the command field.",
    });
  }

  // Check 3: Headless probe invocation if command is resolvable
  if (commandResolvable) {
    try {
      const probeArgs = ["--print", "Respond with OK.", "--output-format", "stream-json"];
      if (model && model !== DEFAULT_ANTIGRAVITY_LOCAL_MODEL) {
        probeArgs.push("--model", model);
      }
      if (dangerouslySkipPermissions) {
        probeArgs.push("--dangerously-skip-permissions");
      }

      const probeProc = await runAdapterExecutionTargetProcess(
        runId,
        target,
        command,
        probeArgs,
        {
          cwd,
          env: runtimeEnv,
          timeoutSec: 30,
          graceSec: 5,
          onLog: async () => {},
        },
      );

      const parsed = parseAntigravityJsonl(probeProc.stdout);
      const detail = summarizeProbeDetail(probeProc.stdout, probeProc.stderr, parsed.errorMessage);
      const auth = detectAntigravityAuthRequired({
        parsed: parsed.resultEvent,
        stdout: probeProc.stdout,
        stderr: probeProc.stderr,
      });

      const structuredFailed = Boolean(
        parsed.errorMessage ||
        (parsed.status && ["ERROR", "FAILURE"].includes(parsed.status.toUpperCase()))
      );
      const processFailed = (probeProc.exitCode ?? 0) !== 0;

      if (probeProc.timedOut) {
        checks.push({
          code: "antigravity_probe_failed",
          level: "warn",
          message: "Antigravity readiness probe timed out.",
          detail: detail ?? undefined,
          hint: "Verify Antigravity CLI can run interactively from this directory.",
        });
      } else if (auth.requiresAuth) {
        checks.push({
          code: "antigravity_auth_required",
          level: "warn",
          message: "Antigravity CLI requires authentication.",
          detail: detail ?? undefined,
          hint: "Run 'agy' in an interactive terminal to log in.",
        });
      } else if (!processFailed && !structuredFailed) {
        checks.push({
          code: "antigravity_cli_ready",
          level: "info",
          message: "Antigravity CLI is ready and responding to commands.",
          detail: parsed.summary ? parsed.summary.slice(0, 200) : undefined,
        });
      } else {
        checks.push({
          code: "antigravity_probe_failed",
          level: "warn",
          message: `Antigravity probe failed (exit code: ${probeProc.exitCode ?? -1}).`,
          detail: detail ?? undefined,
          hint: "Check Antigravity CLI installation and credentials.",
        });
      }
    } catch (err) {
      checks.push({
        code: "antigravity_probe_error",
        level: "error",
        message: err instanceof Error ? err.message : "Failed to execute Antigravity probe",
      });
    }
  }

  return {
    adapterType: "antigravity_local",
    status: summarizeStatus(checks),
    testedAt: new Date().toISOString(),
    checks,
  };
}
