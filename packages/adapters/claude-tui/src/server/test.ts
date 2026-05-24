import fs from "node:fs/promises";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";

const PYTHON_TUI_CLI_PATH = "/tmp/tui-spike/cli.py";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];

  if (await pathExists(PYTHON_TUI_CLI_PATH)) {
    checks.push({
      code: "claude_tui_cli_present",
      level: "info",
      message: `Python TUI CLI is present at ${PYTHON_TUI_CLI_PATH}.`,
    });
  } else {
    checks.push({
      code: "claude_tui_cli_missing",
      level: "error",
      message: `Python TUI CLI not found at ${PYTHON_TUI_CLI_PATH}.`,
      hint: "The Python driver is part of the claude_tui spike. Confirm /tmp/tui-spike/cli.py exists or update the hardcoded path in @paperclipai/adapter-claude-tui/server/execute.ts.",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
