import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@penclipai/adapter-utils";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@penclipai/adapter-utils/server-utils";
import {
  DEFAULT_CODEBUDDY_LOCAL_MODEL,
  DEFAULT_CODEBUDDY_LOCAL_SKIP_PERMISSIONS,
} from "../index.js";
import { hasCodeBuddyPermissionsBypassArg } from "../shared/permissions.js";
import { parseCodeBuddyJsonl } from "./parse.js";

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
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

const CODEBUDDY_AUTH_REQUIRED_RE =
  /(?:authentication\s+required|not\s+authenticated|not\s+logged\s+in|please\s+log\s+in|login\s+required|unauthorized|token\s+(?:is\s+)?invalid|需要登录|请先登录|未登录|未认证)/i;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "codebuddy");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "codebuddy_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "codebuddy_cwd_invalid",
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
      code: "codebuddy_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "codebuddy_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "codebuddy_cwd_invalid" && check.code !== "codebuddy_command_unresolvable");
  if (canRunProbe) {
    const model = asString(config.model, DEFAULT_CODEBUDDY_LOCAL_MODEL).trim();
    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();
    const allowSkipPermissions = asBoolean(
      config.dangerouslySkipPermissions,
      DEFAULT_CODEBUDDY_LOCAL_SKIP_PERMISSIONS,
    );
    const autoPermissionsEnabled = allowSkipPermissions && !hasCodeBuddyPermissionsBypassArg(extraArgs);
    const maxTurnsPerRun = Math.max(1, asNumber(config.maxTurnsPerRun, 1));
    const effort = asString(config.effort, "").trim().toLowerCase();
    const args = ["-p", "--output-format", "stream-json", "--max-turns", String(maxTurnsPerRun)];
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (autoPermissionsEnabled) args.push("-y");
    if (extraArgs.length > 0) args.push(...extraArgs);

    const probe = await runChildProcess(
      `codebuddy-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command,
      args,
      {
        cwd,
        env,
        timeoutSec: 45,
        graceSec: 5,
        stdin: "Respond with hello.",
        onLog: async () => { },
      },
    );
    const parsed = parseCodeBuddyJsonl(probe.stdout);
    const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
    const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

    if (probe.timedOut) {
      checks.push({
        code: "codebuddy_hello_probe_timed_out",
        level: "warn",
        message: "CodeBuddy hello probe timed out.",
        hint: "Retry the probe. If this persists, verify `codebuddy -p --output-format stream-json --max-turns 1` manually.",
      });
    } else if ((probe.exitCode ?? 0) === 0 && !parsed.errorMessage) {
      const summary = parsed.summary.trim();
      const hasHello = /\bhello\b/i.test(summary);
      checks.push({
        code: hasHello ? "codebuddy_hello_probe_passed" : "codebuddy_hello_probe_unexpected_output",
        level: hasHello ? "info" : "warn",
        message: hasHello
          ? "CodeBuddy hello probe succeeded."
          : "CodeBuddy probe ran but did not return `hello` as expected.",
        ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
        ...(hasHello
          ? {}
          : {
            hint: "Try piping `Respond with hello.` into `codebuddy -p --output-format stream-json --max-turns 1` manually to inspect full output.",
          }),
      });
    } else if (CODEBUDDY_AUTH_REQUIRED_RE.test(authEvidence)) {
      checks.push({
        code: "codebuddy_hello_probe_auth_required",
        level: "warn",
        message: "CodeBuddy CLI is installed, but authentication is not ready.",
        ...(detail ? { detail } : {}),
        hint: "Open `codebuddy` once and complete authentication, then retry the probe.",
      });
    } else {
      checks.push({
        code: "codebuddy_hello_probe_failed",
        level: "error",
        message: "CodeBuddy hello probe failed.",
        ...(detail ? { detail } : {}),
        hint: "Pipe `Respond with hello.` into `codebuddy -p --output-format stream-json --max-turns 1` manually in this working directory to debug.",
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
