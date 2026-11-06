import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  ensureCommandResolvable,
  ensurePathInEnv,
  isForbiddenConfigEnvKey,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { firstNonEmptyLine, isT3ProjectNotFound, isT3ServerUnavailable } from "./parse.js";

const PROBE_TIMEOUT_SEC = 15;
const START_SERVER_HINT = "Start the T3 Code server: `t3 serve`, or `systemctl --user start t3code` when it runs as a user service.";

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const finish = (): AdapterEnvironmentTestResult => ({
    adapterType: ctx.adapterType,
    status: checks.some((check) => check.level === "error")
      ? "fail"
      : checks.some((check) => check.level === "warn") ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  });

  if (ctx.executionTarget?.kind === "remote") {
    checks.push({
      code: "t3code_local_only",
      level: "error",
      message: "T3 Code runs only on the Paperclip host.",
      hint: "Use a local environment for this agent.",
    });
    return finish();
  }

  const config = parseObject(ctx.config);
  const command = asString(config.command, "t3");
  const cwd = asString(config.cwd, "") || process.cwd();
  if (Boolean(asString(config.provider, "").trim()) !== Boolean(asString(config.model, "").trim())) {
    checks.push({
      code: "t3code_provider_model_pair",
      level: "error",
      message: "Set provider and model together, or neither to use the project's default model.",
    });
  }
  const env = Object.fromEntries(
    Object.entries(parseObject(config.env)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && !isForbiddenConfigEnvKey(entry[0]),
    ),
  );

  try {
    await ensureCommandResolvable(command, cwd, ensurePathInEnv({ ...process.env, ...env }));
  } catch (err) {
    checks.push({
      code: "t3code_command_missing",
      level: "error",
      message: err instanceof Error ? err.message : String(err),
      hint: "Install T3 Code so the `t3` CLI is on PATH, or set command to its absolute path.",
    });
    return finish();
  }

  const probeId = `t3code-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const probe = (args: string[]) =>
    runChildProcess(`${probeId}-${args[0]}`, command, args, {
      cwd,
      env,
      timeoutSec: PROBE_TIMEOUT_SEC,
      graceSec: 2,
      onLog: async () => {},
    });

  const version = await probe(["--version"]);
  if (version.exitCode !== 0) {
    checks.push({
      code: "t3code_version_failed",
      level: "error",
      message: `\`${command} --version\` failed.`,
      detail: firstNonEmptyLine(version.stderr) || firstNonEmptyLine(version.stdout) || null,
    });
    return finish();
  }
  checks.push({
    code: "t3code_version",
    level: "info",
    message: `T3 Code CLI ${firstNonEmptyLine(version.stdout) || "found"}.`,
  });

  const list = await probe(["thread", "list", "--json"]);
  if (list.exitCode === 0) {
    checks.push({ code: "t3code_server_reachable", level: "info", message: "The T3 Code server is running." });
  } else if (isT3ProjectNotFound(list.stderr)) {
    checks.push({
      code: "t3code_server_reachable",
      level: "info",
      message: "The T3 Code server is running. The working directory is not a T3 Code project yet; the first run adds it.",
    });
  } else {
    checks.push({
      code: "t3code_server_unreachable",
      level: "error",
      message: isT3ServerUnavailable(list.stderr)
        ? "No T3 Code server is running for this user."
        : "Could not list T3 Code threads.",
      detail: firstNonEmptyLine(list.stderr) || null,
      hint: START_SERVER_HINT,
    });
  }
  return finish();
}
