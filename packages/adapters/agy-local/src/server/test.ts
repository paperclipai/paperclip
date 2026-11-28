import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  asStringArray,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_AGY_LOCAL_MODEL } from "../index.js";
import { detectAgyAuthRequired, parseAgyStreamJson } from "./parse.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function clip(text: string, max = 240): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "agy");
  const cwd = asString(config.cwd, "") || process.cwd();
  const runId = `agy-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({ code: "agy_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
  } catch (err) {
    checks.push({
      code: "agy_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseObject(config.env))) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({ code: "agy_command_resolvable", level: "info", message: `Command is executable: ${command}` });
  } catch (err) {
    checks.push({
      code: "agy_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "Install the Antigravity CLI so `agy` is on PATH, or set the adapter `command` to its full path.",
    });
  }

  const canProbe = checks.every(
    (check) => check.code !== "agy_cwd_invalid" && check.code !== "agy_command_unresolvable",
  );

  if (canProbe) {
    const version = await runChildProcess(runId, command, ["--version"], {
      cwd,
      env: runtimeEnv,
      timeoutSec: 15,
      graceSec: 5,
      onLog: async () => {},
    });
    const versionLine = firstLine(version.stdout) || firstLine(version.stderr);
    if (!version.timedOut && (version.exitCode ?? 1) === 0) {
      checks.push({
        code: "agy_version_detected",
        level: "info",
        message: `agy detected${versionLine ? `: ${clip(versionLine, 120)}` : "."}`,
      });
    } else {
      checks.push({
        code: "agy_version_probe_failed",
        level: "warn",
        message: version.timedOut ? "`agy --version` timed out." : "`agy --version` did not exit cleanly.",
        ...(versionLine ? { detail: versionLine } : {}),
      });
    }

    const model = asString(config.model, DEFAULT_AGY_LOCAL_MODEL).trim();
    const extraArgs = asStringArray(config.extraArgs);
    const args = ["-p", "Respond with hello.", "--output-format", "stream-json"];
    if (model) args.push("--model", model);
    args.push(...extraArgs);
    const probe = await runChildProcess(runId, command, args, {
      cwd,
      env: runtimeEnv,
      timeoutSec: Math.max(1, asNumber(config.helloProbeTimeoutSec, 90)),
      graceSec: 5,
      onLog: async () => {},
    });
    const parsed = parseAgyStreamJson(probe.stdout);
    const detail = clip(parsed.errorMessage ?? (firstLine(probe.stderr) || firstLine(probe.stdout)));

    if (probe.timedOut) {
      checks.push({
        code: "agy_hello_probe_timed_out",
        level: "warn",
        message: "agy hello probe timed out.",
        hint: "Run `agy -p \"Respond with hello.\"` manually from this directory.",
      });
    } else if ((probe.exitCode ?? 1) === 0 && !parsed.errorMessage && /\bhello\b/i.test(parsed.summary)) {
      checks.push({
        code: "agy_hello_probe_passed",
        level: "info",
        message: "agy hello probe succeeded.",
        detail: clip(parsed.summary),
      });
    } else if (detectAgyAuthRequired(probe.stdout, probe.stderr)) {
      checks.push({
        code: "agy_hello_probe_auth_required",
        level: "warn",
        message: "agy is installed, but it is not signed in.",
        ...(detail ? { detail } : {}),
        hint: "Run `agy` once in a terminal and complete sign-in, then retry.",
      });
    } else if ((probe.exitCode ?? 1) === 0) {
      checks.push({
        code: "agy_hello_probe_unexpected_output",
        level: "warn",
        message: "agy ran but did not return `hello` as expected.",
        ...(parsed.summary ? { detail: clip(parsed.summary) } : {}),
      });
    } else {
      checks.push({
        code: "agy_hello_probe_failed",
        level: "error",
        message: "agy hello probe failed.",
        ...(detail ? { detail } : {}),
        hint: "Run `agy -p \"Respond with hello.\" --output-format stream-json` manually to debug.",
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
