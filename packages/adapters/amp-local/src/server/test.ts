import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { parseAmpStreamJson } from "./parse.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function summarizeProbeDetail(stdout: string, stderr: string): string | null {
  const raw = firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "amp");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "amp_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "amp_cwd_invalid",
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
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "amp_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "amp_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const configApiKey = env.AMP_API_KEY;
  const hostApiKey = process.env.AMP_API_KEY;
  if (isNonEmpty(configApiKey) || isNonEmpty(hostApiKey)) {
    const source = isNonEmpty(configApiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "amp_api_key_present",
      level: "info",
      message: "AMP_API_KEY is set for non-interactive auth.",
      detail: `Detected in ${source}.`,
    });
  } else {
    checks.push({
      code: "amp_api_key_missing",
      level: "warn",
      message: "AMP_API_KEY is not set. Amp requires an API key for non-interactive (execute) mode.",
      hint: "Set AMP_API_KEY in the agent's env config or server environment.",
    });
  }

  const canRunProbe = checks.every(
    (check) => check.code !== "amp_cwd_invalid" && check.code !== "amp_command_unresolvable",
  );
  if (canRunProbe) {
    const probe = await runChildProcess(
      `amp-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command,
      ["--execute", "--stream-json", "--dangerously-allow-all"],
      {
        cwd,
        env,
        stdin: "Respond with hello.",
        timeoutSec: 60,
        graceSec: 5,
        onLog: async () => {},
      },
    );

    const parsedStream = parseAmpStreamJson(probe.stdout);
    const detail = summarizeProbeDetail(probe.stdout, probe.stderr);

    if (probe.timedOut) {
      checks.push({
        code: "amp_hello_probe_timed_out",
        level: "warn",
        message: "Amp hello probe timed out.",
        hint: "Retry the probe. If this persists, verify Amp can run from this directory manually.",
      });
    } else if ((probe.exitCode ?? 1) === 0) {
      const summary = parsedStream.summary.trim();
      const hasHello = /\bhello\b/i.test(summary);
      checks.push({
        code: hasHello ? "amp_hello_probe_passed" : "amp_hello_probe_unexpected_output",
        level: hasHello ? "info" : "warn",
        message: hasHello
          ? "Amp hello probe succeeded."
          : "Amp probe ran but did not return `hello` as expected.",
        ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
        ...(hasHello
          ? {}
          : {
              hint: "Try running `printf 'Respond with hello.' | amp --execute --stream-json` manually to debug.",
            }),
      });
    } else {
      const authRequired = /AMP_API_KEY|not\s+logged\s+in|unauthorized/i.test(
        [probe.stdout, probe.stderr].join("\n"),
      );
      checks.push({
        code: authRequired ? "amp_hello_probe_auth_required" : "amp_hello_probe_failed",
        level: authRequired ? "warn" : "error",
        message: authRequired
          ? "Amp CLI is installed, but authentication is required."
          : "Amp hello probe failed.",
        ...(detail ? { detail } : {}),
        hint: authRequired
          ? "Set AMP_API_KEY in the agent's env config, or run `amp` interactively to log in."
          : "Run `printf 'Respond with hello.' | amp --execute --stream-json` manually to debug.",
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
