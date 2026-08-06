import type { ToolProfileBindingTargetType } from "@paperclipai/shared";

type BindingLike = {
  profileId: string;
  targetType: ToolProfileBindingTargetType;
  priority: number;
  createdAt: Date | string;
};

const TOOL_PROFILE_SCOPE_PRECEDENCE: Record<ToolProfileBindingTargetType, number> = {
  // Named gateways bind one concrete MCP endpoint instance, so they should
  // override broader run, agent, and company defaults when both match.
  gateway: 0,
  issue: 1,
  routine: 2,
  agent: 3,
  project: 4,
  company: 5,
};

function createdAtMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export function toolProfileBindingScopePrecedence(targetType: ToolProfileBindingTargetType): number {
  return TOOL_PROFILE_SCOPE_PRECEDENCE[targetType];
}

export function narrowestScopeBindings<T extends BindingLike>(bindings: T[]): T[] {
  if (bindings.length === 0) return [];
  const winningScope = Math.min(...bindings.map((binding) => toolProfileBindingScopePrecedence(binding.targetType)));
  return bindings
    .filter((binding) => toolProfileBindingScopePrecedence(binding.targetType) === winningScope)
    .sort((a, b) =>
      a.priority - b.priority
      || createdAtMillis(a.createdAt) - createdAtMillis(b.createdAt)
      || a.profileId.localeCompare(b.profileId)
    );
}

export function profileIdsInBindingOrder<T extends Pick<BindingLike, "profileId">>(bindings: T[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const binding of bindings) {
    if (seen.has(binding.profileId)) continue;
    seen.add(binding.profileId);
    ordered.push(binding.profileId);
  }
  return ordered;
}
