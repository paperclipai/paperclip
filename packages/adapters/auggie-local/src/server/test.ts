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
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_AUGGIE_LOCAL_MODEL } from "../index.js";
import { detectAuggieAuthRequired, parseAuggieJsonResult } from "./parse.js";
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
  const command = asString(config.command, "auggie");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "auggie_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "auggie_cwd_invalid",
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
      code: "auggie_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "auggie_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const configSessionAuth = env.AUGMENT_SESSION_AUTH;
  const hostSessionAuth = process.env.AUGMENT_SESSION_AUTH;
  if (isNonEmpty(configSessionAuth) || isNonEmpty(hostSessionAuth)) {
    const source = isNonEmpty(configSessionAuth) ? "adapter config env" : "server environment";
    checks.push({
      code: "auggie_session_auth_present",
      level: "info",
      message: "AUGMENT_SESSION_AUTH is set for Auggie CLI authentication.",
      detail: `Detected in ${source}.`,
    });
  } else {
    checks.push({
      code: "auggie_session_auth_missing",
      level: "info",
      message: "No AUGMENT_SESSION_AUTH detected. Auggie CLI may still authenticate via `auggie login` (OAuth).",
      hint: "If the hello probe fails with an auth error, run `auggie login` or set AUGMENT_SESSION_AUTH in adapter env.",
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "auggie_cwd_invalid" && check.code !== "auggie_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "auggie")) {
      checks.push({
        code: "auggie_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `auggie`.",
        detail: command,
        hint: "Use the `auggie` CLI command to run the automatic installation and auth probe.",
      });
    } else {
      const model = asString(config.model, DEFAULT_AUGGIE_LOCAL_MODEL).trim();
      const helloProbeTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 20));
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = ["--print", "--output-format", "json", "--max-turns", "1"];
      if (model && model !== DEFAULT_AUGGIE_LOCAL_MODEL) args.push("--model", model);
      if (extraArgs.length > 0) args.push(...extraArgs);
      args.push("-i", "Respond with hello.");

      const probe = await runChildProcess(
        `auggie-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
      const parsed = parseAuggieJsonResult(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authMeta = detectAuggieAuthRequired({
        parsed: parsed.resultEvent,
        stdout: probe.stdout,
        stderr: probe.stderr,
      });

      if (probe.timedOut) {
        checks.push({
          code: "auggie_hello_probe_timed_out",
          level: "warn",
          message: "Auggie hello probe timed out.",
          hint: "Retry the probe. If this persists, verify `auggie --print --output-format json -i \"Respond with hello.\"` runs manually from this directory.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "auggie_hello_probe_passed" : "auggie_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Auggie hello probe succeeded."
            : "Auggie probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
              hint: "Try `auggie --print --output-format json -i \"Respond with hello.\"` manually to inspect full output.",
            }),
        });
      } else if (authMeta.requiresAuth) {
        checks.push({
          code: "auggie_hello_probe_auth_required",
          level: "warn",
          message: "Auggie CLI is installed, but authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Run `auggie login` or set AUGMENT_SESSION_AUTH in adapter env/shell, then retry the probe.",
        });
      } else {
        checks.push({
          code: "auggie_hello_probe_failed",
          level: "error",
          message: "Auggie hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `auggie --print --output-format json -i \"Respond with hello.\"` manually in this working directory to debug.",
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
