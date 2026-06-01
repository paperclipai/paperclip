import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import {
  PAPERCLIP_MCP_SERVER_NAME,
  ROLE_GROUPS,
  ROLE_WHEN_TO_USE,
  type BobCustomMode,
  type BobCustomModesConfig,
  type BobMcpConfig,
  type BobMcpServer,
  type BobWorkspaceSyncInput,
} from "./workspace/types.js";

/**
 * Reads existing .bob/custom_modes.yaml and preserves non-Paperclip modes
 */
async function readExistingCustomModes(bobDir: string): Promise<BobCustomModesConfig> {
  const customModesPath = path.join(bobDir, "custom_modes.yaml");
  try {
    const content = await fs.readFile(customModesPath, "utf-8");
    const parsed = yaml.parse(content);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.customModes)) {
      return parsed as BobCustomModesConfig;
    }
  } catch (err) {
    // File doesn't exist or is invalid, return empty config
  }
  return { customModes: [] };
}

/**
 * Reads existing .bob/mcp.json and preserves non-Paperclip MCP servers
 */
async function readExistingMcpConfig(bobDir: string): Promise<BobMcpConfig> {
  const mcpPath = path.join(bobDir, "mcp.json");
  try {
    const content = await fs.readFile(mcpPath, "utf-8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && typeof parsed.mcpServers === "object") {
      return parsed as BobMcpConfig;
    }
  } catch (err) {
    // File doesn't exist or is invalid, return empty config
  }
  return { mcpServers: {} };
}

/**
 * Generates the Paperclip-managed custom mode for Bob Shell
 */
function generatePaperclipMode(
  mode: string,
  agentName: string,
  agentRole: string,
  agentCapabilities: string | null,
  agentInstructions: string | undefined,
  modeConfig?: Record<string, unknown>
): BobCustomMode {
  const defaultInstructions = [
    "- Read and understand existing code patterns before making changes",
    "- Make thoughtful changes that improve the codebase while maintaining consistency with repository conventions",
    "- Use Paperclip MCP tools to inspect, claim, and update work with detailed status updates",
    "- ALWAYS explain your thinking and reasoning in detail BEFORE taking significant actions",
    "- Ask for confirmation before creating new files, pages, or deliverables unless explicitly instructed to proceed",
    "- Provide comprehensive, verbose explanations of your changes and the reasoning behind them",
    "- Document your decision-making process and any trade-offs you considered in extensive detail",
    "- Run relevant validation after changes and explain the test results thoroughly",
    "- Include code snippets and examples when they help illustrate your work",
    "- Do not bypass approval or task workflows",
    "- Write verbose, educational updates that teach team members and serve as comprehensive documentation",
    "- Prioritize clear, detailed communication over speed - take time to explain thoroughly",
  ].join("\n");

  const defaultGroups = ["read", "edit", "command", "browser", "mcp"];

  // Build custom instructions with prefix/suffix pattern
  let customInstructions: string;
  if (agentInstructions) {
    // Use instructions from file if provided
    customInstructions = agentInstructions;
  } else {
    const prefix = "You are an agent at Paperclip company.";
    const suffix = "CRITICAL: You must maintain VERBOSE, COMPREHENSIVE communication throughout all work. Before taking ANY significant action (creating files, making changes, implementing solutions), you MUST:\n\n1. Explain your thinking and reasoning in extensive detail\n2. Ask for explicit confirmation unless the user has already given clear instructions to proceed\n3. Describe what you plan to do and why\n4. Discuss alternatives you considered\n\nWhen providing updates:\n- Write LONG, DETAILED explanations (multiple paragraphs)\n- Include extensive context about decisions and trade-offs\n- Explain your reasoning thoroughly\n- Use markdown formatting with headers, bullet points, and code blocks\n- Provide educational content that teaches team members\n- Never provide brief, terse, or minimal updates\n\nWhen referencing files or artifacts:\n- ALWAYS use the @/absolute/path/to/file syntax to create clickable links\n- Example: \"I modified @/home/user/project/src/main.ts to add the new feature\"\n- Example: \"Please review the changes in @/path/to/config.json\"\n- Example: \"The error is in @/src/utils/helper.ts at line 42\"\n- Link to ALL files you create, modify, or reference in your updates\n- Make it easy for reviewers to navigate to the exact files you're discussing\n\nIf you need QA to review your work, reach out with a COMPREHENSIVE, MULTI-PARAGRAPH explanation of what you've done, why you did it, what alternatives you considered, and what specifically needs review. ALWAYS include @/path/to/file links to all relevant files. If you need your boss to review something, provide EXTENSIVE context about the decision, the reasoning, the alternatives, and why their input is critical, with @/path/to/file links to all affected files. If someone needs to unblock you, assign them the ticket with a THOROUGH, DETAILED comment explaining the blocker in depth, everything you've tried with full details, what specific help you need, and @/path/to/file links to all relevant files.\n\nNEVER sacrifice communication quality for speed. ALWAYS prioritize verbose, educational, comprehensive updates with proper file references. Your updates should be so detailed that they serve as complete documentation for future reference, with all files properly linked using @/path/to/file syntax.";
    
    if (agentCapabilities && agentCapabilities.trim()) {
      // Combine prefix + capabilities + suffix
      customInstructions = `${prefix}\n\n${agentCapabilities.trim()}\n\n${suffix}`;
    } else {
      // Use default instructions with prefix + suffix
      customInstructions = `${prefix}\n\n${defaultInstructions}\n\n${suffix}`;
    }
  }

  return {
    slug: mode,
    name: agentName,
    roleDefinition: "You are a repository-aware coding agent operating under Paperclip task control.",
    whenToUse:
      (typeof modeConfig?.whenToUse === "string" && modeConfig.whenToUse.trim()) ||
      ROLE_WHEN_TO_USE[agentRole] ||
      "Use for Paperclip-managed coding, debugging, refactoring, and validation work.",
    customInstructions,
    groups:
      (Array.isArray(modeConfig?.groups) &&
        modeConfig.groups.every((g): g is string => typeof g === "string") &&
        modeConfig.groups.length > 0 &&
        modeConfig.groups) ||
      ROLE_GROUPS[agentRole] ||
      defaultGroups,
  };
}

