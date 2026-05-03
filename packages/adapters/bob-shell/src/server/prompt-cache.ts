import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, type Hash } from "node:crypto";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { ensurePaperclipSkillSymlink, type PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";

const DEFAULT_PAPERCLIP_INSTANCE_ID = "default";

type SkillEntry = PaperclipSkillEntry;

export interface BobPromptBundle {
  bundleKey: string;
  rootDir: string;
  bobDir: string;
  instructionsFilePath: string | null;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveManagedBobPromptCacheRoot(
  env: NodeJS.ProcessEnv,
  companyId: string,
): string {
  const paperclipHome = nonEmpty(env.PAPERCLIP_HOME) ?? path.resolve(os.homedir(), ".paperclip");
  const instanceId = nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? DEFAULT_PAPERCLIP_INSTANCE_ID;
  return path.resolve(
    paperclipHome,
    "instances",
    instanceId,
    "companies",
    companyId,
    "bob-prompt-cache",
  );
}

async function hashPathContents(
  candidate: string,
  hash: Hash,
  relativePath: string,
  seenDirectories: Set<string>,
): Promise<void> {
  const stat = await fs.lstat(candidate);

  if (stat.isSymbolicLink()) {
    hash.update(`symlink:${relativePath}\n`);
    const resolved = await fs.realpath(candidate).catch(() => null);
    if (!resolved) {
      hash.update("missing\n");
      return;
    }
    await hashPathContents(resolved, hash, relativePath, seenDirectories);
    return;
  }

  if (stat.isDirectory()) {
    const realDir = await fs.realpath(candidate).catch(() => candidate);
    hash.update(`dir:${relativePath}\n`);
    if (seenDirectories.has(realDir)) {
      hash.update("loop\n");
      return;
    }
    seenDirectories.add(realDir);
    const entries = await fs.readdir(candidate, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelativePath = relativePath.length > 0 ? `${relativePath}/${entry.name}` : entry.name;
      await hashPathContents(path.join(candidate, entry.name), hash, childRelativePath, seenDirectories);
    }
    return;
  }

  if (stat.isFile()) {
    hash.update(`file:${relativePath}\n`);
    hash.update(await fs.readFile(candidate));
    hash.update("\n");
    return;
  }

  hash.update(`other:${relativePath}:${stat.mode}\n`);
}

async function buildBobPromptBundleKey(input: {
  skills: SkillEntry[];
  instructionsContents: string | null;
  modeConfig: Record<string, unknown>;
  agentName: string;
  agentCapabilities: string | null;
}): Promise<string> {
  const hash = createHash("sha256");
  hash.update("paperclip-bob-prompt-bundle:v1\n");
  
  // Hash agent configuration
  hash.update(`agent:${input.agentName}\n`);
  if (input.agentCapabilities) {
    hash.update("capabilities\n");
    hash.update(input.agentCapabilities);
    hash.update("\n");
  }
  
  // Hash mode configuration
  hash.update("modeConfig\n");
  hash.update(JSON.stringify(input.modeConfig, null, 2));
  hash.update("\n");
  
  // Hash instructions
  if (input.instructionsContents) {
    hash.update("instructions\n");
    hash.update(input.instructionsContents);
    hash.update("\n");
  } else {
    hash.update("instructions:none\n");
  }

  // Hash skills
  const sortedSkills = [...input.skills].sort((left, right) => left.runtimeName.localeCompare(right.runtimeName));
  for (const entry of sortedSkills) {
    hash.update(`skill:${entry.key}:${entry.runtimeName}\n`);
    await hashPathContents(entry.source, hash, entry.runtimeName, new Set<string>());
  }

  return hash.digest("hex");
}

async function ensureReadableFile(targetPath: string, contents: string): Promise<void> {
  try {
    await fs.access(targetPath, fsConstants.R_OK);
    return;
  } catch {
    // Fall through and materialize the file.
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, contents, "utf8");
    await fs.rename(tempPath, targetPath);
  } catch (err) {
    const targetReadable = await fs.access(targetPath, fsConstants.R_OK).then(() => true).catch(() => false);
    if (!targetReadable) {
      throw err;
    }
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

export async function prepareBobPromptBundle(input: {
  companyId: string;
  agentId: string;
  agentName: string;
  agentCapabilities: string | null;
  mode: string;
  modeConfig: Record<string, unknown>;
  skills: SkillEntry[];
  instructionsContents: string | null;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<BobPromptBundle> {
  const {
    companyId,
    agentId,
    agentName,
    agentCapabilities,
    mode,
    modeConfig,
    skills,
    instructionsContents,
    onLog,
  } = input;

  const bundleKey = await buildBobPromptBundleKey({
    skills,
    instructionsContents,
    modeConfig,
    agentName,
    agentCapabilities,
  });

  const rootDir = path.join(resolveManagedBobPromptCacheRoot(process.env, companyId), bundleKey);
  const bobDir = path.join(rootDir, ".bob");
  const rulesDir = path.join(bobDir, `rules-${mode}`);

  // Create directory structure
  await fs.mkdir(rulesDir, { recursive: true });

  // Generate custom_modes.yaml
  const customModesPath = path.join(bobDir, "custom_modes.yaml");
  const customModesContent = generateCustomModesYaml(mode, agentName, agentCapabilities, modeConfig);
  await ensureReadableFile(customModesPath, customModesContent);

  // Generate mcp.json
  const mcpJsonPath = path.join(bobDir, "mcp.json");
  const mcpJsonContent = generateMcpJson(companyId, agentId);
  await ensureReadableFile(mcpJsonPath, mcpJsonContent);

  // Generate rule files
  await generateRuleFiles(rulesDir, skills, onLog);

  // Write instructions file if provided
  const instructionsFilePath = instructionsContents
    ? path.join(rootDir, "agent-instructions.md")
    : null;
  if (instructionsFilePath && instructionsContents) {
    await ensureReadableFile(instructionsFilePath, instructionsContents);
  }

  return {
    bundleKey,
    rootDir,
    bobDir,
    instructionsFilePath,
  };
}

function generateCustomModesYaml(
  mode: string,
  agentName: string,
  agentCapabilities: string | null,
  modeConfig: Record<string, unknown>,
): string {
  const role = agentCapabilities || `You are ${agentName}, a Paperclip agent.`;
  const whenToUse = `Use this mode when working on Paperclip tasks as agent ${agentName}.`;
  
  // Extract custom instructions from modeConfig if provided
  const customInstructions = typeof modeConfig.customInstructions === "string" 
    ? modeConfig.customInstructions 
    : "";
  
  const instructions = [
    "You are operating within the Paperclip control plane.",
    "Use the Paperclip MCP server to interact with tasks, approvals, and the board.",
    customInstructions,
  ].filter(Boolean).join("\n\n");

  const toolGroups = Array.isArray(modeConfig.toolGroups) 
    ? modeConfig.toolGroups 
    : ["read", "edit", "command", "browser", "mcp"];

  const yaml = `${mode}:
  name: "${agentName}"
  role: |
    ${role.split("\n").join("\n    ")}
  when_to_use: |
    ${whenToUse.split("\n").join("\n    ")}
  custom_instructions: |
    ${instructions.split("\n").join("\n    ")}
  tool_groups:
${toolGroups.map((group) => `    - ${group}`).join("\n")}
`;

  return yaml;
}

function generateMcpJson(companyId: string, agentId: string): string {
  const mcpConfig = {
    paperclip: {
      command: "npx",
      args: ["-y", "@paperclipai/mcp-server"],
      env: {
        PAPERCLIP_API_URL: "${PAPERCLIP_API_URL}",
        PAPERCLIP_API_KEY: "${PAPERCLIP_API_KEY}",
        PAPERCLIP_COMPANY_ID: companyId,
        PAPERCLIP_AGENT_ID: agentId,
        PAPERCLIP_RUN_ID: "${PAPERCLIP_RUN_ID}",
      },
    },
  };

  return JSON.stringify(mcpConfig, null, 2);
}

async function generateRuleFiles(
  rulesDir: string,
  skills: SkillEntry[],
  onLog: AdapterExecutionContext["onLog"],
): Promise<void> {
  // Core Paperclip rules
  const coreRules = `# Paperclip Agent Core Rules

You are operating as a Paperclip agent within the control plane.

## Task Management
- Use the Paperclip MCP server to query task details
- Update task status as you make progress
- Request approvals for governed actions
- Follow the task workflow defined by your company

## Workspace
- Respect workspace boundaries
- Use the configured working directory
- Follow repository conventions
`;

  await ensureReadableFile(path.join(rulesDir, "01-core.md"), coreRules);

  // Repository context rules
  const repoRules = `# Repository Context

## Working Directory
Your working directory is configured by Paperclip based on the workspace strategy.

## File Operations
- Always use absolute paths when possible
- Respect .gitignore and .bobignore patterns
- Be careful with file modifications

## Version Control
- Follow the repository's branching strategy
- Write clear commit messages
- Respect code review processes
`;

  await ensureReadableFile(path.join(rulesDir, "02-repo.md"), repoRules);

  // Tasking workflow rules
  const taskingRules = `# Task Workflow

## Approval Gates
Some actions require approval:
- Deployment operations
- Database migrations
- External API calls
- Budget-impacting operations

Use the Paperclip MCP server to request approvals when needed.

## Budget Management
- Be mindful of token usage
- Optimize for efficiency
- Stop if budget limits are reached

## Session Management
- Sessions can be resumed across runs
- Context is preserved between sessions
- Use session continuity for complex tasks
`;

  await ensureReadableFile(path.join(rulesDir, "03-tasking.md"), taskingRules);

  // Materialize skill files
  let skillIndex = 4;
  for (const skill of skills) {
    const skillFileName = `${String(skillIndex).padStart(2, "0")}-${skill.runtimeName}.md`;
    const skillPath = path.join(rulesDir, skillFileName);
    
    try {
      // For skills, we create symlinks to preserve the original structure
      await ensurePaperclipSkillSymlink(skill.source, skillPath);
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to materialize Bob Shell skill "${skill.key}" into ${rulesDir}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    
    skillIndex++;
  }
}
