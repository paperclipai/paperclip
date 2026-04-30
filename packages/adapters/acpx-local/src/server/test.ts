import { createRequire } from "node:module";
import fs from "node:fs/promises";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";

const require = createRequire(import.meta.url);
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 12;
const MIN_NODE_PATCH = 0;

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function nodeVersionMeetsMinimum(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (major > MIN_NODE_MAJOR) return true;
  if (major < MIN_NODE_MAJOR) return false;
  if (minor > MIN_NODE_MINOR) return true;
  if (minor < MIN_NODE_MINOR) return false;
  return patch >= MIN_NODE_PATCH;
}

function resolvePackage(name: string): AdapterEnvironmentCheck {
  try {
    const resolved = require.resolve(`${name}/package.json`);
    return {
      code: `acpx_package_${name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_present`,
      level: "info",
      message: `${name} is resolvable.`,
      detail: resolved,
    };
  } catch {
    return {
      code: `acpx_package_${name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_missing`,
      level: "error",
      message: `${name} is not resolvable from the acpx_local adapter package.`,
      hint: "Run pnpm install so the ACPX adapter dependencies are installed.",
    };
  }
}

async function checkDirectory(pathValue: string, code: string, label: string): Promise<AdapterEnvironmentCheck | null> {
  const dir = pathValue.trim();
  if (!dir) return null;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.access(dir);
    return {
      code,
      level: "info",
      message: `${label} is writable: ${dir}`,
    };
  } catch (err) {
    return {
      code: `${code}_invalid`,
      level: "error",
      message: err instanceof Error ? err.message : `${label} is not writable.`,
      detail: dir,
    };
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = parseObject(ctx.config);
  const checks: AdapterEnvironmentCheck[] = [];
  const nodeVersion = process.version;

  checks.push({
    code: nodeVersionMeetsMinimum(nodeVersion) ? "acpx_node_supported" : "acpx_node_unsupported",
    level: nodeVersionMeetsMinimum(nodeVersion) ? "info" : "error",
    message: nodeVersionMeetsMinimum(nodeVersion)
      ? `Node ${nodeVersion} satisfies ACPX's >=22.12.0 requirement.`
      : `Node ${nodeVersion} does not satisfy ACPX's >=22.12.0 requirement.`,
    hint: nodeVersionMeetsMinimum(nodeVersion)
      ? undefined
      : "Run acpx_local agents with Node >=22.12.0 or use claude_local/codex_local on Node 20.",
  });

  checks.push(resolvePackage("acpx"));
  checks.push(resolvePackage("@agentclientprotocol/claude-agent-acp"));
  checks.push(resolvePackage("@zed-industries/codex-acp"));

  const agent = asString(config.agent, "claude");
  if (!["claude", "codex", "custom"].includes(agent)) {
    checks.push({
      code: "acpx_agent_invalid",
      level: "error",
      message: `Unsupported ACP agent: ${agent}`,
      hint: "Use agent=claude, agent=codex, or agent=custom.",
    });
  } else {
    checks.push({
      code: "acpx_agent_selected",
      level: "info",
      message: `ACP agent selected: ${agent}`,
    });
  }

  if (agent === "custom" && !asString(config.agentCommand, "")) {
    checks.push({
      code: "acpx_custom_command_missing",
      level: "error",
      message: "agentCommand is required when agent=custom.",
    });
  }

  const stateDirCheck = await checkDirectory(asString(config.stateDir, ""), "acpx_state_dir_writable", "ACPX state directory");
  if (stateDirCheck) checks.push(stateDirCheck);

  const permissionMode = asString(config.permissionMode, "approve-all");
  checks.push({
    code: "acpx_permission_mode",
    level: "info",
    message: `Effective permission mode: ${permissionMode || "approve-all"}`,
  });

  checks.push({
    code: "acpx_runtime_scaffold",
    level: "info",
    message: "acpx_local runtime execution is available through the bundled ACPX runtime.",
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
