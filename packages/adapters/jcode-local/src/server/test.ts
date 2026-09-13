import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  parseObject,
  ensurePathInEnv,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  ensureAdapterExecutionTargetDirectory,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
} from "@paperclipai/adapter-utils/execution-target";
import { discoverJcodeModelsCached } from "./models.js";
import { parseJcodeNdjson } from "./parse.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

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

function normalizeEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

const JCODE_AUTH_REQUIRED_RE =
  /(?:auth(?:entication)?\s+required|api\s*key|not\s+logged\s+in|no\s+credentials|login\s+required)/i;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "jcode");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `jcode-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "jcode_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: false,
    });
    checks.push({
      code: "jcode_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "jcode_cwd_invalid",
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
  const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env }));

  const cwdInvalid = checks.some((check) => check.code === "jcode_cwd_invalid");
  if (cwdInvalid) {
    checks.push({
      code: "jcode_command_skipped",
      level: "warn",
      message: "Skipped command check because working directory validation failed.",
      detail: command,
    });
  } else {
    const installCheck = await maybeRunSandboxInstallCommand({
      runId,
      target,
      adapterKey: "jcode",
      installCommand: SANDBOX_INSTALL_COMMAND,
      detectCommand: command,
      env,
    });
    if (installCheck) checks.push(installCheck);
    try {
      await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
      checks.push({
        code: "jcode_command_resolvable",
        level: "info",
        message: `Command is executable: ${command}`,
      });
    } catch (err) {
      checks.push({
        code: "jcode_command_unresolvable",
        level: "error",
        message: err instanceof Error ? err.message : "Command is not executable",
        detail: command,
      });
    }
  }

  const canRunProbe =
    checks.every((check) => check.code !== "jcode_cwd_invalid" && check.code !== "jcode_command_unresolvable");

  if (!targetIsRemote && canRunProbe) {
    try {
      const discovered = await discoverJcodeModelsCached({ command, cwd, env: runtimeEnv });
      if (discovered.length > 0) {
        checks.push({
          code: "jcode_models_discovered",
          level: "info",
          message: `Discovered ${discovered.length} model(s) from jcode.`,
        });
      } else {
        checks.push({
          code: "jcode_models_empty",
          level: "warn",
          message: "jcode returned no models.",
          hint: "Run `jcode model list --json` and verify provider authentication.",
        });
      }
    } catch (err) {
      checks.push({
        code: "jcode_models_discovery_failed",
        level: "warn",
        message: err instanceof Error ? err.message : "jcode model discovery failed.",
        hint: "Run `jcode model list --json` manually to verify provider auth and config.",
      });
    }
  }

  const configuredModel = asString(config.model, "").trim();

  if (canRunProbe) {
    const args = ["--quiet", "run", "--ndjson", "Respond with exactly OK"];

    try {
      const probe = await runAdapterExecutionTargetProcess(
        runId,
        target,
        command,
        args,
        {
          cwd,
          env: runtimeEnv,
          timeoutSec: 60,
          graceSec: 5,
          onLog: async () => {},
        },
      );

      const parsed = parseJcodeNdjson(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errors[0] ?? null);
      const authEvidence = `${parsed.errors.join("\n")}\n${probe.stdout}\n${probe.stderr}`.trim();

      if (probe.timedOut) {
        checks.push({
          code: "jcode_hello_probe_timed_out",
          level: "warn",
          message: "jcode hello probe timed out.",
          hint: "Retry the probe. If this persists, run jcode manually in this working directory.",
        });
      } else if ((probe.exitCode ?? 1) === 0 && parsed.errors.length === 0) {
        const hasOk = /\bOK\b/i.test(parsed.text);
        checks.push({
          code: hasOk ? "jcode_hello_probe_passed" : "jcode_hello_probe_unexpected_output",
          level: hasOk ? "info" : "warn",
          message: hasOk
            ? "jcode hello probe succeeded."
            : "jcode probe ran but did not return `OK` as expected.",
          ...(parsed.text ? { detail: parsed.text.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasOk
            ? {}
            : {
                hint: "Run `jcode run --ndjson` manually and prompt `Respond with exactly OK` to inspect output.",
              }),
        });
      } else if (JCODE_AUTH_REQUIRED_RE.test(authEvidence)) {
        checks.push({
          code: "jcode_hello_probe_auth_required",
          level: "warn",
          message: "jcode is installed, but provider authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Run `jcode login --provider <name>` or set provider API key and retry.",
        });
      } else {
        checks.push({
          code: "jcode_hello_probe_failed",
          level: "error",
          message: "jcode hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `jcode run --ndjson` manually in this working directory to debug.",
        });
      }
    } catch (err) {
      checks.push({
        code: "jcode_hello_probe_failed",
        level: "error",
        message: "jcode hello probe failed.",
        detail: err instanceof Error ? err.message : String(err),
        hint: "Run `jcode run --ndjson` manually in this working directory to debug.",
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
