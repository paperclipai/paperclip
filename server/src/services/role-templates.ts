import fs from "node:fs";
import path from "node:path";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

const TEMPLATE_FILES = ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"];

function getTemplateDir(role: string): string {
  // Templates are in server/templates/roles/{role}
  // When running, cwd might be project root or server/, so check both
  const fromRoot = path.resolve(process.cwd(), "server", "templates", "roles", role);
  const fromServer = path.resolve(process.cwd(), "templates", "roles", role);
  
  if (fs.existsSync(fromServer)) {
    return fromServer;
  }
  return fromRoot;
}

export async function copyRoleTemplateToWorkspace(agentId: string, role: string): Promise<void> {
  const templateDir = getTemplateDir(role);
  const workspaceDir = resolveDefaultAgentWorkspaceDir(agentId);

  // Check if template directory exists
  if (!fs.existsSync(templateDir)) {
    logger.warn({ agentId, role, templateDir }, "Role template directory not found, skipping template copy");
    return;
  }

  // Ensure workspace directory exists
  fs.mkdirSync(workspaceDir, { recursive: true });

  // Copy each template file
  for (const filename of TEMPLATE_FILES) {
    const sourcePath = path.join(templateDir, filename);
    const destPath = path.join(workspaceDir, filename);

    if (fs.existsSync(sourcePath)) {
      try {
        fs.copyFileSync(sourcePath, destPath);
        logger.debug({ agentId, role, filename }, "Copied template file to workspace");
      } catch (err) {
        logger.warn({ err, agentId, role, filename, sourcePath, destPath }, "Failed to copy template file");
      }
    }
  }

  logger.info({ agentId, role, workspaceDir }, "Role templates copied to agent workspace");
}

export function listAvailableRoleTemplates(): string[] {
  const templatesDir = path.resolve(process.cwd(), "server", "templates", "roles");
  
  if (!fs.existsSync(templatesDir)) {
    return [];
  }

  try {
    return fs.readdirSync(templatesDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
  } catch (err) {
    logger.warn({ err, templatesDir }, "Failed to list role templates");
    return [];
  }
}
