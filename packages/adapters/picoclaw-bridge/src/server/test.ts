import { execFile } from "node:child_process";
import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";

function summarize(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];

  await new Promise<void>((resolve) => {
    execFile("picoclaw", ["version"], { timeout: 5000, env: process.env }, (err, stdout) => {
      if (err) {
        checks.push({
          code: "picoclaw_not_found",
          level: "error",
          message: "picoclaw binary not found on PATH",
          hint: "Install picoclaw and ensure it is accessible from the server process.",
        });
      } else {
        const version = stdout.trim().split("\n").find((l) => l.includes("picoclaw")) ?? stdout.trim();
        checks.push({
          code: "picoclaw_found",
          level: "info",
          message: `picoclaw detected: ${version}`,
        });
      }
      resolve();
    });
  });

  return {
    adapterType: ctx.adapterType,
    status: summarize(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
