import fs from "node:fs/promises";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { isCrushAgentFailure } from "./execute.js";
import { crushDataDir, crushExtraArgs, crushRunArgs, crushSkillsDir } from "./command.js";

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

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "crush");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "crush_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "crush_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const dataDir = crushDataDir(ctx.companyId, "environment-probe");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  env.CRUSH_SKILLS_DIR = crushSkillsDir(ctx.companyId, "environment-probe");
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "crush_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "crush_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "Install Crush from https://charm.sh or ensure the crush binary is on PATH.",
    });
  }

  const canRunProbe = checks.every(
    (c) => c.code !== "crush_cwd_invalid" && c.code !== "crush_command_unresolvable",
  );

  if (canRunProbe) {
    await fs.mkdir(dataDir, { recursive: true });
    const helloProbeTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 30));
    const model = asString(config.model, "").trim();
    const probeArgs = crushRunArgs({
      cwd,
      dataDir,
      model,
      extraArgs: crushExtraArgs(config),
      prompt: "Respond with only the word: hello",
    });

    const probe = await runChildProcess(
      `crush-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command,
      probeArgs,
      {
        cwd,
        env: runtimeEnv,
        timeoutSec: helloProbeTimeoutSec,
        graceSec: 5,
        onLog: async () => {},
      },
    );

    if (probe.timedOut) {
      checks.push({
        code: "crush_hello_probe_timed_out",
        level: "warn",
        message: "Crush hello probe timed out.",
        hint: "Retry the probe. If this persists, verify Crush can run interactively from this directory.",
      });
    } else if ((probe.exitCode ?? 1) === 0 && !isCrushAgentFailure(probe.stdout)) {
      const summary = probe.stdout.trim();
      const hasHello = /\bhello\b/i.test(summary);
      checks.push({
        code: hasHello ? "crush_hello_probe_passed" : "crush_hello_probe_unexpected_output",
        level: hasHello ? "info" : "warn",
        message: hasHello
          ? "Crush hello probe succeeded."
          : "Crush probe ran but did not return `hello` as expected.",
        ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
        ...(hasHello ? {} : { hint: "Run `crush run --quiet \"Respond with only the word: hello\"` manually to debug." }),
      });
    } else {
      const detail =
        firstNonEmptyLine(probe.stderr) ||
        firstNonEmptyLine(probe.stdout) ||
        null;
      checks.push({
        code: "crush_hello_probe_failed",
        level: "error",
        message: "Crush hello probe failed.",
        ...(detail ? { detail: detail.slice(0, 240) } : {}),
        hint: "Run `crush run --quiet \"Respond with only the word: hello\"` manually in this working directory to debug.",
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
