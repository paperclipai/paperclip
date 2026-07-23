import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
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
import { resolveCopilotHome } from "./execute.js";

const MIN_COPILOT_NODE_MAJOR = 22;
const SUPPORTED_TOKEN_PREFIXES = ["gho_", "ghu_", "github_pat_"] as const;
const TOKEN_ENV_KEYS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

function summarizeStatus(
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult["status"] {
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

export function shouldRetryCopilotProbe(probe: {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}): boolean {
  return (
    !probe.timedOut &&
    (probe.exitCode ?? 1) !== 0 &&
    !firstNonEmptyLine(probe.stdout) &&
    !firstNonEmptyLine(probe.stderr)
  );
}

export function detectCopilotToken(
  env: NodeJS.ProcessEnv | Record<string, string>,
): { key: string; supported: boolean; classicPat: boolean } | null {
  for (const key of TOKEN_ENV_KEYS) {
    const value = env[key]?.trim();
    if (!value) continue;
    return {
      key,
      supported: SUPPORTED_TOKEN_PREFIXES.some((prefix) => value.startsWith(prefix)),
      classicPat: value.startsWith("ghp_"),
    };
  }
  return null;
}

function buildProbeArgs(config: Record<string, unknown>): string[] {
  const model = asString(config.model, "").trim();
  const args = [
    "-p",
    "Respond with exactly: hello",
    "--silent",
    "--no-auto-update",
    "--no-remote",
    "--no-remote-export",
    "--no-color",
  ];
  if (model) args.push("--model", model);
  return args;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const target = ctx.executionTarget ?? null;
  if (target?.kind === "remote") {
    checks.push({
      code: "copilot_remote_target_unsupported",
      level: "error",
      message: "GitHub Copilot CLI is currently supported only on local execution targets.",
      hint: "Use the local environment for copilot_local agents.",
    });
    return {
      adapterType: ctx.adapterType,
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  const cwd = asString(config.cwd, process.cwd());
  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
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

  const nodeMajor = Number(process.versions.node.split(".")[0] ?? 0);
  checks.push({
    code:
      nodeMajor >= MIN_COPILOT_NODE_MAJOR
        ? "copilot_node_supported"
        : "copilot_node_unsupported",
    level: nodeMajor >= MIN_COPILOT_NODE_MAJOR ? "info" : "error",
    message:
      nodeMajor >= MIN_COPILOT_NODE_MAJOR
        ? `Node ${process.version} satisfies Copilot CLI requirements.`
        : `Node ${process.version} does not satisfy Copilot CLI requirements.`,
    hint:
      nodeMajor >= MIN_COPILOT_NODE_MAJOR
        ? undefined
        : `Install Node ${MIN_COPILOT_NODE_MAJOR} or newer.`,
  });

  const envConfig = parseObject(config.env);
  const envOverrides = Object.fromEntries(
    Object.entries(envConfig).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const probeHome = resolveCopilotHome(config);
  let probeHomeReady = true;
  try {
    await fs.mkdir(probeHome, { recursive: true });
    await fs.access(probeHome, fsConstants.R_OK | fsConstants.W_OK);
    checks.push({
      code: "copilot_home_ready",
      level: "info",
      message: `Copilot state directory is ready: ${probeHome}`,
    });
  } catch (err) {
    probeHomeReady = false;
    checks.push({
      code: "copilot_home_unavailable",
      level: "error",
      message:
        err instanceof Error
          ? `Copilot state directory is unavailable: ${err.message}`
          : "Copilot state directory is unavailable.",
      detail: probeHome,
      hint: "Choose a writable COPILOT_HOME or fix the Paperclip data directory ownership.",
    });
  }
  const env = ensurePathInEnv({
    ...process.env,
    ...envOverrides,
    COPILOT_AUTO_UPDATE: "false",
    COPILOT_HOME: probeHome,
  });
  const command = asString(config.command, "copilot").trim() || "copilot";
  let commandResolvable = false;
  try {
    await ensureCommandResolvable(command, cwd, env);
    commandResolvable = true;
    checks.push({
      code: "copilot_command_resolvable",
      level: "info",
      message: `Copilot CLI command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "copilot_command_missing",
      level: "error",
      message: err instanceof Error ? err.message : "Copilot CLI is not executable.",
      hint: "Install it with `npm install -g @github/copilot` or set command to the executable path.",
    });
  }

  const token = detectCopilotToken(env);
  if (token?.classicPat) {
    checks.push({
      code: "copilot_classic_pat_unsupported",
      level: "error",
      message: `${token.key} contains a classic GitHub PAT, which Copilot CLI does not support.`,
      hint: "Use a GitHub CLI OAuth token, Copilot OAuth login, or a fine-grained PAT with Copilot Requests permission.",
    });
  } else if (token) {
    checks.push({
      code: token.supported ? "copilot_token_detected" : "copilot_token_unrecognized",
      level: token.supported ? "info" : "warn",
      message: token.supported
        ? `Copilot authentication token detected in ${token.key}.`
        : `A token was detected in ${token.key}, but its type could not be recognized.`,
      hint: token.supported
        ? undefined
        : "Supported tokens include Copilot/GitHub CLI OAuth tokens and fine-grained PATs with Copilot Requests permission.",
    });
  } else {
    const hasStoredConfig = await fs
      .access(path.join(probeHome, "config.json"))
      .then(() => true)
      .catch(() => false);
    checks.push({
      code: hasStoredConfig ? "copilot_stored_auth_possible" : "copilot_credentials_missing",
      level: hasStoredConfig ? "info" : "warn",
      message: hasStoredConfig
        ? "Copilot configuration is present; the live probe will verify authentication."
        : "No Copilot token or stored configuration was detected.",
      hint: hasStoredConfig
        ? undefined
        : "Set COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN, or run `copilot login`.",
    });
  }

  if (commandResolvable && probeHomeReady && !token?.classicPat) {
    const runProbe = () =>
      runChildProcess(
        `copilot-envtest-${Date.now()}`,
        command,
        buildProbeArgs(config),
        {
          cwd,
          env: Object.fromEntries(
            Object.entries(env).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          timeoutSec: 90,
          graceSec: 5,
          onLog: async () => {},
        },
      );
    let probe = await runProbe();
    if (shouldRetryCopilotProbe(probe)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      probe = await runProbe();
    }
    if (probe.timedOut) {
      checks.push({
        code: "copilot_live_probe_timeout",
        level: "error",
        message: "Copilot CLI live probe timed out.",
      });
    } else if ((probe.exitCode ?? 1) !== 0) {
      checks.push({
        code: "copilot_live_probe_failed",
        level: "error",
        message: "Copilot CLI live probe failed.",
        detail:
          firstNonEmptyLine(probe.stderr) ||
          firstNonEmptyLine(probe.stdout) ||
          `Copilot exited with code ${probe.exitCode ?? "unknown"} without diagnostic output.`,
        hint: "Verify the account has a Copilot entitlement and enterprise policy allows Copilot CLI.",
      });
    } else {
      checks.push({
        code: "copilot_live_probe_passed",
        level: "info",
        message: "Copilot CLI responded successfully to the live hello probe.",
        detail: firstNonEmptyLine(probe.stdout) || null,
      });
    }
  }

  checks.push({
    code: "copilot_acp_runtime_available",
    level: "info",
    message: "Copilot will run through Paperclip's shared ACP engine.",
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
