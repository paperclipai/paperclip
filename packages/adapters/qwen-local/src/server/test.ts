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
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_QWEN_LOCAL_MODEL } from "../index.js";
import { detectQwenAuthRequired, detectQwenQuotaExhausted, parseQwenJsonl } from "./parse.js";
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
  const command = asString(config.command, "qwen");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "qwen_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "qwen_cwd_invalid",
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
  const runtimeEnv: Record<string, string> = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "qwen_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "qwen_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const configDashScopeApiKey = env.DASHSCOPE_API_KEY;
  const hostDashScopeApiKey = process.env.DASHSCOPE_API_KEY;
  const configQwenApiKey = env.QWEN_API_KEY;
  const hostQwenApiKey = process.env.QWEN_API_KEY;
  if (
    isNonEmpty(configDashScopeApiKey) ||
    isNonEmpty(hostDashScopeApiKey) ||
    isNonEmpty(configQwenApiKey) ||
    isNonEmpty(hostQwenApiKey)
  ) {
    const source = isNonEmpty(configDashScopeApiKey) || isNonEmpty(configQwenApiKey)
      ? "adapter config env"
      : "server environment";
    checks.push({
      code: "qwen_api_key_present",
      level: "info",
      message: "Qwen API credentials are set for CLI authentication.",
      detail: `Detected in ${source}.`,
    });
  } else {
    checks.push({
      code: "qwen_api_key_missing",
      level: "info",
      message: "No explicit API key detected. Qwen CLI may still authenticate via `qwen auth login` (OAuth).",
      hint: "If the hello probe fails with an auth error, set DASHSCOPE_API_KEY in adapter env, or run `qwen auth login`.",
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "qwen_cwd_invalid" && check.code !== "qwen_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "qwen")) {
      checks.push({
        code: "qwen_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `qwen`.",
        detail: command,
        hint: "Use the `qwen` CLI command to run the automatic installation and auth probe.",
      });
    } else {
      const model = asString(config.model, DEFAULT_QWEN_LOCAL_MODEL).trim();
      const sandbox = asBoolean(config.sandbox, false);
      const helloProbeTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 10));
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = ["--output-format", "stream-json", "Respond with hello."];
      if (model && model !== DEFAULT_QWEN_LOCAL_MODEL) args.push("--model", model);
      args.push("--yolo");
      if (sandbox) {
        args.push("--sandbox");
      }
      if (extraArgs.length > 0) args.push(...extraArgs);

      const probe = await runChildProcess(
        `qwen-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        args,
        {
          cwd,
          env: runtimeEnv,
          timeoutSec: helloProbeTimeoutSec,
          graceSec: 5,
          onLog: async () => { },
        },
      );
      const parsed = parseQwenJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authMeta = detectQwenAuthRequired({
        parsed: parsed.resultEvent,
        stdout: probe.stdout,
        stderr: probe.stderr,
      });
      const quotaMeta = detectQwenQuotaExhausted({
        parsed: parsed.resultEvent,
        stdout: probe.stdout,
        stderr: probe.stderr,
      });

      if (quotaMeta.exhausted) {
        checks.push({
          code: "qwen_hello_probe_quota_exhausted",
          level: "warn",
          message: probe.timedOut
            ? "Qwen CLI is retrying after quota exhaustion."
            : "Qwen CLI authentication is configured, but the current account or API key is over quota.",
          ...(detail ? { detail } : {}),
          hint: "The configured Qwen account or API key is over quota. Check DashScope usage/billing, then retry the probe.",
        });
      } else if (probe.timedOut) {
        checks.push({
          code: "qwen_hello_probe_timed_out",
          level: "warn",
          message: "Qwen hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Qwen can run `Respond with hello.` from this directory manually.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "qwen_hello_probe_passed" : "qwen_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Qwen hello probe succeeded."
            : "Qwen probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
              hint: "Try `qwen --output-format stream-json \"Respond with hello.\"` manually to inspect full output.",
            }),
        });
      } else if (authMeta.requiresAuth) {
        checks.push({
          code: "qwen_hello_probe_auth_required",
          level: "warn",
          message: "Qwen CLI is installed, but authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Run `qwen auth login` or configure DASHSCOPE_API_KEY in adapter env/shell, then retry the probe.",
        });
      } else {
        checks.push({
          code: "qwen_hello_probe_failed",
          level: "error",
          message: "Qwen hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `qwen --output-format stream-json \"Respond with hello.\"` manually in this working directory to debug.",
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
