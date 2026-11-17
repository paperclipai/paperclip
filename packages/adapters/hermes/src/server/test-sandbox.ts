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
  HERMES_SANDBOX_SSH_UNSUPPORTED_MESSAGE,
  HERMES_SANDBOX_UNTRUSTED_COMMAND_MESSAGE,
} from "./execute-sandbox.js";
import { HERMES_EXPLICIT_CREDENTIAL_REQUIRED_MESSAGE, hasExplicitHermesProviderCredential } from "./isolation.js";
import { resolveHermesMemoryProvider } from "./memory-config.js";
import { normalizeConfiguredModel } from "./model-arg.js";
import { ROUTER_REMOTE_TARGET_UNSUPPORTED_MESSAGE } from "./router-readiness.js";

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
  // Ramp Router readiness is not verified on remote targets yet; refused before anything launches.
  if (effective.isRouter) {
    return result([{ level: "error", code: "hermes_router_remote_unsupported", message: ROUTER_REMOTE_TARGET_UNSUPPORTED_MESSAGE }]);
  }
  const target = readAdapterExecutionTarget({ executionTarget: ctx.executionTarget });
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
  return result(checks);
}
