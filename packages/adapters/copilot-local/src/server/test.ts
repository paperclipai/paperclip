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
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_COPILOT_LOCAL_MODEL } from "../index.js";
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

export interface CursorAuthInfo {
  email: string | null;
  displayName: string | null;
  userId: number | null;
}

export function cursorConfigPath(cursorHome?: string): string {
  return path.join(cursorHome ?? path.join(os.homedir(), ".cursor"), "cli-config.json");
}

export async function readCursorAuthInfo(cursorHome?: string): Promise<CursorAuthInfo | null> {
  let raw: string;
  try {
    raw = await fs.readFile(cursorConfigPath(cursorHome), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const authInfo = obj.authInfo;
  if (typeof authInfo !== "object" || authInfo === null) return null;
  const info = authInfo as Record<string, unknown>;
  const email = typeof info.email === "string" && info.email.trim().length > 0 ? info.email.trim() : null;
  const displayName = typeof info.displayName === "string" && info.displayName.trim().length > 0 ? info.displayName.trim() : null;
  const userId = typeof info.userId === "number" ? info.userId : null;
  if (!email && !displayName && userId == null) return null;
  return { email, displayName, userId };
}

const CURSOR_AUTH_REQUIRED_RE =
  /(?:authentication\s+required|not\s+authenticated|not\s+logged\s+in|unauthorized|invalid(?:\s+or\s+missing)?\s+api(?:[_\s-]?key)?|cursor[_\s-]?api[_\s-]?key|run\s+'?agent\s+login'?\s+first|api(?:[_\s-]?key)?(?:\s+is)?\s+required)/i;

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

  const configCursorApiKey = env.GITHUB_TOKEN;
  const hostCursorApiKey = process.env.GITHUB_TOKEN;
  if (isNonEmpty(configCursorApiKey) || isNonEmpty(hostCursorApiKey)) {
    const source = isNonEmpty(configCursorApiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "cursor_api_key_present",
      level: "info",
      message: "GITHUB_TOKEN is set for Cursor authentication.",
      detail: `Detected in ${source}.`,
    });
  } else {
    const cursorHome = isNonEmpty(env.CURSOR_HOME) ? env.CURSOR_HOME : undefined;
    const cursorAuth = await readCursorAuthInfo(cursorHome).catch(() => null);
    if (cursorAuth) {
      checks.push({
        code: "cursor_native_auth_present",
        level: "info",
        message: "Copilot is authenticated via `copilot auth login`.",
        detail: cursorAuth.email
          ? `Logged in as ${cursorAuth.email}.`
          : `Credentials found in ${cursorConfigPath(cursorHome)}.`,
      });
    } else {
      checks.push({
        code: "cursor_api_key_missing",
        level: "warn",
        message: "GITHUB_TOKEN is not set. Copilot runs may fail until authentication is configured.",
        hint: "Set GITHUB_TOKEN in adapter env or run `copilot auth login`.",
      });
    }
  }

  const canRunProbe =
    checks.every((check) => check.code !== "cursor_cwd_invalid" && check.code !== "cursor_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "copilot")) {
      checks.push({
        code: "cursor_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `copilot`.",
        detail: command,
        hint: "Use the `copilot` CLI command to run the automatic installation and auth probe.",
      });
    } else {
      const model = asString(config.model, DEFAULT_COPILOT_LOCAL_MODEL).trim();
      const autoTrustEnabled = true;
      const args = ["-p", "Respond with hello.", "--output-format", "json"];
      if (model) args.push("--model", model);
      if (autoTrustEnabled) args.push("--yolo");

      console.log('[copilot test args]', JSON.stringify({ command, args, model, cwd, envKeys: Object.keys(env).sort() }));
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
          hint: "Retry the probe. If this persists, verify `copilot` manually.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const stdoutCompact = probe.stdout.replace(/\s+/g, " ").trim();
        const helloFromSummary = /\bhello\b/i.test(summary);
        const helloFromContentField = /\"content\"\s*:\s*\"hello\"/i.test(probe.stdout);
        const helloFromDeltaField = /\"deltaContent\"\s*:\s*\"hello\"/i.test(probe.stdout);
        const helloFromStdout = /\bhello\b/i.test(stdoutCompact);
        const hasHello = helloFromSummary || helloFromContentField || helloFromDeltaField || helloFromStdout;
        const detailText = summary || stdoutCompact;
        checks.push({
          code: hasHello ? "cursor_hello_probe_passed" : "cursor_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Copilot hello probe succeeded."
            : "Copilot probe ran but did not return `hello` as expected.",
          ...(detailText ? { detail: detailText.slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
                hint: "Try `copilot` manually to inspect full output.",
              }),
        });
      } else if (CURSOR_AUTH_REQUIRED_RE.test(authEvidence)) {
        checks.push({
          code: "cursor_hello_probe_auth_required",
          level: "warn",
          message: "Cursor CLI is installed, but authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Run `copilot auth login` or configure GITHUB_TOKEN in adapter env/shell, then retry the probe.",
        });
      } else {
        checks.push({
          code: "cursor_hello_probe_failed",
          level: "error",
          message: "Cursor hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `copilot` manually in this working directory to debug.",
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
