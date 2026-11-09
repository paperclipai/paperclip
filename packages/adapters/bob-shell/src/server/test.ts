/**
 * Environment test for the IBM Bob Shell adapter.
 *
 * Verifies that `bob` CLI is installed and accessible.
 */

import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";
import {
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { ADAPTER_TYPE } from "../shared/constants.js";
import { resolveBobCommand } from "./execute.js";

/**
 * Environment and working directory used to probe the CLI. They mirror what
 * `execute` uses for real runs so the probe resolves `bobCommand` the same way.
 * The probe never goes through a shell: `runChildProcess` spawns with
 * `shell: false` (and wraps `.cmd`/`.bat` shims in `cmd.exe` with quoting), so
 * a configured `bobCommand` cannot inject shell syntax.
 */
function probeContext(config: Record<string, unknown>): {
  cwd: string;
  env: Record<string, string>;
} {
  const userEnv =
    config.env && typeof config.env === "object"
      ? Object.fromEntries(
          Object.entries(config.env as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  const cwd =
    typeof config.cwd === "string" && config.cwd.trim().length > 0
      ? config.cwd.trim()
      : process.cwd();
  return {
    cwd,
    env: ensurePathInEnv({ ...process.env, ...userEnv }) as Record<string, string>,
  };
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function checkCliInstalled(
  command: string,
  config: Record<string, unknown>,
): Promise<AdapterEnvironmentCheck | null> {
  const { cwd, env } = probeContext(config);
  try {
    await ensureCommandResolvable(command, cwd, env);
    return null; // OK
  } catch {
    return {
      level: "error",
      message: `IBM Bob CLI "${command}" not found in PATH`,
      hint: "Install IBM Bob and ensure the `bob` binary is in your PATH. See https://bob.ibm.com/docs/shell/getting-started/install-bobshell",
      code: "bob_cli_not_found",
    };
  }
}

async function checkCliVersion(
  command: string,
  config: Record<string, unknown>,
): Promise<AdapterEnvironmentCheck | null> {
  const { cwd, env } = probeContext(config);
  try {
    const result = await runChildProcess(
      `bob-shell-probe-${Date.now()}`,
      command,
      ["--version"],
      {
        cwd,
        env,
        timeoutSec: 10,
        graceSec: 2,
        onLog: async () => {},
      },
    );
    const version = (result.stdout || result.stderr).trim();
    if (version) {
      return {
        level: "info",
        message: `IBM Bob Shell version: ${version}`,
        code: "bob_version",
      };
    }
    return {
      level: "warn",
      message: "Could not determine IBM Bob Shell version",
      code: "bob_version_unknown",
    };
  } catch {
    return {
      level: "warn",
      message: "Could not determine IBM Bob Shell version (bob --version failed)",
      hint: "Ensure the bob CLI is properly installed",
      code: "bob_version_failed",
    };
  }
}

function checkWorkspace(config: Record<string, unknown>): AdapterEnvironmentCheck | null {
  const ws =
    typeof config.workspace === "string" ? config.workspace.trim() : null;
  if (ws && ws.length > 0) {
    return {
      level: "info",
      message: `Workspace override: ${ws}`,
      code: "bob_workspace_configured",
    };
  }
  return {
    level: "info",
    message: "No workspace override — Bob will use the cwd as the workspace root",
    code: "bob_workspace_default",
  };
}

function checkTeamId(config: Record<string, unknown>): AdapterEnvironmentCheck | null {
  const teamId =
    typeof config.teamId === "string" ? config.teamId.trim() : null;
  if (teamId && teamId.length > 0) {
    return {
      level: "info",
      message: `Team ID configured: ${teamId}`,
      code: "bob_team_id_configured",
    };
  }
  // team-id is only required for general API keys — warn, not error
  return null;
}

function checkMaxCost(config: Record<string, unknown>): AdapterEnvironmentCheck | null {
  const maxCost = typeof config.maxCost === "number" ? config.maxCost : 0;
  if (maxCost > 0) {
    return {
      level: "info",
      message: `Max cost per run: ${maxCost} Bobcoins`,
      code: "bob_max_cost_configured",
    };
  }
  return {
    level: "warn",
    message: "No max-cost limit configured — Bob runs may consume unlimited Bobcoins",
    hint: "Set maxCost in the agent config to cap spend per heartbeat run",
    code: "bob_no_max_cost",
  };
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const command = resolveBobCommand(config);
  const checks: AdapterEnvironmentCheck[] = [];

  // 1. Is the CLI installed?
  const cliCheck = await checkCliInstalled(command, config);
  if (cliCheck) {
    checks.push(cliCheck);
  }

  // 2. What version? (only meaningful when the CLI was found)
  if (!cliCheck) {
    const versionCheck = await checkCliVersion(command, config);
    if (versionCheck) checks.push(versionCheck);
  }

  // 3. Workspace configuration
  const wsCheck = checkWorkspace(config);
  if (wsCheck) checks.push(wsCheck);

  // 4. Team ID
  const teamCheck = checkTeamId(config);
  if (teamCheck) checks.push(teamCheck);

  // 5. Cost limits
  const costCheck = checkMaxCost(config);
  if (costCheck) checks.push(costCheck);

  const hasErrors = checks.some((c) => c.level === "error");
  const hasWarnings = checks.some((c) => c.level === "warn");

  return {
    adapterType: ADAPTER_TYPE,
    status: hasErrors ? "fail" : hasWarnings ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
