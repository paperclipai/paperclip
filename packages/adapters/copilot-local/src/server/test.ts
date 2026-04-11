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
import { DEFAULT_COPILOT_LOCAL_MODEL } from "../index.js";
import { detectCopilotAuthRequired, parseCopilotJsonl } from "./parse.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || stderr.trim() || stdout.trim();
  if (!raw) return null;
  const singleLine = raw.replace(/\s+/g, " ").trim();
  return singleLine.length > 240 ? `${singleLine.slice(0, 239)}…` : singleLine;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "copilot");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "copilot_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
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

  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "copilot_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "copilot_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const hasToken =
    (typeof env.GH_TOKEN === "string" && env.GH_TOKEN.trim().length > 0) ||
    (typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.trim().length > 0) ||
    (typeof process.env.GH_TOKEN === "string" && process.env.GH_TOKEN.trim().length > 0) ||
    (typeof process.env.GITHUB_TOKEN === "string" && process.env.GITHUB_TOKEN.trim().length > 0);

  checks.push({
    code: hasToken ? "copilot_token_present" : "copilot_token_missing",
    level: "info",
    message: hasToken
      ? "GitHub token detected for Copilot authentication."
      : "No explicit GH_TOKEN/GITHUB_TOKEN detected. Copilot CLI may still be authenticated via local login.",
    ...(hasToken
      ? {}
      : {
          hint: "If the hello probe fails with an auth error, run `copilot login` or provide GH_TOKEN/GITHUB_TOKEN.",
        }),
  });

  const canRunProbe =
    checks.every((check) => check.code !== "copilot_cwd_invalid" && check.code !== "copilot_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "copilot")) {
      checks.push({
        code: "copilot_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `copilot`.",
        detail: command,
      });
    } else {
      const model = asString(config.model, DEFAULT_COPILOT_LOCAL_MODEL).trim();
      const autopilot = asBoolean(config.autopilot, true);
      const experimental = asBoolean(config.experimental, false);
      const enableReasoningSummaries = asBoolean(config.enableReasoningSummaries, false);
      const helloProbeTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 15));
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = [
        "-p",
        "Respond with exactly: hello",
        "--output-format",
        "json",
        "--allow-all-tools",
        "--allow-all-paths",
        "--allow-all-urls",
        "--no-ask-user",
        "--stream",
        "off",
        "--no-color",
      ];
      if (autopilot) args.push("--autopilot");
      if (experimental) args.push("--experimental");
      if (enableReasoningSummaries) args.push("--enable-reasoning-summaries");
      if (model) args.push("--model", model);
      if (extraArgs.length > 0) args.push(...extraArgs);

      const probe = await runChildProcess(
        `copilot-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
      const parsed = parseCopilotJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authMeta = detectCopilotAuthRequired({
        stdout: probe.stdout,
        stderr: probe.stderr,
      });

      if (probe.timedOut) {
        checks.push({
          code: "copilot_hello_probe_timed_out",
          level: "warn",
          message: "Copilot hello probe timed out.",
          hint: "Retry the probe. If this persists, verify `copilot -p \"Respond with exactly: hello\"` works manually in this directory.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "copilot_hello_probe_passed" : "copilot_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Copilot hello probe succeeded."
            : "Copilot probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
        });
      } else if (authMeta.requiresAuth) {
        checks.push({
          code: "copilot_hello_probe_auth_required",
          level: "warn",
          message: "Copilot CLI is installed, but authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Run `copilot login` or configure GH_TOKEN/GITHUB_TOKEN, then retry the probe.",
        });
      } else {
        checks.push({
          code: "copilot_hello_probe_failed",
          level: "error",
          message: "Copilot hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `copilot -p \"Respond with exactly: hello\" --output-format json --allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user --stream off --no-color` manually to debug.",
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
