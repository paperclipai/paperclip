import type { Agent } from "@paperclipai/shared";

export const HERMES_ORCHESTRATION_TOOLSETS = ["file", "browser", "mcp", "delegation", "kanban"];
export const HERMES_PAPERCLIP_ADAPTER_VERSION = "0.3.0";
export const HERMES_ADAPTER_MANAGED_YOLO = true;
export const HERMES_PHASE1_APPROVAL_PACKAGE = {
  title: "Approve Hermes-first phase 1 persistent configuration",
  action: "Hermes orchestrator profile proposal and read-only Paperclip visibility only",
  targets: ["yoon-orchestrator", "yoon-research", "yoon-docs"],
  allowed: ["profile templates", "display/draft agent only", "heartbeat disabled", "repo write prohibited"],
  blocked: ["autonomous heartbeat", "Hermes repo write", "direct DB writes", "deploy/send/publish"],
};

export const HERMES_PROFILE_ROSTER = [
  {
    name: "yoon-orchestrator",
    role: "Routes work, decomposes tasks, owns Hermes Kanban",
    toolsets: ["kanban", "memory", "skills", "session_search", "web", "browser"],
    phase: "phase 1",
  },
  {
    name: "yoon-research",
    role: "Public research, market scans, source summaries",
    toolsets: ["web", "browser", "memory", "skills", "session_search"],
    phase: "phase 1",
  },
  {
    name: "yoon-docs",
    role: "Internal docs, handoffs, summaries, procedure drafts",
    toolsets: ["file", "memory", "skills", "session_search"],
    phase: "phase 1",
  },
  {
    name: "yoon-business",
    role: "Business division planning and KPI work",
    toolsets: ["web", "browser", "memory", "skills", "session_search"],
    phase: "phase 2",
  },
  {
    name: "yoon-startup",
    role: "Everyone's Startup division planning",
    toolsets: ["web", "browser", "memory", "skills", "session_search"],
    phase: "phase 2",
  },
  {
    name: "yoon-academy",
    role: "Academy/Tinker operations",
    toolsets: ["web", "browser", "memory", "skills", "session_search"],
    phase: "phase 2",
  },
  {
    name: "yoon-media",
    role: "YouTube/content production pipeline planning",
    toolsets: ["kanban", "web", "browser", "memory", "skills", "session_search"],
    phase: "phase 2",
  },
  {
    name: "yoon-tincolive",
    role: "TincoLive product/development planning",
    toolsets: ["kanban", "web", "browser", "memory", "skills", "session_search"],
    phase: "phase 2",
  },
  {
    name: "yoon-codex-bridge",
    role: "Creates and audits Paperclip issues for Codex implementation",
    toolsets: ["kanban", "web", "memory", "skills", "session_search"],
    phase: "phase 2",
  },
];

export function findYoonCompanyAgent(agents: Agent[] | undefined, keyword: "codex" | "hermes") {
  return agents?.find((agent) => {
    const haystack = `${agent.name} ${agent.title ?? ""} ${agent.adapterType}`.toLowerCase();
    return haystack.includes(keyword);
  }) ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function parseToolsets(config: Record<string, unknown>): string[] {
  const fromString = readString(config.toolsets)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return fromString.length > 0 ? fromString : readStringArray(config.enabledToolsets);
}

function parseMaxTurns(config: Record<string, unknown>, extraArgs: string[]) {
  const configured = readNumber(config.maxTurnsPerRun);
  if (configured !== null) {
    return { value: configured, source: "maxTurnsPerRun" as const };
  }

  for (let index = 0; index < extraArgs.length; index += 1) {
    const arg = extraArgs[index];
    if (arg === "--max-turns") {
      const value = Number(extraArgs[index + 1]);
      return Number.isFinite(value) ? { value, source: "extraArgs" as const } : null;
    }
    if (arg.startsWith("--max-turns=")) {
      const value = Number(arg.slice("--max-turns=".length));
      return Number.isFinite(value) ? { value, source: "extraArgs" as const } : null;
    }
  }

  return null;
}

export function getYoonCompanyHermesStatus(agent: Agent | null) {
  const config = asRecord(agent?.adapterConfig);
  const toolsets = parseToolsets(config);
  const extraArgs = readStringArray(config.extraArgs);
  const maxTurns = parseMaxTurns(config, extraArgs);
  const missingToolsets = toolsets.length > 0
    ? HERMES_ORCHESTRATION_TOOLSETS.filter((toolset) => !toolsets.includes(toolset))
    : [];
  const permissions = asRecord(agent?.permissions);
  const canCreateAgents = permissions.canCreateAgents === true;
  const persistSession = readBoolean(config.persistSession);
  const explicitYolo = extraArgs.includes("--yolo");
  const duplicateYoloRisk = HERMES_ADAPTER_MANAGED_YOLO && explicitYolo;

  return {
    extraArgs,
    toolsets,
    missingToolsets,
    persistSession,
    explicitYolo,
    adapterManagedYolo: HERMES_ADAPTER_MANAGED_YOLO,
    duplicateYoloRisk,
    yolo: explicitYolo || HERMES_ADAPTER_MANAGED_YOLO,
    maxTurns,
    canCreateAgents,
    title: agent?.title ?? "",
    adapterType: agent?.adapterType ?? null,
    orchestrationReady: Boolean(agent) && missingToolsets.length === 0 && persistSession === true,
  };
}
