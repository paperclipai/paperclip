import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asBoolean,
  asStringArray,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import path from "node:path";
import { detectGeminiAuthRequired, parseGeminiStreamJson } from "./parse.js";

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
  const command = asString(config.command, "gemini");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
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
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
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

  const configGeminiKey = env.GEMINI_API_KEY;
  const configGoogleKey = env.GOOGLE_API_KEY;
  const hostGeminiKey = process.env.GEMINI_API_KEY;
  const hostGoogleKey = process.env.GOOGLE_API_KEY;
  const hostGcloudProject = process.env.GOOGLE_CLOUD_PROJECT;
  if (isNonEmpty(configGeminiKey) || isNonEmpty(hostGeminiKey)) {
    const source = isNonEmpty(configGeminiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "gemini_api_key_present",
      level: "info",
      message: `GEMINI_API_KEY is set (detected in ${source}). API-key auth will be used.`,
    });
  } else if (isNonEmpty(configGoogleKey) || isNonEmpty(hostGoogleKey)) {
    const source = isNonEmpty(configGoogleKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "gemini_google_api_key_present",
      level: "info",
      message: `GOOGLE_API_KEY is set (detected in ${source}). API-key auth will be used.`,
    });
  } else if (isNonEmpty(hostGcloudProject)) {
    checks.push({
      code: "gemini_gcloud_project_present",
      level: "info",
      message: "GOOGLE_CLOUD_PROJECT is set; Google Cloud / Vertex AI auth can be used.",
    });
  } else {
    checks.push({
      code: "gemini_no_api_key",
      level: "warn",
      message: "No GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_CLOUD_PROJECT detected.",
      hint: "Set GEMINI_API_KEY in the agent's env config or server environment, or authenticate via `gcloud auth application-default login`.",
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
        hint: "Use the `gemini` CLI command to run the automatic probe.",
      });
    } else {
      const model = asString(config.model, "").trim();
      const yolo = asBoolean(config.yolo, false);
      const sandbox = asBoolean(config.sandbox, false);
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = ["-p", "Respond with hello.", "--output-format", "stream-json"];
      if (model) args.push("--model", model);
      if (yolo) args.push("--yolo");
      if (sandbox) args.push("--sandbox");
      if (extraArgs.length > 0) args.push(...extraArgs);

      const probe = await runChildProcess(
        `gemini-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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

      const parsedStream = parseGeminiStreamJson(probe.stdout);
      const parsed = parsedStream.resultJson;
      const authMeta = detectGeminiAuthRequired({
        parsed,
        stdout: probe.stdout,
        stderr: probe.stderr,
      });
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr);

      if (probe.timedOut) {
        checks.push({
          code: "gemini_hello_probe_timed_out",
          level: "warn",
          message: "Gemini hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Gemini can run from this directory manually.",
        });
      } else if (authMeta.requiresAuth) {
        checks.push({
          code: "gemini_hello_probe_auth_required",
          level: "warn",
          message: "Gemini CLI is installed, but authentication is required.",
          ...(detail ? { detail } : {}),
          hint: "Set GEMINI_API_KEY or run `gcloud auth application-default login`, then retry.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsedStream.summary.trim();
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
                hint: "Try the probe manually: `gemini -p \"Respond with hello.\" --output-format stream-json`.",
              }),
        });
      } else {
        checks.push({
          code: "gemini_hello_probe_failed",
          level: "error",
          message: "Gemini hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `gemini -p \"Respond with hello.\" --output-format stream-json` manually in this directory to debug.",
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
