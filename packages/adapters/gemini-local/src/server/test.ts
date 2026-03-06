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
import { parseGeminiJson } from "./parse.js";

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

const GEMINI_AUTH_REQUIRED_RE =
  /(?:auth|login|credential|api.?key.*required|please set|GEMINI_API_KEY|GOOGLE_GENAI)/i;

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

  const configApiKey = env.GEMINI_API_KEY;
  const hostApiKey = process.env.GEMINI_API_KEY;
  const hasGca = env.GOOGLE_GENAI_USE_GCA === "true" || process.env.GOOGLE_GENAI_USE_GCA === "true";
  if (isNonEmpty(configApiKey) || isNonEmpty(hostApiKey)) {
    const source = isNonEmpty(configApiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "gemini_api_key_present",
      level: "info",
      message: "GEMINI_API_KEY is set for Gemini authentication.",
      detail: `Detected in ${source}.`,
    });
  } else if (hasGca) {
    checks.push({
      code: "gemini_gca_login",
      level: "info",
      message: "Google account login (GCA) is configured.",
    });
  } else {
    checks.push({
      code: "gemini_auth_missing",
      level: "warn",
      message: "No Gemini authentication detected. Set GEMINI_API_KEY or configure Google login.",
      hint: "Set GEMINI_API_KEY in adapter env, or run `gemini` interactively to login with Google.",
    });
  }

  const canRunProbe = checks.every(
    (check) => check.code !== "gemini_cwd_invalid" && check.code !== "gemini_command_unresolvable",
  );
  if (canRunProbe) {
    const model = asString(config.model, "").trim();
    const approvalMode = asString(config.approvalMode, "yolo");

    const sandbox = asBoolean(config.sandbox, false);
    const args: string[] = ["--output-format", "json", "--approval-mode", approvalMode];
    if (sandbox) {
      args.push("--sandbox");
    } else {
      args.push("--sandbox=none");
    }
    if (model) args.push("--model", model);

    const probe = await runChildProcess(
      `gemini-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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

    const parsed = parseGeminiJson(probe.stdout);
    const authEvidence = `${probe.stdout}\n${probe.stderr}`.trim();

    if (probe.timedOut) {
      checks.push({
        code: "gemini_hello_probe_timed_out",
        level: "warn",
        message: "Gemini hello probe timed out.",
        hint: "Retry the probe. If this persists, verify Gemini can run from this directory manually.",
      });
    } else if ((probe.exitCode ?? 1) === 0) {
      const hasHello = /\bhello\b/i.test(parsed.summary);
      checks.push({
        code: hasHello ? "gemini_hello_probe_passed" : "gemini_hello_probe_unexpected_output",
        level: hasHello ? "info" : "warn",
        message: hasHello
          ? "Gemini hello probe succeeded."
          : "Gemini probe ran but did not return `hello` as expected.",
        ...(parsed.summary ? { detail: parsed.summary.slice(0, 240) } : {}),
      });
    } else if (GEMINI_AUTH_REQUIRED_RE.test(authEvidence)) {
      checks.push({
        code: "gemini_hello_probe_auth_required",
        level: "warn",
        message: "Gemini CLI is installed, but authentication is not ready.",
        detail: firstNonEmptyLine(probe.stderr) || firstNonEmptyLine(probe.stdout) || undefined,
        hint: "Set GEMINI_API_KEY or run `gemini` interactively to login with Google.",
      });
    } else {
      checks.push({
        code: "gemini_hello_probe_failed",
        level: "error",
        message: "Gemini hello probe failed.",
        detail: firstNonEmptyLine(probe.stderr) || firstNonEmptyLine(probe.stdout) || undefined,
        hint: "Run `gemini` manually in this working directory to debug.",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
