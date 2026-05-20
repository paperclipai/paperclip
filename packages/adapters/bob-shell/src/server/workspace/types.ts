import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";

/**
 * Input parameters for Bob workspace synchronization.
 */
export interface BobWorkspaceSyncInput {
  /** Working directory where .bob/ will be created */
  cwd: string;
  /** Paperclip company ID */
  companyId: string;
  /** Paperclip agent ID */
  agentId: string;
  /** Agent display name */
  agentName: string;
  /** Agent role (e.g., "ceo", "engineer") */
  agentRole: string;
  /** Agent capabilities description */
  agentCapabilities: string | null;
  /** Agent instructions from file (if configured) */
  agentInstructions?: string;
  /** Bob Shell mode to configure */
  mode: string;
  /** Mode-specific configuration */
  modeConfig?: Record<string, unknown>;
  /** Paperclip skills to install as rule files */
  skills: PaperclipSkillEntry[];
  /** Environment variables for MCP server configuration */
  env: Record<string, string>;
  /** Optional logging callback */
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

/**
 * Bob Shell custom mode definition.
 */
export interface BobCustomMode {
  /** Mode slug (e.g., "paperclip-agent") */
  slug: string;
  /** Display name */
  name: string;
  /** Role definition text */
  roleDefinition: string;
  /** When to use this mode */
  whenToUse: string;
  /** Custom instructions for the mode */
  customInstructions: string;
  /** Tool groups enabled for this mode */
  groups: string[];
}

/**
 * Bob Shell custom modes configuration file structure.
 */
export interface BobCustomModesConfig {
  /** Array of custom mode definitions */
  customModes: BobCustomMode[];
}

/**
 * Bob Shell MCP server configuration.
 */
export interface BobMcpServer {
  /** Command to execute */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
}

/**
 * Bob Shell MCP configuration file structure.
 */
export interface BobMcpConfig {
  /** Map of server name to server configuration */
  mcpServers: Record<string, BobMcpServer>;
}

/** Name of the Paperclip MCP server in Bob's configuration */
export const PAPERCLIP_MCP_SERVER_NAME = "paperclip";

/** Default tool groups for different agent roles */
export const ROLE_GROUPS: Record<string, string[]> = {
  ceo: ["read", "command", "mcp"],
  cto: ["read", "command", "mcp"],
  cmo: ["read", "mcp"],
  cfo: ["read", "mcp"],
  coo: ["read", "command", "mcp"],
  vp: ["read", "command", "mcp"],
  manager: ["read", "mcp"],
  engineer: ["read", "edit", "command", "mcp"],
};

/** Default "when to use" descriptions for different agent roles */
export const ROLE_WHEN_TO_USE: Record<string, string> = {
  ceo: "Strategic oversight, executive decisions, and company-level approvals.",
  cto: "Architecture review, technical planning, and engineering governance.",
  cmo: "Marketing strategy, content direction, and brand decisions.",
  cfo: "Financial analysis, budget review, and cost decisions.",
  coo: "Operations coordination, process management, and cross-team work.",
  vp: "Division leadership, team management, and delivery oversight.",
  manager: "Task coordination, team management, and issue triage.",
  engineer: "Coding, debugging, refactoring, testing, and validation.",
};
