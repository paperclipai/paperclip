import path from "node:path";
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
import { parsePiJsonl } from "./parse.js";

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

const PI_AUTH_REQUIRED_RE =
  /(?:api[_\s-]?key|missing\s+credentials|authentication\s+required|unauthorized|forbidden|invalid\s+api\s+key|provider\s+requires\s+an\s+api\s+key|set\s+[A-Z0-9_]+_API_KEY)/i;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "pi");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "pi_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "pi_cwd_invalid",
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
  const probeEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (typeof value === "string") probeEnv[key] = value;
  }
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "pi_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "pi_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const anyApiKeySet =
    [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "GROQ_API_KEY",
      "CEREBRAS_API_KEY",
      "XAI_API_KEY",
      "OPENROUTER_API_KEY",
      "AI_GATEWAY_API_KEY",
      "ZAI_API_KEY",
      "MISTRAL_API_KEY",
      "MINIMAX_API_KEY",
      "OPENCODE_API_KEY",
      "KIMI_API_KEY",
    ].some((key) => isNonEmpty(env[key]) || isNonEmpty(process.env[key]));

  if (anyApiKeySet) {
    checks.push({
      code: "pi_api_key_present",
      level: "info",
      message: "At least one model provider API key is configured for pi.",
    });
  } else {
    checks.push({
      code: "pi_api_key_missing",
      level: "warn",
      message: "No model provider API key detected. pi runs may fail until credentials are configured.",
      hint: "Set provider credentials in adapter env or server environment (for example OPENAI_API_KEY).",
    });
  }

  const canRunProbe = checks.every((check) => check.code !== "pi_cwd_invalid" && check.code !== "pi_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "pi")) {
      checks.push({
        code: "pi_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `pi`.",
        detail: command,
        hint: "Use the `pi` CLI command to run the automatic installation and auth probe.",
      });
    } else {
      const provider = asString(config.provider, "").trim();
      const model = asString(config.model, "").trim();
      const thinking = asString(config.thinking, "").trim();
      const noTools = asBoolean(config.noTools, false);
      const tools = asStringArray(config.tools);
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = ["--mode", "json", "--print", "--no-session"];
      if (provider) args.push("--provider", provider);
      if (model) args.push("--model", model);
      if (thinking) args.push("--thinking", thinking);
      if (noTools) args.push("--no-tools");
      else if (tools.length > 0) args.push("--tools", tools.join(","));
      if (extraArgs.length > 0) args.push(...extraArgs);
      args.push("Respond with hello.");

      let probe: Awaited<ReturnType<typeof runChildProcess>> | null = null;
      try {
        probe = await runChildProcess(
          `pi-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          command,
          args,
          {
            cwd,
            env: probeEnv,
            timeoutSec: 45,
            graceSec: 5,
            onLog: async () => {},
          },
        );
      } catch (err) {
        checks.push({
          code: "pi_hello_probe_failed",
          level: "error",
          message: "pi hello probe failed to start.",
          detail: err instanceof Error ? err.message : String(err),
          hint: "Verify CLI installation/permissions and retry the probe.",
        });
      }
      if (!probe) {
        return {
          adapterType: ctx.adapterType,
          status: summarizeStatus(checks),
          checks,
          testedAt: new Date().toISOString(),
        };
      }

      const parsed = parsePiJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`;

      if (probe.timedOut) {
        checks.push({
          code: "pi_hello_probe_timed_out",
          level: "warn",
          message: "pi hello probe timed out.",
          hint: "Retry the probe. If this persists, run `pi --mode json --print --no-session \"Respond with hello.\"` manually.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "pi_hello_probe_passed" : "pi_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "pi hello probe succeeded."
            : "pi probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
                hint: "Run the probe manually to inspect full output and auth/config state.",
              }),
        });
      } else if (PI_AUTH_REQUIRED_RE.test(authEvidence)) {
        checks.push({
          code: "pi_hello_probe_auth_required",
          level: "warn",
          message: "pi CLI is installed, but provider credentials are not ready.",
          ...(detail ? { detail } : {}),
          hint: "Set provider API keys (for example OPENAI_API_KEY) or adjust --provider/--model, then retry.",
        });
      } else {
        checks.push({
          code: "pi_hello_probe_failed",
          level: "error",
          message: "pi hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `pi --mode json --print --no-session \"Respond with hello.\"` manually in this working directory to debug.",
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
