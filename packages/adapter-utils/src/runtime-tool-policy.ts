export type RuntimeToolSurface =
  | "web.search"
  | "web.fetch"
  | "browser.automation"
  | "network.outbound"
  | `mcp.server:${string}`
  | `connector:${string}`
  | `plugin:${string}`;

export type RuntimeToolPolicyProfile = "blind_judge";

export interface RuntimeToolPolicyInput {
  profile?: RuntimeToolPolicyProfile | string | null;
  allow?: unknown;
  deny?: unknown;
  enforcement?: "required" | "best_effort" | string | null;
  paperclipReadIssueIds?: unknown;
}

export interface ResolvedRuntimeToolPolicy {
  profile: RuntimeToolPolicyProfile | null;
  enforcement: "required" | "best_effort";
  allow: RuntimeToolSurface[];
  deny: RuntimeToolSurface[];
  restricted: boolean;
  source: "agent_runtime_config" | "context" | "none";
  unsupported: string[];
  paperclipReadIssueIds?: string[];
}

const BLIND_JUDGE_DENY: RuntimeToolSurface[] = [
  "web.search",
  "web.fetch",
  "browser.automation",
  "network.outbound",
  "mcp.server:*",
  "connector:*",
  "plugin:*",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSurface(value: unknown): RuntimeToolSurface | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (
    trimmed === "web.search" ||
    trimmed === "web.fetch" ||
    trimmed === "browser.automation" ||
    trimmed === "network.outbound"
  ) {
    return trimmed;
  }
  if (
    trimmed.startsWith("mcp.server:") ||
    trimmed.startsWith("connector:") ||
    trimmed.startsWith("plugin:")
  ) {
    return trimmed as RuntimeToolSurface;
  }
  return null;
}

function normalizeSurfaces(value: unknown): RuntimeToolSurface[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeSurface).filter((entry): entry is RuntimeToolSurface => entry !== null))];
}

function normalizeIssueIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function readPolicyInput(value: unknown): RuntimeToolPolicyInput | null {
  if (!isRecord(value)) return null;
  return value as RuntimeToolPolicyInput;
}

export function resolveRuntimeToolPolicy(input: {
  agentRuntimeConfig?: unknown;
  context?: unknown;
}): ResolvedRuntimeToolPolicy {
  const contextPolicy = readPolicyInput(isRecord(input.context) ? input.context.paperclipRuntimeToolPolicy : null);
  const runtimeConfig = isRecord(input.agentRuntimeConfig) ? input.agentRuntimeConfig : {};
  const agentPolicy = readPolicyInput(runtimeConfig.runtimeToolPolicy);
  const raw = contextPolicy ?? agentPolicy;
  const source = contextPolicy ? "context" : agentPolicy ? "agent_runtime_config" : "none";
  const profile = raw?.profile === "blind_judge" ? "blind_judge" : null;
  const enforcement = raw?.enforcement === "best_effort" ? "best_effort" : "required";

  if (profile === "blind_judge") {
    const explicitAllow = normalizeSurfaces(raw?.allow);
    const explicitDeny = normalizeSurfaces(raw?.deny);
    return {
      profile,
      enforcement,
      allow: explicitAllow,
      deny: [...new Set([...BLIND_JUDGE_DENY, ...explicitDeny])],
      restricted: true,
      source,
      unsupported: [],
      paperclipReadIssueIds: normalizeIssueIds(raw?.paperclipReadIssueIds),
    };
  }

  return {
    profile: null,
    enforcement,
    allow: normalizeSurfaces(raw?.allow),
    deny: normalizeSurfaces(raw?.deny),
    restricted: false,
    source,
    unsupported: [],
    paperclipReadIssueIds: [],
  };
}

export function runtimeToolPolicyDenies(policy: ResolvedRuntimeToolPolicy, surface: RuntimeToolSurface): boolean {
  if (policy.deny.includes(surface)) return true;
  if (surface.startsWith("mcp.server:") && policy.deny.includes("mcp.server:*")) return true;
  if (surface.startsWith("connector:") && policy.deny.includes("connector:*")) return true;
  if (surface.startsWith("plugin:") && policy.deny.includes("plugin:*")) return true;
  return false;
}

export function runtimeToolPolicyAllows(policy: ResolvedRuntimeToolPolicy, surface: RuntimeToolSurface): boolean {
  return policy.allow.includes(surface);
}

export function summarizeRuntimeToolPolicy(policy: ResolvedRuntimeToolPolicy): string {
  const sortedDeny = [...new Set(policy.deny)].sort();
  const sortedAllow = [...new Set(policy.allow)].sort();
  const sortedUnsupported = [...new Set(policy.unsupported)].sort();
  return [
    `runtimeToolPolicy(profile=${policy.profile ?? "none"}, enforcement=${policy.enforcement}, restricted=${policy.restricted}, source=${policy.source})`,
    `granted=${sortedAllow.length > 0 ? sortedAllow.join(",") : "none"}`,
    `denied=${sortedDeny.length > 0 ? sortedDeny.join(",") : "none"}`,
    `unsupported=${sortedUnsupported.length > 0 ? sortedUnsupported.join(",") : "none"}`,
    `paperclipReadIssueIds=${(policy.paperclipReadIssueIds?.length ?? 0) > 0 ? policy.paperclipReadIssueIds!.join(",") : "none"}`,
  ].join("; ");
}
