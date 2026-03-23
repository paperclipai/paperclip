import path from "node:path";
import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
  AdapterEnvironmentCheckLevel,
} from "@paperclipai/adapter-utils";
import {
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  asString,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";

function commandLooksLikeKiroCli(command: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === "kiro-cli" || base === "kiro-cli.cmd" || base === "kiro-cli.exe";
}

/**
 * Test Kiro CLI environment.
 *
 * Checks:
 * 1. cwd exists and is valid
 * 2. kiro-cli command is resolvable in PATH
 * 3. Auth status via `kiro-cli whoami --format json` (returns {accountType, email})
 */
export async function testEnvironment(
  context: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(context.config);
  const configuredCwd = asString(config.cwd, "");
  const cwd = configuredCwd || process.cwd();
  const command = asString(config.command, "kiro-cli");

  let hasError = false;
  let hasWarn = false;

  function addCheck(
    code: string,
    level: AdapterEnvironmentCheckLevel,
    message: string,
    detail?: string | null,
    hint?: string | null,
  ): void {
    if (level === "error") hasError = true;
    if (level === "warn") hasWarn = true;
    const check: AdapterEnvironmentCheck = { code, level, message };
    if (detail != null) check.detail = detail;
    if (hint != null) check.hint = hint;
    checks.push(check);
  }

  // Check 1: cwd exists
  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    addCheck("kiro_cwd_valid", "info", `Working directory exists: ${cwd}`);
  } catch (err) {
    addCheck(
      "kiro_cwd_invalid",
      "error",
      `Working directory does not exist: ${cwd}`,
      err instanceof Error ? err.message : String(err),
    );
    return { adapterType: context.adapterType, status: "fail", checks, testedAt: new Date().toISOString() };
  }

  // Build runtime env
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
  const runtimeEnv = ensurePathInEnv(env) as Record<string, string>;

  // Check 2: kiro-cli command is resolvable
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    addCheck("kiro_command_resolvable", "info", `kiro-cli command found: ${command}`);
  } catch (err) {
    addCheck(
      "kiro_command_unresolvable",
      "error",
      err instanceof Error ? err.message : "Command not found",
      command,
    );
    return { adapterType: context.adapterType, status: "fail", checks, testedAt: new Date().toISOString() };
  }

  // Check 3: whoami probe (skip for custom commands)
  if (!commandLooksLikeKiroCli(command)) {
    addCheck(
      "kiro_whoami_probe_skipped_custom_command",
      "info",
      "Skipped whoami probe because command is not `kiro-cli`.",
      command,
      "To run the whoami probe, set the command to kiro-cli.",
    );
  } else {
    try {
      const proc = await runChildProcess("test-whoami", command, ["whoami", "--format", "json"], {
        cwd,
        env: runtimeEnv,
        timeoutSec: 10,
        graceSec: 2,
        onLog: async () => {},
      });

      if (proc.timedOut) {
        addCheck(
          "kiro_whoami_probe_timed_out",
          "warn",
          "Kiro whoami probe timed out.",
          null,
          "Run `kiro-cli whoami --format json` manually to check.",
        );
      } else if (proc.exitCode === 0) {
        try {
          const whoami = JSON.parse(proc.stdout);
          const accountType = whoami.accountType || whoami.account_type || "unknown";
          const email = whoami.email || "unknown";
          addCheck(
            "kiro_whoami_probe_passed",
            "info",
            `Kiro authentication successful. Account: ${accountType}, Email: ${email}`,
            `Logged in as ${email} (${accountType})`,
          );
        } catch {
          addCheck(
            "kiro_whoami_probe_unexpected_output",
            "warn",
            "Kiro whoami probe ran but returned unexpected output.",
            proc.stdout,
            "Expected JSON from `kiro-cli whoami --format json`. Check kiro-cli version.",
          );
        }
      } else {
        const stderr = proc.stderr.trim();
        const isAuthError =
          stderr.toLowerCase().includes("authentication") ||
          stderr.toLowerCase().includes("login") ||
          stderr.toLowerCase().includes("not authenticated");

        if (isAuthError) {
          addCheck(
            "kiro_whoami_probe_auth_required",
            "warn",
            "Kiro CLI is installed, but authentication is not ready.",
            stderr,
            "Run `kiro-cli login` to authenticate, then try again.",
          );
        } else {
          addCheck(
            "kiro_whoami_probe_failed",
            "error",
            "Kiro whoami probe failed.",
            stderr,
            "Run `kiro-cli whoami --format json` manually to diagnose.",
          );
        }
      }
    } catch (err) {
      addCheck(
        "kiro_whoami_probe_failed",
        "error",
        "Kiro whoami probe failed.",
        err instanceof Error ? err.message : String(err),
        "Run `kiro-cli whoami --format json` manually to diagnose.",
      );
    }
  }

  return {
    adapterType: context.adapterType,
    status: hasError ? "fail" : hasWarn ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
