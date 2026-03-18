/**
 * Environment test for Hermes Agent adapter.
 *
 * Verifies that Hermes CLI is available and configured.
 */
import { spawn } from "node:child_process";
import type { AdapterTestContext, AdapterTestResult } from "@paperclipai/adapter-utils";
import { HERMES_CLI } from "./constants.js";

/**
 * Test that Hermes CLI is available and can be invoked.
 */
export async function testEnvironment(ctx: AdapterTestContext): Promise<AdapterTestResult> {
  const checks: AdapterTestResult["checks"] = [];

  const versionCheck = await new Promise<AdapterTestResult["checks"][number]>((resolve) => {
    const proc = spawn(HERMES_CLI, ["--version"], {
      timeout: 5000,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    proc.on("close", (code: number | null) => {
      if (code === 0) {
        resolve({
          code: "hermes_cli_available",
          level: "info",
          message: `Hermes CLI available: ${stdout.trim() || "ok"}`,
          detail: stdout.trim() || undefined,
        });
      } else {
        resolve({
          code: "hermes_cli_failed",
          level: "error",
          message: `Hermes CLI exited with code ${code}: ${stderr.trim() || stdout.trim()}`,
        });
      }
    });
    proc.on("error", (err: Error) => {
      resolve({
        code: "hermes_cli_not_found",
        level: "error",
        message: `Hermes CLI not found: ${err.message}`,
        hint: "Install with: pip install hermes-agent",
      });
    });
  });

  checks.push(versionCheck);

  const status = checks.some(c => c.level === "error")
    ? "fail"
    : checks.some(c => c.level === "warn")
      ? "warn"
      : "pass";

  return {
    adapterType: ctx.adapterType,
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}
