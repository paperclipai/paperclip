import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  asStringArray,
  ensurePathInEnv,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import { DEFAULT_GROK_LOCAL_MODEL } from "../index.js";
import { parseGrokJsonl } from "./parse.js";

export interface GrokModelsProbe {
  authenticated: boolean;
  defaultModel: string | null;
  models: string[];
}

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

const GROK_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|login\s+required|run\s+`?grok\s+login`?|authentication\s+required|unauthorized|invalid\s+credentials)/i;

export function parseGrokModelsOutput(stdout: string): GrokModelsProbe {
  const trimmedLines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const models: string[] = [];
  let defaultModel: string | null = null;
  let authenticated = false;
  let inModelsBlock = false;

  for (const line of trimmedLines) {
    if (/logged in/i.test(line)) authenticated = true;
    const defaultMatch = /^Default model:\s*(.+)$/i.exec(line);
    if (defaultMatch?.[1]) {
      defaultModel = defaultMatch[1].trim();
      continue;
    }
    if (/^Available models:/i.test(line)) {
      inModelsBlock = true;
      continue;
    }
    if (!inModelsBlock) continue;
    const bulletMatch = /^[*-]\s*(.+?)(?:\s+\(default\))?$/.exec(line);
    if (bulletMatch?.[1]) {
      models.push(bulletMatch[1].trim());
      continue;
    }
    if (line.length > 0) {
      models.push(line.replace(/\s+\(default\)$/, "").trim());
    }
  }

  return {
    authenticated,
    defaultModel,
    models: Array.from(new Set(models.filter(Boolean))),
  };
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "grok");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `grok-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "grok_environment_target",
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
      code: "grok_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "grok_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const env = normalizeEnv(config.env);
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({
      code: "grok_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "grok_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "grok_cwd_invalid" && check.code !== "grok_command_unresolvable");

  const configuredModel = asString(config.model, DEFAULT_GROK_LOCAL_MODEL).trim();

  if (canRunProbe) {
    const modelsProbe = await runAdapterExecutionTargetProcess(
      runId,
      target,
      command,
      ["models"],
      {
        cwd,
        env,
        timeoutSec: Math.max(1, asNumber(config.helloProbeTimeoutSec, 45)),
        graceSec: 5,
        onLog: async () => {},
      },
    );

    const probeOutput = `${modelsProbe.stdout}\n${modelsProbe.stderr}`;
    const parsedModels = parseGrokModelsOutput(modelsProbe.stdout);
    const authRequired = GROK_AUTH_REQUIRED_RE.test(probeOutput);

    if (modelsProbe.timedOut) {
      checks.push({
        code: "grok_models_probe_timed_out",
        level: "warn",
        message: "`grok models` timed out.",
        hint: "Retry the probe. If this persists, run `grok models` manually from the target environment.",
      });
    } else if ((modelsProbe.exitCode ?? 1) !== 0) {
      checks.push({
        code: authRequired ? "grok_auth_required" : "grok_models_probe_failed",
        level: authRequired ? "warn" : "error",
        message: authRequired
          ? "Grok CLI is not authenticated."
          : "`grok models` failed.",
        detail: summarizeProbeDetail(modelsProbe.stdout, modelsProbe.stderr, null),
        hint: authRequired ? "Run `grok login` on the target host, then retry." : undefined,
      });
    } else {
      checks.push({
        code: "grok_models_probe_passed",
        level: "info",
        message: parsedModels.authenticated
          ? "Grok CLI authentication is configured."
          : "`grok models` completed.",
        detail: parsedModels.defaultModel ? `Default model: ${parsedModels.defaultModel}` : undefined,
      });
      if (parsedModels.models.length > 0) {
        checks.push({
          code: "grok_models_discovered",
          level: "info",
          message: `Discovered ${parsedModels.models.length} Grok model(s).`,
        });
      } else {
        checks.push({
          code: "grok_models_empty",
          level: "warn",
          message: "Grok returned no available models.",
          hint: "Run `grok models` manually and verify the account has access to a model.",
        });
      }
      if (configuredModel) {
        checks.push({
          code: parsedModels.models.includes(configuredModel) ? "grok_model_configured" : "grok_model_not_found",
          level: parsedModels.models.includes(configuredModel) ? "info" : "warn",
          message: parsedModels.models.includes(configuredModel)
            ? `Configured model: ${configuredModel}`
            : `Configured model "${configuredModel}" not found in available models.`,
          hint: parsedModels.models.includes(configuredModel)
            ? undefined
            : "Run `grok models` and choose an available model id.",
        });
      }
    }
  }

  if (canRunProbe) {
    const probeArgs = [
      "--output-format",
      "streaming-json",
      "--always-approve",
      "--permission-mode",
      "dontAsk",
      "--disable-web-search",
    ];
    if (configuredModel && configuredModel !== DEFAULT_GROK_LOCAL_MODEL) {
      probeArgs.push("--model", configuredModel);
    }
    probeArgs.push("--single", "Respond with exactly hello.");

    const helloProbe = await runAdapterExecutionTargetProcess(
      runId,
      target,
      command,
      probeArgs,
      {
        cwd,
        env,
        timeoutSec: Math.max(1, asNumber(config.helloProbeTimeoutSec, 45)),
        graceSec: 5,
        onLog: async () => {},
      },
    );
    const parsed = parseGrokJsonl(helloProbe.stdout);
    const detail = summarizeProbeDetail(helloProbe.stdout, helloProbe.stderr, parsed.errorMessage);
    const authRequired = GROK_AUTH_REQUIRED_RE.test(`${helloProbe.stdout}\n${helloProbe.stderr}`);

    if (helloProbe.timedOut) {
      checks.push({
        code: "grok_hello_probe_timed_out",
        level: "warn",
        message: "Grok hello probe timed out.",
        hint: "Retry the probe. If this persists, verify Grok can run a simple `--single` prompt manually.",
      });
    } else if ((helloProbe.exitCode ?? 1) !== 0) {
      checks.push({
        code: authRequired ? "grok_hello_probe_auth_required" : "grok_hello_probe_failed",
        level: authRequired ? "warn" : "error",
        message: authRequired
          ? "Grok CLI could not answer the hello probe because authentication is missing."
          : "Grok hello probe failed.",
        ...(detail ? { detail } : {}),
        hint: authRequired ? "Run `grok login` on the target host, then retry." : undefined,
      });
    } else if (/\bhello\b/i.test(parsed.summary)) {
      checks.push({
        code: "grok_hello_probe_passed",
        level: "info",
        message: "Grok hello probe succeeded.",
      });
    } else {
      checks.push({
        code: "grok_hello_probe_unexpected_output",
        level: "warn",
        message: "Grok hello probe succeeded but returned unexpected output.",
        ...(detail ? { detail } : {}),
      });
    }
  }

  return {
    adapterType: "grok_local",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
