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
import { parseQwenStreamJson, detectQwenLoginRequired } from "./parse.js";

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
  const command = asString(config.command, "qwen");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "qwen_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "qwen_cwd_invalid",
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
      code: "qwen_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "qwen_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const configApiKey = env.DASHSCOPE_API_KEY;
  const hostApiKey = process.env.DASHSCOPE_API_KEY;
  if (isNonEmpty(configApiKey) || isNonEmpty(hostApiKey)) {
    const source = isNonEmpty(configApiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "qwen_dashscope_api_key_set",
      level: "info",
      message: "DASHSCOPE_API_KEY is set; Qwen Code will use API-key auth.",
      detail: `Detected in ${source}.`,
    });
  } else {
    checks.push({
      code: "qwen_dashscope_api_key_missing",
      level: "warn",
      message: "DASHSCOPE_API_KEY is not set. Qwen Code may require interactive login.",
      hint: "Ensure Qwen Code is authenticated (e.g. via `qwen auth qwen-oauth`) or set DASHSCOPE_API_KEY.",
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "qwen_cwd_invalid" && check.code !== "qwen_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "qwen")) {
      checks.push({
        code: "qwen_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `qwen`.",
        detail: command,
        hint: "Use the `qwen` CLI command to run the automatic probe.",
      });
    } else {
      const model = asString(config.model, "").trim();
      const yolo = asBoolean(config.yolo, true);
      const maxTurns = asNumber(config.maxTurnsPerRun, 0);
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = ["--output-format", "stream-json"];
      if (yolo) args.push("--yolo");
      if (model) args.push("--model", model);
      if (maxTurns > 0) args.push("--max-session-turns", String(maxTurns));
      if (extraArgs.length > 0) args.push(...extraArgs);
      args.push("-");

      const probe = await runChildProcess(
        `qwen-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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

      const parsedStream = parseQwenStreamJson(probe.stdout);
      const parsed = parsedStream.resultJson;
      const loginMeta = detectQwenLoginRequired({
        parsed,
        stdout: probe.stdout,
        stderr: probe.stderr,
      });
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr);

      if (probe.timedOut) {
        checks.push({
          code: "qwen_hello_probe_timed_out",
          level: "warn",
          message: "Qwen hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Qwen Code can run `Respond with hello` from this directory manually.",
        });
      } else if (loginMeta.requiresLogin) {
        checks.push({
          code: "qwen_hello_probe_auth_required",
          level: "warn",
          message: "Qwen CLI is installed, but login is required.",
          ...(detail ? { detail } : {}),
          hint: loginMeta.loginUrl
            ? `Run \`qwen auth qwen-oauth\` and complete sign-in at ${loginMeta.loginUrl}, then retry.`
            : "Run `qwen auth qwen-oauth` or `qwen auth coding-plan` in this environment, then retry the probe.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsedStream.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "qwen_hello_probe_passed" : "qwen_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Qwen hello probe succeeded."
            : "Qwen probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
                hint: "Try the probe manually (`qwen --output-format stream-json -`) and prompt `Respond with hello`.",
              }),
        });
      } else {
        checks.push({
          code: "qwen_hello_probe_failed",
          level: "error",
          message: "Qwen hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `qwen --output-format stream-json -` manually in this directory and prompt `Respond with hello` to debug.",
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
