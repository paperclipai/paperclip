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
import { detectPixelAuthRequired, detectPixelQuotaExhausted, parsePixelJsonl } from "./parse.js";
import { firstNonEmptyLine } from "./utils.js";

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
  const command = asString(config.command, "pixel");
  const cwd = asString(config.cwd, process.cwd());
  const streamJson = asBoolean(config.streamJson, true);

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "pixel_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "pixel_cwd_invalid",
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
      code: "pixel_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "pixel_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "pixel_cwd_invalid" && check.code !== "pixel_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "pixel")) {
      checks.push({
        code: "pixel_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `pixel`.",
        detail: command,
        hint: "Use the default Pixel CLI command to run the automatic probe, or verify your wrapper manually.",
      });
    } else {
      const model = asString(config.model, "").trim();
      const approvalMode = asString(config.approvalMode, "").trim();
      const sandboxCli = asBoolean(config.sandboxCli, false);
      const sandbox = asBoolean(config.sandbox, false);
      const helloProbeTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 10));
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args: string[] = [];
      if (streamJson) args.push("--output-format", "stream-json");
      if (model) args.push("--model", model);
      if (approvalMode) args.push("--approval-mode", approvalMode);
      if (sandboxCli) {
        if (sandbox) args.push("--sandbox");
        else args.push("--sandbox=none");
      }
      if (extraArgs.length > 0) args.push(...extraArgs);
      args.push("--prompt", "Respond with hello.");

      const probe = await runChildProcess(
        `pixel-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
      const parsed = parsePixelJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authMeta = detectPixelAuthRequired({
        parsed: parsed.resultEvent,
        stdout: probe.stdout,
        stderr: probe.stderr,
      });
      const quotaMeta = detectPixelQuotaExhausted({
        parsed: parsed.resultEvent,
        stdout: probe.stdout,
        stderr: probe.stderr,
      });

      if (quotaMeta.exhausted) {
        checks.push({
          code: "pixel_hello_probe_quota_exhausted",
          level: "warn",
          message: probe.timedOut
            ? "Pixel CLI is retrying after quota exhaustion."
            : "Pixel CLI may be over quota or rate-limited.",
          ...(detail ? { detail } : {}),
          hint: "Check provider usage and billing, then retry the probe.",
        });
      } else if (probe.timedOut) {
        checks.push({
          code: "pixel_hello_probe_timed_out",
          level: "warn",
          message: "Pixel hello probe timed out.",
          hint: "Retry the probe or run a minimal prompt manually from this directory.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "pixel_hello_probe_passed" : "pixel_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello ? "Pixel hello probe succeeded." : "Pixel probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
                hint: "If your CLI is not stream-json compatible, set streamJson to false and adjust extraArgs.",
              }),
        });
      } else if (authMeta.requiresAuth) {
        checks.push({
          code: "pixel_hello_probe_auth_required",
          level: "warn",
          message: "Pixel CLI is installed, but authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Configure provider credentials per Pixel docs, then retry the probe.",
        });
      } else {
        checks.push({
          code: "pixel_hello_probe_failed",
          level: "error",
          message: "Pixel hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run your Pixel CLI manually with the same flags, or disable streamJson / adjust cli flags in adapter config.",
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
