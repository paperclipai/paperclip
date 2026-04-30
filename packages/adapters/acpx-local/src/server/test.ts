import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function getStringEnv(configEnv: Record<string, string>, key: string): string | undefined {
  const configured = configEnv[key];
  if (typeof configured === "string") return configured;
  return process.env[key];
}

function credentialSource(configEnv: Record<string, string>, key: string): string {
  return typeof configEnv[key] === "string" ? "adapter config env" : "server environment";
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readNestedString(record: Record<string, unknown>, pathSegments: string[]): string | null {
  let current: unknown = record;
  for (const segment of pathSegments) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return isNonEmpty(current) ? current.trim() : null;
}

async function hasClaudeSubscriptionCredentials(configDir: string): Promise<boolean> {
  for (const filename of [".credentials.json", "credentials.json"]) {
    const credentials = await readJsonObject(path.join(configDir, filename));
    if (!credentials) continue;
    if (readNestedString(credentials, ["claudeAiOauth", "accessToken"])) return true;
  }
  return false;
}

async function hasCodexNativeCredentials(codexHome: string): Promise<boolean> {
  const auth = await readJsonObject(path.join(codexHome, "auth.json"));
  if (!auth) return false;
  return Boolean(
    readNestedString(auth, ["accessToken"]) ||
    readNestedString(auth, ["tokens", "access_token"]) ||
    readNestedString(auth, ["OPENAI_API_KEY"]),
  );
}

async function buildCredentialHintChecks(
  agent: string,
  configEnv: Record<string, string>,
): Promise<AdapterEnvironmentCheck[]> {
  if (agent === "claude") {
    const bedrockFlag = getStringEnv(configEnv, "CLAUDE_CODE_USE_BEDROCK");
    const bedrockBaseUrl = getStringEnv(configEnv, "ANTHROPIC_BEDROCK_BASE_URL");
    const hasBedrock =
      bedrockFlag === "1" ||
      /^true$/i.test(bedrockFlag ?? "") ||
      isNonEmpty(bedrockBaseUrl);
    const bedrockSourceKey = isNonEmpty(bedrockFlag)
      ? "CLAUDE_CODE_USE_BEDROCK"
      : "ANTHROPIC_BEDROCK_BASE_URL";
    const anthropicApiKey = getStringEnv(configEnv, "ANTHROPIC_API_KEY");
    const claudeConfigDir = isNonEmpty(getStringEnv(configEnv, "CLAUDE_CONFIG_DIR"))
      ? path.resolve(getStringEnv(configEnv, "CLAUDE_CONFIG_DIR") as string)
      : path.join(os.homedir(), ".claude");

    if (hasBedrock) {
      return [{
        code: "acpx_claude_bedrock_auth_detected",
        level: "info",
        message: "Claude credential hint: Bedrock auth indicators are configured.",
        detail: `Detected in ${credentialSource(configEnv, bedrockSourceKey)}.`,
        hint: "Ensure AWS credentials and AWS_REGION are available to the ACPX-launched Claude agent.",
      }];
    }

    if (isNonEmpty(anthropicApiKey)) {
      return [{
        code: "acpx_claude_anthropic_api_key_detected",
        level: "info",
        message: "Claude credential hint: ANTHROPIC_API_KEY is set.",
        detail: `Detected in ${credentialSource(configEnv, "ANTHROPIC_API_KEY")}.`,
      }];
    }

    if (await hasClaudeSubscriptionCredentials(claudeConfigDir)) {
      return [{
        code: "acpx_claude_subscription_auth_detected",
        level: "info",
        message: "Claude credential hint: local Claude subscription credentials were found.",
        detail: `Credentials found in ${claudeConfigDir}.`,
      }];
    }

    return [{
      code: "acpx_claude_credentials_missing",
      level: "info",
      message: "Claude credential hint: no Claude API, Bedrock, or local subscription credentials were detected.",
      hint: "Set ANTHROPIC_API_KEY, configure Bedrock, or run `claude login` before starting an ACPX Claude agent.",
    }];
  }

  if (agent === "codex") {
    const openAiApiKey = getStringEnv(configEnv, "OPENAI_API_KEY");
    const codexHome = isNonEmpty(getStringEnv(configEnv, "CODEX_HOME"))
      ? path.resolve(getStringEnv(configEnv, "CODEX_HOME") as string)
      : path.join(os.homedir(), ".codex");

    if (isNonEmpty(openAiApiKey)) {
      return [{
        code: "acpx_codex_openai_api_key_detected",
        level: "info",
        message: "Codex credential hint: OPENAI_API_KEY is set.",
        detail: `Detected in ${credentialSource(configEnv, "OPENAI_API_KEY")}.`,
      }];
    }

    if (await hasCodexNativeCredentials(codexHome)) {
      return [{
        code: "acpx_codex_native_auth_detected",
        level: "info",
        message: "Codex credential hint: local Codex auth configuration was found.",
        detail: `Credentials found in ${path.join(codexHome, "auth.json")}.`,
      }];
    }

    return [{
      code: "acpx_codex_credentials_missing",
      level: "info",
      message: "Codex credential hint: no OpenAI API key or local Codex auth configuration was detected.",
      hint: "Set OPENAI_API_KEY or run `codex login` before starting an ACPX Codex agent.",
    }];
  }

  return [];
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
  const envConfig = parseObject(config.env);
  const configEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") configEnv[key] = value;
  }
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
    checks.push(...await buildCredentialHintChecks(agent, configEnv));
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
