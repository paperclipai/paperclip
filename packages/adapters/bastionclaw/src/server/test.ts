import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { existsSync, accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

function summarizeStatus(
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const bastionclawRoot = asString(config.bastionclaw_root, "").trim();

  if (!bastionclawRoot) {
    checks.push({
      code: "bastionclaw_root_missing",
      level: "error",
      message: "bastionclaw_root is not configured.",
      hint: "Set adapterConfig.bastionclaw_root to the BastionClaw installation path.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  if (!existsSync(bastionclawRoot)) {
    checks.push({
      code: "bastionclaw_root_not_found",
      level: "error",
      message: `Directory not found: ${bastionclawRoot}`,
      hint: "Verify bastionclaw_root points to an existing BastionClaw installation.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  checks.push({
    code: "bastionclaw_root_exists",
    level: "info",
    message: `BastionClaw root: ${bastionclawRoot}`,
  });

  // Check SQLite database
  const dbPath = join(bastionclawRoot, "store", "messages.db");
  if (existsSync(dbPath)) {
    try {
      accessSync(dbPath, constants.R_OK);
      checks.push({
        code: "bastionclaw_db_readable",
        level: "info",
        message: "SQLite database is readable.",
      });
    } catch {
      checks.push({
        code: "bastionclaw_db_not_readable",
        level: "error",
        message: "SQLite database exists but is not readable.",
        hint: "Check file permissions on store/messages.db.",
      });
    }
  } else {
    checks.push({
      code: "bastionclaw_db_missing",
      level: "error",
      message: "SQLite database not found at store/messages.db.",
      hint: "Ensure BastionClaw has been initialized and run at least once.",
    });
  }

  // Check IPC directory
  const ipcDir = join(bastionclawRoot, "data", "ipc", "main", "tasks");
  if (existsSync(ipcDir)) {
    checks.push({
      code: "bastionclaw_ipc_dir_exists",
      level: "info",
      message: "IPC tasks directory exists.",
    });
  } else {
    checks.push({
      code: "bastionclaw_ipc_dir_missing",
      level: "warn",
      message: "IPC tasks directory does not exist yet.",
      hint: "It will be created on first task dispatch. Ensure BastionClaw is running.",
    });
  }

  // Check sqlite3 CLI availability
  try {
    execFileSync("sqlite3", ["--version"], { encoding: "utf-8", timeout: 3_000 });
    checks.push({
      code: "bastionclaw_sqlite3_available",
      level: "info",
      message: "sqlite3 CLI is available.",
    });
  } catch {
    checks.push({
      code: "bastionclaw_sqlite3_missing",
      level: "error",
      message: "sqlite3 CLI not found in PATH.",
      hint: "Install sqlite3 (brew install sqlite3 or apt install sqlite3).",
    });
  }

  // Check if BastionClaw process is running (optional, non-blocking)
  try {
    const ps = execFileSync("pgrep", ["-f", "bastionclaw"], {
      encoding: "utf-8",
      timeout: 3_000,
    }).trim();
    if (ps) {
      checks.push({
        code: "bastionclaw_process_running",
        level: "info",
        message: "BastionClaw process detected.",
      });
    }
  } catch {
    checks.push({
      code: "bastionclaw_process_not_found",
      level: "warn",
      message: "No running BastionClaw process detected.",
      hint: "Start BastionClaw before dispatching tasks.",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
