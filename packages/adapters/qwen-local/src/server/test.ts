import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function normalizeEnv(input: unknown): Record<string, string> {
  const record = parseObject(input);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      env[key] = value;
      continue;
    }
    const nested = parseObject(value);
    if (nested.type === "plain" && typeof nested.value === "string") {
      env[key] = nested.value;
    }
  }
  return env;
}

function hasEnvValue(env: Record<string, string>, key: string): boolean {
  const value = env[key] ?? process.env[key];
  return typeof value === "string" && value.trim().length > 0;
}

const AUTH_ERROR_RE = /auth|unauthorized|forbidden|api[_ -]?key|login/i;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "qwen");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: false });
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

  const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...normalizeEnv(config.env) }));
  const cwdValid = !checks.some((check) => check.code === "qwen_cwd_invalid");
  if (cwdValid) {
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
        hint: "Install Qwen Code or set adapterConfig.command to the correct binary path.",
      });
    }
  }

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push({
    code: nodeMajor >= 20 ? "qwen_node_ok" : "qwen_node_old",
    level: nodeMajor >= 20 ? "info" : "warn",
    message:
      nodeMajor >= 20
        ? `Node.js ${process.versions.node} satisfies Qwen Code runtime requirements.`
        : `Node.js ${process.versions.node} may be too old for Qwen Code.`,
    hint: nodeMajor >= 20 ? undefined : "Upgrade the host to Node.js 20 or newer.",
  });

  const hasAuth =
    hasEnvValue(runtimeEnv, "DASHSCOPE_API_KEY") ||
    hasEnvValue(runtimeEnv, "BAILIAN_CODING_PLAN_API_KEY") ||
    hasEnvValue(runtimeEnv, "OPENAI_API_KEY") ||
    hasEnvValue(runtimeEnv, "QWEN_CODE_API_KEY");
  checks.push({
    code: hasAuth ? "qwen_auth_configured" : "qwen_auth_missing",
    level: hasAuth ? "info" : "warn",
    message: hasAuth
      ? "Found a likely Qwen authentication environment variable."
      : "No obvious Qwen authentication environment variable was found.",
    hint: hasAuth
      ? undefined
      : "Set DASHSCOPE_API_KEY, BAILIAN_CODING_PLAN_API_KEY, OPENAI_API_KEY, or rely on local Qwen OAuth login.",
  });

  const canProbe =
    cwdValid &&
    !checks.some((check) => check.code === "qwen_command_unresolvable");
  if (canProbe) {
    try {
      const probe = await runChildProcess(
        `qwen-envtest-${Date.now()}`,
        command,
        ["-p", "Respond with hello.", "--output-format", "stream-json"],
        {
          cwd,
          env: runtimeEnv,
          timeoutSec: 30,
          graceSec: 5,
          onLog: async () => {},
        },
      );
      const detail = [probe.stderr.trim(), probe.stdout.trim()].find(Boolean) ?? null;
      if (probe.exitCode === 0) {
        checks.push({
          code: "qwen_probe_ok",
          level: "info",
          message: "Qwen hello probe completed successfully.",
          detail,
        });
      } else if (AUTH_ERROR_RE.test(`${probe.stdout}\n${probe.stderr}`)) {
        checks.push({
          code: "qwen_probe_auth_warning",
          level: "warn",
          message: "Qwen CLI started but reported an authentication problem.",
          detail,
          hint: "Verify your API key or local Qwen login state.",
        });
      } else {
        checks.push({
          code: "qwen_probe_failed",
          level: "warn",
          message: "Qwen CLI started but the hello probe did not succeed.",
          detail,
        });
      }
    } catch (err) {
      checks.push({
        code: "qwen_probe_failed",
        level: "warn",
        message: err instanceof Error ? err.message : "Qwen hello probe failed.",
      });
    }
  }

  return {
    adapterType: "qwen_local",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
