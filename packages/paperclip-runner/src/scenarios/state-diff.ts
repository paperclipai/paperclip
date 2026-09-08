import type {
  CapabilityFixtureState,
  CapabilityJsonValue,
} from "../mock-core/capability-control-plane-types.js";
import type {
  CapabilityDiffDomain,
  CapabilityDiffDomainSection,
  CapabilityDiffFieldChange,
  CapabilityDiffRow,
  CapabilityStateDiff,
} from "../scenarios/scenario-explorer-types.js";

/**
 * Immutable before/after diff of the mock fixture state, grouped by the ten
 * entity domains the Capability plan names. The browser renders this verbatim; it
 * performs no diffing of its own (UX map §4.3).
 */

type Entity = Record<string, unknown> & { id: string };

const DOMAINS: Array<{
  domain: CapabilityDiffDomain;
  select: (state: CapabilityFixtureState) => Entity[];
  noun: string;
}> = [
  { domain: "tasks", select: (state) => state.tasks as unknown as Entity[], noun: "task" },
  { domain: "comments", select: (state) => state.comments as unknown as Entity[], noun: "comment" },
  { domain: "documents", select: (state) => state.documents as unknown as Entity[], noun: "document" },
  { domain: "interactions", select: (state) => state.interactions as unknown as Entity[], noun: "interaction" },
  { domain: "approvals", select: (state) => state.approvals as unknown as Entity[], noun: "approval" },
  {
    domain: "artifacts",
    select: (state) => [...state.artifacts, ...state.workProducts] as unknown as Entity[],
    noun: "artifact",
  },
  { domain: "blockers", select: (state) => state.blockers as unknown as Entity[], noun: "blocker" },
  {
    domain: "workspace",
    select: (state) => state.workspaceServices as unknown as Entity[],
    noun: "service",
  },
  { domain: "budget", select: (state) => state.budgets as unknown as Entity[], noun: "budget" },
  {
    domain: "run",
    select: (state) => state.runs.map((run) => ({ ...run, events: run.events.length })) as unknown as Entity[],
    noun: "run",
  },
];

export function capabilityStateDiff(
  before: CapabilityFixtureState,
  after: CapabilityFixtureState,
): CapabilityStateDiff {
  return {
    schema: "paperclip.capability.state-diff.v1",
    beforeRevision: before.revision,
    afterRevision: after.revision,
    domains: DOMAINS.map(({ domain, select, noun }) =>
      domainSection(domain, noun, select(before), select(after)),
    ),
  };
}

function domainSection(
  domain: CapabilityDiffDomain,
  noun: string,
  before: Entity[],
  after: Entity[],
): CapabilityDiffDomainSection {
  const beforeById = new Map(before.map((entity) => [entity.id, entity]));
  const afterById = new Map(after.map((entity) => [entity.id, entity]));
  const rows: CapabilityDiffRow[] = [];

  for (const [id, entity] of afterById) {
    const previous = beforeById.get(id);
    if (previous === undefined) {
      rows.push({ entityId: id, change: "added", fields: describe(entity) });
      continue;
    }
    const fields = fieldChanges(previous, entity);
    if (fields.length > 0) rows.push({ entityId: id, change: "changed", fields });
  }
  for (const [id, entity] of beforeById) {
    if (!afterById.has(id)) rows.push({ entityId: id, change: "removed", fields: describe(entity) });
  }
  rows.sort((left, right) => left.entityId.localeCompare(right.entityId));

  const counts = rows.reduce<Record<string, number>>((totals, row) => {
    totals[row.change] = (totals[row.change] ?? 0) + 1;
    return totals;
  }, {});
  const summary =
    rows.length === 0
      ? "unchanged"
      : (["added", "changed", "removed"] as const)
          .filter((change) => counts[change] !== undefined)
          .map((change) => `${counts[change]} ${change}`)
          .join(" · ");

  return {
    domain,
    summary: rows.length === 0 ? summary : `${summary} ${rows.length === 1 ? noun : `${noun}s`}`,
    changed: rows.length > 0,
    rows,
    afterSnapshot: JSON.parse(JSON.stringify(after)) as CapabilityJsonValue,
  };
}

function describe(entity: Entity): CapabilityDiffFieldChange[] {
  return Object.entries(entity)
    .filter(([field]) => field !== "id")
    .map(([field, value]) => ({ field, before: null, after: render(value) }))
    .filter((change) => change.after !== null)
    .sort((left, right) => left.field.localeCompare(right.field));
}

function fieldChanges(before: Entity, after: Entity): CapabilityDiffFieldChange[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return fields
    .filter((field) => field !== "id")
    .map((field) => ({ field, before: render(before[field]), after: render(after[field]) }))
    .filter((change) => change.before !== change.after);
}

function render(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 160 ? `${value.slice(0, 157)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const json = JSON.stringify(value);
  return json.length > 160 ? `${json.slice(0, 157)}…` : json;
}
