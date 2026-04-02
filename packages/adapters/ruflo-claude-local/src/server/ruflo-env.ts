import path from "node:path";
import {
  asBoolean,
  asString,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";

function extractPlainEnv(envConfig: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(envConfig)) {
    if (typeof raw === "string") {
      env[key] = raw;
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (entry.type === "plain" && typeof entry.value === "string") {
      env[key] = entry.value;
    }
  }
  return env;
}

function hasNamedMcpServer(output: string, serverName: string) {
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, "im").test(output);
}

export interface ResolvedRufloConfig {
  config: Record<string, unknown>;
  command: string;
  rufloCommand: string;
  rufloMcpServerName: string;
  env: Record<string, string>;
  cwd: string;
  commandNotes: string[];
}

export function resolveRufloConfig(config: Record<string, unknown>): ResolvedRufloConfig {
  const command = asString(config.command, "claude");
  const rufloCommand = asString(config.rufloCommand, "");
  const rufloMcpServerName = asString(config.rufloMcpServerName, "ruflo");
  const configuredHome = asString(config.claudeConfigHome, "");
  const configEnv = parseObject(config.env);
  const env = { ...configEnv };

  if (configuredHome) {
    const home = path.resolve(configuredHome);
    env.HOME = home;
    if (typeof env.XDG_CONFIG_HOME !== "string" || env.XDG_CONFIG_HOME.length === 0) {
      env.XDG_CONFIG_HOME = path.join(home, ".config");
    }
  }

  return {
    config: {
      ...config,
      rufloRequired: asBoolean(config.rufloRequired, true),
      env,
    },
    command,
    rufloCommand,
    rufloMcpServerName,
    env: extractPlainEnv(env),
    cwd: configuredHome ? path.resolve(configuredHome) : process.cwd(),
    commandNotes: [
      ...(rufloCommand ? [`Ruflo command verified: ${rufloCommand}`] : ["Ruflo command verification: skipped"]),
      `Ruflo MCP required: ${rufloMcpServerName}`,
      ...(configuredHome ? [`Claude config home: ${path.resolve(configuredHome)}`] : []),
    ],
  };
}

export async function verifyRufloConfig(config: Record<string, unknown>) {
  const resolved = resolveRufloConfig(config);
  const required = asBoolean(resolved.config.rufloRequired, true);
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...resolved.env });

  if (!required) {
    return {
      ok: true,
      resolved,
      detail: "Ruflo enforcement disabled by config.",
    };
  }

  await ensureCommandResolvable(resolved.command, resolved.cwd, runtimeEnv);
  if (resolved.rufloCommand) {
    await ensureCommandResolvable(resolved.rufloCommand, resolved.cwd, runtimeEnv);
  }

  const proc = await runChildProcess(`ruflo-mcp-${Date.now()}`, resolved.command, ["mcp", "list"], {
    cwd: resolved.cwd,
    env: resolved.env,
    timeoutSec: 15,
    graceSec: 5,
    onLog: async () => {},
  });

  const output = `${proc.stdout}\n${proc.stderr}`.trim();
  if (proc.exitCode !== 0 || !hasNamedMcpServer(output, resolved.rufloMcpServerName)) {
    const detail = output.replace(/\s+/g, " ").trim().slice(0, 400);
    return {
      ok: false,
      resolved,
      detail: detail || `Expected Claude MCP server "${resolved.rufloMcpServerName}" was not found.`,
    };
  }

  return {
    ok: true,
    resolved,
    detail: `Detected Claude MCP server "${resolved.rufloMcpServerName}".`,
  };
}
