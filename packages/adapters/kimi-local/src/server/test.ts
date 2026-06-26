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
import { DEFAULT_KIMI_LOCAL_MODEL } from "../index.js";
import { parseKimiJsonl } from "./parse.js";

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
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function normalizeEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

const KIMI_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|login\s+required|run\s+`?kimi\s+login`?|authentication\s+required|unauthorized|invalid\s+credentials)/i;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "kimi");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `kimi-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "kimi_environment_target",
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
      code: "kimi_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "kimi_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const env = normalizeEnv(config.env);
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({
      code: "kimi_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "kimi_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "kimi_cwd_invalid" && check.code !== "kimi_command_unresolvable");

  const configuredModel = asString(config.model, DEFAULT_KIMI_LOCAL_MODEL).trim();

  if (canRunProbe) {
    const probeArgs = [
      "--print",
      "-p",
      "Respond with exactly hello.",
      "--output-format=stream-json",
    ];
    if (configuredModel && configuredModel !== DEFAULT_KIMI_LOCAL_MODEL) {
      probeArgs.push("--model", configuredModel);
    }

    const helloProbe = await runAdapterExecutionTargetProcess(
      runId,
      target,
      command,
      probeArgs,
      {
        cwd,
        env,
        timeoutSec: Math.max(1, asNumber(config.helloProbeTimeoutSec, 45)),
        graceSec: 5,
        onLog: async () => {},
      },
    );

    const parsed = parseKimiJsonl(helloProbe.stdout);
    const detail = summarizeProbeDetail(helloProbe.stdout, helloProbe.stderr, parsed.errorMessage);
    const authRequired = KIMI_AUTH_REQUIRED_RE.test(`${helloProbe.stdout}\n${helloProbe.stderr}`);

    if (helloProbe.timedOut) {
      checks.push({
        code: "kimi_hello_probe_timed_out",
        level: "warn",
        message: "Kimi hello probe timed out.",
        hint: "Retry the probe. If this persists, verify Kimi can run a simple `--print` prompt manually.",
      });
    } else if ((helloProbe.exitCode ?? 1) !== 0) {
      checks.push({
        code: authRequired ? "kimi_hello_probe_auth_required" : "kimi_hello_probe_failed",
        level: authRequired ? "warn" : "error",
        message: authRequired
          ? "Kimi CLI could not answer the hello probe because authentication is missing."
          : "Kimi hello probe failed.",
        ...(detail ? { detail } : {}),
        hint: authRequired ? "Run `kimi login` on the target host, then retry." : undefined,
      });
    } else if (/\bhello\b/i.test(parsed.summary)) {
      checks.push({
        code: "kimi_hello_probe_passed",
        level: "info",
        message: "Kimi hello probe succeeded.",
      });
    } else {
      checks.push({
        code: "kimi_hello_probe_unexpected_output",
        level: "warn",
        message: "Kimi hello probe succeeded but returned unexpected output.",
        ...(detail ? { detail } : {}),
      });
    }
  }

  return {
    adapterType: "kimi_local",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
