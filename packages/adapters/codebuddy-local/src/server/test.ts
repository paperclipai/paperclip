import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult, AdapterEnvironmentCheck } from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const command = asString(ctx.config.command, "codebuddy");
  const checks: AdapterEnvironmentCheck[] = [];
  let status: "pass" | "warn" | "fail" = "pass";

  // Check if codebuddy binary is on PATH
  try {
    const { execSync } = await import("node:child_process");
    const version = execSync(`${command} --version`, {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
    if (!version) {
      checks.push({
        code: "codebuddy_empty_version",
        level: "warn",
        message: "CodeBuddy CLI returned empty version string",
      });
      status = "warn";
    } else {
      checks.push({
        code: "codebuddy_installed",
        level: "info",
        message: `CodeBuddy CLI found: ${version}`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    checks.push({
      code: "codebuddy_not_found",
      level: "error",
      message: `CodeBuddy CLI ("${command}") not found or not executable`,
      detail: message,
      hint: "Install with: npm install -g @tencent-ai/codebuddy-code",
    });
    status = "fail";
  }

  return {
    adapterType: "codebuddy_local",
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}
