import {
  dashboardChangesDroppedWith,
  dashboardChangesKeptWith,
  type ResponsibilityDashboardChange,
  type ResponsibilityDashboardVersionSummary,
} from "@paperclipai/shared";

/**
 * Derivations for the Dashboard's edit module and the proposed-changes card
 * (experimental `enableResponsibilities`): the changes grouped by area, how
 * each reads before and after, and which go together when one is dropped.
 */

export interface DashboardChangeGroup {
  key: string;
  name: string;
  /** The group is a new area. */
  isNew: boolean;
  changes: ResponsibilityDashboardChange[];
}

const AREA_OPS = new Set<ResponsibilityDashboardChange["op"]>(["add_area", "rename_area", "remove_area"]);

function groupKey(change: Pick<ResponsibilityDashboardChange, "groupAreaId" | "groupRef">) {
  if (change.groupRef !== null) return `new:${change.groupRef}`;
  return change.groupAreaId ?? "__none__";
}

/** The changes by area, in the order the agent first named each area; area changes first within a group. */
export function dashboardChangeGroups(changes: readonly ResponsibilityDashboardChange[]): DashboardChangeGroup[] {
  const groups = new Map<string, DashboardChangeGroup>();
  for (const change of changes) {
    const key = groupKey(change);
    const group = groups.get(key) ?? { key, name: change.groupName, isNew: false, changes: [] };
    if (change.op === "add_area") group.isNew = true;
    group.changes.push(change);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    changes: [...group.changes].sort((a, b) => Number(!AREA_OPS.has(a.op)) - Number(!AREA_OPS.has(b.op)) || a.index - b.index),
  }));
}

export interface DashboardChangeWords {
  /** What it reads as today, struck through; null when it is new. */
  before: string | null;
  /** What it will read; null when it goes. */
  after: string | null;
  /** A few muted words when the before and after do not say it on their own. */
  note: string | null;
}

/** How one change reads on the card: a before and an after a person can compare at a glance. */
export function dashboardChangeWords(change: ResponsibilityDashboardChange): DashboardChangeWords {
  switch (change.op) {
    case "add_area":
      return { before: null, after: "New area", note: null };
    case "rename_area":
      return {
        before: change.fromName,
        after: change.name,
        note: change.sharedWith > 0 ? `Also renamed for ${change.sharedWith === 1 ? "1 other person" : `${change.sharedWith} other people`}` : null,
      };
    case "remove_area":
      return { before: null, after: "Remove this area", note: null };
    case "add_responsibility":
      return { before: null, after: change.sentence, note: null };
    case "reword_responsibility":
      return { before: change.fromSentence, after: change.sentence, note: null };
    case "move_responsibility":
      return { before: null, after: change.fromSentence, note: change.fromAreaName ? `Moved from ${change.fromAreaName}` : "Moved here" };
    case "remove_responsibility":
      return { before: change.fromSentence, after: null, note: "Let go" };
  }
}

/**
 * Drop or keep one change. Dropping a new area drops what is filed under it;
 * keeping something filed under a dropped new area keeps the area too.
 */
export function toggleDashboardChange(
  changes: readonly ResponsibilityDashboardChange[],
  dropped: ReadonlySet<number>,
  index: number,
): Set<number> {
  const next = new Set(dropped);
  if (dropped.has(index)) for (const kept of dashboardChangesKeptWith(changes, index)) next.delete(kept);
  else for (const gone of dashboardChangesDroppedWith(changes, index)) next.add(gone);
  return next;
}

/** The indexes to apply; undefined when nothing was dropped (apply them all). */
export function keptDashboardChanges(changes: readonly ResponsibilityDashboardChange[], dropped: ReadonlySet<number>): number[] | undefined {
  if (dropped.size === 0) return undefined;
  return changes.map((change) => change.index).filter((index) => !dropped.has(index));
}

/** For a dropped change that goes because the new area it needs was dropped: that area's name. */
export function droppedWithArea(
  changes: readonly ResponsibilityDashboardChange[],
  dropped: ReadonlySet<number>,
  change: ResponsibilityDashboardChange,
): string | null {
  const needed = change.dependsOn.find((index) => dropped.has(index));
  if (needed === undefined) return null;
  return changes.find((candidate) => candidate.index === needed)?.name ?? null;
}

/** What a kept "remove this area" lets go of, after the kept moves and removals take their items out. */
export function lettingGoWith(
  changes: readonly ResponsibilityDashboardChange[],
  dropped: ReadonlySet<number>,
  change: ResponsibilityDashboardChange,
): string[] {
  const leaving = new Set(changes
    .filter((candidate) => !dropped.has(candidate.index)
      && (candidate.op === "move_responsibility" || candidate.op === "remove_responsibility"))
    .map((candidate) => candidate.responsibilityId));
  // A dropped move out (or removal) leaves the responsibility in the area, so it goes with the area.
  const stayingBehind = changes.filter((candidate) => dropped.has(candidate.index)
    && ((candidate.op === "move_responsibility" && candidate.fromAreaId === change.groupAreaId)
      || (candidate.op === "remove_responsibility" && candidate.groupAreaId === change.groupAreaId)));
  const items = [...change.lettingGo];
  for (const candidate of stayingBehind) {
    const { responsibilityId: id, fromSentence: sentence } = candidate;
    if (id && sentence && !items.some((item) => item.id === id)) items.push({ id, sentence });
  }
  return items.filter((item) => !leaving.has(item.id)).map((item) => item.sentence);
}

/** Who caused a version, in a word or a name. */
export function dashboardVersionWho(version: Pick<ResponsibilityDashboardVersionSummary, "cause" | "actorAgentId">, agentName: (id: string) => string | undefined): string {
  if (version.cause === "restore") return "Restored";
  if (version.cause === "person") return "You";
  return (version.actorAgentId ? agentName(version.actorAgentId) : undefined) ?? "An agent";
}

/** The line the Dashboard shows right after a change, beside Undo. */
export function dashboardChangeLine(version: Pick<ResponsibilityDashboardVersionSummary, "cause" | "summary">): string {
  if (version.cause === "restore") return "Restored an earlier version.";
  return `${version.summary}.`;
}

/** Undo is dismissed per change, in this browser; works without storage. */
export const DASHBOARD_UNDO_DISMISSED_STORAGE_KEY = "paperclip:responsibilities:dashboard-undo-dismissed";

export function readDismissedUndo(): string | null {
  try {
    return globalThis.localStorage?.getItem(DASHBOARD_UNDO_DISMISSED_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeDismissedUndo(versionId: string): void {
  try {
    globalThis.localStorage?.setItem(DASHBOARD_UNDO_DISMISSED_STORAGE_KEY, versionId);
  } catch {
    // Private windows and blocked storage: it stays dismissed for this visit only.
  }
}
