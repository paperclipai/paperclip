import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asBoolean,
  asNumber,
  asStringArray,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import path from "node:path";
import { parseCopilotJsonl, detectCopilotLoginRequired } from "./parse.js";

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

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function summarizeProbeDetail(stdout: string, stderr: string): string | null {
  const raw = firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
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

  // Check for GitHub token in environment
  const hasEnvToken =
    (typeof env.COPILOT_GITHUB_TOKEN === "string" && env.COPILOT_GITHUB_TOKEN.trim().length > 0) ||
    (typeof env.GH_TOKEN === "string" && env.GH_TOKEN.trim().length > 0) ||
    (typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.trim().length > 0) ||
    (typeof process.env.COPILOT_GITHUB_TOKEN === "string" && process.env.COPILOT_GITHUB_TOKEN.trim().length > 0) ||
    (typeof process.env.GH_TOKEN === "string" && process.env.GH_TOKEN.trim().length > 0) ||
    (typeof process.env.GITHUB_TOKEN === "string" && process.env.GITHUB_TOKEN.trim().length > 0);

  // Token check is deferred until after the hello probe — if the probe succeeds,
  // Copilot is authenticated via its own stored OAuth session and no env token is needed.

  const canRunProbe = checks.every(
    (check) => check.code !== "copilot_cwd_invalid" && check.code !== "copilot_command_unresolvable",
  );

  if (canRunProbe) {
    if (!commandLooksLike(command, "copilot")) {
      checks.push({
        code: "copilot_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `copilot`.",
        detail: command,
      });
    } else {
      const model = asString(config.model, "").trim();
      const reasoningEffort = asString(config.reasoningEffort, "").trim();
      const allowAll = asBoolean(config.allowAll, false);
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = ["-p", "Respond with exactly: hello", "--output-format", "json", "--silent", "--no-ask-user", "--no-auto-update"];
      if (allowAll) args.push("--yolo");
      if (model) args.push("--model", model);
      if (reasoningEffort) args.push("--reasoning-effort", reasoningEffort);
      if (extraArgs.length > 0) args.push(...extraArgs);

      const probe = await runChildProcess(
        `copilot-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        args,
        {
          cwd,
          env,
          timeoutSec: 60,
          graceSec: 5,
          onLog: async () => {},
        },
      );

      const parsedStream = parseCopilotJsonl(probe.stdout);
      const loginMeta = detectCopilotLoginRequired({
        stdout: probe.stdout,
        stderr: probe.stderr,
      });
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr);

      if (probe.timedOut) {
        checks.push({
          code: "copilot_hello_probe_timed_out",
          level: "warn",
          message: "Copilot hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Copilot can run from this directory manually.",
        });
      } else if (loginMeta.requiresLogin) {
        checks.push({
          code: "copilot_hello_probe_auth_required",
          level: "warn",
          message: "Copilot CLI is installed, but login is required.",
          ...(detail ? { detail } : {}),
          hint: "Run `copilot login` in this environment, then retry the probe.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsedStream.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "copilot_hello_probe_passed" : "copilot_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Copilot hello probe succeeded."
            : "Copilot probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello ? {} : { hint: "Verify Copilot works manually with: copilot -p 'Respond with: hello'" }),
        });
      } else {
        checks.push({
          code: "copilot_hello_probe_failed",
          level: "warn",
          message: `Copilot hello probe exited with code ${probe.exitCode ?? -1}.`,
          ...(detail ? { detail } : {}),
          hint: "Verify the Copilot CLI is correctly installed and authenticated.",
        });
      }
    }
  }

  // Emit token/auth check AFTER the probe so we can distinguish
  // "no env token but stored OAuth works" from "no auth at all".
  const probeSucceeded = checks.some((c) => c.code === "copilot_hello_probe_passed");
  const probeNeedsLogin = checks.some((c) => c.code === "copilot_hello_probe_auth_required");

  if (hasEnvToken) {
    checks.push({
      code: "copilot_github_token_found",
      level: "info",
      message: "GitHub token detected in environment.",
    });
  } else if (probeSucceeded) {
    checks.push({
      code: "copilot_auth_stored_session",
      level: "info",
      message: "Authenticated via Copilot stored session (`copilot login`).",
    });
  } else if (probeNeedsLogin) {
    checks.push({
      code: "copilot_github_token_missing",
      level: "warn",
      message: "No GitHub token or stored session found.",
      hint: "Run `copilot login`, or set COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN.",
    });
  } else if (!canRunProbe) {
    // Probe didn't run — we can't confirm auth, so warn
    checks.push({
      code: "copilot_github_token_missing",
      level: "warn",
      message: "No GitHub token found in environment.",
      hint: "Set COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN, or run `copilot login`.",
    });
  }

  return {
    adapterType: "copilot_cli",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
