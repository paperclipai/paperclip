import type { ResponsibilityArea, ResponsibilityWithRollup } from "@paperclipai/shared";
import { groupByArea, responsibilityPath } from "./responsibilities";
import { activeResponsibilities } from "./responsibility-views";

/**
 * Derivations for the Dashboard's "Outline v2" view (experimental,
 * `enableResponsibilities`): areas, and under each the responsibilities as
 * one sentence each. Nothing here reads status: the view shows none.
 */

type AreaRef = Pick<ResponsibilityArea, "id" | "title" | "status">;

/** The collapse key of the group of responsibilities filed under no area. */
export const OUTLINE_V2_NO_AREA_KEY = "__no_area__";

/** Where each area's collapsed state is remembered in the browser. */
export const OUTLINE_V2_COLLAPSED_STORAGE_KEY = "paperclip:responsibilities:outline-v2-collapsed";

/** The responsibility page's simplified view that rows from this view open. */
export const OUTLINE_V2_RESPONSIBILITY_VIEW = "one_screen_v2";

export interface OutlineV2Group {
  /** The area's id, or `OUTLINE_V2_NO_AREA_KEY`. */
  key: string;
  /** Null for the last group: responsibilities filed under no area. */
  area: AreaRef | null;
  /** Active responsibilities, in the order the overview returned them. */
  items: ResponsibilityWithRollup[];
}

/**
 * Every active area, holding what the person owns there or nothing yet, plus
 * any other area (proposed, archived) that holds one of their active
 * responsibilities and any area just added; then the responsibilities filed
 * under no area. Areas and responsibilities keep the overview's order.
 */
export function outlineV2Groups(
  areas: readonly AreaRef[],
  responsibilities: readonly ResponsibilityWithRollup[],
  keepEmpty: ReadonlySet<string> = new Set(),
): OutlineV2Group[] {
  const shown = new Set(keepEmpty);
  for (const area of areas) if (area.status === "active") shown.add(area.id);
  return groupByArea(areas, activeResponsibilities(responsibilities), shown).map((group) => ({
    key: group.area?.id ?? OUTLINE_V2_NO_AREA_KEY,
    area: group.area,
    items: group.items,
  }));
}

/** The one line a row shows: the bar sentence, or the title when there is none. */
export function outlineV2Line(responsibility: Pick<ResponsibilityWithRollup, "standard" | "title">): string {
  return responsibility.standard?.trim() || responsibility.title;
}

export interface OutlineV2Counts {
  areas: number;
  responsibilities: number;
}

/** How many areas the outline shows and how many responsibilities sit in it, with or without an area. */
export function outlineV2Counts(groups: readonly OutlineV2Group[]): OutlineV2Counts {
  return {
    areas: groups.filter((group) => group.area !== null).length,
    responsibilities: groups.reduce((total, group) => total + group.items.length, 0),
  };
}

/** The counts as the one line above the outline: "3 areas and 4 responsibilities". */
export function outlineV2CountsLabel({ areas, responsibilities }: OutlineV2Counts): string {
  const areaPart = areas === 1 ? "1 area" : `${areas} areas`;
  const responsibilityPart = responsibilities === 1 ? "1 responsibility" : `${responsibilities} responsibilities`;
  return `${areaPart} and ${responsibilityPart}`;
}

/**
 * The groups narrowed to a search. Every entered word must appear, in any
 * order and any case, across a responsibility's sentence, its title and its
 * area's name. An area whose name alone matches keeps everything in it; an
 * area with nothing matching is left out. A blank search returns the groups
 * unchanged.
 */
export function searchOutlineV2Groups(groups: readonly OutlineV2Group[], query: string): OutlineV2Group[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...groups];
  const matches = (text: string) => words.every((word) => text.includes(word));
  const found: OutlineV2Group[] = [];
  for (const group of groups) {
    const areaName = (group.area?.title ?? "").toLowerCase();
    if (areaName && matches(areaName)) {
      found.push(group);
      continue;
    }
    const items = group.items.filter((item) =>
      matches(`${areaName} ${item.title} ${item.standard ?? ""}`.toLowerCase()),
    );
    if (items.length > 0) found.push({ ...group, items });
  }
  return found;
}

/** A row's link: the responsibility page, opened in its simplified view. */
export function outlineV2Href(responsibilityId: string): string {
  return `${responsibilityPath(responsibilityId)}?view=${OUTLINE_V2_RESPONSIBILITY_VIEW}`;
}

/** The collapsed groups' keys as stored; empty when nothing is stored or storage is unavailable. Never throws. */
export function readCollapsedAreas(scope: string): Set<string> {
  try {
    const stored = globalThis.localStorage?.getItem(`${OUTLINE_V2_COLLAPSED_STORAGE_KEY}:${scope}`);
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

/** Remembers the collapsed groups when storage is available; silently does nothing otherwise. */
export function writeCollapsedAreas(keys: ReadonlySet<string>, scope: string): void {
  try {
    globalThis.localStorage?.setItem(`${OUTLINE_V2_COLLAPSED_STORAGE_KEY}:${scope}`, JSON.stringify([...keys]));
  } catch {
    // Private windows and blocked storage: the choice lasts for this visit only.
  }
}
