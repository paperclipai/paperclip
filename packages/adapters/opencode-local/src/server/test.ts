import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  asBoolean,
  asString,
  asStringArray,
  parseObject,
  ensurePathInEnv,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  ensureAdapterExecutionTargetDirectory,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  prepareAdapterExecutionTargetRuntime,
  overrideAdapterExecutionTargetRemoteCwd,
} from "@paperclipai/adapter-utils/execution-target";
import { discoverOpenCodeModels, ensureOpenCodeModelConfiguredAndAvailable } from "./models.js";
import { parseOpenCodeJsonl } from "./parse.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";

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

function normalizeEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

const OPENCODE_AUTH_REQUIRED_RE =
  /(?:auth(?:entication)?\s+required|api\s*key|invalid\s*api\s*key|not\s+logged\s+in|opencode\s+auth\s+login|free\s+usage\s+exceeded)/i;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "opencode");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `opencode-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "opencode_environment_target",
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
      code: "opencode_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "opencode_cwd_invalid",
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

  const openaiKeyOverride = "OPENAI_API_KEY" in envConfig ? asString(envConfig.OPENAI_API_KEY, "") : null;
  if (openaiKeyOverride !== null && openaiKeyOverride.trim() === "") {
    checks.push({
      code: "opencode_openai_api_key_missing",
      level: "warn",
      message: "OPENAI_API_KEY override is empty.",
      hint: "The OPENAI_API_KEY override is empty. Set a valid key or remove the override.",
    });
  }

  // Prevent OpenCode from writing an opencode.json into the working directory.
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
  const preparedRuntimeConfig = await prepareOpenCodeRuntimeConfig({ env, config });
  const localRuntimeConfigHome =
    preparedRuntimeConfig.notes.length > 0 ? preparedRuntimeConfig.env.XDG_CONFIG_HOME : "";
  if (asBoolean(config.dangerouslySkipPermissions, true)) {
    checks.push({
      code: "opencode_headless_permissions_enabled",
      level: "info",
      message: "Headless OpenCode external-directory permissions are auto-approved for unattended runs.",
    });
  }
  let restoreWorkspace: (() => Promise<void>) | null = null;
  // Declared outside `try` so a failure inside `prepareAdapterExecutionTargetRuntime`
  // still has the path available for cleanup in `finally` — otherwise the
  // `fs.mkdtemp` directory leaks on the early-throw path.
  let preparedRuntimeWorkspaceLocalDir: string | null = null;
  try {
    let runtimeTarget: AdapterExecutionTarget | null = target ?? null;
    let runtimeCwd = cwd;
    if (targetIsRemote) {
      preparedRuntimeWorkspaceLocalDir = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-opencode-envtest-${runId}-`));
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target,
        adapterKey: "opencode",
        workspaceLocalDir: preparedRuntimeWorkspaceLocalDir,
        workspaceRemoteDir: cwd,
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        assets: localRuntimeConfigHome
          ? [{
            key: "xdgConfig",
            localDir: localRuntimeConfigHome,
          }]
          : [],
      });
      restoreWorkspace = async () => {
        await preparedExecutionTargetRuntime.restoreWorkspace().catch(() => {});
        if (preparedRuntimeWorkspaceLocalDir) {
          await fs.rm(preparedRuntimeWorkspaceLocalDir, { recursive: true, force: true }).catch(() => {});
        }
      };
      runtimeCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? runtimeCwd;
      runtimeTarget = overrideAdapterExecutionTargetRemoteCwd(target ?? null, runtimeCwd) ?? null;
      if (localRuntimeConfigHome && preparedExecutionTargetRuntime.assetDirs.xdgConfig) {
        preparedRuntimeConfig.env.XDG_CONFIG_HOME = preparedExecutionTargetRuntime.assetDirs.xdgConfig;
      }
    }
    const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...preparedRuntimeConfig.env }));

    const cwdInvalid = checks.some((check) => check.code === "opencode_cwd_invalid");
    if (cwdInvalid) {
      checks.push({
        code: "opencode_command_skipped",
        level: "warn",
        message: "Skipped command check because working directory validation failed.",
        detail: command,
      });
    } else {
      const installCheck = await maybeRunSandboxInstallCommand({
        runId,
        target,
        adapterKey: "opencode",
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        env,
      });
      if (installCheck) checks.push(installCheck);
      try {
        await ensureAdapterExecutionTargetCommandResolvable(command, runtimeTarget, runtimeCwd, runtimeEnv);
        checks.push({
          code: "opencode_command_resolvable",
          level: "info",
          message: `Command is executable: ${command}`,
        });
      } catch (err) {
        checks.push({
          code: "opencode_command_unresolvable",
          level: "error",
          message: err instanceof Error ? err.message : "Command is not executable",
          detail: command,
        });
      }
    }

    const canRunProbe =
      checks.every((check) => check.code !== "opencode_cwd_invalid" && check.code !== "opencode_command_unresolvable");

    let modelValidationPassed = false;
    const configuredModel = asString(config.model, "").trim();

    // Model discovery and validation use local child processes against
    // OpenCode's `models` subcommand and JSON config; these are not yet
    // wired through the execution target. When probing a remote env, skip
    // discovery/validation and rely on the remote hello probe to surface
    // model/auth issues directly.
    if (targetIsRemote && configuredModel) {
      checks.push({
        code: "opencode_model_validation_skipped_remote",
        level: "info",
        message: `Skipped local model validation; will be validated by the hello probe inside ${targetLabel}.`,
      });
      modelValidationPassed = true;
    } else if (canRunProbe && configuredModel) {
      try {
        const discovered = await discoverOpenCodeModels({ command, cwd, env: runtimeEnv });
        if (discovered.length > 0) {
          checks.push({
            code: "opencode_models_discovered",
            level: "info",
            message: `Discovered ${discovered.length} model(s) from OpenCode providers.`,
          });
        } else {
          checks.push({
            code: "opencode_models_empty",
            level: "error",
            message: "OpenCode returned no models.",
            hint: "Run `opencode models` and verify provider authentication.",
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (/ProviderModelNotFoundError/i.test(errMsg)) {
          checks.push({
            code: "opencode_hello_probe_model_unavailable",
            level: "warn",
            message: "The configured model was not found by the provider.",
            detail: errMsg,
            hint: "Run `opencode models` and choose an available provider/model ID.",
          });
        } else {
          checks.push({
            code: "opencode_models_discovery_failed",
            level: "error",
            message: errMsg || "OpenCode model discovery failed.",
            hint: "Run `opencode models` manually to verify provider auth and config.",
          });
        }
      }
    } else if (!targetIsRemote && canRunProbe && !configuredModel) {
      try {
        const discovered = await discoverOpenCodeModels({ command, cwd, env: runtimeEnv });
        if (discovered.length > 0) {
          checks.push({
            code: "opencode_models_discovered",
            level: "info",
            message: `Discovered ${discovered.length} model(s) from OpenCode providers.`,
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (/ProviderModelNotFoundError/i.test(errMsg)) {
          checks.push({
            code: "opencode_hello_probe_model_unavailable",
            level: "warn",
            message: "The configured model was not found by the provider.",
            detail: errMsg,
            hint: "Run `opencode models` and choose an available provider/model ID.",
          });
        } else {
          checks.push({
            code: "opencode_models_discovery_failed",
            level: "warn",
            message: errMsg || "OpenCode model discovery failed (best-effort, no model configured).",
            hint: "Run `opencode models` manually to verify provider auth and config.",
          });
        }
      }
    }

    const modelUnavailable = checks.some((check) => check.code === "opencode_hello_probe_model_unavailable");
    if (!configuredModel && !modelUnavailable) {
      // No model configured – skip model requirement if no model-related checks exist
    } else if (!targetIsRemote && configuredModel && canRunProbe) {
      try {
        await ensureOpenCodeModelConfiguredAndAvailable({
          model: configuredModel,
          command,
          cwd,
          env: runtimeEnv,
        });
        checks.push({
          code: "opencode_model_configured",
          level: "info",
          message: `Configured model: ${configuredModel}`,
        });
        modelValidationPassed = true;
      } catch (err) {
        checks.push({
          code: "opencode_model_invalid",
          level: "error",
          message: err instanceof Error ? err.message : "Configured model is unavailable.",
          hint: "Run `opencode models` and choose a currently available provider/model ID.",
        });
      }
    }

    if (canRunProbe && modelValidationPassed) {
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();
      const variant = asString(config.variant, "").trim();
      const probeModel = configuredModel;

      const args = ["run", "--format", "json"];
      args.push("--model", probeModel);
      if (variant) args.push("--variant", variant);
      if (extraArgs.length > 0) args.push(...extraArgs);

      try {
        const probe = await runAdapterExecutionTargetProcess(
          runId,
          runtimeTarget,
          command,
          args,
          {
            cwd: runtimeCwd,
            env: runtimeEnv,
            timeoutSec: 60,
            graceSec: 5,
            stdin: "Respond with hello.",
            onLog: async () => {},
          },
        );

        const parsed = parseOpenCodeJsonl(probe.stdout);
        const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
        const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

        if (probe.timedOut) {
          checks.push({
            code: "opencode_hello_probe_timed_out",
            level: "warn",
            message: "OpenCode hello probe timed out.",
            hint: "Retry the probe. If this persists, run OpenCode manually in this working directory.",
          });
        } else if ((probe.exitCode ?? 1) === 0 && !parsed.errorMessage) {
          const summary = parsed.summary.trim();
          const hasHello = /\bhello\b/i.test(summary);
          checks.push({
            code: hasHello ? "opencode_hello_probe_passed" : "opencode_hello_probe_unexpected_output",
            level: hasHello ? "info" : "warn",
            message: hasHello
              ? "OpenCode hello probe succeeded."
              : "OpenCode probe ran but did not return `hello` as expected.",
            ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
            ...(hasHello
              ? {}
              : {
                  hint: "Run `opencode run --format json` manually and prompt `Respond with hello` to inspect output.",
                }),
          });
        } else if (/ProviderModelNotFoundError/i.test(authEvidence)) {
          checks.push({
            code: "opencode_hello_probe_model_unavailable",
            level: "warn",
            message: "The configured model was not found by the provider.",
            ...(detail ? { detail } : {}),
            hint: "Run `opencode models` and choose an available provider/model ID.",
          });
        } else if (OPENCODE_AUTH_REQUIRED_RE.test(authEvidence)) {
          checks.push({
            code: "opencode_hello_probe_auth_required",
            level: "warn",
            message: "OpenCode is installed, but provider authentication is not ready.",
            ...(detail ? { detail } : {}),
            hint: "Run `opencode auth login` or set provider credentials, then retry the probe.",
          });
        } else {
          checks.push({
            code: "opencode_hello_probe_failed",
            level: "error",
            message: "OpenCode hello probe failed.",
            ...(detail ? { detail } : {}),
            hint: "Run `opencode run --format json` manually in this working directory to debug.",
          });
        }
      } catch (err) {
        checks.push({
          code: "opencode_hello_probe_failed",
          level: "error",
          message: "OpenCode hello probe failed.",
          detail: err instanceof Error ? err.message : String(err),
          hint: "Run `opencode run --format json` manually in this working directory to debug.",
        });
      }
    }
  } finally {
    await restoreWorkspace?.();
    if (!restoreWorkspace && preparedRuntimeWorkspaceLocalDir) {
      // Reached when `prepareAdapterExecutionTargetRuntime` threw before
      // assigning `restoreWorkspace`: clean up the temp dir directly.
      await fs.rm(preparedRuntimeWorkspaceLocalDir, { recursive: true, force: true }).catch(() => {});
    }
    await preparedRuntimeConfig.cleanup();
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
