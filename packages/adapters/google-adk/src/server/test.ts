import fs from "node:fs/promises";
import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_GOOGLE_ADK_COMMAND } from "../index.js";
import { detectGoogleAdkAuthError, parseGoogleAdkJsonl } from "./parse.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function trimDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || stderr.trim() || stdout.trim();
  if (!raw) return null;
  const singleLine = raw.replace(/\s+/g, " ").trim();
  return singleLine.length > 240 ? `${singleLine.slice(0, 239)}…` : singleLine;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, DEFAULT_GOOGLE_ADK_COMMAND);
  const agentPath = asString(config.agentPath, "").trim();

  if (!agentPath) {
    checks.push({
      code: "google_adk_agent_path_missing",
      level: "error",
      message: "ADK agent path is required.",
      hint: "Set adapterConfig.agentPath to the ADK agent folder or file accepted by `adk run`.",
    });
  } else {
    const resolvedAgentPath = path.resolve(agentPath);
    const exists = await fs.stat(resolvedAgentPath).then(() => true).catch(() => false);
    if (!exists) {
      checks.push({
        code: "google_adk_agent_path_missing_on_disk",
        level: "error",
        message: `ADK agent path does not exist: ${resolvedAgentPath}`,
      });
    } else {
      checks.push({
        code: "google_adk_agent_path_set",
        level: "info",
        message: `ADK agent path set: ${resolvedAgentPath}`,
      });
    }
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  try {
    await ensureCommandResolvable(command, process.cwd(), runtimeEnv);
    checks.push({
      code: "google_adk_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "google_adk_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  if (
    !agentPath ||
    checks.some((check) =>
      check.code === "google_adk_command_unresolvable" || check.code === "google_adk_agent_path_missing_on_disk"
    )
  ) {
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  const helloProbeTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 20));
  const model = asString(config.model, "").trim();
  const args = ["run", "--jsonl", "--timeout", `${helloProbeTimeoutSec}s`];
  if (model) args.push("--default_llm_model", model);
  args.push(path.resolve(agentPath), "Respond with hello.");

  const probe = await runChildProcess(
    `google-adk-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    args,
    {
      cwd: process.cwd(),
      env,
      timeoutSec: helloProbeTimeoutSec + 5,
      graceSec: 5,
      onLog: async () => {},
    },
  );
  const parsed = parseGoogleAdkJsonl(probe.stdout);
  const detail = trimDetail(probe.stdout, probe.stderr, parsed.errorMessage);

  if (probe.timedOut) {
    checks.push({
      code: "google_adk_hello_probe_timed_out",
      level: "warn",
      message: "Google ADK hello probe timed out.",
      hint: "Retry the probe. If it persists, run the same `adk run` command manually from this machine.",
    });
  } else if ((probe.exitCode ?? 1) === 0) {
    const hasHello = /\bhello\b/i.test(parsed.summary);
    checks.push({
      code: hasHello ? "google_adk_hello_probe_passed" : "google_adk_hello_probe_unexpected_output",
      level: hasHello ? "info" : "warn",
      message: hasHello
        ? "Google ADK hello probe succeeded."
        : "Google ADK probe ran but did not return `hello` as expected.",
      ...(detail ? { detail } : {}),
    });
  } else if (detectGoogleAdkAuthError(probe.stdout, probe.stderr)) {
    checks.push({
      code: "google_adk_auth_required",
      level: "warn",
      message: "Google ADK is installed, but authentication is not ready.",
      ...(detail ? { detail } : {}),
      hint: "Configure the model backend credentials your ADK agent expects, such as GOOGLE_API_KEY.",
    });
  } else {
    checks.push({
      code: "google_adk_hello_probe_failed",
      level: "error",
      message: "Google ADK hello probe failed.",
      ...(detail ? { detail } : {}),
      hint: "Run the same `adk run --jsonl <agentPath> \"Respond with hello.\"` command manually to inspect the failure.",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
