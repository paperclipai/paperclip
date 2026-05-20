import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import type { BobCustomMode, BobCustomModesConfig, ROLE_GROUPS, ROLE_WHEN_TO_USE } from "./types.js";

/**
 * Reads existing .bob/custom_modes.yaml and preserves non-Paperclip modes.
 * 
 * @param bobDir - Path to .bob directory
 * @returns Existing custom modes configuration
 */
export async function readExistingCustomModes(bobDir: string): Promise<BobCustomModesConfig> {
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
 * Generates the Paperclip-managed custom mode for Bob Shell.
 * 
 * Creates a mode configuration with appropriate tool groups, instructions,
 * and role-specific settings based on the agent's role and capabilities.
 * 
 * @param mode - Mode slug (e.g., "paperclip-agent")
 * @param agentName - Agent display name
 * @param agentRole - Agent role (e.g., "engineer", "ceo")
 * @param agentCapabilities - Agent capabilities description
 * @param agentInstructions - Agent instructions from file (if configured)
 * @param modeConfig - Mode-specific configuration overrides
 * @returns Generated custom mode definition
 */
export function generatePaperclipMode(
  mode: string,
  agentName: string,
  agentRole: string,
  agentCapabilities: string | null,
  agentInstructions: string | undefined,
  modeConfig?: Record<string, unknown>,
  roleGroups?: typeof ROLE_GROUPS,
  roleWhenToUse?: typeof ROLE_WHEN_TO_USE,
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
    const suffix =
      "CRITICAL: You must maintain VERBOSE, COMPREHENSIVE communication throughout all work. Before taking ANY significant action (creating files, making changes, implementing solutions), you MUST:\n\n1. Explain your thinking and reasoning in extensive detail\n2. Ask for explicit confirmation unless the user has already given clear instructions to proceed\n3. Describe what you plan to do and why\n4. Discuss alternatives you considered\n\nWhen providing updates:\n- Write LONG, DETAILED explanations (multiple paragraphs)\n- Include extensive context about decisions and trade-offs\n- Explain your reasoning thoroughly\n- Use markdown formatting with headers, bullet points, and code blocks\n- Provide educational content that teaches team members\n- Never provide brief, terse, or minimal updates\n\nWhen referencing files or artifacts:\n- ALWAYS use the @/absolute/path/to/file syntax to create clickable links\n- Example: \"I modified @/home/user/project/src/main.ts to add the new feature\"\n- Example: \"Please review the changes in @/path/to/config.json\"\n- Example: \"The error is in @/src/utils/helper.ts at line 42\"\n- Link to ALL files you create, modify, or reference in your updates\n- Make it easy for reviewers to navigate to the exact files you're discussing\n\nIf you need QA to review your work, reach out with a COMPREHENSIVE, MULTI-PARAGRAPH explanation of what you've done, why you did it, what alternatives you considered, and what specifically needs review. ALWAYS include @/path/to/file links to all relevant files. If you need your boss to review something, provide EXTENSIVE context about the decision, the reasoning, the alternatives, and why their input is critical, with @/path/to/file links to all affected files. If someone needs to unblock you, assign them the ticket with a THOROUGH, DETAILED comment explaining the blocker in depth, everything you've tried with full details, what specific help you need, and @/path/to/file links to all relevant files.\n\nNEVER sacrifice communication quality for speed. ALWAYS prioritize verbose, educational, comprehensive updates with proper file references. Your updates should be so detailed that they serve as complete documentation for future reference, with all files properly linked using @/path/to/file syntax.";

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
      (roleWhenToUse && roleWhenToUse[agentRole]) ||
      "Use for Paperclip-managed coding, debugging, refactoring, and validation work.",
    customInstructions,
    groups:
      (Array.isArray(modeConfig?.groups) &&
        modeConfig.groups.every((g): g is string => typeof g === "string") &&
        modeConfig.groups.length > 0 &&
        modeConfig.groups) ||
      (roleGroups && roleGroups[agentRole]) ||
      defaultGroups,
  };
}

/**
 * Merges Paperclip mode into existing custom modes configuration.
 * 
 * Removes any existing Paperclip-managed modes (slug starts with "paperclip-")
 * and adds the new Paperclip mode.
 * 
 * @param existing - Existing custom modes configuration
 * @param paperclipMode - New Paperclip mode to add
 * @returns Merged configuration
 */
export function mergeCustomModes(
  existing: BobCustomModesConfig,
  paperclipMode: BobCustomMode,
): BobCustomModesConfig {
  const filtered = existing.customModes.filter((m) => !m.slug.startsWith("paperclip-"));
  return {
    customModes: [...filtered, paperclipMode],
  };
}

/**
 * Writes custom modes configuration to .bob/custom_modes.yaml.
 * 
 * @param bobDir - Path to .bob directory
 * @param config - Custom modes configuration to write
 */
export async function writeCustomModesConfig(bobDir: string, config: BobCustomModesConfig): Promise<void> {
  const customModesPath = path.join(bobDir, "custom_modes.yaml");
  const yamlContent = yaml.stringify(config, { lineWidth: 0 });
  await fs.writeFile(customModesPath, yamlContent, "utf-8");
}