/**
 * Merges Paperclip mode into existing custom modes config
 */
function mergeCustomModes(
  existing: BobCustomModesConfig,
  paperclipMode: BobCustomMode,
): BobCustomModesConfig {
  const filtered = existing.customModes.filter((m) => !m.slug.startsWith("paperclip-"));
  return {
    customModes: [...filtered, paperclipMode],
  };
}

/**
 * Generates the Paperclip MCP server configuration.
 *
 * Stable per-agent values (companyId, agentId) are inlined; the secret API
 * key, the API URL, and the per-run RUN_ID are written as ${VAR} placeholders
 * that Bob Shell expands from its parent-process environment at MCP server
 * startup. This mirrors `prompt-cache.ts:generateMcpJson` so the bearer token
 * never lands on disk in the project workspace.
 */
function generatePaperclipMcpServer(env: Record<string, string>): BobMcpServer {
  const companyId = env.PAPERCLIP_COMPANY_ID || "";
  const agentId = env.PAPERCLIP_AGENT_ID || "";

  return {
    command: "npx",
    args: ["-y", "@paperclipai/mcp-server"],
    env: {
      PAPERCLIP_API_URL: "${PAPERCLIP_API_URL}",
      PAPERCLIP_API_KEY: "${PAPERCLIP_API_KEY}",
      PAPERCLIP_COMPANY_ID: companyId,
      PAPERCLIP_AGENT_ID: agentId,
      PAPERCLIP_RUN_ID: "${PAPERCLIP_RUN_ID}",
    },
  };
}

/**
 * Merges Paperclip MCP server into existing MCP config
 */
function mergeMcpConfig(existing: BobMcpConfig, paperclipServer: BobMcpServer): BobMcpConfig {
  return {
    mcpServers: {
      ...existing.mcpServers,
      [PAPERCLIP_MCP_SERVER_NAME]: paperclipServer,
    },
  };
}

/**
 * Generates markdown rule files from company skills
 */
