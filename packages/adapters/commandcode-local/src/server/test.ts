import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asBoolean,
  asNumber,
  asString,
  ensurePathInEnv,
  parseJson,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  maybeRunSandboxInstallCommand,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import { parseCommandCodeModelsOutput } from "./models.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function summarizeProbeDetail(stdout: string, stderr: string): string | null {
  const raw = firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function normalizeEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

const COMMANDCODE_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|login\s+required|authentication\s+required|unauthorized|invalid\s+credentials|run\s+`?commandcode\s+login`?)/i;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "commandcode");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `commandcode-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "commandcode_environment_target",
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
      code: "commandcode_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "commandcode_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const env = normalizeEnv(config.env);
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const installCheck = await maybeRunSandboxInstallCommand({
    runId,
    target,
    adapterKey: "commandcode",
    installCommand: SANDBOX_INSTALL_COMMAND,
    detectCommand: command,
    env,
  });
  if (installCheck) checks.push(installCheck);

  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({
      code: "commandcode_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "commandcode_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "Install CommandCode with `npm i -g command-code@latest`, then restart Paperclip from a shell where `commandcode` is on PATH.",
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "commandcode_cwd_invalid" && check.code !== "commandcode_command_unresolvable");

  if (canRunProbe) {
    const statusProbe = await runAdapterExecutionTargetProcess(
      runId,
      target,
      command,
      ["status", "--json"],
      {
        cwd,
        env,
        timeoutSec: Math.max(1, asNumber(config.statusProbeTimeoutSec, 20)),
        graceSec: 5,
        onLog: async () => {},
      },
    );
    const statusOutput = `${statusProbe.stdout}\n${statusProbe.stderr}`;
    const authRequired = COMMANDCODE_AUTH_REQUIRED_RE.test(statusOutput);

    if (statusProbe.timedOut) {
      checks.push({
        code: "commandcode_status_probe_timed_out",
        level: "warn",
        message: "`commandcode status --json` timed out.",
        hint: "Retry the probe. If this persists, run `commandcode status --json` manually from the target environment.",
      });
    } else if ((statusProbe.exitCode ?? 1) !== 0) {
      checks.push({
        code: authRequired ? "commandcode_auth_required" : "commandcode_status_probe_failed",
        level: authRequired ? "warn" : "error",
        message: authRequired
          ? "CommandCode CLI is not authenticated."
          : "`commandcode status --json` failed.",
        detail: summarizeProbeDetail(statusProbe.stdout, statusProbe.stderr),
        hint: authRequired ? "Run `commandcode login` on the target host, then retry." : undefined,
      });
    } else {
      const parsedStatus = parseJson(statusProbe.stdout);
      const authenticated = asBoolean(parsedStatus?.authenticated, false);
      checks.push({
        code: authenticated ? "commandcode_auth_configured" : "commandcode_auth_unknown",
        level: authenticated ? "info" : "warn",
        message: authenticated
          ? "CommandCode CLI authentication is configured."
          : "`commandcode status --json` completed, but did not report authenticated=true.",
        detail: [
          asString(parsedStatus?.version, "") ? `version=${asString(parsedStatus?.version, "")}` : "",
          asString(parsedStatus?.user, "") ? `user=${asString(parsedStatus?.user, "")}` : "",
          asString(parsedStatus?.model, "") ? `model=${asString(parsedStatus?.model, "")}` : "",
        ].filter(Boolean).join(" ") || null,
      });
    }

    const modelsProbe = await runAdapterExecutionTargetProcess(
      runId,
      target,
      command,
      ["--list-models"],
      {
        cwd,
        env,
        timeoutSec: Math.max(1, asNumber(config.modelsProbeTimeoutSec, 30)),
        graceSec: 5,
        onLog: async () => {},
      },
    );
    if (modelsProbe.timedOut) {
      checks.push({
        code: "commandcode_models_probe_timed_out",
        level: "warn",
        message: "`commandcode --list-models` timed out.",
      });
    } else if ((modelsProbe.exitCode ?? 1) !== 0) {
      checks.push({
        code: "commandcode_models_probe_failed",
        level: "warn",
        message: "`commandcode --list-models` failed.",
        detail: summarizeProbeDetail(modelsProbe.stdout, modelsProbe.stderr),
      });
    } else {
      const discoveredModels = parseCommandCodeModelsOutput(modelsProbe.stdout);
      checks.push({
        code: "commandcode_models_discovered",
        level: "info",
        message: `Discovered ${discoveredModels.length} CommandCode model(s).`,
      });
      const configuredModel = asString(config.model, "").trim();
      if (configuredModel && discoveredModels.length > 0 && !discoveredModels.some((entry) => entry.id === configuredModel)) {
        checks.push({
          code: "commandcode_model_not_listed",
          level: "warn",
          message: `Configured model was not listed by CommandCode: ${configuredModel}`,
          hint: "Verify the model id with `commandcode --list-models` or leave the model empty to use CommandCode's default.",
        });
      }
    }

    const helloProbe = await runAdapterExecutionTargetProcess(
      runId,
      target,
      command,
      [
        "-p",
        "--skip-onboarding",
        "--trust",
        ...(asBoolean(config.dangerouslySkipPermissions, true) ? ["--yolo"] : []),
        ...(asString(config.model, "").trim() ? ["--model", asString(config.model, "").trim()] : []),
        "--max-turns",
        "1",
      ],
      {
        cwd,
        env,
        stdin: "Respond with hello.",
        timeoutSec: Math.max(1, asNumber(config.helloProbeTimeoutSec, 60)),
        graceSec: 5,
        onLog: async () => {},
      },
    );
    const helloOutput = `${helloProbe.stdout}\n${helloProbe.stderr}`;
    const helloAuthRequired = COMMANDCODE_AUTH_REQUIRED_RE.test(helloOutput);
    if (helloProbe.timedOut) {
      checks.push({
        code: "commandcode_hello_probe_timed_out",
        level: "error",
        message: "CommandCode hello probe timed out.",
        hint: "Run `commandcode -p \"Respond with hello.\"` manually from the target environment.",
      });
    } else if ((helloProbe.exitCode ?? 1) !== 0) {
      checks.push({
        code: helloAuthRequired ? "commandcode_hello_auth_required" : "commandcode_hello_probe_failed",
        level: "error",
        message: helloAuthRequired
          ? "CommandCode hello probe failed because authentication is required."
          : "CommandCode hello probe failed.",
        detail: summarizeProbeDetail(helloProbe.stdout, helloProbe.stderr),
        hint: helloAuthRequired ? "Run `commandcode login` on the target host, then retry." : undefined,
      });
    } else if (!/hello/i.test(helloProbe.stdout)) {
      checks.push({
        code: "commandcode_hello_probe_unexpected_output",
        level: "warn",
        message: "CommandCode hello probe completed but did not include `hello` in stdout.",
        detail: summarizeProbeDetail(helloProbe.stdout, helloProbe.stderr),
      });
    } else {
      checks.push({
        code: "commandcode_hello_probe_passed",
        level: "info",
        message: "CommandCode responded to the hello probe.",
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
