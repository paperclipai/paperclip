import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import { DEFAULT_DISTILL_LOCAL_MODEL } from "../index.js";
import { parseDistillJsonl, parseDistillModelsOutput } from "./parse.js";

function stringEnv(input: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseObject(input))) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function brief(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
}

function summarize(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "distill");
  const cwd = asString(config.cwd, "") || process.cwd();
  const model = asString(config.model, DEFAULT_DISTILL_LOCAL_MODEL).trim() || DEFAULT_DISTILL_LOCAL_MODEL;
  const env = { GROK_FOLDER_TRUST: "0", ...stringEnv(config.env) };
  const runId = `distill-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const finish = (): AdapterEnvironmentTestResult => ({
    adapterType: ctx.adapterType,
    status: summarize(checks),
    checks,
    testedAt: new Date().toISOString(),
  });

  if (ctx.executionTarget?.kind === "remote") {
    checks.push({
      code: "distill_target_unsupported",
      level: "error",
      message: "The Distill adapter runs only on the Paperclip host.",
      hint: "Use a local execution target for Distill agents.",
    });
    return finish();
  }

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({ code: "distill_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
  } catch (err) {
    checks.push({
      code: "distill_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
    return finish();
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, null, cwd, runtimeEnv);
    checks.push({ code: "distill_command_resolvable", level: "info", message: `Command is executable: ${command}` });
  } catch (err) {
    checks.push({
      code: "distill_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "Install Distill on the Paperclip host or set the command field to its absolute path.",
    });
    return finish();
  }

  const run = (args: string[], timeoutSec: number) =>
    runAdapterExecutionTargetProcess(runId, null, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec: 5,
      onLog: async () => {},
    });

  const modelsProbe = await run(["models"], Math.max(1, asNumber(config.helloProbeTimeoutSec, 45)));
  if (modelsProbe.timedOut || (modelsProbe.exitCode ?? 1) !== 0) {
    checks.push({
      code: "distill_models_probe_failed",
      level: "error",
      message: modelsProbe.timedOut ? "`distill models` timed out." : "`distill models` failed.",
      detail: brief(`${modelsProbe.stderr}\n${modelsProbe.stdout}`),
    });
    return finish();
  }
  const { defaultModel, models } = parseDistillModelsOutput(modelsProbe.stdout);
  checks.push({
    code: models.length > 0 ? "distill_models_discovered" : "distill_models_empty",
    level: models.length > 0 ? "info" : "warn",
    message: models.length > 0 ? `Distill offers ${models.length} model(s).` : "Distill listed no models.",
    detail: defaultModel ? `Default model: ${defaultModel}` : undefined,
    hint: models.length > 0 ? undefined : "Log in with `distill accounts login <id>` or add API keys on the host.",
  });
  if (model !== DEFAULT_DISTILL_LOCAL_MODEL && !models.includes(model)) {
    checks.push({
      code: "distill_model_not_found",
      level: "warn",
      message: `Configured model "${model}" is not in \`distill models\`.`,
      hint: 'Choose a listed model or "auto".',
    });
  }

  const hello = await run(
    [
      "--cwd",
      cwd,
      "--output-format",
      "streaming-json",
      "--model",
      model,
      "--always-approve",
      "--max-turns",
      "1",
      "--single",
      "Respond with hello.",
    ],
    Math.max(1, asNumber(config.helloProbeTimeoutSec, 120)),
  );
  const parsed = parseDistillJsonl(hello.stdout);
  if (!hello.timedOut && (hello.exitCode ?? 1) === 0 && parsed.sawEnd) {
    checks.push({
      code: "distill_hello_probe_passed",
      level: "info",
      message: `Distill answered with model ${parsed.primaryModel ?? model}.`,
      detail: parsed.summary ? brief(parsed.summary) : undefined,
    });
  } else {
    const detail = parsed.errorMessage || brief(`${hello.stderr}\n${hello.stdout}`);
    const authRequired = /not\s+(signed|logged)\s+in|login|unauthori[sz]ed|no\s+(saved\s+)?account|credential/i.test(detail);
    checks.push({
      code: authRequired ? "distill_auth_required" : "distill_hello_probe_failed",
      level: authRequired ? "warn" : "error",
      message: hello.timedOut
        ? "Distill hello probe timed out."
        : authRequired
          ? "Distill has no usable login for this model."
          : "Distill hello probe failed.",
      detail,
      hint: authRequired ? "Run `distill accounts list` on the host and log in the needed account." : undefined,
    });
  }
  return finish();
}
