import type { AgentCapabilityMcpServer } from "@paperclipai/shared";

export type CapabilityCategoryKey = "mcp" | "tools" | "skills" | "knowledge";

export type CapabilityRiskClass = "low" | "medium" | "high";

export interface CapabilityCategoryGroup {
  key: CapabilityCategoryKey;
  label: string;
  description: string;
  status: "available" | "coming_soon";
  comingSoonNote?: string;
}

export const capabilityCategoryGroups: CapabilityCategoryGroup[] = [
  {
    key: "mcp",
    label: "MCP servers",
    description: "Model Context Protocol servers the agent should request when desired config is applied.",
    status: "available",
  },
  {
    key: "tools",
    label: "Tools",
    description: "Standalone agent tools.",
    status: "coming_soon",
    comingSoonNote: "Tool catalog not implemented yet — desired-only placeholder.",
  },
  {
    key: "skills",
    label: "Skills",
    description: "Reusable agent skill bundles.",
    status: "coming_soon",
    comingSoonNote: "Skill catalog not implemented yet — desired-only placeholder.",
  },
  {
    key: "knowledge",
    label: "Knowledge",
    description: "Knowledge sources / retrieval bundles.",
    status: "coming_soon",
    comingSoonNote: "Knowledge catalog not implemented yet — desired-only placeholder.",
  },
];

export interface McpPresetEntry {
  id: string;
  displayName: string;
  provider: AgentCapabilityMcpServer["provider"];
  source: string;
  description: string;
  riskClass: CapabilityRiskClass;
  approvalPosture: "no_live_action" | "approval_required_for_live_action";
  transport: AgentCapabilityMcpServer["transport"];
  command?: string;
  remoteUrl?: string;
  requiredSecretNames: string[];
  tags: string[];
  /**
   * Optional safety / configuration guidance attached to the preset. When the
   * preset is materialised into an `AgentCapabilityMcpServer` draft, this
   * string is copied into the server's `notes` field so the hint surfaces in
   * the Advanced-JSON view and any downstream apply-preview consumers.
   */
  safetyNotes?: string;
}

export const mcpPresetCatalog: McpPresetEntry[] = [
  {
    id: "paperclip-local",
    displayName: "Paperclip MCP",
    provider: "manual",
    source: "Paperclip",
    description:
      "First-party Paperclip MCP server. Exposes Paperclip control-plane tools to the agent once approved.",
    riskClass: "low",
    approvalPosture: "no_live_action",
    transport: "stdio",
    command: "npx -y @paperclipai/mcp-server",
    requiredSecretNames: ["PAPERCLIP_API_KEY"],
    tags: ["paperclip", "control-plane", "first-party"],
  },
  {
    id: "filesystem",
    displayName: "Filesystem (full read/write)",
    provider: "official_registry",
    source: "modelcontextprotocol/servers — main/src/filesystem",
    description:
      "Reference filesystem server from modelcontextprotocol/servers. The server exposes write_file, edit_file, move_file, and create_directory tools — there is no CLI read-only flag and read-only behaviour can only be enforced by an external sandbox (e.g. a Docker bind mount with `:ro`). The server also requires at least one allowed-directory argument or it errors at init; configure those in the command/args before any live apply.",
    riskClass: "high",
    approvalPosture: "approval_required_for_live_action",
    transport: "stdio",
    command: "npx -y @modelcontextprotocol/server-filesystem",
    requiredSecretNames: [],
    tags: ["filesystem", "read-write", "local", "sandbox-required"],
    safetyNotes:
      "Append one or more allowed-directory paths to the command before live apply (e.g. `npx -y @modelcontextprotocol/server-filesystem /srv/agent-sandbox`). Server-side enforcement of read-only access requires an external sandbox harness (Docker `:ro` bind mount or equivalent) which is not implemented in this PR.",
  },
  {
    id: "github",
    displayName: "GitHub MCP server",
    provider: "official_registry",
    source: "github/github-mcp-server",
    description:
      "Actively maintained GitHub MCP server published by GitHub (github/github-mcp-server, distributed as a Go binary and a container image at ghcr.io/github/github-mcp-server). Replaces the deprecated @modelcontextprotocol/server-github npm package. The default preset command runs the server in its standard, write-capable mode (issues, PRs, contents). The server does support a strict server-side read-only mode (local `--read-only` flag or `GITHUB_READ_ONLY=true` env; remote `X-MCP-Readonly` header or `/readonly` URL) that filters out write tools, but this preset does not enable it — read-only posture must be configured explicitly before any live apply.",
    riskClass: "high",
    approvalPosture: "approval_required_for_live_action",
    transport: "stdio",
    command: "docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server",
    requiredSecretNames: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    tags: ["github", "external", "write-capable"],
    safetyNotes:
      "Default preset is write-capable. For a safe read-only posture, both enable the server's read-only mode (local `--read-only` or `GITHUB_READ_ONLY=true`; remote `X-MCP-Readonly` header or `/readonly` URL) AND mint a fine-grained, read-scoped GITHUB_PERSONAL_ACCESS_TOKEN before live apply — token scope alone is not the enforcement boundary when the server is started write-capable.",
  },
  {
    id: "fetch-http",
    displayName: "Fetch (HTTP)",
    provider: "official_registry",
    source: "modelcontextprotocol/servers — main/src/fetch (Python mcp-server-fetch)",
    description:
      "Official MCP fetch server. The reference implementation is the Python package mcp-server-fetch and is invoked via `uvx mcp-server-fetch` (the npm package @modelcontextprotocol/server-fetch does not exist). External network access is live and remains approval-gated before any live apply.",
    riskClass: "medium",
    approvalPosture: "approval_required_for_live_action",
    transport: "stdio",
    command: "uvx mcp-server-fetch",
    requiredSecretNames: [],
    tags: ["fetch", "http", "external"],
    safetyNotes:
      "Requires the `uv`/`uvx` Python launcher on the host; install before live apply. The server performs arbitrary outbound HTTP requests on behalf of the agent.",
  },
];

export function presetToDesiredMcpServer(preset: McpPresetEntry): AgentCapabilityMcpServer {
  return {
    id: preset.id,
    provider: preset.provider,
    catalogId: preset.id,
    displayName: preset.displayName,
    transport: preset.transport,
    command: preset.command ?? null,
    remoteUrl: preset.remoteUrl ?? null,
    requiredSecretNames: preset.requiredSecretNames,
    desiredState: "enabled",
    liveState: "not_installed",
    notes: preset.safetyNotes ?? null,
  };
}
