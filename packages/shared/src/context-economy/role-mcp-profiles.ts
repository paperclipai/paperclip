// Canonical, runtime-authoritative role → eager MCP profile.
//
// Paperclip injects managed MCP servers into agent runtimes. Historically the
// eager set was over-broad: a non-UI Engineer run could receive Cloudflare +
// Playwright + Storybook even though the Engineer policy is Git-only. This
// module makes the role profile the single source of truth for which MCP
// servers are eagerly injected, and lets task classification widen the set only
// when the scope genuinely requires it (UI → shadcn/storybook/playwright, infra
// → cloudflare). Archived/disabled app bindings NEVER count as active eager
// context.

export type AgentRole =
  | "engineer"
  | "cto"
  | "board-operator"
  | "agent-developer"
  | (string & {});

export type TaskCategory = "ui" | "infra" | "technical" | "generic" | (string & {});

export interface RoleMcpProfile {
  role: string;
  /**
   * MCP server names eagerly injected for this role by default (when no task
   * category widens the set).
   */
  defaultEagerMcp: string[];
  /**
   * Hard cap on the number of eager MCP servers (excluding the always-allowed
   * Git server) for a plain technical task. Undefined = no extra cap beyond the
   * default set.
   */
  maxEagerMcpTechnical?: number;
  description: string;
}

/**
 * Canonical role profiles. `github` is the Git server and is the only default
 * eager MCP for the Engineer. The CTO defaults to at most one relevant eager
 * MCP for technical tasks; the exact server is chosen by task scope, so the
 * default set is empty and widened via `scopeRequiredMcp`.
 */
export const ROLE_MCP_PROFILES: Record<string, RoleMcpProfile> = {
  engineer: {
    role: "engineer",
    defaultEagerMcp: ["github"],
    description:
      "Engineer default for non-UI/non-infra technical tasks = Git-only eager MCP. Cloudflare, Playwright, Storybook, Shadcn are absent unless task classification/scope explicitly requires them.",
  },
  cto: {
    role: "cto",
    defaultEagerMcp: [],
    maxEagerMcpTechnical: 1,
    description:
      "CTO default <=1 relevant eager MCP for technical tasks unless scope requires more.",
  },
  "board-operator": {
    role: "board-operator",
    defaultEagerMcp: ["github"],
    description: "Board operator uses Git-only eager MCP by default.",
  },
  "agent-developer": {
    role: "agent-developer",
    defaultEagerMcp: ["github"],
    description: "Agent developer uses Git-only eager MCP by default.",
  },
};

const DEFAULT_PROFILE: RoleMcpProfile = {
  role: "__default__",
  defaultEagerMcp: ["github"],
  description: "Fallback profile: Git-only eager MCP.",
};

/**
 * Task-category → additional eager MCP names. Only applied when the task
 * category is explicitly one of these; a plain technical/generic task never
 * widens beyond the role default.
 */
export const CATEGORY_EAGER_MCP: Record<TaskCategory, string[]> = {
  ui: ["github", "shadcn", "storybook", "playwright"],
  infra: ["github", "cloudflare"],
  technical: [],
  generic: [],
};

export interface CandidateMcpServer {
  name: string;
  /** A disabled binding must never be counted as active eager context. */
  enabled?: boolean;
  /** An archived binding must never be counted as active eager context. */
  archived?: boolean;
}

export interface NarrowMcpInput {
  role: AgentRole;
  taskCategory?: TaskCategory;
  candidates: CandidateMcpServer[];
  /**
   * Servers explicitly required by the task scope (e.g. a UI task that needs
   * Storybook). Always allowed on top of the role/category set.
   */
  scopeRequiredMcp?: string[];
}

export interface NarrowMcpResult {
  servers: Array<{ name: string }>;
  /** Names dropped because they were not authorized for this role/scope. */
  droppedUnauthorized: string[];
  /** Names dropped because they were disabled or archived. */
  droppedInactive: string[];
}

function profileFor(role: AgentRole): RoleMcpProfile {
  return ROLE_MCP_PROFILES[role] ?? DEFAULT_PROFILE;
}

/**
 * Narrow the candidate MCP servers to the eager set authorized for the given
 * role + task category + scope. Pure and deterministic; safe to call on every
 * run start so the canonical profile stays authoritative at runtime.
 */
export function narrowEagerMcpServers(input: NarrowMcpInput): NarrowMcpResult {
  const profile = profileFor(input.role);
  const category = (input.taskCategory ?? "technical") as TaskCategory;
  const categoryExtra = CATEGORY_EAGER_MCP[category] ?? [];

  const allowed = new Set<string>([
    ...profile.defaultEagerMcp,
    ...categoryExtra,
    ...(input.scopeRequiredMcp ?? []),
  ]);

  const servers: Array<{ name: string }> = [];
  const droppedUnauthorized: string[] = [];
  const droppedInactive: string[] = [];

  for (const candidate of input.candidates) {
    if (candidate.enabled === false || candidate.archived === true) {
      droppedInactive.push(candidate.name);
      continue;
    }
    if (!allowed.has(candidate.name)) {
      droppedUnauthorized.push(candidate.name);
      continue;
    }
    // De-dupe by name (keep first occurrence).
    if (!servers.some((s) => s.name === candidate.name)) {
      servers.push({ name: candidate.name });
    }
  }

  // Enforce the technical-task cap (excluding the always-allowed Git server).
  if (
    profile.maxEagerMcpTechnical !== undefined &&
    category === "technical" &&
    profile.maxEagerMcpTechnical >= 0
  ) {
    const gitName = profile.defaultEagerMcp[0];
    const git = servers.filter((s) => s.name === gitName);
    const others = servers.filter((s) => s.name !== gitName);
    if (others.length > profile.maxEagerMcpTechnical) {
      const trimmed = others.slice(0, profile.maxEagerMcpTechnical);
      const removed = others.slice(profile.maxEagerMcpTechnical).map((s) => s.name);
      droppedUnauthorized.push(...removed);
      servers.length = 0;
      servers.push(...git, ...trimmed);
    }
  }

  return { servers, droppedUnauthorized, droppedInactive };
}
