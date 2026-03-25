import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTemplate } from "@paperclipai/shared";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

const TEMPLATES_DIR_CANDIDATES = [
  path.resolve(__moduleDir, "../../skills/paperclip-create-agent/templates"),
  path.resolve(__moduleDir, "../../../skills/paperclip-create-agent/templates"),
];

async function resolveTemplatesDir(): Promise<string | null> {
  for (const candidate of TEMPLATES_DIR_CANDIDATES) {
    const isDir = await fs
      .stat(candidate)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (isDir) return candidate;
  }
  return null;
}

interface ScaffoldConfig {
  directories: string[];
  files: Record<string, string>;
}

export interface ScaffoldVars {
  name: string;
  title: string;
  role_description: string;
  escalation_target: string;
  company_name: string;
  agent_email?: string;
}

function renderTemplate(content: string, vars: ScaffoldVars): string {
  let rendered = content;
  for (const [key, value] of Object.entries(vars)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value ?? "");
  }
  return rendered;
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
}

export interface ScaffoldResult {
  created: string[];
  skipped: string[];
}

/**
 * Scaffold an agent's local directory from a template.
 * Skips any files/directories that already exist (safe for retroactive use).
 */
export async function scaffoldAgent(
  agentCwd: string,
  template: AgentTemplate,
  vars: ScaffoldVars,
): Promise<ScaffoldResult> {
  const templatesDir = await resolveTemplatesDir();
  if (!templatesDir) {
    throw new Error("Agent templates directory not found");
  }

  const templateDir = path.join(templatesDir, template);
  if (!(await fileExists(templateDir))) {
    throw new Error(`Template "${template}" not found at ${templateDir}`);
  }

  const scaffoldJsonPath = path.join(templateDir, "scaffold.json");
  const scaffoldJson = await fs.readFile(scaffoldJsonPath, "utf-8");
  const config: ScaffoldConfig = JSON.parse(scaffoldJson);

  const result: ScaffoldResult = { created: [], skipped: [] };

  for (const dir of config.directories) {
    const targetDir = path.join(agentCwd, dir);
    if (await fileExists(targetDir)) {
      result.skipped.push(dir);
    } else {
      await fs.mkdir(targetDir, { recursive: true });
      result.created.push(dir);
    }
  }

  for (const [destRelative, srcRelative] of Object.entries(config.files)) {
    const targetPath = path.join(agentCwd, destRelative);
    if (await fileExists(targetPath)) {
      result.skipped.push(destRelative);
    } else {
      const srcPath = path.join(templateDir, srcRelative);
      const raw = await fs.readFile(srcPath, "utf-8");
      const rendered = renderTemplate(raw, vars);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, rendered, "utf-8");
      result.created.push(destRelative);
    }
  }

  const tmplPath = path.join(templateDir, "AGENTS.md.tmpl");
  const agentsMdPath = path.join(agentCwd, "AGENTS.md");
  if (await fileExists(agentsMdPath)) {
    result.skipped.push("AGENTS.md");
  } else {
    const tmplContent = await fs.readFile(tmplPath, "utf-8");
    const rendered = renderTemplate(tmplContent, vars);
    await fs.writeFile(agentsMdPath, rendered, "utf-8");
    result.created.push("AGENTS.md");
  }

  return result;
}
