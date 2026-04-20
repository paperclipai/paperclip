import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_COPILOT_LOCAL_MODEL } from "../index.js";
import { createCopilotClient, approveAll } from "./sdk-client.js";
import {
  buildCopilotClientBootstrap,
  isCopilotAuthRequiredMessage,
  normalizeCopilotDiscoveredModels,
  normalizeEnvConfig,
  normalizeRuntimeEnv,
  resolveCopilotModelSelection,
} from "./runtime.js";
import { sendPromptAndWaitForIdle } from "./session.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function resolveGithubToken(env: Record<string, string>): string | null {
  const token = (env.COPILOT_GITHUB_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "").trim();
  return token.length > 0 ? token : null;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: false });
    checks.push({
      code: "copilot_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "copilot_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const runtimeEnv = normalizeRuntimeEnv(
    ensurePathInEnv({ ...process.env, ...normalizeEnvConfig(config.env) }),
  );
  const githubToken = resolveGithubToken(runtimeEnv);
  if (githubToken) {
    checks.push({
      code: "copilot_auth_env_present",
      level: "info",
      message: "COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN is set in the runtime environment.",
    });
  } else {
    checks.push({
      code: "copilot_auth_env_missing",
      level: "warn",
      message: "No explicit Copilot GitHub token was found in the runtime environment.",
      hint:
        "The Copilot SDK can still use stored user auth, but set COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN when you need explicit token auth.",
    });
  }

  const cwdInvalid = checks.some((check) => check.code === "copilot_cwd_invalid");
  let bootstrap:
    | Awaited<ReturnType<typeof buildCopilotClientBootstrap>>
    | null = null;
  if (!cwdInvalid) {
    try {
      bootstrap = await buildCopilotClientBootstrap({
        command: config.command,
        args: config.args,
        extraArgs: config.extraArgs,
        cwd,
        runtimeEnv,
      });
      checks.push({
        code: bootstrap.resolvedCommand ? "copilot_command_resolvable" : "copilot_command_bundled",
        level: "info",
        message: bootstrap.resolvedCommand
          ? `Using custom Copilot CLI command: ${bootstrap.resolvedCommand}`
          : "Using the bundled Copilot CLI from @github/copilot-sdk.",
      });
    } catch (err) {
      checks.push({
        code: "copilot_command_unresolvable",
        level: "error",
        message: err instanceof Error ? err.message : "Command is not executable",
        detail: asString(config.command, ""),
      });
    }
  }

  if (!bootstrap) {
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  const client = await createCopilotClient({
    ...bootstrap.clientOptions,
    ...(githubToken ? { githubToken, useLoggedInUser: false } : { useLoggedInUser: true }),
  });

  try {
    await client.start();

    try {
      const status = await client.getStatus();
      checks.push({
        code: "copilot_sdk_started",
        level: "info",
        message: `Copilot SDK connected (CLI ${status.version}, protocol ${status.protocolVersion}).`,
      });
    } catch (err) {
      checks.push({
        code: "copilot_sdk_status_failed",
        level: "warn",
        message: "Copilot SDK connected, but status.get failed.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    let authReady = false;
    try {
      const authStatus = await client.getAuthStatus();
      authReady = authStatus.isAuthenticated;
      checks.push(
        authStatus.isAuthenticated
          ? {
              code: "copilot_sdk_auth_ready",
              level: "info",
              message:
                authStatus.login && authStatus.authType
                  ? `Copilot authentication is ready (${authStatus.login} via ${authStatus.authType}).`
                  : "Copilot authentication is ready.",
              ...(authStatus.statusMessage ? { detail: authStatus.statusMessage } : {}),
            }
          : {
              code: "copilot_sdk_auth_required",
              level: "warn",
              message: "Copilot SDK connected, but authentication is not ready.",
              ...(authStatus.statusMessage ? { detail: authStatus.statusMessage } : {}),
              hint:
                "Sign in to GitHub Copilot or set COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN, then rerun the environment test.",
            },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      checks.push({
        code: "copilot_sdk_auth_status_failed",
        level: isCopilotAuthRequiredMessage(message) ? "warn" : "error",
        message: isCopilotAuthRequiredMessage(message)
          ? "Copilot SDK is reachable, but authentication is not ready."
          : "Copilot SDK auth.getStatus probe failed.",
        detail: message,
      });
    }

    let discoveredModels: ReturnType<typeof normalizeCopilotDiscoveredModels> = [];
    try {
      discoveredModels = normalizeCopilotDiscoveredModels(await client.listModels());
      if (discoveredModels.length > 0) {
        checks.push({
          code: "copilot_models_listed",
          level: "info",
          message: `Discovered ${discoveredModels.length} Copilot model${discoveredModels.length === 1 ? "" : "s"} through the SDK.`,
        });
      } else {
        checks.push({
          code: "copilot_models_empty",
          level: "warn",
          message: "Copilot SDK returned an empty model list.",
        });
      }
    } catch (err) {
      checks.push({
        code: "copilot_models_list_failed",
        level: "warn",
        message: "Connected to the Copilot SDK, but model discovery failed.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const selection = discoveredModels.length > 0
      ? resolveCopilotModelSelection(asString(config.model, "").trim(), discoveredModels)
      : null;
    if (selection?.errorMessage) {
      checks.push({
        code: "copilot_model_unavailable",
        level: "warn",
        message: selection.errorMessage,
      });
    } else if (selection?.warningMessage) {
      checks.push({
        code: "copilot_default_model_unavailable",
        level: "warn",
        message: selection.warningMessage,
      });
    } else if (selection?.effectiveModel) {
      checks.push({
        code: "copilot_model_available",
        level: "info",
        message: `Configured Copilot model is available: ${selection.effectiveModel}`,
      });
    }

    if (authReady) {
      const probeModel = selection?.effectiveModel ?? DEFAULT_COPILOT_LOCAL_MODEL;
      const session = await client.createSession({
        ...(probeModel ? { model: probeModel } : {}),
        onPermissionRequest: approveAll,
        workingDirectory: cwd,
      });
      try {
        const response = await sendPromptAndWaitForIdle(
          session,
          "Reply with the single word: hello",
          60_000,
        );
        const summary =
          response && response.data && typeof response.data.content === "string"
            ? response.data.content.trim()
            : "";
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "copilot_sdk_send_probe_passed" : "copilot_sdk_send_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Copilot SDK send probe succeeded."
            : "Copilot SDK send probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
        });
      } finally {
        await session.disconnect().catch(() => {});
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    checks.push({
      code: isCopilotAuthRequiredMessage(message) ? "copilot_sdk_auth_required" : "copilot_sdk_probe_failed",
      level: isCopilotAuthRequiredMessage(message) ? "warn" : "error",
      message: isCopilotAuthRequiredMessage(message)
        ? "Copilot SDK is reachable, but authentication is not ready."
        : "Copilot SDK environment probe failed.",
      detail: message,
      hint: isCopilotAuthRequiredMessage(message)
        ? "Sign in to GitHub Copilot or set COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN, then rerun the environment test."
        : "If you configured a custom command override, verify it points to a compatible Copilot CLI binary.",
    });
  } finally {
    await client.stop().catch(() => []);
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
