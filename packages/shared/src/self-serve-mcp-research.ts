import manifest from "./self-serve-mcp-research.json" with { type: "json" };
import type { SelfServeMcpResearchManifest } from "./types/app-definition.js";

export const SELF_SERVE_MCP_RESEARCH = manifest as SelfServeMcpResearchManifest;
export const SELF_SERVE_MCP_CANDIDATES = SELF_SERVE_MCP_RESEARCH.entries.filter(
  (entry) => entry.status === "self_serve",
);
export const BLOCKED_MCP_PROVIDERS = SELF_SERVE_MCP_RESEARCH.entries.filter(
  (entry) => entry.status === "blocked",
);