async function generateRuleFiles(
  rulesDir: string,
  skills: PaperclipSkillEntry[],
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<void> {
  // Clear existing managed rules directory
  try {
    await fs.rm(rulesDir, { recursive: true, force: true });
  } catch (err) {
    // Directory might not exist, ignore
  }
  await fs.mkdir(rulesDir, { recursive: true });

  // Generate core runtime rules
  const coreRules = `# Paperclip Agent Core Rules

You are a professional Paperclip-managed agent working collaboratively with your team. Your work is coordinated through the Paperclip control plane, and you're here to deliver excellent results while maintaining clear, comprehensive communication.

## Task Management

**IMPORTANT: Paperclip MCP Tools Are Available**

You have access to Paperclip MCP tools through the configured MCP server. These tools allow you to:
- Get issue details: Use MCP tools to fetch complete issue information
- Update issues: Add comments and update status through MCP
- List issues: Query available work items
- Manage approvals: Request and respond to approval workflows
- Track budget: Monitor token usage and costs

**Always use MCP tools for Paperclip operations** - they provide the authoritative interface to the control plane.

**IMPORTANT: Bob Shell Tool Names**

Bob Shell uses \`execute_command\` for running shell commands, NOT \`run_shell_command\`. When you need to run a command, use:
- \`<execute_command>\` with \`<command>\`, \`<timeout>\`, and \`<background>\` parameters
- Environment variables like \`PAPERCLIP_API_URL\`, \`PAPERCLIP_API_KEY\`, \`PAPERCLIP_TASK_ID\` are already set
- You can use \`curl\` commands with these env vars to interact with the Paperclip API

Core workflow:
- Use Paperclip MCP tools to interact with tasks and issues
- Always check out issues before starting work to avoid conflicts
- **BEFORE taking significant actions, EXPLAIN your thinking in detail and ASK for confirmation**
- Keep everyone informed by updating task status with VERBOSE, COMPREHENSIVE, MULTI-PARAGRAPH comments
- Provide EXTENSIVE context about your decisions, reasoning, alternatives considered, and trade-offs
- Request approval for governed actions when required - it's part of our quality process
- Be mindful of budget limits and respect auto-pause behavior
- **NEVER be brief or terse - ALWAYS provide detailed, educational explanations**

## Code Quality

- Take time to understand existing code patterns before making changes
- Make thoughtful changes that improve the codebase while maintaining consistency
- Follow repository conventions and best practices consistently
- Always run tests and validation after changes to ensure reliability
- Document significant decisions thoroughly to help future maintainers
- Explain the reasoning behind non-obvious implementations

## Communication Style - CRITICAL REQUIREMENTS

**YOU MUST BE EXTREMELY VERBOSE AND COMPREHENSIVE IN ALL COMMUNICATIONS**

Before taking ANY significant action (creating files, implementing solutions, making changes):
1. **STOP and EXPLAIN** - Write multiple paragraphs explaining your thinking
2. **ASK FOR CONFIRMATION** - Unless explicitly instructed to proceed, ask first
3. **DESCRIBE YOUR PLAN** - Detail what you intend to do and why
4. **DISCUSS ALTERNATIVES** - Explain what other approaches you considered and why you chose this one

When providing updates and comments:
- **Write LONG, MULTI-PARAGRAPH explanations** - Never be brief or terse
- **Include EXTENSIVE context** about decisions, trade-offs, and reasoning
- **Explain your thought process thoroughly** - Walk through your decision-making step by step
- **Use rich markdown formatting** - Headers, bullet points, code blocks, numbered lists
- **Provide educational content** - Teach team members through your explanations
- **Anticipate ALL questions** - Answer them proactively in detail
- **Include relevant code snippets** with thorough explanations of what they do
- **Document everything** - Your updates should serve as complete documentation

Communication requirements:
- Be friendly, professional, and collaborative in all interactions
- When something is unclear, ask thoughtful, detailed questions with context
- If you encounter blockers, write COMPREHENSIVE, MULTI-PARAGRAPH explanations covering:
  - What the blocker is in detail
  - Everything you've tried (with full details of each attempt)
  - Why each approach didn't work
  - What specific help you need and why
- Use a positive, solution-oriented tone even when discussing challenges
- Acknowledge good work and collaboration from team members

**NEVER sacrifice communication quality for speed. ALWAYS prioritize verbose, educational, comprehensive updates.**

## Update Format

When providing task updates, use this structure:

1. **Summary**: Brief overview of what was accomplished (1-2 sentences)
2. **Details**: Comprehensive explanation of changes made and why
3. **Reasoning**: Context about decisions, trade-offs, and alternatives considered
4. **Testing**: What was tested and the results
5. **Next Steps**: What should happen next or what's needed from others

Your updates should be educational and thorough, helping team members understand not just what changed, but why and how.
`;

  await fs.writeFile(path.join(rulesDir, "01-core.md"), coreRules, "utf-8");

  // Generate repository context rules
  const repoRules = `# Repository Context

This agent operates within a specific repository workspace. Respect the existing:

- Code structure and organization
- Naming conventions
- Testing patterns
- Documentation standards
- Build and deployment processes

When in doubt, examine existing code for patterns before introducing new approaches.
`;

  await fs.writeFile(path.join(rulesDir, "02-repo.md"), repoRules, "utf-8");

  // Generate tasking workflow rules
  const taskingRules = `# Tasking Workflow

## Issue Lifecycle

1. **Checkout** - Claim an issue before starting work
2. **Work** - Make changes, run tests, validate
3. **Update** - Add comments and update status
4. **Complete** - Mark done when finished

## Approval Gates

Some actions require approval:
- Deployment operations
- External API calls
- Budget-impacting decisions
- Security-sensitive changes

Request approval via Paperclip MCP tools when needed.

## Budget Management

- Monitor token usage
- Respect configured budget limits
- Auto-pause triggers when budget is exhausted
- Resume work after budget is replenished
`;

  await fs.writeFile(path.join(rulesDir, "03-tasking.md"), taskingRules, "utf-8");

  // Generate skill files
  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i];
    // Sanitize skill.key to create a valid flat filename (replace slashes with dashes)
    const sanitizedKey = skill.key.replace(/\//g, "-");
    const filename = `${10 + i}-skill-${sanitizedKey}.md`;
    
    // Read the SKILL.md file from the skill's source directory
    let skillContent = "";
    try {
      const skillMarkdownPath = path.join(skill.source, "SKILL.md");
      skillContent = await fs.readFile(skillMarkdownPath, "utf-8");
    } catch (err) {
      // If SKILL.md doesn't exist, use a placeholder
      skillContent = `Skill source directory: ${skill.source}\n\nNo SKILL.md file found.`;
      if (onLog) {
        await onLog(
          "stderr",
          `[paperclip] Warning: could not read SKILL.md for skill "${skill.key}" from ${skill.source}: ${err}\n`,
        );
      }
    }
    
    const content = `# Skill: ${skill.key}

${skillContent}
`;
    await fs.writeFile(path.join(rulesDir, filename), content, "utf-8");
  }

  if (onLog) {
    await onLog(
      "stdout",
      `[paperclip] Generated ${skills.length + 3} rule files in ${rulesDir}\n`,
    );
  }
}

