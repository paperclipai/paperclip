import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { testEnvironment as testClaudeEnvironment } from "@paperclipai/adapter-claude-local/server";
import { verifyRufloConfig } from "./ruflo-env.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const base = await testClaudeEnvironment(ctx);
  const checks = [...base.checks];

  const verification = await verifyRufloConfig(ctx.config).catch((error) => ({
    ok: false as const,
    resolved: null,
    detail: error instanceof Error ? error.message : String(error),
  }));

  if (!verification.ok || !verification.resolved) {
    checks.push({
      code: "ruflo_missing",
      level: "error",
      message: "Ruflo verification failed.",
      detail: verification.detail,
      hint: "Install Ruflo and ensure `claude mcp list` shows the configured Ruflo MCP server.",
    });
  } else {
    if (verification.resolved.rufloCommand) {
      checks.push({
        code: "ruflo_command_found",
        level: "info",
        message: `Resolved Ruflo command "${verification.resolved.rufloCommand}".`,
      });
    } else {
      checks.push({
        code: "ruflo_command_skipped",
        level: "info",
        message: "Skipped direct Ruflo command verification and relied on Claude MCP registration.",
      });
    }
    checks.push({
      code: "ruflo_mcp_detected",
      level: "info",
      message: `Detected Ruflo MCP server "${verification.resolved.rufloMcpServerName}".`,
      detail: verification.detail,
    });
  }

  return {
    adapterType: "ruflo_claude_local",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
