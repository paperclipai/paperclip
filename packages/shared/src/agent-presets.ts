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
  },
];
