import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  asStringArray,
  ensurePathInEnv,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  ensureAdapterExecutionTargetDirectory,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
} from "@paperclipai/adapter-utils/execution-target";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import { resolveKimiExecutionEngineForRun, testKimiAcpEnvironment } from "./acp.js";
import { detectKimiAuthRequired, parseKimiJsonl } from "./parse.js";
import { firstNonEmptyLine } from "./utils.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

/**
 * config.toml exists on any configured install and is not by itself proof of
 * auth material. Only treat it as such when a [providers.*] table carries a
 * non-empty api_key (direct API-key auth) — the OAuth dirs are checked
 * separately.
 */
const PROVIDERS_TABLE_RE = /^\s*\[providers\.[^\]]+\]/m;
const PROVIDER_API_KEY_RE = /^\s*api_key\s*=\s*"[^"]+"/m;

async function configTomlHasProviderKey(configPath: string): Promise<boolean> {
  try {
    const contents = await fs.readFile(configPath, "utf8");
    return PROVIDERS_TABLE_RE.test(contents) && PROVIDER_API_KEY_RE.test(contents);
  } catch {
    return false;
  }
}

/**
 * Detect Kimi authentication material on the local host: OAuth credentials
 * under $KIMI_CODE_HOME (default ~/.kimi-code) or a config.toml with a keyed
 * provider, plus the KIMI_MODEL_NAME + KIMI_MODEL_API_KEY env pair (config
 * env or server env).
 */
async function detectLocalKimiAuth(env: Record<string, string>): Promise<string | null> {
  if (
    (isNonEmpty(env.KIMI_MODEL_NAME) || isNonEmpty(process.env.KIMI_MODEL_NAME)) &&
    (isNonEmpty(env.KIMI_MODEL_API_KEY) || isNonEmpty(process.env.KIMI_MODEL_API_KEY))
  ) {
    return "KIMI_MODEL_NAME + KIMI_MODEL_API_KEY environment";
  }
  const kimiCodeHome =
    (isNonEmpty(env.KIMI_CODE_HOME) && env.KIMI_CODE_HOME.trim()) ||
    (isNonEmpty(process.env.KIMI_CODE_HOME) && process.env.KIMI_CODE_HOME.trim()) ||
    path.join(os.homedir(), ".kimi-code");
  for (const candidate of [path.join(kimiCodeHome, "credentials"), path.join(kimiCodeHome, "oauth")]) {
    if (await pathExists(candidate)) {
      return `${candidate} (kimi login OAuth)`;
    }
  }
  const configPath = path.join(kimiCodeHome, "config.toml");
  if (await configTomlHasProviderKey(configPath)) {
    return `${configPath} ([providers.*] api_key)`;
  }
  return null;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const engineSelection = await resolveKimiExecutionEngineForRun({
    config: parseObject(ctx.config),
    executionTarget: ctx.executionTarget,
  });
  if (engineSelection.engine === "acp") {
    return testKimiAcpEnvironment(ctx);
  }

  const checks: AdapterEnvironmentCheck[] = [];
  if (!engineSelection.explicit && engineSelection.fallbackReason) {
    checks.push({
      code: "kimi_acp_default_fallback",
      level: "warn",
      message: "Kimi ACP default is unavailable; testing the Kimi CLI fallback lane.",
      detail: engineSelection.fallbackReason,
      hint: "Fix the ACP prerequisite to use the default ACP lane, or set engine=cli to pin the CLI lane.",
    });
  }
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

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const installCheck = await maybeRunSandboxInstallCommand({
    runId,
    target,
    adapterKey: "kimi",
    installCommand: SANDBOX_INSTALL_COMMAND,
    detectCommand: command,
    env,
  });
  if (installCheck) checks.push(installCheck);
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

  if (canRunProbe && commandLooksLike(command, "kimi")) {
    const versionProbe = await runAdapterExecutionTargetProcess(
      runId,
      target,
      command,
      ["--version"],
      {
        cwd,
        env,
        timeoutSec: 15,
        graceSec: 5,
        onLog: async () => {},
      },
    );
    const versionLine = firstNonEmptyLine(versionProbe.stdout) || firstNonEmptyLine(versionProbe.stderr);
    if (!versionProbe.timedOut && (versionProbe.exitCode ?? 1) === 0) {
      checks.push({
        code: "kimi_version_detected",
        level: "info",
        message: `Kimi CLI detected${versionLine ? `: ${versionLine.replace(/\s+/g, " ").trim().slice(0, 120)}` : "."}`,
      });
    } else {
      checks.push({
        code: "kimi_version_probe_failed",
        level: "warn",
        message: versionProbe.timedOut
          ? "`kimi --version` timed out."
          : "`kimi --version` did not exit cleanly.",
        ...(versionLine ? { detail: versionLine } : {}),
      });
    }
  }

  const authSource = targetIsRemote
    ? ((isNonEmpty(env.KIMI_MODEL_NAME) && isNonEmpty(env.KIMI_MODEL_API_KEY))
      ? "KIMI_MODEL_NAME + KIMI_MODEL_API_KEY adapter env"
      : null)
    : await detectLocalKimiAuth(env);
  if (authSource) {
    checks.push({
      code: "kimi_auth_detected",
      level: "info",
      message: "Kimi authentication material detected.",
      detail: `Source: ${authSource}.`,
    });
  } else {
    checks.push({
      code: "kimi_auth_missing",
      level: "warn",
      message: "No Kimi authentication detected.",
      hint: "Run `kimi login` (OAuth device flow) on the target host, or set KIMI_MODEL_NAME + KIMI_MODEL_API_KEY in the adapter env.",
    });
  }

  if (canRunProbe) {
    if (!commandLooksLike(command, "kimi")) {
      checks.push({
        code: "kimi_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `kimi`.",
        detail: command,
        hint: "Use the `kimi` CLI command to run the automatic installation and auth probe.",
      });
    } else {
      const model = asString(config.model, "").trim();
      const helloProbeTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 60));
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = ["--output-format", "stream-json"];
      if (model) args.push("-m", model);
      if (extraArgs.length > 0) args.push(...extraArgs);
      args.push("-p", "Respond with hello.");

      const probe = await runAdapterExecutionTargetProcess(
        runId,
        target,
        command,
        args,
        {
          cwd,
          env,
          timeoutSec: helloProbeTimeoutSec,
          graceSec: 5,
          onLog: async () => {},
        },
      );
      const parsed = parseKimiJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authMeta = detectKimiAuthRequired({
        stdout: probe.stdout,
        stderr: probe.stderr,
      });

      if (probe.timedOut) {
        checks.push({
          code: "kimi_hello_probe_timed_out",
          level: "warn",
          message: "Kimi hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Kimi can run `kimi -p \"Respond with hello.\"` from this directory manually.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "kimi_hello_probe_passed" : "kimi_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Kimi hello probe succeeded."
            : "Kimi probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
              hint: "Try `kimi -p \"Respond with hello.\" --output-format stream-json` manually to inspect full output.",
            }),
        });
      } else if (authMeta.requiresAuth) {
        checks.push({
          code: "kimi_hello_probe_auth_required",
          level: "warn",
          message: "Kimi CLI is installed, but authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Run `kimi login` or configure KIMI_MODEL_NAME + KIMI_MODEL_API_KEY in adapter env/shell, then retry the probe.",
        });
      } else {
        checks.push({
          code: "kimi_hello_probe_failed",
          level: "error",
          message: "Kimi hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `kimi -p \"Respond with hello.\" --output-format stream-json` manually in this working directory to debug.",
        });
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
