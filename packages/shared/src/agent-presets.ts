import type { AgentAdapterType, AgentRole, AgentIconName } from "./constants.js";

export interface AgentPreset {
  id: string;
  name: string;
  title: string;
  role: AgentRole;
  icon: AgentIconName;
  description: string;
  adapterType: AgentAdapterType;
  category: "engineering" | "leadership" | "specialist" | "custom";
  defaultProvider: "claude" | "qwen";
}

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: "claude-engineer",
    name: "Engineer",
    title: "Software Engineer",
    role: "engineer",
    icon: "code",
    description: "Full-stack engineer powered by Claude Code",
    adapterType: "claude_local",
    category: "engineering",
    defaultProvider: "qwen",
  },
  {
    id: "codex-engineer",
    name: "Codex Engineer",
    title: "Software Engineer",
    role: "engineer",
    icon: "terminal",
    description: "Engineer powered by OpenAI Codex",
    adapterType: "codex_local",
    category: "engineering",
    defaultProvider: "claude",
  },
  {
    id: "cursor-developer",
    name: "Cursor Dev",
    title: "Software Developer",
    role: "engineer",
    icon: "sparkles",
    description: "Developer powered by Cursor",
    adapterType: "cursor",
    category: "engineering",
    defaultProvider: "claude",
  },
  {
    id: "opencode-developer",
    name: "OpenCode Dev",
    title: "Software Developer",
    role: "engineer",
    icon: "git-branch",
    description: "Developer powered by OpenCode",
    adapterType: "opencode_local",
    category: "engineering",
    defaultProvider: "claude",
  },
  {
    id: "claude-qa",
    name: "QA Agent",
    title: "QA Engineer",
    role: "qa",
    icon: "bug",
    description: "Testing and quality assurance with Claude",
    adapterType: "claude_local",
    category: "specialist",
    defaultProvider: "qwen",
  },
  {
    id: "claude-devops",
    name: "DevOps Agent",
    title: "DevOps Engineer",
    role: "devops",
    icon: "cog",
    description: "Infrastructure and CI/CD with Claude",
    adapterType: "claude_local",
    category: "specialist",
    defaultProvider: "qwen",
  },
  {
    id: "claude-pm",
    name: "PM Agent",
    title: "Product Manager",
    role: "pm",
    icon: "target",
    description: "Product management and planning with Claude",
    adapterType: "claude_local",
    category: "leadership",
    defaultProvider: "qwen",
  },
  {
    id: "claude-researcher",
    name: "Researcher",
    title: "Research Analyst",
    role: "researcher",
    icon: "microscope",
    description: "Research and analysis with Claude",
    adapterType: "claude_local",
    category: "specialist",
    defaultProvider: "qwen",
  },
  {
    id: "claude-designer",
    name: "Designer",
    title: "UI/UX Designer",
    role: "designer",
    icon: "wand",
    description: "Design and UX work with Claude",
    adapterType: "claude_local",
    category: "specialist",
    defaultProvider: "qwen",
  },
  {
    id: "claude-cto",
    name: "CTO",
    title: "Chief Technology Officer",
    role: "cto",
    icon: "crown",
    description: "Technical leadership with Claude",
    adapterType: "claude_local",
    category: "leadership",
    defaultProvider: "claude",
  },
];

/** Maps credential type + Claude model to display name in Paperclip UI */
export const QWEN_MODEL_DISPLAY: Record<string, string> = {
  "claude-opus-4-6": "Qwen3 Coder Plus",
  "claude-opus-4-5-20250918": "Qwen3 Coder Plus",
  "opus": "Qwen3 Coder Plus",
  "claude-sonnet-4-6": "Qwen3 Coder Next",
  "claude-sonnet-4-5-20241022": "Qwen3 Coder Next",
  "sonnet": "Qwen3 Coder Next",
  "claude-haiku-4-5-20251001": "Qwen3.5 Plus",
  "claude-haiku-3-5-20241022": "Qwen3.5 Plus",
  "haiku": "Qwen3.5 Plus",
};

/** Given credential type and model ID, return display name */
export function getModelDisplayName(credentialType: string | null | undefined, modelId: string | null | undefined): string {
  if (!modelId) return "Unknown";
  if (credentialType === "qwen_api_key") {
    const lower = modelId.toLowerCase().trim();
    if (QWEN_MODEL_DISPLAY[lower]) return QWEN_MODEL_DISPLAY[lower];
    if (lower.includes("opus")) return "Qwen3 Coder Plus";
    if (lower.includes("sonnet")) return "Qwen3 Coder Next";
    if (lower.includes("haiku")) return "Qwen3.5 Plus";
    return `Qwen (${modelId})`;
  }
  // Claude models - clean up display
  if (modelId.includes("opus")) return "Claude Opus";
  if (modelId.includes("sonnet")) return "Claude Sonnet";
  if (modelId.includes("haiku")) return "Claude Haiku";
  return modelId;
}

/** Provider labels for UI */
export const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  qwen: "Qwen",
};

/** Roles that default to Claude (strategic) */
export const STRATEGIC_ROLES = new Set(["ceo", "cto", "cfo"]);
