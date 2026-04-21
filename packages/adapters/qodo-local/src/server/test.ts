import type { AdapterEnvironmentCheck, AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { asString, parseObject, ensureAbsoluteDirectory, ensureCommandResolvable, ensurePathInEnv, runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import path from "node:path";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
}

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "qodo");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({ code: "qodo_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
  } catch (err) {
    checks.push({ code: "qodo_cwd_invalid", level: "error", message: err instanceof Error ? err.message : "Invalid working directory", detail: cwd });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({ code: "qodo_command_resolvable", level: "info", message: `Command is executable: ${command}` });
  } catch (err) {
    checks.push({ code: "qodo_command_unresolvable", level: "error", message: err instanceof Error ? err.message : "Command is not executable", detail: command, hint: "Install Qodo CLI: npm install -g @qodo/command" });
  }

  const canRunProbe = checks.every((c) => c.code !== "qodo_cwd_invalid" && c.code !== "qodo_command_unresolvable");
  if (canRunProbe && path.basename(command).replace(/\.(cmd|exe)$/i, "") === "qodo") {
    const probe = await runChildProcess(`qodo-envtest-${Date.now()}`, command, ["--version"], { cwd, env, timeoutSec: 15, graceSec: 5, onLog: async () => {} });
    const detail = firstNonEmptyLine(probe.stdout) || firstNonEmptyLine(probe.stderr);

    if (probe.timedOut) {
      checks.push({ code: "qodo_version_probe_timed_out", level: "warn", message: "Qodo version probe timed out." });
    } else if ((probe.exitCode ?? 1) === 0) {
      checks.push({ code: "qodo_version_probe_passed", level: "info", message: `Qodo CLI detected: ${detail || "ok"}` });
    } else {
      checks.push({ code: "qodo_version_probe_failed", level: "error", message: "Qodo version probe failed.", ...(detail ? { detail } : {}), hint: "Run `qodo --version` manually to debug." });
    }
  }

  return { adapterType: ctx.adapterType, status: summarizeStatus(checks), checks, testedAt: new Date().toISOString() };
}
