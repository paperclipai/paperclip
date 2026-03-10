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
import { extractHermesSummary } from "./execute.js";
import path from "node:path";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "hermes");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "hermes_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "hermes_cwd_invalid",
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
    checks.push({
      code: "hermes_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "hermes_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "hermes_cwd_invalid" && check.code !== "hermes_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "hermes")) {
      checks.push({
        code: "hermes_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `hermes`.",
        detail: command,
      });
    } else {
      const probe = await runChildProcess(
        `hermes-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        ["chat", "-q", "Respond with exactly: hello"],
        {
          cwd,
          env,
          timeoutSec: 45,
          graceSec: 5,
          onLog: async () => {},
        },
      );

      const summary = extractHermesSummary(probe.stdout)?.replace(/\s+/g, " ").trim() ?? "";
      if (probe.timedOut) {
        checks.push({
          code: "hermes_hello_probe_timed_out",
          level: "warn",
          message: "Hermes hello probe timed out.",
          hint: "Retry the probe. If this persists, run `hermes chat -q \"Respond with exactly: hello\"` manually.",
        });
      } else if ((probe.exitCode ?? 1) === 0 && /\bhello\b/i.test(summary)) {
        checks.push({
          code: "hermes_hello_probe_passed",
          level: "info",
          message: "Hermes hello probe succeeded.",
          detail: summary,
        });
      } else {
        const detail = summary || probe.stderr.trim() || probe.stdout.trim();
        checks.push({
          code: "hermes_hello_probe_failed",
          level: "error",
          message: "Hermes hello probe failed.",
          ...(detail ? { detail: detail.slice(0, 240) } : {}),
          hint: "Run `hermes chat -q \"Respond with exactly: hello\"` manually to debug the local runtime.",
        });
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
