import { execFile } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  asStringArray,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import { MUSE_CODE_REASONING_EFFORTS } from "../index.js";
import { parseMuseCodeJsonl } from "./parse.js";

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function summarizeDetail(text: string | null): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > 240 ? `${clean.slice(0, 239)}…` : clean;
}

const execFileAsync = promisify(execFile);

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function readConfiguredEnv(config: Record<string, unknown>, key: string): string | null {
  const env = parseObject(config.env);
  const value = env[key];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (value && typeof value === "object") return "(configured reference)";
  return null;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "muse");
  const cwd = asString(config.cwd, "");
  const model = asString(config.model, "").trim();
  const effort = (
    asString(config.effort, "") ||
    asString(config.thinkingEffort, "") ||
    asString(config.reasoningEffort, "")
  ).trim();

  if (ctx.executionTarget?.kind === "remote") {
    checks.push({
      code: "muse_code_local_only",
      level: "error",
      message: "Muse adapter supports local environments only",
      hint: "Choose a local environment, or use an adapter with SSH/sandbox support.",
    });
  }

  if (cwd) {
    if (!path.isAbsolute(cwd)) {
      checks.push({
        code: "muse_code_cwd_relative",
        level: "error",
        message: `Configured cwd is not absolute: ${cwd}`,
      });
    } else if (!fs.existsSync(cwd)) {
      checks.push({
        code: "muse_code_cwd_missing",
        level: "warn",
        message: `Configured cwd does not exist yet and will be created on first run: ${cwd}`,
      });
    }
  }

  if (effort && !(MUSE_CODE_REASONING_EFFORTS as readonly string[]).includes(effort)) {
    checks.push({
      code: "muse_code_effort_invalid",
      level: "error",
      message: `Unknown Muse reasoning effort: ${effort}`,
      hint: `Use one of ${MUSE_CODE_REASONING_EFFORTS.join(", ")}.`,
    });
  }

  let cliDetected = false;
  try {
    const { stdout } = await execFileAsync(command, ["--version"], { timeout: 10_000 });
    const version = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "unknown version";
    cliDetected = true;
    checks.push({
      code: "muse_code_cli_detected",
      level: "info",
      message: `Muse detected: ${version}`,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    checks.push({
      code: "muse_code_cli_not_found",
      level: "error",
      message: code === "ENOENT"
        ? `Muse not found: ${command}`
        : `Muse could not be executed: ${error instanceof Error ? error.message : String(error)}`,
      hint: "Install Muse on the host that runs Paperclip, or set the command field to its absolute path.",
    });
  }

  const hasMetaApiKey = Boolean(readConfiguredEnv(config, "META_API_KEY") || process.env.META_API_KEY);
  if (hasMetaApiKey) {
    checks.push({
      code: "muse_code_api_key_configured",
      level: "info",
      message: "META_API_KEY is configured for Muse runs",
    });
  }

  if (model) {
    checks.push({
      code: "muse_code_model_configured",
      level: "info",
      message: `Model override configured: ${model}`,
    });
  }

  if (cliDetected && ctx.executionTarget?.kind !== "remote") {
    if (!commandLooksLike(command, "muse")) {
      checks.push({
        code: "muse_code_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `muse`.",
        detail: command,
        hint: "Use the `muse` CLI command to run the automatic installation and auth probe.",
      });
    } else {
      checks.push(...(await runHelloProbe({ command, cwd, config, model, effort })));
    }
  }

  const probePassed = checks.some((check) => check.code === "muse_code_hello_probe_passed");
  if (!hasMetaApiKey && !probePassed) {
    checks.push({
      code: "muse_code_login_assumed",
      level: "warn",
      message: "No META_API_KEY configured; runs will use the host Muse login",
      hint: "Run `muse login` on the host that runs Paperclip, or configure META_API_KEY.",
    });
  }

  return {
    adapterType: "muse_code_local",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

const AUTH_REQUIRED_PATTERN = /not logged in|login required|please (log|sign) in|unauthorized|\b401\b|authentication (failed|required)|api key[^\n]{0,60}(rejected|invalid|incorrect)/i;

async function runHelloProbe(input: {
  command: string;
  cwd: string;
  config: Record<string, unknown>;
  model: string;
  effort: string;
}): Promise<AdapterEnvironmentCheck[]> {
  const configuredCwd = input.cwd.trim() && path.isAbsolute(input.cwd.trim()) ? input.cwd.trim() : null;
  const tempCwd = configuredCwd ? null : await fsPromises.mkdtemp(path.join(os.tmpdir(), "paperclip-muse-probe-"));
  try {
    return await runHelloProbeInCwd({ ...input, cwd: configuredCwd ?? tempCwd! });
  } finally {
    if (tempCwd) await fsPromises.rm(tempCwd, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runHelloProbeInCwd(input: {
  command: string;
  cwd: string;
  config: Record<string, unknown>;
  model: string;
  effort: string;
}): Promise<AdapterEnvironmentCheck[]> {
  const timeoutSec = Math.max(1, asNumber(input.config.helloProbeTimeoutSec, 120));
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(input.config.extraArgs);
    return fromExtraArgs.length > 0 ? fromExtraArgs : asStringArray(input.config.args);
  })();
  const args = [
    "exec",
    "--json",
    "--disable-reminders",
    "--disable-request-user-input",
    "--no-session-log",
    "--workspace",
    input.cwd,
  ];
  if (input.model) args.push("--model", input.model);
  if (input.effort && (MUSE_CODE_REASONING_EFFORTS as readonly string[]).includes(input.effort)) {
    args.push("--reasoning-effort", input.effort);
  }
  if (extraArgs.length > 0) args.push(...extraArgs);
  args.push("Respond with hello.");

  const configEnv = parseObject(input.config.env);
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [key, value] of Object.entries(configEnv)) {
    if (typeof value === "string") env[key] = value;
  }

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let timedOut = false;
  try {
    const result = await execFileAsync(input.command, args, {
      cwd: input.cwd,
      env,
      timeout: timeoutSec * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; signal?: string };
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
    exitCode = typeof err.code === "number" ? err.code : 1;
    timedOut = Boolean(err.killed && err.signal === "SIGTERM");
    if (!stderr && error instanceof Error) stderr = error.message;
  }

  if (timedOut) {
    return [{
      code: "muse_code_hello_probe_timed_out",
      level: "warn",
      message: "Muse hello probe timed out.",
      hint: "Retry the probe. If this persists, verify Muse can run `muse exec \"Respond with hello.\"` from this directory manually.",
    }];
  }

  const parsed = parseMuseCodeJsonl(stdout);
  const lastStderrLine = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? null;
  const detail = summarizeDetail(parsed.errorMessage ?? lastStderrLine ?? parsed.summary);

  if (exitCode === 0 && !parsed.errorMessage) {
    const summary = (parsed.summary ?? "").trim();
    const hasHello = /\bhello\b/i.test(summary);
    return [{
      code: hasHello ? "muse_code_hello_probe_passed" : "muse_code_hello_probe_unexpected_output",
      level: hasHello ? "info" : "warn",
      message: hasHello
        ? "Muse hello probe succeeded."
        : "Muse probe ran but did not return `hello` as expected.",
      ...(summary ? { detail: summarizeDetail(summary) } : {}),
      ...(hasHello ? {} : { hint: "Run `muse exec --json \"Respond with hello.\"` manually to inspect the full event stream." }),
    }];
  }

  if (AUTH_REQUIRED_PATTERN.test(`${stderr}\n${stdout}`)) {
    return [{
      code: "muse_code_hello_probe_auth_required",
      level: "warn",
      message: "Muse is installed, but authentication is not ready.",
      ...(detail ? { detail } : {}),
      hint: "Run `muse login` on the host or configure META_API_KEY, then retry the probe.",
    }];
  }

  return [{
    code: "muse_code_hello_probe_failed",
    level: "error",
    message: "Muse hello probe failed.",
    ...(detail ? { detail } : {}),
    hint: "Run `muse exec --json \"Respond with hello.\"` manually in this working directory to debug.",
  }];
}
