import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];

  const config = parseObject(ctx.config);
  const hermesCommand =
    (typeof config.hermesCommand === "string" && config.hermesCommand.trim()
      ? config.hermesCommand.trim()
      : typeof config.command === "string" && config.command.trim()
        ? config.command.trim()
        : "hermes");
  const hermesHome = typeof config.hermesHome === "string" && config.hermesHome.trim()
    ? config.hermesHome.trim()
    : process.env.HERMES_HOME ?? "/paperclip/hermes";
  const mcpServerPath = typeof config.mcpServerPath === "string" && config.mcpServerPath.trim()
    ? config.mcpServerPath.trim()
    : "/usr/local/bin/paperclip-mcp-server";
  const paperclipApiUrl = typeof config.paperclipApiUrl === "string" && config.paperclipApiUrl.trim()
    ? config.paperclipApiUrl.trim()
    : "http://localhost:3100/api";

  const envConfig = (typeof config.env === "object" && config.env !== null ? config.env : {}) as Record<string, string>;
  const hasExplicitApiKey = typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;

  checks.push({
    code: "hermes_cli_check",
    level: "info",
    message: `Hermes CLI probe: ${hermesCommand}`,
    detail: "Run: hermes --version",
  });

  checks.push({
    code: "hermes_mcp_server_binary",
    level: "info",
    message: `MCP server binary: ${mcpServerPath}`,
    detail: "Paperclip MCP tools require paperclip-mcp-server to be installed.",
  });

  checks.push({
    code: "hermes_mcp_python_dep",
    level: "info",
    message: "Python 'mcp' package required for MCP tool support",
    detail: "Install with: uv pip install mcp (or pip install mcp)",
  });

  checks.push({
    code: "hermes_paperclip_api",
    level: "info",
    message: `Paperclip API URL: ${paperclipApiUrl}`,
    detail: hasExplicitApiKey ? "PAPERCLIP_API_KEY is set in adapter config." : "PAPERCLIP_API_KEY will be injected at runtime from authToken.",
  });

  checks.push({
    code: "hermes_home_isolation",
    level: "info",
    message: `HERMES_HOME: ${hermesHome}`,
    detail: "Each agent gets a per-company/per-agent HERMES_HOME under /paperclip/hermes/agents/<companyId>/<agentId>",
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}