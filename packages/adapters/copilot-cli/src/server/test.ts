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
import path from "node:path";

function summarizeStatus(
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function summarizeProbeDetail(stdout: string, stderr: string): string | null {
  const raw = firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
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
  const command = asString(config.command, "gh");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
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

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
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
      hint: "Install the GitHub CLI: https://cli.github.com/",
    });
  }

  const configGhToken = env.GITHUB_TOKEN;
  const hostGhToken = process.env.GITHUB_TOKEN;
  if (isNonEmpty(configGhToken) || isNonEmpty(hostGhToken)) {
    const source = isNonEmpty(configGhToken) ? "adapter config env" : "server environment";
    checks.push({
      code: "copilot_github_token_present",
      level: "info",
      message: "GITHUB_TOKEN is set for GitHub Copilot authentication.",
      detail: `Detected in ${source}.`,
    });
  } else {
    checks.push({
      code: "copilot_github_token_missing",
      level: "warn",
      message:
        "GITHUB_TOKEN is not set. GitHub Copilot may rely on `gh auth login` session.",
      hint: "Set GITHUB_TOKEN in adapter env or run `gh auth login`.",
    });
  }

  const canRunProbe = checks.every(
    (check) =>
      check.code !== "copilot_cwd_invalid" &&
      check.code !== "copilot_command_unresolvable",
  );
  if (canRunProbe) {
    if (!commandLooksLike(command, "gh")) {
      checks.push({
        code: "copilot_probe_skipped_custom_command",
        level: "info",
        message: "Skipped probe because command is not `gh`.",
        detail: command,
        hint: "Use the `gh` CLI command to run the automatic probe.",
      });
    } else {
      const probe = await runChildProcess(
        `copilot-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        ["copilot", "--version"],
        {
          cwd,
          env,
          timeoutSec: 15,
          graceSec: 5,
          onLog: async () => {},
        },
      );
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr);

      if (probe.timedOut) {
        checks.push({
          code: "copilot_probe_timed_out",
          level: "warn",
          message: "GitHub Copilot CLI probe timed out.",
          hint: "Verify `gh copilot --version` works in this environment.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        checks.push({
          code: "copilot_probe_passed",
          level: "info",
          message: "GitHub Copilot CLI is available.",
          ...(detail ? { detail } : {}),
        });
      } else {
        checks.push({
          code: "copilot_probe_failed",
          level: "error",
          message: "GitHub Copilot CLI is not available.",
          ...(detail ? { detail } : {}),
          hint: "Install the Copilot extension: `gh extension install github/gh-copilot`",
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
