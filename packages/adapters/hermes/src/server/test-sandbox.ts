/**
 * TECH-8174: environment test for Hermes on a remote target. Mirrors the sandbox run path
 * (execute-sandbox.ts): every probe runs inside the target, and nothing on this host (its Hermes
 * install, ~/.hermes, python3, or the server env) counts as evidence.
 */

import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import path from "node:path";

import {
  readAdapterExecutionTarget,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";

import { ADAPTER_TYPE } from "../shared/constants.js";
import { CANONICAL_HERMES_BIN, TRUSTED_HERMES_LAUNCHERS, type HermesCommandScanMode } from "./command-scan-policy.js";
import { resolveEffectiveRunConfig } from "./detect-model.js";
import { resolveHermesCommand } from "./execute.js";
import {
  HERMES_SANDBOX_COMMAND_SCAN_UNSUPPORTED_MESSAGE,
  HERMES_SANDBOX_MEMORY_PROVIDER_UNSUPPORTED_MESSAGE,
  HERMES_SANDBOX_PROVIDERS,
  HERMES_SANDBOX_PROVIDER_UNSUPPORTED_MESSAGE,
  HERMES_SANDBOX_ROUTER_KEY_UNREDACTABLE_MESSAGE,
  HERMES_SANDBOX_SSH_UNSUPPORTED_MESSAGE,
  HERMES_SANDBOX_UNTRUSTED_COMMAND_MESSAGE,
} from "./execute-sandbox.js";
import { HERMES_EXPLICIT_CREDENTIAL_REQUIRED_MESSAGE, hasExplicitHermesProviderCredential } from "./isolation.js";
import { resolveHermesMemoryProvider } from "./memory-config.js";
import { normalizeConfiguredModel } from "./model-arg.js";
import {
  ROUTER_EXTRA_ARGS_UNSUPPORTED_MESSAGE,
  ROUTER_KEY_MISSING_MESSAGE,
  RAMP_ROUTER_API_KEY_ENV,
  ROUTER_REMOTE_TARGET_UNSUPPORTED_MESSAGE,
  readRouterApiKey,
} from "./router-readiness.js";
import { MAX_CONFIG_STRING_LENGTH, canSafelyRedactSecret } from "./memory-config.js";
import { probeHermesRouterSupportInTarget } from "./router-readiness-remote.js";

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function result(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult {
  const hasErrors = checks.some((c) => c.level === "error");
  const hasWarnings = checks.some((c) => c.level === "warn");
  return {
    adapterType: ADAPTER_TYPE,
    status: hasErrors ? "fail" : hasWarnings ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}

export async function testRemoteEnvironment(
  ctx: AdapterEnvironmentTestContext,
  config: Record<string, unknown>,
  scanMode: HermesCommandScanMode,
): Promise<AdapterEnvironmentTestResult> {
  const configuredModel = normalizeConfiguredModel(asString(config.model));
  const effective = resolveEffectiveRunConfig({
    explicitProvider: asString(config.provider),
    configuredModel,
    detected: null,
  });
  // Managed connections still need a local hello probe, as before this stage; the sandbox run
  // refuses them too (managedAiRouting or managedAiConnection).
  if (config.managedAiRouting || config.managedAiConnection) {
    return result([{ level: "error", code: "hermes_remote_probe_unsupported", message: "Hermes connection testing requires a local execution environment." }]);
  }
  const target = readAdapterExecutionTarget({ executionTarget: ctx.executionTarget });
  const isSandbox = target?.kind === "remote" && target.transport === "sandbox";
  // Ramp Router readiness is verified inside sandbox targets only; any other remote target is
  // refused before anything launches.
  if (effective.isRouter && !isSandbox) {
    return result([{ level: "error", code: "hermes_router_remote_unsupported", message: ROUTER_REMOTE_TARGET_UNSUPPORTED_MESSAGE }]);
  }
  if (!target || target.kind !== "remote" || target.transport !== "sandbox") {
    return result([{ level: "error", code: "hermes_ssh_unsupported", message: HERMES_SANDBOX_SSH_UNSUPPORTED_MESSAGE }]);
  }
  if (!HERMES_SANDBOX_PROVIDERS.includes(target.providerKey ?? "")) {
    return result([{ level: "error", code: "hermes_sandbox_provider_unsupported", message: HERMES_SANDBOX_PROVIDER_UNSUPPORTED_MESSAGE }]);
  }
  if (scanMode === "required") {
    return result([{ level: "error", code: "hermes_command_scan_sandbox_unsupported", message: HERMES_SANDBOX_COMMAND_SCAN_UNSUPPORTED_MESSAGE }]);
  }
  const checks: AdapterEnvironmentCheck[] = [
    {
      level: "info",
      code: "hermes_environment_target",
      message: `Probing inside environment: ${ctx.environmentName ?? describeAdapterExecutionTarget(target)}`,
    },
  ];

  let memoryProvider: string | undefined;
  try {
    memoryProvider = resolveHermesMemoryProvider(config);
  } catch (err) {
    checks.push({ level: "error", code: "hermes_memory_provider_invalid", message: err instanceof Error ? err.message : String(err) });
  }
  if (memoryProvider) {
    checks.push({ level: "error", code: "hermes_memory_sandbox_unsupported", message: HERMES_SANDBOX_MEMORY_PROVIDER_UNSUPPORTED_MESSAGE });
  }
  const configEnv = (config.env && typeof config.env === "object" ? config.env : {}) as Record<string, unknown>;
  if (effective.isRouter) {
    // The run's Router gates: no extraArgs, and the agent's own RAMP_ROUTER_API_KEY binding only.
    if (Array.isArray(config.extraArgs) && config.extraArgs.length > 0) {
      checks.push({ level: "error", code: "hermes_router_extra_args", message: ROUTER_EXTRA_ARGS_UNSUPPORTED_MESSAGE });
    }
    const rawKey = configEnv[RAMP_ROUTER_API_KEY_ENV];
    const redactable = (value: string) => value.length <= MAX_CONFIG_STRING_LENGTH && canSafelyRedactSecret(value);
    checks.push(
      !readRouterApiKey(configEnv) || typeof rawKey !== "string"
        ? { level: "error", code: "hermes_router_key_missing", message: ROUTER_KEY_MISSING_MESSAGE }
        : !redactable(rawKey) || !redactable(rawKey.trim())
        // The run refuses a key it cannot redact from output; report it here too.
        ? { level: "error", code: "hermes_router_key_unredactable", message: HERMES_SANDBOX_ROUTER_KEY_UNREDACTABLE_MESSAGE }
        : { level: "info", code: "hermes_router_key_found", message: "Ramp Router API key found (RAMP_ROUTER_API_KEY)" },
    );
  }
  checks.push(
    hasExplicitHermesProviderCredential(configEnv)
      ? { level: "info", code: "hermes_api_keys_found", message: "Provider credential found in the agent's env" }
      : { level: "error", code: "hermes_explicit_credential_required", message: HERMES_EXPLICIT_CREDENTIAL_REQUIRED_MESSAGE },
  );
  if (!effective.ok) {
    checks.push({ level: "error", code: "hermes_model_required", message: effective.message });
  } else if (effective.modelArg) {
    checks.push({ level: "info", code: "hermes_model_configured", message: `Model: ${effective.modelArg}` });
  } else {
    checks.push({
      level: "warn",
      code: "hermes_no_default_model",
      message: "No model specified; in a sandbox Hermes has no host config to supply a default.",
      hint: "Set a model and provider on the agent.",
    });
  }

  if (!TRUSTED_HERMES_LAUNCHERS.has(resolveHermesCommand(config).trim())) {
    checks.push({ level: "error", code: "hermes_untrusted_launcher", message: HERMES_SANDBOX_UNTRUSTED_COMMAND_MESSAGE });
    return result(checks);
  }

  // Installed and runnable inside the target (the image's Hermes), not on this host.
  const runId = `hermes-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await ensureAdapterExecutionTargetCommandResolvable(CANONICAL_HERMES_BIN, target, target.remoteCwd, {});
  } catch (err) {
    checks.push({
      level: "error",
      code: "hermes_cli_not_found",
      message: err instanceof Error ? err.message : `Hermes CLI "${CANONICAL_HERMES_BIN}" not found in the environment`,
    });
    return result(checks);
  }
  try {
    const probe = await runAdapterExecutionTargetProcess(runId, target, CANONICAL_HERMES_BIN, ["--version"], {
      cwd: target.remoteCwd,
      env: {},
      timeoutSec: 30,
      graceSec: 5,
      onLog: async () => {},
    });
    const version = probe.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
    if (!probe.timedOut && probe.exitCode === 0 && version) {
      checks.push({ level: "info", code: "hermes_version", message: `Hermes Agent version: ${version}` });
    } else {
      checks.push({
        level: "error",
        code: "hermes_version_failed",
        message: probe.timedOut
          ? "hermes --version timed out inside the environment"
          : `hermes --version failed inside the environment (exit ${probe.exitCode ?? "none"})`,
      });
    }
  } catch (err) {
    checks.push({
      level: "error",
      code: "hermes_version_failed",
      message: `hermes --version failed inside the environment: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  if (effective.isRouter) {
    // Registry probe inside the target against the image's Hermes (never this host's).
    const capability = await probeHermesRouterSupportInTarget({
      runId,
      target,
      cwd: target.remoteCwd,
      probeDir: path.posix.join(target.remoteCwd, ".paperclip-runtime", "hermes", "envtests", runId, "router-probe"),
    });
    checks.push(
      capability.supported
        ? { level: "info", code: "hermes_router_supported", message: `Hermes at "${CANONICAL_HERMES_BIN}" in the environment provides the native Ramp Router provider` }
        : { level: "error", code: `hermes_router_${capability.reason}`, message: capability.message },
    );
  }
  return result(checks);
}
