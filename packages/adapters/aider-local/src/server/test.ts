import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  ensurePathInEnv,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import { ADAPTER_TYPE } from "../shared/constants.js";
import { firstNonEmptyLine, stripAnsi } from "./parse.js";

/**
 * Any one of these is enough for Aider to reach a provider. Aider can also read
 * credentials from ~/.aider.conf.yml or a .env file, so a miss is a warning
 * rather than an error.
 */
const CREDENTIAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "AZURE_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
];

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function summarizeProbeDetail(stdout: string, stderr: string): string | null {
  const raw = firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

export function parseAiderVersion(stdout: string): string | null {
  const match = /aider\s+v?(\d+\.\d+(?:\.\d+)?)/i.exec(stripAnsi(stdout));
  return match?.[1] ?? null;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "aider");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `aider-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "aider_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    checks.push({
      code: "aider_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "aider_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const env = Object.fromEntries(
    Object.entries(parseObject(config.env)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({
      code: "aider_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "aider_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "Install Aider on the target host (for example `python -m pip install aider-install && aider-install`).",
    });
  }

  const canRunProbe = checks.every(
    (check) => check.code !== "aider_cwd_invalid" && check.code !== "aider_command_unresolvable",
  );

  if (canRunProbe) {
    // `--version` is the only safe probe: a real prompt would spend tokens and
    // could edit files in the workspace.
    const versionProbe = await runAdapterExecutionTargetProcess(
      runId,
      target,
      command,
      ["--version"],
      {
        cwd,
        env,
        timeoutSec: Math.max(1, asNumber(config.versionProbeTimeoutSec, 45)),
        graceSec: 5,
        onLog: async () => {},
      },
    );

    if (versionProbe.timedOut) {
      checks.push({
        code: "aider_version_probe_timed_out",
        level: "warn",
        message: "`aider --version` timed out.",
        hint: "Retry the probe. If this persists, run `aider --version` manually from the target environment.",
      });
    } else if ((versionProbe.exitCode ?? 1) !== 0) {
      checks.push({
        code: "aider_version_probe_failed",
        level: "error",
        message: "`aider --version` failed.",
        detail: summarizeProbeDetail(versionProbe.stdout, versionProbe.stderr),
      });
    } else {
      const version = parseAiderVersion(versionProbe.stdout);
      checks.push({
        code: "aider_version_probe_passed",
        level: "info",
        message: version ? `Aider ${version} is installed.` : "`aider --version` completed.",
      });
    }
  }

  const credentialKey = CREDENTIAL_ENV_KEYS.find((key) => {
    const value = runtimeEnv[key];
    return typeof value === "string" && value.trim().length > 0;
  });
  checks.push(
    credentialKey
      ? {
          code: "aider_credentials_present",
          level: "info",
          message: `Model credentials found in ${credentialKey}.`,
        }
      : {
          code: "aider_credentials_missing",
          level: "warn",
          message: "No provider API key found in the adapter environment.",
          detail: `Checked: ${CREDENTIAL_ENV_KEYS.join(", ")}`,
          hint: "Set a provider key in the adapter env, or rely on Aider's own ~/.aider.conf.yml on the target host.",
        },
  );

  return {
    adapterType: ADAPTER_TYPE,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
