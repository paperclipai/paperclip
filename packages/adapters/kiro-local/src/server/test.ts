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
  const command = asString(config.command, "kiro-cli");
  const cwd = asString(config.cwd, process.cwd());

  // Validate working directory
  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "kiro_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "kiro_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  // Validate command resolvable
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "kiro_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "kiro_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "Install Kiro CLI: curl -fsSL https://cli.kiro.dev/install | bash",
    });
  }

  // Run a hello probe if command is resolvable
  const canRunProbe =
    checks.every((check) => check.code !== "kiro_cwd_invalid" && check.code !== "kiro_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "kiro-cli")) {
      checks.push({
        code: "kiro_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `kiro-cli`.",
        detail: command,
      });
    } else {
      const probe = await runChildProcess(
        `kiro-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        ["chat", "--no-interactive", "--format", "json", "--trust-all-tools", "Respond with hello."],
        {
          cwd,
          env,
          timeoutSec: 45,
          graceSec: 5,
          onLog: async () => {},
        },
      );

      const detail = summarizeProbeDetail(probe.stdout, probe.stderr);

      if (probe.timedOut) {
        checks.push({
          code: "kiro_hello_probe_timed_out",
          level: "warn",
          message: "Kiro hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Kiro can run from this directory manually.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const hasHello = /\bhello\b/i.test(probe.stdout);
        checks.push({
          code: hasHello ? "kiro_hello_probe_passed" : "kiro_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Kiro hello probe succeeded."
            : "Kiro probe ran but did not return `hello` as expected.",
          ...(detail ? { detail } : {}),
          ...(hasHello
            ? {}
            : {
                hint: "Try running `kiro-cli chat --no-interactive --format json \"Respond with hello.\"` manually.",
              }),
        });
      } else {
        const isAuthError = /(?:not\s+logged\s+in|please\s+log\s+in|login\s+required|unauthorized)/i.test(
          `${probe.stdout}\n${probe.stderr}`,
        );
        if (isAuthError) {
          checks.push({
            code: "kiro_hello_probe_auth_required",
            level: "warn",
            message: "Kiro CLI is installed, but login is required.",
            ...(detail ? { detail } : {}),
            hint: "Run `kiro-cli login` to authenticate, then retry the probe.",
          });
        } else {
          checks.push({
            code: "kiro_hello_probe_failed",
            level: "error",
            message: "Kiro hello probe failed.",
            ...(detail ? { detail } : {}),
            hint: "Run `kiro-cli chat --no-interactive --format json \"Respond with hello.\"` manually to debug.",
          });
        }
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
