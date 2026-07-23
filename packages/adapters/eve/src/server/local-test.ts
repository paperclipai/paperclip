import { spawn } from "node:child_process";
import fsSync from "node:fs";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { looksLikeEveProject } from "./local-runtime.js";

const COMMAND_PROBE_TIMEOUT_MS = 10_000;

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function probeCommand(command: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      resolve({ ok, detail });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, ["--version"], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      settle(false, err instanceof Error ? err.message : String(err));
      return;
    }
    let output = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Best effort only.
      }
      settle(false, `Timed out after ${COMMAND_PROBE_TIMEOUT_MS}ms running "${command} --version".`);
    }, COMMAND_PROBE_TIMEOUT_MS);
    child.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        settle(false, `Command "${command}" was not found.`);
      } else {
        settle(false, err.message);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const version = output.trim().split(/\r?\n/)[0] ?? "";
      if (code === 0) {
        settle(true, version ? `${command} --version: ${version}` : `${command} --version exited 0.`);
      } else {
        settle(false, `"${command} --version" exited with code ${code}.`);
      }
    });
  });
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const projectDir = asString(config.projectDir, "").trim();
  const command = asString(config.command, "eve").trim() || "eve";

  if (!projectDir) {
    checks.push({
      code: "eve_local_project_dir_missing",
      level: "error",
      message: "projectDir is required.",
      hint: "Set the absolute path of the Eve project directory (created with `npx eve init`).",
    });
  } else if (!fsSync.existsSync(projectDir) || !fsSync.statSync(projectDir).isDirectory()) {
    checks.push({
      code: "eve_local_project_dir_not_found",
      level: "error",
      message: "projectDir does not exist or is not a directory.",
      detail: projectDir,
    });
  } else {
    if (!looksLikeEveProject(projectDir)) {
      checks.push({
        code: "eve_local_project_shape_unrecognized",
        level: "warn",
        message: "Directory does not look like an Eve project (no agent/instructions.md or agent.ts).",
        detail: projectDir,
        hint: "Run `npx eve init` in the project directory, or double-check the path.",
      });
    } else {
      checks.push({
        code: "eve_local_project_dir_ok",
        level: "info",
        message: `Eve project directory found: ${projectDir}`,
      });
    }
  }

  const probe = await probeCommand(command);
  if (probe.ok) {
    checks.push({
      code: "eve_local_command_ok",
      level: "info",
      message: `Eve command "${command}" is runnable.`,
      detail: probe.detail,
    });
  } else {
    checks.push({
      code: "eve_local_command_missing",
      level: "error",
      message: probe.detail,
      hint: 'Install Eve (npm i -g eve) or set the "command" config field.',
    });
  }

  checks.push({
    code: "eve_local_boot_not_probed",
    level: "info",
    message: "Environment test does not start the agent; first run compiles the project and may take a minute.",
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
