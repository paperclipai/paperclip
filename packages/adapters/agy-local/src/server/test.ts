import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject, ensureAbsoluteDirectory } from "@paperclipai/adapter-utils/server-utils";
import { resolveAgyBinary } from "./execute.js";

const execFileAsync = promisify(execFile);

// Documented in agy-local's agentConfigurationDoc as where `agy auth login` stores its token.
const AGY_AUTH_TOKEN_PATH = path.join(
  os.homedir(),
  ".gemini",
  "antigravity-cli",
  "antigravity-oauth-token",
);

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const cwd = asString(config.cwd, "") || process.cwd();

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "agy_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "agy_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const binary = await resolveAgyBinary();
  try {
    await execFileAsync(binary, ["--version"], { timeout: 15_000 });
    checks.push({
      code: "agy_binary_resolvable",
      level: "info",
      message: `agy CLI is executable: ${binary}`,
    });
  } catch (err) {
    checks.push({
      code: "agy_binary_missing",
      level: "error",
      message: "agy CLI is not installed or not executable.",
      detail: err instanceof Error ? err.message : String(err),
      hint: "Install with: curl -fsSL https://antigravity.google/cli/install.sh | bash",
    });
  }

  try {
    await fs.access(AGY_AUTH_TOKEN_PATH);
    checks.push({
      code: "agy_auth_configured",
      level: "info",
      message: "Antigravity OAuth token found.",
    });
  } catch {
    checks.push({
      code: "agy_auth_required",
      level: "warn",
      message: "Antigravity CLI is not authenticated.",
      hint: "Run `agy auth login` interactively on the server.",
    });
  }

  return {
    adapterType: "agy_local",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
