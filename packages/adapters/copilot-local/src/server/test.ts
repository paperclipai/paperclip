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
import { AUTH_ENV_VARS } from "../index.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

function hasNonEmptyEnvValue(env: Record<string, string | undefined>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({ code: "copilot_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
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
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  const command = "copilot";
  let commandFound = false;
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    commandFound = true;
    checks.push({ code: "copilot_command_resolvable", level: "info", message: "Command is executable: copilot" });
  } catch {
    checks.push({
      code: "copilot_command_unresolvable",
      level: "error",
      message: "GitHub Copilot CLI not found in PATH. Install: npm install -g @github/copilot, brew install copilot-cli, or curl -fsSL https://gh.io/copilot-install | bash",
    });
  }

  // Check auth token
  const mergedEnv: Record<string, string | undefined> = { ...process.env, ...env };
  let authSource: string | null = null;
  for (const key of AUTH_ENV_VARS) {
    if (hasNonEmptyEnvValue(mergedEnv, key)) {
      authSource = key;
      break;
    }
  }
  if (authSource) {
    checks.push({
      code: "copilot_auth_found",
      level: "info",
      message: `GitHub auth token found via ${authSource}.`,
    });
  } else {
    checks.push({
      code: "copilot_auth_missing",
      level: "error",
      message: "No GitHub auth token found. Set COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN, or run `gh auth login`.",
    });
  }

  // Run probe if binary and auth are available
  const canProbe = commandFound && authSource !== null;
  if (canProbe) {
    const probeArgs = ["-p", "Respond with the single word: ready", "--yolo"];
    try {
      const probe = await runChildProcess(
        `copilot-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        probeArgs,
        {
          cwd,
          env,
          timeoutSec: 45,
          graceSec: 5,
          onLog: async () => {},
        },
      );

      if (probe.timedOut) {
        checks.push({
          code: "copilot_probe_timed_out",
          level: "warn",
          message: "Copilot probe timed out.",
          hint: "Retry the probe. If this persists, verify Copilot can run from this directory manually.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        checks.push({
          code: "copilot_probe_passed",
          level: "info",
          message: "Copilot CLI probe succeeded.",
        });
      } else {
        const stderr = probe.stderr.toLowerCase();
        if (stderr.includes("401") || stderr.includes("unauthorized")) {
          checks.push({
            code: "copilot_probe_auth_failed",
            level: "error",
            message: `Authentication failed (${authSource}). Verify your GitHub token has Copilot access.`,
          });
        } else if (stderr.includes("subscription")) {
          checks.push({
            code: "copilot_probe_no_subscription",
            level: "error",
            message: "No active Copilot subscription found. Verify at github.com/settings/copilot.",
          });
        } else {
          const detail = probe.stderr.trim().slice(0, 300) || null;
          checks.push({
            code: "copilot_probe_failed",
            level: "error",
            message: `Copilot CLI probe failed (exit ${probe.exitCode ?? "?"}).`,
            ...(detail ? { detail } : {}),
          });
        }
      }
    } catch (err) {
      checks.push({
        code: "copilot_probe_error",
        level: "error",
        message: `Copilot CLI probe error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  checks.push({
    code: "copilot_no_cost_tracking",
    level: "warn",
    message: "Cost tracking is not available for copilot_local. The Copilot CLI does not report token usage.",
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
