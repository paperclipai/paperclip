import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asBoolean,
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
import { DEFAULT_ANTIGRAVITY_LOCAL_MODEL, SANDBOX_INSTALL_COMMAND } from "../index.js";
import { detectAntigravityAuthRequired, detectAntigravityQuotaExhausted, parseAntigravityJsonl } from "./parse.js";
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

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "agy");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `antigravity-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "antigravity_environment_target",
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
      code: "antigravity_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "antigravity_cwd_invalid",
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
  if (targetIsRemote && typeof env.ANTIGRAVITY_CLI_TRUST_WORKSPACE !== "string") {
    env.ANTIGRAVITY_CLI_TRUST_WORKSPACE = "true";
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const installCheck = await maybeRunSandboxInstallCommand({
    runId,
    target,
    adapterKey: "antigravity",
    installCommand: SANDBOX_INSTALL_COMMAND,
    detectCommand: command,
    env,
  });
  if (installCheck) checks.push(installCheck);
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({
      code: "antigravity_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "antigravity_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const configAntigravityApiKey = env.ANTIGRAVITY_API_KEY;
  const configGeminiApiKey = env.GEMINI_API_KEY;
  const hostAntigravityApiKey = targetIsRemote ? undefined : process.env.ANTIGRAVITY_API_KEY;
  const hostGeminiApiKey = targetIsRemote ? undefined : process.env.GEMINI_API_KEY;
  const configGoogleApiKey = env.GOOGLE_API_KEY;
  const hostGoogleApiKey = targetIsRemote ? undefined : process.env.GOOGLE_API_KEY;
  const hasGca = env.GOOGLE_GENAI_USE_GCA === "true" || (!targetIsRemote && process.env.GOOGLE_GENAI_USE_GCA === "true");
  if (
    isNonEmpty(configAntigravityApiKey) ||
    isNonEmpty(hostAntigravityApiKey) ||
    isNonEmpty(configGeminiApiKey) ||
    isNonEmpty(hostGeminiApiKey) ||
    isNonEmpty(configGoogleApiKey) ||
    isNonEmpty(hostGoogleApiKey) ||
    hasGca
  ) {
    const source = hasGca
      ? "Google account login (GCA)"
      : isNonEmpty(configAntigravityApiKey) || isNonEmpty(configGeminiApiKey) || isNonEmpty(configGoogleApiKey)
        ? "adapter config env"
        : "server environment";
    checks.push({
      code: "antigravity_api_key_present",
      level: "info",
      message: "Antigravity API credentials are set for CLI authentication.",
      detail: `Detected in ${source}.`,
    });
  } else {
    checks.push({
      code: "antigravity_api_key_missing",
      level: "info",
      message: "No explicit API key detected. Antigravity CLI may still authenticate via `agy auth login` (OAuth).",
      hint: "If the hello probe fails with an auth error, set ANTIGRAVITY_API_KEY, GEMINI_API_KEY or GOOGLE_API_KEY in adapter env, or run `agy auth login`.",
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "antigravity_cwd_invalid" && check.code !== "antigravity_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "agy")) {
      checks.push({
        code: "antigravity_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `agy`.",
        detail: command,
        hint: "Use the `agy` CLI command to run the automatic installation and auth probe.",
      });
    } else {
      const model = asString(config.model, DEFAULT_ANTIGRAVITY_LOCAL_MODEL).trim();
      const sandbox = asBoolean(config.sandbox, false);
      const helloProbeTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 60));
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = ["--output-format", "stream-json", "--prompt", "Respond with hello."];
      if (model && model !== DEFAULT_ANTIGRAVITY_LOCAL_MODEL) args.push("--model", model);
      args.push("--dangerously-skip-permissions");
      if (sandbox) {
        args.push("--sandbox");
      }
      if (extraArgs.length > 0) args.push(...extraArgs);

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
          onLog: async () => { },
        },
      );
        
      const parsed = parseAntigravityJsonl(probe.stdout);     
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authMeta = detectAntigravityAuthRequired({
        parsed: parsed.resultEvent,
        stdout: probe.stdout,
        stderr: probe.stderr,
      });
      const quotaMeta = detectAntigravityQuotaExhausted({
        parsed: parsed.resultEvent,
        stdout: probe.stdout,
        stderr: probe.stderr,
      });

      if (quotaMeta.exhausted) {
        checks.push({
          code: "antigravity_hello_probe_quota_exhausted",
          level: "warn",
          message: probe.timedOut
            ? "Antigravity CLI is retrying after quota exhaustion."
            : "Antigravity CLI authentication is configured, but the current account or API key is over quota.",
          ...(detail ? { detail } : {}),
          hint: "The configured Antigravity account or API key is over quota. Check ai.google.dev usage/billing, then retry the probe.",
        });
      } else if (probe.timedOut) {
        checks.push({
          code: "antigravity_hello_probe_timed_out",
          level: "warn",
          message: "Antigravity hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Antigravity can run `Respond with hello.` from this directory manually.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "antigravity_hello_probe_passed" : "antigravity_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Antigravity hello probe succeeded."
            : "Antigravity probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
              hint: "Try `agy --prompt \"Respond with hello.\"` manually to inspect full output.",
            }),
        });
      } else if (authMeta.requiresAuth) {
        checks.push({
          code: "antigravity_hello_probe_auth_required",
          level: "warn",
          message: "Antigravity CLI is installed, but authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Run `agy auth` or configure ANTIGRAVITY_API_KEY in adapter env/shell, then retry the probe.",
        });
      } else {
        checks.push({
          code: "antigravity_hello_probe_failed",
          level: "error",
          message: "Antigravity hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `agy --prompt \"Respond with hello.\"` manually in this working directory to debug.",
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
