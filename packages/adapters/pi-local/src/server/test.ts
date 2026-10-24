import path from "node:path";

import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  parseObject,
  ensurePathInEnv,
} from "@paperclipai/adapter-utils/server-utils";
import {
  asStringArray,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  ensureAdapterExecutionTargetDirectory,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  prepareAdapterExecutionTargetRuntime,
} from "@paperclipai/adapter-utils/execution-target";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import { discoverPiModelsCached } from "./models.js";
import { parsePiJsonl } from "./parse.js";
import { preparePiRuntimeConfig } from "./runtime-config.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

type RemoteExecutionTarget = Extract<AdapterExecutionTarget, { kind: "remote" }>;

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

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

type PiProviderProbeEnv = {
  env: Record<string, string>;
  agentConfigDir: string | null;
  cleanup: () => Promise<void>;
};

async function preparePiProviderProbeEnv(
  runtimeEnv: Record<string, string>,
  env: Record<string, string>,
): Promise<PiProviderProbeEnv> {
  const prepared = await preparePiRuntimeConfig({ env });
  return {
    env: prepared.agentConfigDir
      ? { ...runtimeEnv, PI_CODING_AGENT_DIR: prepared.agentConfigDir }
      : runtimeEnv,
    agentConfigDir: prepared.agentConfigDir,
    cleanup: prepared.cleanup,
  };
}

function normalizeEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function remoteCheckDirectory(target: RemoteExecutionTarget, runId: string): string {
  return path.posix.join(target.remoteCwd, ".paperclip-runtime", "runs", runId);
}

async function removeRemoteCheckDirectory(
  runId: string,
  target: RemoteExecutionTarget,
  directory: string,
): Promise<void> {
  const result = await runAdapterExecutionTargetShellCommand(
    runId,
    target,
    `rm -rf -- ${shellQuote(directory)}`,
    {
      cwd: target.remoteCwd,
      env: {},
      timeoutSec: 30,
      graceSec: 5,
      onLog: async () => {},
    },
  );
  if (result.timedOut) {
    throw new Error(`Timed out removing the remote check directory "${directory}".`);
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `Could not remove the remote check directory "${directory}" (exit ${result.exitCode ?? "none"})${detail ? `: ${detail}` : "."}`,
    );
  }
}

const PI_AUTH_REQUIRED_RE =
  /(?:auth(?:entication)?\s+required|api\s*key|invalid\s*api\s*key|not\s+logged\s+in|free\s+usage\s+exceeded)/i;
const PI_STALE_PACKAGE_RE = /pi-driver|npm:\s*pi-driver/i;

function buildPiModelDiscoveryFailureCheck(message: string): AdapterEnvironmentCheck {
  if (PI_STALE_PACKAGE_RE.test(message)) {
    return {
      code: "pi_package_install_failed",
      level: "warn",
      message: "Pi startup failed while installing configured package `npm:pi-driver`.",
      detail: message,
      hint: "Remove `npm:pi-driver` from ~/.pi/agent/settings.json or set adapter env HOME to a clean Pi profile, then retry `pi --list-models`.",
    };
  }

  return {
    code: "pi_models_discovery_failed",
    level: "warn",
    message,
    hint: "Run `pi --list-models` manually to verify provider auth and config.",
  };
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = parseObject(ctx.config);
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env }));
  let providerProbe: PiProviderProbeEnv;
  try {
    providerProbe = await preparePiProviderProbeEnv(runtimeEnv, env);
  } catch (err) {
    const checks: AdapterEnvironmentCheck[] = [
      {
        code: "pi_provider_config_failed",
        level: "error",
        message: "Pi provider configuration could not be prepared.",
        detail: err instanceof Error ? err.message : String(err),
        hint: "Check that the temporary directory is writable and that the provider configuration is valid.",
      },
    ];
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }
  try {
    return await runPiConfigurationChecks(ctx, { env, runtimeEnv, providerProbe });
  } finally {
    await providerProbe.cleanup();
  }
}

