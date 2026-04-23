import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { parseCopilotJsonOutput } from "./parse.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const COPILOT_AUTH_REQUIRED_RE =
  /(?:auth(?:entication)?\s+required|not\s+logged\s+in|please\s+run\s+copilot\s+auth|unauthorized|forbidden|token\s+expired)/i;

function applyCopilotAuthEnvAliases(env: Record<string, string>): void {
  const token = env.COPILOT_GITHUB_TOKEN?.trim();
  if (!token) return;
  if (!env.GH_TOKEN?.trim()) env.GH_TOKEN = token;
  if (!env.GITHUB_TOKEN?.trim()) env.GITHUB_TOKEN = token;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "copilot");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "copilot_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "copilot_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  applyCopilotAuthEnvAliases(env);
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "copilot_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "copilot_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "copilot_cwd_invalid" && check.code !== "copilot_command_unresolvable");
  if (canRunProbe) {
    const probe = await runChildProcess(
      `copilot-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command,
      ["--allow-all-tools", "--output-format", "json", "--stream", "off", "-p", "Respond with hello."],
      {
        cwd,
        env: runtimeEnv,
        timeoutSec: 45,
        graceSec: 5,
        onLog: async () => {},
      },
    );
    const parsed = parseCopilotJsonOutput(probe.stdout);
    const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
    const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

    if (probe.timedOut) {
      checks.push({
        code: "copilot_hello_probe_timed_out",
        level: "warn",
        message: "Copilot hello probe timed out.",
        hint: "Retry the probe. If this persists, run the copilot command manually in this working directory.",
      });
    } else if ((probe.exitCode ?? 1) === 0 && !parsed.errorMessage) {
      const summary = parsed.summary.trim();
      const hasHello = /\bhello\b/i.test(summary);
      checks.push({
        code: hasHello ? "copilot_hello_probe_passed" : "copilot_hello_probe_unexpected_output",
        level: hasHello ? "info" : "warn",
        message: hasHello
          ? "Copilot hello probe succeeded."
          : "Copilot probe ran but did not return `hello` as expected.",
        ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
      });
    } else if (COPILOT_AUTH_REQUIRED_RE.test(authEvidence)) {
      checks.push({
        code: "copilot_hello_probe_auth_required",
        level: "warn",
        message: "Copilot CLI is installed, but authentication is not ready.",
        ...(detail ? { detail } : {}),
        hint: "Run `copilot auth login` (or configure credentials) and retry.",
      });
    } else {
      checks.push({
        code: "copilot_hello_probe_failed",
        level: "error",
        message: "Copilot hello probe failed.",
        ...(detail ? { detail } : {}),
        hint: "Run the copilot command manually with --output-format json to inspect output.",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
