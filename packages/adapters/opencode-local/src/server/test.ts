import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asStringArray,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { discoverOpenCodeModels, ensureOpenCodeModelConfiguredAndAvailable } from "./models.js";
import { parseOpenCodeJsonl } from "./parse.js";

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
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: false });
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
  const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env }));

  const cwdInvalid = checks.some((check) => check.code === "opencode_cwd_invalid");
  if (cwdInvalid) {
    checks.push({
      code: "opencode_command_skipped",
      level: "warn",
      message: "Skipped command check because working directory validation failed.",
      detail: command,
    });
  } else {
    try {
      await ensureCommandResolvable(command, cwd, runtimeEnv);
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

  if (canRunProbe && configuredModel) {
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
  } else if (canRunProbe && !configuredModel) {
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
  } else if (configuredModel && canRunProbe) {
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
      const probe = await runChildProcess(
        `opencode-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        args,
        {
          cwd,
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

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