async function runPiConfigurationChecks(
  ctx: AdapterEnvironmentTestContext,
  prepared: {
    env: Record<string, string>;
    runtimeEnv: Record<string, string>;
    providerProbe: PiProviderProbeEnv;
  },
): Promise<AdapterEnvironmentTestResult> {
  const { env, runtimeEnv, providerProbe } = prepared;
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "pi");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `pi-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "pi_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: false,
    });
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

  const cwdInvalid = checks.some((check) => check.code === "pi_cwd_invalid");
  if (cwdInvalid) {
    checks.push({
      code: "pi_command_skipped",
      level: "warn",
      message: "Skipped command check because working directory validation failed.",
      detail: command,
    });
  } else {
    const installCheck = await maybeRunSandboxInstallCommand({
      runId,
      target,
      adapterKey: "pi",
      installCommand: SANDBOX_INSTALL_COMMAND,
    detectCommand: command,
      env,
    });
    if (installCheck) checks.push(installCheck);
    try {
      await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
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
  }

  const canRunProbe =
    checks.every((check) => check.code !== "pi_cwd_invalid" && check.code !== "pi_command_unresolvable");

  // Pi model discovery shells out to `pi --list-models` locally; when probing a
  // remote target we skip discovery and let the remote hello probe surface
  // model/auth issues directly.
  if (!targetIsRemote && canRunProbe) {
    try {
      const discovered = await discoverPiModelsCached({ command, cwd, env: providerProbe.env });
      if (discovered.length > 0) {
        checks.push({
          code: "pi_models_discovered",
          level: "info",
          message: `Discovered ${discovered.length} model(s) from Pi.`,
        });
      } else {
        checks.push({
          code: "pi_models_empty",
          level: "warn",
          message: "Pi returned no models.",
          hint: "Run `pi --list-models` and verify provider authentication.",
        });
      }
    } catch (err) {
      checks.push(
        buildPiModelDiscoveryFailureCheck(
          err instanceof Error ? err.message : "Pi model discovery failed.",
        ),
      );
    }
  }

  const configuredModel = asString(config.model, "").trim();
  if (!configuredModel) {
    checks.push({
      code: "pi_model_required",
      level: "error",
      message: "Pi requires a configured model in provider/model format.",
      hint: "Set adapterConfig.model using an ID from `pi --list-models`.",
    });
  } else if (targetIsRemote) {
    checks.push({
      code: "pi_model_validation_skipped_remote",
      level: "info",
      message: `Skipped local model validation; will be validated by the hello probe inside ${targetLabel}.`,
    });
  } else if (canRunProbe) {
    // Verify model is in the list
    try {
      const discovered = await discoverPiModelsCached({ command, cwd, env: providerProbe.env });
      const modelExists = discovered.some((m: { id: string }) => m.id === configuredModel);
      if (modelExists) {
        checks.push({
          code: "pi_model_configured",
          level: "info",
          message: `Configured model: ${configuredModel}`,
        });
      } else {
        checks.push({
          code: "pi_model_not_found",
          level: "warn",
          message: `Configured model "${configuredModel}" not found in available models.`,
          hint: "Run `pi --list-models` and choose a currently available provider/model ID.",
        });
      }
    } catch {
      // If we can't verify, just note it
      checks.push({
        code: "pi_model_configured",
        level: "info",
        message: `Configured model: ${configuredModel}`,
      });
    }
  }

  let probeEnv = providerProbe.env;
  let providerAvailable = true;
  let remoteCheckDir: string | null = null;
  if (canRunProbe && configuredModel && targetIsRemote && providerProbe.agentConfigDir) {
    remoteCheckDir = remoteCheckDirectory(target, runId);
    try {
      const remoteWorkspaceDir = path.posix.join(remoteCheckDir, "workspace");
      const preparedRemoteRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target,
        adapterKey: "pi",
        workspaceLocalDir: cwd,
        workspaceRemoteDir: remoteWorkspaceDir,
        syncWorkspace: false,
        assets: [
          {
            key: "agentConfig",
            localDir: providerProbe.agentConfigDir,
          },
        ],
      });
      const remoteAgentConfigDir = preparedRemoteRuntime.assetDirs.agentConfig;
      if (!remoteAgentConfigDir) {
        throw new Error("Pi provider configuration was not staged to the execution target.");
      }
      probeEnv = { ...probeEnv, PI_CODING_AGENT_DIR: remoteAgentConfigDir };
    } catch (err) {
      providerAvailable = false;
      checks.push({
        code: "pi_provider_config_not_staged",
        level: "error",
        message: "Pi provider configuration could not be staged to the execution target.",
        detail: err instanceof Error ? err.message : String(err),
        hint: "Pi on the execution target cannot read the provider configuration stored on the Paperclip host.",
      });
    }
  }

  try {
    if (canRunProbe && configuredModel && providerAvailable) {
      const provider = configuredModel.includes("/") 
        ? configuredModel.slice(0, configuredModel.indexOf("/")) 
        : "";
      const modelId = configuredModel.includes("/")
        ? configuredModel.slice(configuredModel.indexOf("/") + 1)
        : configuredModel;
      const thinking = asString(config.thinking, "").trim();
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = ["-p", "Respond with hello.", "--mode", "json"];
      if (provider) args.push("--provider", provider);
      if (modelId) args.push("--model", modelId);
      if (thinking) args.push("--thinking", thinking);
      args.push("--tools", "read");
      if (extraArgs.length > 0) args.push(...extraArgs);

      try {
        const probe = await runAdapterExecutionTargetProcess(
          runId,
          target,
          command,
          args,
          {
            cwd,
            env: probeEnv,
            timeoutSec: 60,
            graceSec: 5,
            onLog: async () => {},
          },
        );

        const parsed = parsePiJsonl(probe.stdout);
        const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errors[0] ?? null);
        const authEvidence = `${parsed.errors.join("\n")}\n${probe.stdout}\n${probe.stderr}`.trim();

        if (probe.timedOut) {
          checks.push({
            code: "pi_hello_probe_timed_out",
            level: "warn",
            message: "Pi hello probe timed out.",
            hint: "Retry the probe. If this persists, run Pi manually in this working directory.",
          });
        } else if ((probe.exitCode ?? 1) === 0 && parsed.errors.length === 0) {
          const summary = (parsed.finalMessage || parsed.messages.join(" ")).trim();
          const hasHello = /\bhello\b/i.test(summary);
          checks.push({
            code: hasHello ? "pi_hello_probe_passed" : "pi_hello_probe_unexpected_output",
            level: hasHello ? "info" : "warn",
            message: hasHello
              ? "Pi hello probe succeeded."
              : "Pi probe ran but did not return `hello` as expected.",
            ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
            ...(hasHello
              ? {}
              : {
                  hint: "Run `pi --mode json` manually and prompt `Respond with hello` to inspect output.",
                }),
          });
        } else if (PI_AUTH_REQUIRED_RE.test(authEvidence)) {
          checks.push({
            code: "pi_hello_probe_auth_required",
            level: "warn",
            message: "Pi is installed, but provider authentication is not ready.",
            ...(detail ? { detail } : {}),
            hint: "Set provider API key environment variable (e.g., ANTHROPIC_API_KEY, XAI_API_KEY) and retry.",
          });
        } else {
          checks.push({
            code: "pi_hello_probe_failed",
            level: "error",
            message: "Pi hello probe failed.",
            ...(detail ? { detail } : {}),
            hint: "Run `pi --mode json` manually in this working directory to debug.",
          });
        }
      } catch (err) {
        checks.push({
          code: "pi_hello_probe_failed",
          level: "error",
          message: "Pi hello probe failed.",
          detail: err instanceof Error ? err.message : String(err),
          hint: "Run `pi --mode json` manually in this working directory to debug.",
        });
      }
    }
  } finally {
    if (remoteCheckDir && target && target.kind === "remote") {
      try {
        await removeRemoteCheckDirectory(runId, target, remoteCheckDir);
      } catch (err) {
        checks.push({
          code: "pi_provider_config_cleanup_failed",
          level: "warn",
          message: "The staged Pi provider configuration could not be removed from the execution target.",
          detail: err instanceof Error ? err.message : String(err),
          hint: "Remove the leftover directory manually when the execution target is a persistent host.",
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
