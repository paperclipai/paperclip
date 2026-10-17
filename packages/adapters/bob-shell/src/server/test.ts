/**
 * Environment test for the IBM Bob Shell adapter.
 *
 * Verifies that `bob` CLI is installed and accessible.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";
import { ensurePathInEnv } from "@paperclipai/adapter-utils/server-utils";
import { ADAPTER_TYPE } from "../shared/constants.js";
import { resolveBobCommand } from "./execute.js";

const execFileAsync = promisify(execFile);

/** Inherited process environment with a guaranteed non-empty PATH. */
const ENV_WITH_PATH = ensurePathInEnv({ ...process.env });

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function checkCliInstalled(
  command: string,
): Promise<AdapterEnvironmentCheck | null> {
  try {
    await execFileAsync(command, ["--version"], {
      timeout: 10_000,
      env: ENV_WITH_PATH,
      shell: process.platform === "win32",
    });
    return null; // OK
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return {
        level: "error",
        message: `IBM Bob CLI "${command}" not found in PATH`,
        hint: "Install IBM Bob and ensure the `bob` binary is in your PATH. See https://bob.ibm.com/docs/shell/getting-started/install-bobshell",
        code: "bob_cli_not_found",
      };
    }
    // Command exists but returned non-zero (e.g. license not accepted yet)
    return null;
  }
}

async function checkCliVersion(
  command: string,
): Promise<AdapterEnvironmentCheck | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, ["--version"], {
      timeout: 10_000,
      env: ENV_WITH_PATH,
      shell: process.platform === "win32",
    });
    const version = (stdout || stderr).trim();
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
  const cliCheck = await checkCliInstalled(command);
  if (cliCheck) {
    checks.push(cliCheck);
  }

  // 2. What version?
  const versionCheck = await checkCliVersion(command);
  if (versionCheck) checks.push(versionCheck);

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
