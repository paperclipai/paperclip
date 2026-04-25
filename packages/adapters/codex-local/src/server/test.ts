import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import fs from "node:fs/promises";
import path from "node:path";
import { parseCodexJsonl } from "./parse.js";
import { readCodexAuthInfo, type CodexAuthInfo } from "./quota.js";
import { resolveManagedCodexHomeDir, resolveSharedCodexHomeDir } from "./codex-home.js";
import { buildCodexExecArgs } from "./codex-args.js";

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

const CODEX_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|login\s+required|authentication\s+required|unauthorized|invalid(?:\s+or\s+missing)?\s+api(?:[_\s-]?key)?|openai[_\s-]?api[_\s-]?key|api[_\s-]?key.*required|please\s+run\s+`?codex\s+login`?)/i;

const CODEX_MODEL_UNSUPPORTED_RE =
  /(?:unknown|unsupported|invalid|unrecognized)\s+model|model\s+(?:unknown|unsupported|invalid|unrecognized)|model.+(?:not\s+available|not\s+supported)|(?:not\s+available|not\s+supported).+model/i;

type AuthFileMode = "chatgpt_oauth" | "api_key" | "unknown";

function redactMiddle(
  value: string | null | undefined,
  options: { prefix?: number; suffix?: number } = {},
): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const clean = value.trim();
  const prefix = options.prefix ?? 4;
  const suffix = options.suffix ?? 4;
  if (clean.length <= prefix + suffix + 2) return "[redacted]";
  return `${clean.slice(0, prefix)}…${clean.slice(-suffix)}`;
}

function redactEmail(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const clean = value.trim();
  const at = clean.indexOf("@");
  if (at <= 0) return redactMiddle(clean, { prefix: 2, suffix: 2 });
  const local = clean.slice(0, at);
  const domain = clean.slice(at + 1);
  const redactedLocal = local.length <= 2 ? `${local[0] ?? "*"}…` : `${local.slice(0, 2)}…`;
  return `${redactedLocal}@${domain}`;
}

