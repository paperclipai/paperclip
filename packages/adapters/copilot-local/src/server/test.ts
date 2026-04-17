import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { COPILOT_API_BASE_URL, DEFAULT_COPILOT_MODEL } from "../index.js";
import { resolveCopilotToken } from "./token.js";
import { isClaudeModel } from "./execute.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const envConfig = parseObject(config.env);
  const model = asString(config.model, DEFAULT_COPILOT_MODEL).trim();
  const command = asString(config.command, "claude");
  const cwd = asString(config.cwd, process.cwd());

  // 1. Check working directory
  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: false });
    checks.push({ code: "copilot_cwd_valid", level: "info", message: `Working directory valid: ${cwd}` });
  } catch {
    checks.push({
      code: "copilot_cwd_invalid",
      level: "error",
      message: `Working directory does not exist: ${cwd}`,
      hint: "Set adapterConfig.cwd to an existing directory.",
    });
  }

  // 2. Resolve env for command checking
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const runtimeEnv = ensurePathInEnv(effectiveEnv);

  // 3. Check that the agent CLI command is resolvable
  const cwdInvalid = checks.some((c) => c.code === "copilot_cwd_invalid");
  if (!cwdInvalid) {
    try {
      await ensureCommandResolvable(command, cwd, runtimeEnv);
      checks.push({ code: "copilot_command_resolvable", level: "info", message: `Command executable: ${command}` });
    } catch (err) {
      checks.push({
        code: "copilot_command_unresolvable",
        level: "error",
        message: err instanceof Error ? err.message : `Command not found: ${command}`,
        hint: `Install the \`${command}\` CLI and ensure it is on PATH.`,
      });
    }
  }

  // 4. Check GitHub auth and Copilot token exchange
  let resolvedToken = "";
  try {
    resolvedToken = await resolveCopilotToken(effectiveEnv);
    checks.push({
      code: "copilot_token_resolved",
      level: "info",
      message: "Successfully obtained a GitHub Copilot API token.",
    });
  } catch (err) {
    checks.push({
      code: "copilot_token_failed",
      level: "error",
      message: err instanceof Error ? err.message : "Failed to resolve Copilot token.",
      hint:
        "Set GITHUB_TOKEN (GitHub PAT with `read:user` scope) or GITHUB_COPILOT_TOKEN in adapterConfig.env, or run `gh auth login`.",
    });
  }

  // 5. Check model is configured
  if (!model) {
    checks.push({
      code: "copilot_model_missing",
      level: "warn",
      message: "No model configured; will use default.",
      hint: `Set adapterConfig.model to one of the supported Copilot model IDs.`,
    });
  } else {
    checks.push({ code: "copilot_model_configured", level: "info", message: `Model: ${model}` });
  }

  // 6. Quick hello probe if everything looks good
  const canProbe = checks.every(
    (c) => !["copilot_cwd_invalid", "copilot_command_unresolvable", "copilot_token_failed"].includes(c.code),
  );

  if (canProbe && resolvedToken) {
    const probeEnv = { ...env };
    // Mirror the same env-var routing used in execute.ts
    if (isClaudeModel(model)) {
      probeEnv.ANTHROPIC_BASE_URL = COPILOT_API_BASE_URL;
      probeEnv.ANTHROPIC_API_KEY = resolvedToken;
    } else {
      probeEnv.OPENAI_BASE_URL = COPILOT_API_BASE_URL;
      probeEnv.OPENAI_API_KEY = resolvedToken;
    }

    try {
      const probe = await runChildProcess(
        `copilot-envtest-${Date.now()}`,
        command,
        ["--output-format", "json", "--dangerously-skip-permissions", "--print", "Respond with: hello"],
        {
          cwd,
          env: probeEnv,
          timeoutSec: 60,
          graceSec: 5,
          onLog: async () => {},
        },
      );

      if (probe.timedOut) {
        checks.push({
          code: "copilot_hello_probe_timeout",
          level: "warn",
          message: "Hello probe timed out.",
          hint: "The Copilot API may be slow or the model may be unavailable. Retry.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        checks.push({
          code: "copilot_hello_probe_passed",
          level: "info",
          message: "Hello probe succeeded — Copilot API is reachable and responding.",
        });
      } else {
        const detail = probe.stderr.trim() || probe.stdout.slice(0, 240);
        checks.push({
          code: "copilot_hello_probe_failed",
          level: "error",
          message: "Hello probe returned a non-zero exit code.",
          ...(detail ? { detail } : {}),
          hint: "Run the CLI manually to debug. The model may be unavailable in your Copilot plan.",
        });
      }
    } catch (err) {
      checks.push({
        code: "copilot_hello_probe_error",
        level: "error",
        message: "Hello probe threw an error.",
        detail: err instanceof Error ? err.message : String(err),
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
