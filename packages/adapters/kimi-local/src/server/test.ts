import { spawn } from "node:child_process";
import os from "node:os";
import { access } from "node:fs/promises";
import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = parseObject(ctx.config);
  const command = asString(config.command, "kimi");
  const checks: AdapterEnvironmentTestResult["checks"] = [];

  // Check 1: command resolves
  try {
    const proc = await new Promise<{ ok: boolean; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(command, ["--version"], {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10000,
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: unknown) => {
          stdout += String(chunk);
        });
        child.stderr?.on("data", (chunk: unknown) => {
          stderr += String(chunk);
        });
        child.on("error", (err: Error) => reject(err));
        child.on("close", (code: number | null) => {
          resolve({ ok: code === 0, stdout, stderr });
        });
      },
    );

    if (proc.ok) {
      const version = proc.stdout.trim() || proc.stderr.trim();
      checks.push({
        code: "kimi_version",
        level: "info",
        message: `Kimi CLI found: ${version}`,
      });
    } else {
      checks.push({
        code: "kimi_version_failed",
        level: "error",
        message: `Kimi CLI "${command}" returned non-zero exit code`,
        detail: proc.stderr.trim(),
        hint: "Install Kimi CLI: uv tool install --python 3.13 kimi-cli",
      });
      return {
        adapterType: "kimi_local",
        status: "fail",
        checks,
        testedAt: new Date().toISOString(),
      };
    }
  } catch (err) {
    checks.push({
      code: "kimi_not_found",
      level: "error",
      message: `Kimi CLI "${command}" is not available in PATH`,
      detail: err instanceof Error ? err.message : String(err),
      hint: "Install Kimi CLI: uv tool install --python 3.13 kimi-cli",
    });
    return {
      adapterType: "kimi_local",
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  // Check 2: config file exists (indicates login was run)
  try {
    const configPath = `${os.homedir()}/.kimi/config.toml`;
    await access(configPath);
    checks.push({
      code: "kimi_config_exists",
      level: "info",
      message: "Kimi config file found at ~/.kimi/config.toml",
    });
  } catch {
    checks.push({
      code: "kimi_config_missing",
      level: "warn",
      message: "Kimi config file not found at ~/.kimi/config.toml",
      hint: "Run `kimi` and use `/login` to configure your API key and model.",
    });
  }

  const hasErrors = checks.some((c: AdapterEnvironmentTestResult["checks"][number]) => c.level === "error");
  const hasWarns = checks.some((c: AdapterEnvironmentTestResult["checks"][number]) => c.level === "warn");
  const status = hasErrors ? "fail" : hasWarns ? "warn" : "pass";

  return {
    adapterType: "kimi_local",
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}
