import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asStringArray,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import path from "node:path";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "../index.js";
import { parseCursorJsonl } from "./parse.js";
import { hasCursorTrustBypassArg } from "../shared/trust.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const CURSOR_AUTH_REQUIRED_RE =
  /(?:authentication\s+required|not\s+authenticated|not\s+logged\s+in|unauthorized|invalid(?:\s+or\s+missing)?\s+api(?:[_\s-]?key)?|cursor[_\s-]?api[_\s-]?key|run\s+'?agent\s+login'?\s+first|api(?:[_\s-]?key)?(?:\s+is)?\s+required)/i;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "agent");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "cursor_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "cursor_cwd_invalid",
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
      code: "cursor_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "cursor_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const configCursorApiKey = env.CURSOR_API_KEY;
  const hostCursorApiKey = process.env.CURSOR_API_KEY;
  if (isNonEmpty(configCursorApiKey) || isNonEmpty(hostCursorApiKey)) {
    const source = isNonEmpty(configCursorApiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "cursor_api_key_present",
      level: "info",
      message: "CURSOR_API_KEY is set for Cursor authentication.",
      detail: `Detected in ${source}.`,
    });
  } else {
    checks.push({
      code: "cursor_api_key_missing",
      level: "warn",
      message: "CURSOR_API_KEY is not set. Cursor runs may fail until authentication is configured.",
      hint: "Set CURSOR_API_KEY in adapter env or run `agent login`.",
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "cursor_cwd_invalid" && check.code !== "cursor_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "agent")) {
      checks.push({
        code: "cursor_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `agent`.",
        detail: command,
        hint: "Use the `agent` CLI command to run the automatic installation and auth probe.",
      });
    } else {
      const model = asString(config.model, DEFAULT_CURSOR_LOCAL_MODEL).trim();
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();
      const autoTrustEnabled = !hasCursorTrustBypassArg(extraArgs);
      const args = ["-p", "--mode", "ask", "--output-format", "json", "--workspace", cwd];
      if (model) args.push("--model", model);
      if (autoTrustEnabled) args.push("--yolo");
      if (extraArgs.length > 0) args.push(...extraArgs);
      args.push("Respond with hello.");

      const probe = await runChildProcess(
        `cursor-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        args,
        {
          cwd,
          env,
          timeoutSec: 45,
          graceSec: 5,
          onLog: async () => {},
        },
      );
      const parsed = parseCursorJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

      if (probe.timedOut) {
        checks.push({
          code: "cursor_hello_probe_timed_out",
          level: "warn",
          message: "Cursor hello probe timed out.",
          hint: "Retry the probe. If this persists, verify `agent -p --mode ask --output-format json \"Respond with hello.\"` manually.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "cursor_hello_probe_passed" : "cursor_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Cursor hello probe succeeded."
            : "Cursor probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
                hint: "Try `agent -p --mode ask --output-format json \"Respond with hello.\"` manually to inspect full output.",
              }),
        });
      } else if (CURSOR_AUTH_REQUIRED_RE.test(authEvidence)) {
        checks.push({
          code: "cursor_hello_probe_auth_required",
          level: "warn",
          message: "Cursor CLI is installed, but authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Run `agent login` or configure CURSOR_API_KEY in adapter env/shell, then retry the probe.",
        });
      } else {
        checks.push({
          code: "cursor_hello_probe_failed",
          level: "error",
          message: "Cursor hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `agent -p --mode ask --output-format json \"Respond with hello.\"` manually in this working directory to debug.",
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
