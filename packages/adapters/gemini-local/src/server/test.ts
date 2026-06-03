import path from "node:path";
import https from "node:https";
import type { IncomingMessage } from "node:http";
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
import { DEFAULT_GEMINI_LOCAL_MODEL, SANDBOX_INSTALL_COMMAND } from "../index.js";
import { detectGeminiAuthRequired, detectGeminiQuotaExhausted, parseGeminiJsonl } from "./parse.js";
import { firstNonEmptyLine } from "./utils.js";

// Models that require GEMINI_API_KEY and are verified via direct Gemini API v1beta.
// The Gemini CLI may lag behind the direct API for these model IDs.
const GEMINI_DIRECT_API_REQUIRED_MODELS = new Set([
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
]);

export interface DirectApiProbeResult {
  ok: boolean;
  statusCode: number;
  hasOkText: boolean;
}

export function parseGeminiDirectApiBody(body: string): { hasOkText: boolean } {
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const candidates = Array.isArray(json.candidates) ? json.candidates : [];
    const first = parseObject(candidates[0]);
    const content = parseObject(first.content);
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const text = parts
      .map((p) => asString(parseObject(p).text, ""))
      .join("")
      .trim();
    return { hasOkText: /\bOK\b/i.test(text) };
  } catch {
    return { hasOkText: false };
  }
}