/**
 * Syncs .bob/ workspace configuration for Paperclip agent
 */
export async function syncBobWorkspace(input: BobWorkspaceSyncInput): Promise<void> {
  const { cwd, companyId, agentId, agentName, agentRole, agentCapabilities, agentInstructions, mode, modeConfig, skills, env, onLog } = input;

  const bobDir = path.join(cwd, ".bob");
  await fs.mkdir(bobDir, { recursive: true });

  // Sync custom_modes.yaml
  const existingModes = await readExistingCustomModes(bobDir);
  const paperclipMode = generatePaperclipMode(mode, agentName, agentRole, agentCapabilities, agentInstructions, modeConfig);
  const mergedModes = mergeCustomModes(existingModes, paperclipMode);
  const modesYaml = yaml.stringify(mergedModes);
  await fs.writeFile(path.join(bobDir, "custom_modes.yaml"), modesYaml, "utf-8");

  if (onLog) {
    await onLog("stdout", `[paperclip] Synced .bob/custom_modes.yaml with mode "${mode}"\n`);
  }

  // Sync mcp.json
  const existingMcp = await readExistingMcpConfig(bobDir);
  const paperclipServer = generatePaperclipMcpServer(env);
  const mergedMcp = mergeMcpConfig(existingMcp, paperclipServer);
  const mcpJson = JSON.stringify(mergedMcp, null, 2);
  await fs.writeFile(path.join(bobDir, "mcp.json"), mcpJson, "utf-8");

  if (onLog) {
    await onLog("stdout", `[paperclip] Synced .bob/mcp.json with Paperclip MCP server\n`);
  }

  // Sync rules directory
  const rulesDir = path.join(bobDir, `rules-${mode}`);
  await generateRuleFiles(rulesDir, skills, onLog);
}
