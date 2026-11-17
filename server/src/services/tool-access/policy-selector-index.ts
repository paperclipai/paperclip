/**
 * Compiled tool-policy selectors and the per-company policy index.
 *
 * A tools/list decision runs once per listed tool. Matching every enabled
 * policy's raw selector for every tool made each listing cost tools x policies
 * selector checks on the main thread. Compiling the selectors once per decision
 * batch and indexing policies by the selector key that rejects most
 * (catalogEntryId, then toolName) limits each decision to the policies that can
 * match the tool. The compiled matcher has the same semantics as the raw
 * selector match in tool-access-policy.ts.
 */

export type PolicySelectorContext = {
  actorType: string;
  agentId: string | null;
  projectId: string | null;
  routineId: string | null;
  issueId: string | null;
  gatewayId: string | null;
  applicationId: string | null;
  connectionId: string | null;
  catalogEntryId: string | null;
  applicationKey: string | null;
  providerType: string | null;
  toolName: string;
  upstreamToolName: string | null;
  riskLevel: string | null;
};

type ExactKey = Exclude<keyof PolicySelectorContext, "toolName" | "upstreamToolName">;

// Selector key pairs matched against one context value each.
const EXACT_SELECTOR_KEYS: ReadonlyArray<readonly [ExactKey, string]> = [
  ["actorType", "actorTypes"],
  ["agentId", "agentIds"],
  ["projectId", "projectIds"],
  ["routineId", "routineIds"],
  ["issueId", "issueIds"],
  ["gatewayId", "gatewayIds"],
  ["applicationId", "applicationIds"],
  ["connectionId", "connectionIds"],
  ["catalogEntryId", "catalogEntryIds"],
  ["applicationKey", "applicationKeys"],
  ["providerType", "providerTypes"],
  ["riskLevel", "riskLevels"],
];

export function listValues(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

type Constraint = { single: string | null; many: string[] };

export type CompiledPolicySelector = {
  matches(ctx: PolicySelectorContext): boolean;
  /** Values the context catalogEntryId must equal, or null when unconstrained. */
  readonly catalogEntryIds: readonly string[] | null;
  /** Values one of the context tool names must equal, or null when unconstrained. */
  readonly toolNames: readonly string[] | null;
};

function constraint(selector: Record<string, unknown>, singleKey: string, pluralKey: string): Constraint | null {
  const raw = selector[singleKey];
  // An empty single value does not constrain, as in the raw selector match.
  const single = typeof raw === "string" && raw ? raw : null;
  const many = listValues(selector[pluralKey]);
  return single || many.length > 0 ? { single, many } : null;
}

function indexValues(value: Constraint | null): string[] | null {
  if (!value) return null;
  return value.single ? [value.single] : [...new Set(value.many)];
}

export function compilePolicySelector(selector: unknown): CompiledPolicySelector {
  const s: Record<string, unknown> = selector && typeof selector === "object" ? selector as Record<string, unknown> : {};
  const exact: Array<{ key: ExactKey } & Constraint> = [];
  let catalogEntry: Constraint | null = null;
  for (const [singleKey, pluralKey] of EXACT_SELECTOR_KEYS) {
    const value = constraint(s, singleKey, pluralKey);
    if (!value) continue;
    exact.push({ key: singleKey, ...value });
    if (singleKey === "catalogEntryId") catalogEntry = value;
  }
  const toolName = constraint(s, "toolName", "toolNames");
  return {
    catalogEntryIds: indexValues(catalogEntry),
    toolNames: indexValues(toolName),
    matches(ctx) {
      for (const { key, single, many } of exact) {
        const actual = ctx[key];
        if (single && actual !== single) return false;
        if (many.length > 0 && !(actual && many.includes(actual))) return false;
      }
      if (toolName) {
        const { single, many } = toolName;
        // Constraint values are never empty, so an empty context name never matches.
        const names = [ctx.toolName, ctx.upstreamToolName];
        if (single && !names.includes(single)) return false;
        if (many.length > 0 && !many.some((value) => names.includes(value))) return false;
      }
      return true;
    },
  };
}

export type PolicySelectorIndex<T> = {
  readonly entries: readonly T[];
  /** Entries whose selector can match the context, in their original order. */
  candidates(ctx: PolicySelectorContext): T[];
};

/**
 * Indexes entries (already in evaluation order) by catalogEntryId, then by
 * toolName for entries without a catalogEntryId selector. Entries with neither
 * are candidates for every context. A context that a selector rejects on its
 * index key can never match it, so leaving it out changes no decision.
 */
export function indexPoliciesBySelector<T>(
  entries: readonly T[],
  selectorOf: (entry: T) => CompiledPolicySelector,
): PolicySelectorIndex<T> {
  const byCatalogEntryId = new Map<string, number[]>();
  const byToolName = new Map<string, number[]>();
  const unindexed: number[] = [];
  const add = (buckets: Map<string, number[]>, keys: readonly string[], position: number) => {
    for (const key of keys) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(position);
      else buckets.set(key, [position]);
    }
  };
  entries.forEach((entry, position) => {
    const selector = selectorOf(entry);
    if (selector.catalogEntryIds) add(byCatalogEntryId, selector.catalogEntryIds, position);
    else if (selector.toolNames) add(byToolName, selector.toolNames, position);
    else unindexed.push(position);
  });
  return {
    entries,
    candidates(ctx) {
      const lists: number[][] = [];
      if (ctx.catalogEntryId) {
        const bucket = byCatalogEntryId.get(ctx.catalogEntryId);
        if (bucket) lists.push(bucket);
      }
      for (const name of new Set([ctx.toolName, ctx.upstreamToolName])) {
        const bucket = name ? byToolName.get(name) : undefined;
        if (bucket) lists.push(bucket);
      }
      if (unindexed.length > 0) lists.push(unindexed);
      if (lists.length === 0) return [];
      if (lists.length === 1) return lists[0]!.map((position) => entries[position]!);
      const positions = [...new Set(lists.flat())].sort((left, right) => left - right);
      return positions.map((position) => entries[position]!);
    },
  };
}