async function readAuthJsonObject(authPath: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(authPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function summarizeChatGptAuth(auth: CodexAuthInfo, authPath: string): string {
  const redactedEmail = redactEmail(auth.email);
  const redactedAccountId = redactMiddle(auth.accountId, { prefix: 6, suffix: 4 });
  const parts = [
    `auth.json: ${authPath}`,
    redactedEmail ? `email: ${redactedEmail}` : null,
    auth.planType ? `plan: ${auth.planType}` : null,
    redactedAccountId ? `account: ${redactedAccountId}` : null,
    auth.refreshToken ? "refresh token: present" : "refresh token: absent",
    auth.lastRefresh ? `last refresh: ${auth.lastRefresh}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join("; ");
}

async function readCodexAuthFileMode(codexHome: string): Promise<{
  authPath: string;
  mode: AuthFileMode | null;
  auth: CodexAuthInfo | null;
}> {
  const authPath = path.join(codexHome, "auth.json");
  const [auth, raw] = await Promise.all([
    readCodexAuthInfo(codexHome).catch(() => null),
    readAuthJsonObject(authPath),
  ]);
  if (auth) return { authPath, mode: "chatgpt_oauth", auth };
  if (!raw) return { authPath, mode: null, auth: null };
  if (hasNonEmptyString(raw.OPENAI_API_KEY)) return { authPath, mode: "api_key", auth: null };
  return { authPath, mode: "unknown", auth: null };
}

async function probeCodexVersion(
  command: string,
  cwd: string,
  env: Record<string, string>,
): Promise<AdapterEnvironmentCheck> {
  const probe = await runChildProcess(
    `codex-version-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["--version"],
    {
      cwd,
      env,
      timeoutSec: 10,
      graceSec: 2,
      onLog: async () => {},
    },
  );
  const detail = summarizeProbeDetail(probe.stdout, probe.stderr, null);
  if (probe.timedOut) {
    return {
      code: "codex_cli_version_probe_timed_out",
      level: "warn",
      message: "Codex CLI version probe timed out.",
      hint: "Run `codex --version` manually and upgrade Codex if the installed CLI is stale.",
    };
  }
  if ((probe.exitCode ?? 1) !== 0) {
    return {
      code: "codex_cli_version_unavailable",
      level: "warn",
      message: "Could not determine Codex CLI version.",
      ...(detail ? { detail } : {}),
      hint: "Run `codex --version` manually and upgrade Codex if the installed CLI is stale.",
    };
  }
  return {
    code: "codex_cli_version",
    level: "info",
    message: detail ? `Codex CLI version: ${detail}` : "Codex CLI version probe succeeded.",
  };
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "codex");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "codex_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "codex_cwd_invalid",
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
  const configuredCodexHome = isNonEmpty(env.CODEX_HOME) ? path.resolve(env.CODEX_HOME) : null;
  const sharedCodexHome = resolveSharedCodexHomeDir(process.env);
  const effectiveCodexHome =
    configuredCodexHome ?? resolveManagedCodexHomeDir(process.env, ctx.companyId);
  const authSourceCodexHome = configuredCodexHome ?? sharedCodexHome;

  checks.push({
    code: "codex_home_effective",
    level: "info",
    message: `Effective CODEX_HOME: ${effectiveCodexHome}`,
    detail: configuredCodexHome
      ? "Source: adapter config env.CODEX_HOME."
      : `Source: Paperclip-managed Codex home; auth/config are seeded from ${sharedCodexHome} during runs.`,
  });
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "codex_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "codex_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const configOpenAiKey = env.OPENAI_API_KEY;
  const hostOpenAiKey = process.env.OPENAI_API_KEY;
  if (isNonEmpty(configOpenAiKey) || isNonEmpty(hostOpenAiKey)) {
    const source = isNonEmpty(configOpenAiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "codex_openai_api_key_present",
      level: "info",
      message: "Codex auth mode: OpenAI API key.",
      detail: `OPENAI_API_KEY detected in ${source}; value is not shown.`,
    });
  } else {
    const codexAuth = await readCodexAuthFileMode(authSourceCodexHome);
    if (codexAuth.mode === "chatgpt_oauth" && codexAuth.auth) {
      checks.push({
        code: "codex_native_auth_present",
        level: "info",
        message: "Codex auth mode: ChatGPT login.",
        detail: summarizeChatGptAuth(codexAuth.auth, codexAuth.authPath),
      });
    } else if (codexAuth.mode === "api_key") {
      checks.push({
        code: "codex_auth_file_api_key_present",
        level: "info",
        message: "Codex auth mode: OpenAI API key from auth.json.",
        detail: `API key is present in ${codexAuth.authPath}; value is not shown.`,
      });
    } else {
      checks.push({
        code: "codex_openai_api_key_missing",
        level: "warn",
        message: "Codex authentication is not configured.",
        detail: `Checked OPENAI_API_KEY and ${codexAuth.authPath}.`,
        hint: "Set OPENAI_API_KEY in adapter env/shell, or run `codex login` for ChatGPT login auth, then retry.",
      });
    }
  }

  const canRunProbe =
    checks.every((check) => check.code !== "codex_cwd_invalid" && check.code !== "codex_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "codex")) {
      checks.push({
        code: "codex_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `codex`.",
        detail: command,
        hint: "Use the `codex` CLI command to run the automatic login and installation probe.",
      });
    } else {
      checks.push(await probeCodexVersion(command, cwd, env));

      const execArgs = buildCodexExecArgs({ ...config, fastMode: false });
      const args = execArgs.args;
      if (execArgs.fastModeIgnoredReason) {
        checks.push({
          code: "codex_fast_mode_unsupported_model",
          level: "warn",
          message: execArgs.fastModeIgnoredReason,
          hint: "Switch the agent model to GPT-5.4 or enter a manual model ID to enable Codex Fast mode.",
        });
      }

      const probe = await runChildProcess(
        `codex-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        args,
        {
          cwd,
          env,
          timeoutSec: 45,
          graceSec: 5,
          stdin: "Respond with hello.",
          onLog: async () => {},
        },
      );
      const parsed = parseCodexJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

      if (probe.timedOut) {
        checks.push({
          code: "codex_hello_probe_timed_out",
          level: "warn",
          message: "Codex hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Codex can run `Respond with hello` from this directory manually.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "codex_hello_probe_passed" : "codex_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Codex hello probe succeeded."
            : "Codex probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
                hint: "Try the probe manually (`codex exec --json -` then prompt: Respond with hello) to inspect full output.",
              }),
        });
      } else if (CODEX_AUTH_REQUIRED_RE.test(authEvidence)) {
        checks.push({
          code: "codex_hello_probe_auth_required",
          level: "warn",
          message: "Codex CLI is installed, but authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Configure OPENAI_API_KEY in adapter env/shell or run `codex login`, then retry the probe.",
        });
      } else if (execArgs.model && CODEX_MODEL_UNSUPPORTED_RE.test(authEvidence)) {
        checks.push({
          code: "codex_hello_probe_model_unsupported",
          level: "error",
          message: `Codex CLI rejected configured model ${execArgs.model}.`,
          ...(detail ? { detail } : {}),
          hint: "Upgrade the Codex CLI to the latest version, or choose a model supported by the installed CLI, then retry.",
        });
      } else {
        checks.push({
          code: "codex_hello_probe_failed",
          level: "error",
          message: "Codex hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `codex exec --json -` manually in this working directory and prompt `Respond with hello` to debug.",
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
