import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asBoolean,
  asString,
  asStringArray,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { discoverOpenHandsModels, ensureOpenHandsModelConfiguredAndAvailable } from "./models.js";
import { parseOpenHandsJsonl } from "./parse.js";
import { prepareOpenHandsRuntimeConfig } from "./runtime-config.js";

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

const OPENHANDS_AUTH_REQUIRED_RE =
  /(?:auth(?:entication)?\s+required|api\s*key|invalid\s*api\s*key|not\s+logged\s+in|openhands\s+auth|free\s+usage\s+exceeded)/i;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "openhands");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: false });
    checks.push({
      code: "openhands_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "openhands_cwd_invalid",
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

  // Check for API key configuration
  const llmApiKey = asString(envConfig.LLM_API_KEY ?? envConfig.OPENAI_API_KEY, "");
  const llmBaseUrl = asString(envConfig.LLM_BASE_URL ?? envConfig.OPENAI_API_BASE, "");
  
  if (!llmApiKey) {
    checks.push({
      code: "openhands_api_key_missing",
      level: "warn",
      message: "No LLM_API_KEY or OPENAI_API_KEY configured.",
      hint: "Set LLM_API_KEY (or OPENAI_API_KEY) in the agent environment variables.",
    });
  }
  
  if (!llmBaseUrl) {
    checks.push({
      code: "openhands_api_base_missing",
      level: "warn",
      message: "No LLM_BASE_URL or OPENAI_API_BASE configured.",
      hint: "Set LLM_BASE_URL (or OPENAI_API_BASE) in the agent environment variables.",
    });
  }

  const preparedRuntimeConfig = await prepareOpenHandsRuntimeConfig({ env, config });
  checks.push({
    code: "openhands_headless_mode",
    level: "info",
    message: "OpenHands will run in headless mode with --override-with-envs.",
  });
  
  try {
    const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...preparedRuntimeConfig.env }));

    const cwdInvalid = checks.some((check) => check.code === "openhands_cwd_invalid");
    if (cwdInvalid) {
      checks.push({
        code: "openhands_command_skipped",
        level: "warn",
        message: "Skipped command check because working directory validation failed.",
        detail: command,
      });
    } else {
      try {
        await ensureCommandResolvable(command, cwd, runtimeEnv);
        checks.push({
          code: "openhands_command_resolvable",
          level: "info",
          message: `Command is executable: ${command}`,
        });
      } catch (err) {
        checks.push({
          code: "openhands_command_unresolvable",
          level: "error",
          message: err instanceof Error ? err.message : "Command is not executable",
          detail: command,
        });
      }
    }

    const canRunProbe =
      checks.every((check) => check.code !== "openhands_cwd_invalid" && check.code !== "openhands_command_unresolvable");

    let modelValidationPassed = false;
    const configuredModel = asString(config.model, "").trim();

    if (canRunProbe && configuredModel) {
      try {
        const discovered = await discoverOpenHandsModels({ command, cwd, env: runtimeEnv });
        if (discovered.length > 0) {
          checks.push({
            code: "openhands_models_discovered",
            level: "info",
            message: `Discovered ${discovered.length} model(s) from OpenHands providers.`,
          });
        } else {
          checks.push({
            code: "openhands_models_empty",
            level: "error",
            message: "OpenHands returned no models.",
            hint: "Run `openhands models` and verify provider authentication.",
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        checks.push({
          code: "openhands_models_discovery_failed",
          level: "error",
          message: errMsg || "OpenHands model discovery failed.",
          hint: "Run `openhands models` manually to verify provider auth and config.",
        });
      }
    } else if (canRunProbe && !configuredModel) {
      try {
        const discovered = await discoverOpenHandsModels({ command, cwd, env: runtimeEnv });
        if (discovered.length > 0) {
          checks.push({
            code: "openhands_models_discovered",
            level: "info",
            message: `Discovered ${discovered.length} model(s) from OpenHands providers.`,
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        checks.push({
          code: "openhands_models_discovery_failed",
          level: "warn",
          message: errMsg || "OpenHands model discovery failed (best-effort, no model configured).",
          hint: "Run `openhands models` manually to verify provider auth and config.",
        });
      }
    }

    const modelUnavailable = checks.some((check) => check.code === "openhands_hello_probe_model_unavailable");
    if (!configuredModel && !modelUnavailable) {
      // No model configured – skip model requirement if no model-related checks exist
    } else if (configuredModel && canRunProbe) {
      try {
        await ensureOpenHandsModelConfiguredAndAvailable({
          model: configuredModel,
          command,
          cwd,
          env: runtimeEnv,
        });
        checks.push({
          code: "openhands_model_configured",
          level: "info",
          message: `Configured model: ${configuredModel}`,
        });
        modelValidationPassed = true;
      } catch (err) {
        checks.push({
          code: "openhands_model_invalid",
          level: "error",
          message: err instanceof Error ? err.message : "Configured model is unavailable.",
          hint: "Run `openhands models` and choose a currently available provider/model ID.",
        });
      }
    }

    if (canRunProbe && modelValidationPassed) {
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();
      const probeModel = configuredModel;

      const args = ["--headless", "--override-with-envs", "-t", "Respond with hello."];
      if (extraArgs.length > 0) args.push(...extraArgs);

      try {
        const probe = await runChildProcess(
          `openhands-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          command,
          args,
          {
            cwd,
            env: runtimeEnv,
            timeoutSec: 60,
            graceSec: 5,
            stdin: "",
            onLog: async () => {},
          },
        );

        const parsed = parseOpenHandsJsonl(probe.stdout);
        const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
        const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

        if (probe.timedOut) {
          checks.push({
            code: "openhands_hello_probe_timed_out",
            level: "warn",
            message: "OpenHands hello probe timed out.",
            hint: "Retry the probe. If this persists, run OpenHands manually in this working directory.",
          });
        } else if ((probe.exitCode ?? 1) === 0 && !parsed.errorMessage) {
          const summary = parsed.summary.trim();
          const hasHello = /\bhello\b/i.test(summary);
          checks.push({
            code: hasHello ? "openhands_hello_probe_passed" : "openhands_hello_probe_unexpected_output",
            level: hasHello ? "info" : "warn",
            message: hasHello
              ? "OpenHands hello probe succeeded."
              : "OpenHands probe ran but did not return `hello` as expected.",
            ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
            ...(hasHello
              ? {}
              : {
                  hint: "Run `openhands --headless --override-with-envs -t 'Respond with hello'` manually to inspect output.",
                }),
          });
        } else if (OPENHANDS_AUTH_REQUIRED_RE.test(authEvidence)) {
          checks.push({
            code: "openhands_hello_probe_auth_required",
            level: "warn",
            message: "OpenHands is installed, but provider authentication is not ready.",
            ...(detail ? { detail } : {}),
            hint: "Set LLM_API_KEY and LLM_BASE_URL environment variables, then retry the probe.",
          });
        } else {
          checks.push({
            code: "openhands_hello_probe_failed",
            level: "error",
            message: "OpenHands hello probe failed.",
            ...(detail ? { detail } : {}),
            hint: "Run `openhands --headless --override-with-envs -t 'Respond with hello'` manually in this working directory to debug.",
          });
        }
      } catch (err) {
        checks.push({
          code: "openhands_hello_probe_failed",
          level: "error",
          message: "OpenHands hello probe failed.",
          detail: err instanceof Error ? err.message : String(err),
          hint: "Run `openhands --headless --override-with-envs -t 'Respond with hello'` manually in this working directory to debug.",
        });
      }
    }
  } finally {
    await preparedRuntimeConfig.cleanup();
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
