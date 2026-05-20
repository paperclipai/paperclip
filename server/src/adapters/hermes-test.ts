import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PAPERCLIP_SKILLS_ROOT = path.resolve(__moduleDir, "../../../skills");

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
  const configPath = path.join(hermesHome, "config.yaml");
  const envPath = path.join(hermesHome, ".env");
  const skillsPath = path.join(hermesHome, "skills");
  const paperclipSkillsPath = path.join(skillsPath, "paperclip");
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
    detail: "Optional only. Hermes Paperclip integration uses the native API contract first.",
  });

  checks.push({
    code: "hermes_mcp_python_dep",
    level: "info",
    message: "Python 'mcp' package required for MCP tool support",
    detail: "Optional only. Native Paperclip API operation does not require MCP.",
  });

  checks.push({
    code: "hermes_paperclip_api",
    level: "info",
    message: `Paperclip API URL: ${paperclipApiUrl}`,
    detail: hasExplicitApiKey ? "PAPERCLIP_API_KEY is set in adapter config." : "PAPERCLIP_API_KEY will be injected at runtime from authToken.",
  });

  checks.push({
    code: "hermes_shared_home",
    level: "info",
    message: `HERMES_HOME: ${hermesHome}`,
    detail: "Paperclip uses the shared Hermes home so CLI/TUI configuration, sessions, memory, and skills stay unified.",
  });

  const configContent = await fs.readFile(configPath, "utf8").catch(() => null);
  checks.push({
    code: "hermes_shared_config",
    level: configContent ? "info" : "warn",
    message: configContent ? `Hermes config found: ${configPath}` : `Hermes config not found: ${configPath}`,
    detail: configContent
      ? "Paperclip should see the same config created by hermes setup or the Hermes TUI."
      : "Run hermes setup with this HERMES_HOME, or mount/copy your existing Hermes config here.",
  });

  const envContent = await fs.readFile(envPath, "utf8").catch(() => null);
  const hasEnvProviderKey = Boolean(envContent && /^(OPENROUTER_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|NOUS_API_KEY)=.+/m.test(envContent));
  const hasConfigProvider = Boolean(configContent && /^\s*(provider|base_url|default)\s*:/m.test(configContent));
  const hasProcessProviderKey = ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NOUS_API_KEY"]
    .some((key) => typeof process.env[key] === "string" && process.env[key]!.trim().length > 0);
  checks.push({
    code: "hermes_provider_credentials",
    level: hasEnvProviderKey || hasProcessProviderKey || hasConfigProvider ? "info" : "warn",
    message: hasEnvProviderKey || hasProcessProviderKey || hasConfigProvider
      ? "Hermes provider configuration detected"
      : "No Hermes provider credentials detected in shared .env or process env",
    detail: hasEnvProviderKey
      ? `Provider key found in ${envPath}.`
      : hasProcessProviderKey
        ? "Provider key found in process environment."
        : hasConfigProvider
          ? `Provider/model fields found in ${configPath}.`
          : "Hermes may trigger non-interactive setup unless config.yaml points at a configured provider or a provider API key is available.",
  });

  const skillDirs = await fs.readdir(skillsPath, { withFileTypes: true }).catch(() => []);
  const bundledSkillChecks = await Promise.all([
    fs.stat(path.join(PAPERCLIP_SKILLS_ROOT, "paperclip", "SKILL.md")).then(() => true).catch(() => false),
    fs.stat(path.join(PAPERCLIP_SKILLS_ROOT, "paperclip-create-agent", "SKILL.md")).then(() => true).catch(() => false),
  ]);
  checks.push({
    code: "hermes_shared_skills",
    level: "info",
    message: `Hermes skills directory: ${skillsPath}`,
    detail: skillDirs.length > 0
      ? `${skillDirs.filter((entry) => entry.isDirectory()).length} skill categories/directories detected.`
      : "No Hermes skills detected yet. Paperclip-managed skills will be linked under skills/paperclip when synced.",
  });
  checks.push({
    code: "hermes_paperclip_skill_sources",
    level: bundledSkillChecks.every(Boolean) ? "info" : "warn",
    message: bundledSkillChecks.every(Boolean)
      ? "Bundled Paperclip skills found"
      : "Bundled Paperclip skills incomplete",
    detail: `Source root: ${PAPERCLIP_SKILLS_ROOT}; paperclip=${bundledSkillChecks[0] ? "yes" : "missing"}; paperclip-create-agent=${bundledSkillChecks[1] ? "yes" : "missing"}`,
  });

  const linkedSkillChecks = await Promise.all([
    fs.stat(path.join(paperclipSkillsPath, "paperclip", "SKILL.md")).then(() => true).catch(() => false),
    fs.stat(path.join(paperclipSkillsPath, "paperclip-create-agent", "SKILL.md")).then(() => true).catch(() => false),
  ]);
  checks.push({
    code: "hermes_paperclip_skill_links",
    level: linkedSkillChecks.every(Boolean) ? "info" : "warn",
    message: linkedSkillChecks.every(Boolean)
      ? "Paperclip skills are linked into Hermes home"
      : "Paperclip skills are not linked into Hermes home yet",
    detail: linkedSkillChecks.every(Boolean)
      ? `Preload can use: paperclip,paperclip-create-agent from ${paperclipSkillsPath}`
      : `Expected links under ${paperclipSkillsPath}. They are created automatically before Hermes runs; if missing at runtime, Paperclip falls back to prompt-only native API instructions instead of failing the adapter.`,
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