export function probeGeminiDirectApi(
  apiKey: string,
  model: string,
  timeoutMs = 15000,
): Promise<DirectApiProbeResult> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Reply exactly: OK" }] }],
    });

    const onResponse = (res: IncomingMessage) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        const { hasOkText } = parseGeminiDirectApiBody(data);
        resolve({ ok: res.statusCode === 200, statusCode: res.statusCode ?? 0, hasOkText });
      });
    };

    const req = https.request(
      {
        hostname: "generativelanguage.googleapis.com",
        path: `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          // API key in header, never in URL or logs
          "x-goog-api-key": apiKey,
        },
        timeout: timeoutMs,
      },
      onResponse,
    );

    req.on("error", () => resolve({ ok: false, statusCode: 0, hasOkText: false }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, statusCode: 0, hasOkText: false });
    });
    req.write(body);
    req.end();
  });
}

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
  const command = asString(config.command, "gemini");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `gemini-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "gemini_environment_target",
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
      code: "gemini_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "gemini_cwd_invalid",
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
  if (targetIsRemote && typeof env.GEMINI_CLI_TRUST_WORKSPACE !== "string") {
    env.GEMINI_CLI_TRUST_WORKSPACE = "true";
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const installCheck = await maybeRunSandboxInstallCommand({
    runId,
    target,
    adapterKey: "gemini",
    installCommand: SANDBOX_INSTALL_COMMAND,
    detectCommand: command,
    env,
  });
  if (installCheck) checks.push(installCheck);
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({
      code: "gemini_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "gemini_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const configGeminiApiKey = env.GEMINI_API_KEY;
  const hostGeminiApiKey = targetIsRemote ? undefined : process.env.GEMINI_API_KEY;
  const configGoogleApiKey = env.GOOGLE_API_KEY;
  const hostGoogleApiKey = targetIsRemote ? undefined : process.env.GOOGLE_API_KEY;
  const hasGca = env.GOOGLE_GENAI_USE_GCA === "true" || (!targetIsRemote && process.env.GOOGLE_GENAI_USE_GCA === "true");
  if (
    isNonEmpty(configGeminiApiKey) ||
    isNonEmpty(hostGeminiApiKey) ||
    isNonEmpty(configGoogleApiKey) ||
    isNonEmpty(hostGoogleApiKey) ||
    hasGca
  ) {
    const source = hasGca
      ? "Google account login (GCA)"
      : isNonEmpty(configGeminiApiKey) || isNonEmpty(configGoogleApiKey)
        ? "adapter config env"
        : "server environment";
    checks.push({
      code: "gemini_api_key_present",
      level: "info",
      message: "Gemini API credentials are set for CLI authentication.",
      detail: `Detected in ${source}.`,
    });
  } else {
    checks.push({
      code: "gemini_api_key_missing",
      level: "info",
      message: "No explicit API key detected. Gemini CLI may still authenticate via `gemini auth login` (OAuth).",
      hint: "If the hello probe fails with an auth error, set GEMINI_API_KEY or GOOGLE_API_KEY in adapter env, or run `gemini auth login`.",
    });
  }

  // For Gemini 3.x models, probe the direct v1beta API since the CLI may lag behind.
  // Only runs when an API key is present; never prints key values.
  const configuredModel = asString(config.model, DEFAULT_GEMINI_LOCAL_MODEL).trim();
  const effectiveApiKey =
    (isNonEmpty(configGeminiApiKey) ? configGeminiApiKey : null) ??
    (isNonEmpty(hostGeminiApiKey) ? hostGeminiApiKey : null) ??
    (isNonEmpty(configGoogleApiKey) ? configGoogleApiKey : null) ??
    (isNonEmpty(hostGoogleApiKey) ? hostGoogleApiKey : null) ??
    null;

  if (GEMINI_DIRECT_API_REQUIRED_MODELS.has(configuredModel) && effectiveApiKey !== null) {
    const directProbeTimeoutMs = Math.max(1, asNumber(config.directProbeTimeoutSec, 15)) * 1000;
    const directProbe = await probeGeminiDirectApi(effectiveApiKey, configuredModel, directProbeTimeoutMs);

    if (directProbe.ok && directProbe.hasOkText) {
      checks.push({
        code: "gemini_direct_api_probe_passed",
        level: "info",
        message: `Direct API probe passed for ${configuredModel}.`,
        detail: `HTTP ${directProbe.statusCode} with expected OK response. Model accessible via Gemini API v1beta.`,
      });
    } else if (directProbe.ok) {
      checks.push({
        code: "gemini_direct_api_probe_unexpected_output",
        level: "warn",
        message: `Direct API probe for ${configuredModel} returned HTTP ${directProbe.statusCode} but unexpected response text.`,
        hint: "Model may still work. Run a short test task to verify actual output.",
      });
    } else {
      checks.push({
        code: "gemini_direct_api_probe_failed",
        level: "warn",
        message: `Direct API probe failed for ${configuredModel} (HTTP ${directProbe.statusCode}).`,
        hint: `${configuredModel} requires a valid GEMINI_API_KEY. Verify the key has access to this model at ai.google.dev.`,
      });
    }
  } else if (GEMINI_DIRECT_API_REQUIRED_MODELS.has(configuredModel) && effectiveApiKey === null) {
    checks.push({
      code: "gemini_direct_api_key_required",
      level: "warn",
      message: `${configuredModel} requires GEMINI_API_KEY but no API key is configured.`,
      hint: "Set GEMINI_API_KEY in adapter env or server environment. OAuth-only auth returns ModelNotFoundError for Gemini 3.x models.",
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "gemini_cwd_invalid" && check.code !== "gemini_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "gemini")) {
      checks.push({
        code: "gemini_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `gemini`.",
        detail: command,
        hint: "Use the `gemini` CLI command to run the automatic installation and auth probe.",
      });
    } else {
      const model = asString(config.model, DEFAULT_GEMINI_LOCAL_MODEL).trim();
      const approvalMode = asString(config.approvalMode, asBoolean(config.yolo, false) ? "yolo" : "default");
      const sandbox = asBoolean(config.sandbox, false);
      const helloProbeTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 60));
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = ["--output-format", "stream-json", "--prompt", "Respond with hello."];
      if (model && model !== DEFAULT_GEMINI_LOCAL_MODEL) args.push("--model", model);
      if (approvalMode !== "default") args.push("--approval-mode", approvalMode);
      if (sandbox) {
        args.push("--sandbox");
      } else {
        args.push("--sandbox=none");
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
      const parsed = parseGeminiJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authMeta = detectGeminiAuthRequired({
        parsed: parsed.resultEvent,
        stdout: probe.stdout,
        stderr: probe.stderr,
      });
      const quotaMeta = detectGeminiQuotaExhausted({
        parsed: parsed.resultEvent,
        stdout: probe.stdout,
        stderr: probe.stderr,
      });

      if (quotaMeta.exhausted) {
        checks.push({
          code: "gemini_hello_probe_quota_exhausted",
          level: "warn",
          message: probe.timedOut
            ? "Gemini CLI is retrying after quota exhaustion."
            : "Gemini CLI authentication is configured, but the current account or API key is over quota.",
          ...(detail ? { detail } : {}),
          hint: "The configured Gemini account or API key is over quota. Check ai.google.dev usage/billing, then retry the probe.",
        });
      } else if (probe.timedOut) {
        checks.push({
          code: "gemini_hello_probe_timed_out",
          level: "warn",
          message: "Gemini hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Gemini can run `Respond with hello.` from this directory manually.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "gemini_hello_probe_passed" : "gemini_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Gemini hello probe succeeded."
            : "Gemini probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
              hint: "Try `gemini --output-format json \"Respond with hello.\"` manually to inspect full output.",
            }),
        });
      } else if (authMeta.requiresAuth) {
        checks.push({
          code: "gemini_hello_probe_auth_required",
          level: "warn",
          message: "Gemini CLI is installed, but authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Run `gemini auth` or configure GEMINI_API_KEY / GOOGLE_API_KEY in adapter env/shell, then retry the probe.",
        });
      } else {
        checks.push({
          code: "gemini_hello_probe_failed",
          level: "error",
          message: "Gemini hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `gemini --output-format json \"Respond with hello.\"` manually in this working directory to debug.",
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
