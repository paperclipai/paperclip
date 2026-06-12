import type {
  ToolCatalogEntry,
  ToolProfileDefaultAction,
  ToolProfileEntry,
  ToolRiskLevel,
} from "@paperclipai/shared";
import type { ToolProfileEntryInput } from "@/api/tools";

/**
 * Pure domain model for the prosumer access-profile wizard (PAP-10997).
 *
 * The wizard speaks a friendly per-app language ("All Gmail tools", "All Gmail
 * except 2", "3 Gmail tools") while the server stores the existing entry model
 * (`application` / `catalog_entry` selectors with include/exclude effects). This
 * module is the single source of truth for that translation and for the
 * "except N" math, so it can be unit-tested without React.
 *
 * Vocabulary gate: nothing here renders. Labels produced here are prosumer copy
 * ("tools", "All … except N"); selector/entry/effect/default-action vocabulary
 * never leaves this module.
 */

// --- Capability ------------------------------------------------------------

export type ToolCapability = "read" | "write" | "destructive";

export function toolCapability(tool: ToolCatalogEntry): ToolCapability {
  if (tool.isDestructive) return "destructive";
  if (tool.isWrite) return "write";
  return "read";
}

export const CAPABILITY_LABEL: Record<ToolCapability, string> = {
  read: "Read-only",
  write: "Makes changes",
  destructive: "Destructive",
};

// --- App grouping ----------------------------------------------------------

/** A connected app and the concrete tools its catalog currently exposes. */
export interface AppGroup {
  /** Stable grouping key — the application id, or the connection id when an
   * entry has no application (admin "run your own" connections). */
  appKey: string;
  applicationId: string | null;
  connectionId: string;
  name: string;
  tools: ToolCatalogEntry[];
}

/**
 * Group the company-wide catalog into apps, preferring the application name and
 * falling back to the connection name for application-less connections.
 */
export function groupCatalogByApp(
  catalog: ToolCatalogEntry[],
  applicationsById: Map<string, string>,
  connectionsById: Map<string, string>,
): AppGroup[] {
  const groups = new Map<string, AppGroup>();
  for (const tool of catalog) {
    const appKey = tool.applicationId ?? tool.connectionId;
    let group = groups.get(appKey);
    if (!group) {
      const name =
        (tool.applicationId ? applicationsById.get(tool.applicationId) : null) ??
        connectionsById.get(tool.connectionId) ??
        "Tools";
      group = {
        appKey,
        applicationId: tool.applicationId,
        connectionId: tool.connectionId,
        name,
        tools: [],
      };
      groups.set(appKey, group);
    }
    group.tools.push(tool);
  }
  for (const group of groups.values()) {
    group.tools.sort((a, b) => a.toolName.localeCompare(b.toolName));
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// --- Per-app selection state ----------------------------------------------

export type AppSelection =
  | { kind: "all" }
  | { kind: "all_except"; excluded: string[] }
  | { kind: "some"; included: string[] }
  | { kind: "none" };

export type WizardSelections = Record<string, AppSelection>;

/** Set of catalog-entry ids currently allowed for one app, given the catalog. */
export function selectedToolIds(group: AppGroup, selection: AppSelection | undefined): Set<string> {
  if (!selection || selection.kind === "none") return new Set();
  if (selection.kind === "all") return new Set(group.tools.map((t) => t.id));
  if (selection.kind === "all_except") {
    const excluded = new Set(selection.excluded);
    return new Set(group.tools.filter((t) => !excluded.has(t.id)).map((t) => t.id));
  }
  const included = new Set(selection.included);
  return new Set(group.tools.filter((t) => included.has(t.id)).map((t) => t.id));
}

export function isToolSelected(
  group: AppGroup,
  selection: AppSelection | undefined,
  toolId: string,
): boolean {
  return selectedToolIds(group, selection).has(toolId);
}

export type AppCheckState = "checked" | "indeterminate" | "unchecked";

export function appCheckState(group: AppGroup, selection: AppSelection | undefined): AppCheckState {
  const n = selectedToolIds(group, selection).size;
  if (n === 0) return "unchecked";
  if (n === group.tools.length) return "checked";
  return "indeterminate";
}

/**
 * "All Gmail tools (12)" / "All Gmail except 2" / "3 of 12 tools" — the prosumer
 * summary the tree row and the index render. `appName` is woven in by the caller
 * when it wants the app-scoped variant.
 */
export function appSelectionLabel(group: AppGroup, selection: AppSelection | undefined): string {
  const total = group.tools.length;
  const state = appCheckState(group, selection);
  if (state === "unchecked") return "None selected";
  if (selection?.kind === "all" || (selection?.kind === "all_except" && selection.excluded.length === 0)) {
    return `All ${group.name} tools (${total})`;
  }
  if (selection?.kind === "all_except") {
    const n = selection.excluded.length;
    return `All ${group.name} except ${n}`;
  }
  const n = selectedToolIds(group, selection).size;
  return `${n} of ${total} ${group.name} tools`;
}

// --- Checkbox reducers -----------------------------------------------------

/** Toggle the app-level checkbox: off → all tools; on → none. */
export function toggleApp(group: AppGroup, selection: AppSelection | undefined): AppSelection {
  const state = appCheckState(group, selection);
  return state === "unchecked" ? { kind: "all" } : { kind: "none" };
}

/** Toggle one tool, preserving "include future tools" intent when the app box is on. */
export function toggleTool(
  group: AppGroup,
  selection: AppSelection | undefined,
  toolId: string,
): AppSelection {
  const current = selection ?? { kind: "none" as const };
  const selected = selectedToolIds(group, current);
  const willSelect = !selected.has(toolId);

  // App box is on (all / all_except): keep app-include semantics, edit excludes.
  if (current.kind === "all" || current.kind === "all_except") {
    const excluded = new Set(current.kind === "all_except" ? current.excluded : []);
    if (willSelect) excluded.delete(toolId);
    else excluded.add(toolId);
    if (excluded.size === 0) return { kind: "all" };
    if (excluded.size >= group.tools.length) return { kind: "none" };
    return { kind: "all_except", excluded: group.tools.filter((t) => excluded.has(t.id)).map((t) => t.id) };
  }

  // App box is off: explicit per-tool includes (future tools stay blocked).
  const included = new Set(current.kind === "some" ? current.included : []);
  if (willSelect) included.add(toolId);
  else included.delete(toolId);
  if (included.size === 0) return { kind: "none" };
  if (included.size >= group.tools.length) return { kind: "all" };
  return { kind: "some", included: group.tools.filter((t) => included.has(t.id)).map((t) => t.id) };
}

// --- Advanced rules (AP18) -------------------------------------------------

export type AdvancedRuleKind = "tool_name" | "risk_level" | "catalog_entry";

export interface AdvancedRule {
  id: string;
  kind: AdvancedRuleKind;
  /** wildcard pattern for tool_name, a risk level, or a catalog id. */
  value: string;
  riskLevel?: ToolRiskLevel;
  effect: "include" | "exclude";
}

// --- Entry <-> selection translation --------------------------------------

/**
 * Flatten the wizard's per-app selections (+ advanced rules) into the server
 * entry model. App-on selections become an `application` include; per-tool
 * opt-outs become `catalog_entry` excludes; explicit picks become
 * `catalog_entry` includes.
 */
export function buildEntries(
  groups: AppGroup[],
  selections: WizardSelections,
  advancedRules: AdvancedRule[] = [],
): ToolProfileEntryInput[] {
  const entries: ToolProfileEntryInput[] = [];
  for (const group of groups) {
    const selection = selections[group.appKey];
    if (!selection || selection.kind === "none") continue;
    if (selection.kind === "all" || selection.kind === "all_except") {
      if (group.applicationId) {
        entries.push({ selectorType: "application", effect: "include", applicationId: group.applicationId });
      } else {
        entries.push({ selectorType: "connection", effect: "include", connectionId: group.connectionId });
      }
      if (selection.kind === "all_except") {
        for (const toolId of selection.excluded) {
          entries.push({ selectorType: "catalog_entry", effect: "exclude", catalogEntryId: toolId });
        }
      }
    } else {
      for (const toolId of selection.included) {
        entries.push({ selectorType: "catalog_entry", effect: "include", catalogEntryId: toolId });
      }
    }
  }
  for (const rule of advancedRules) {
    if (rule.kind === "tool_name") {
      entries.push({ selectorType: "tool_name", effect: rule.effect, toolName: rule.value });
    } else if (rule.kind === "risk_level") {
      entries.push({ selectorType: "risk_level", effect: rule.effect, riskLevel: rule.riskLevel ?? "destructive" });
    } else {
      entries.push({ selectorType: "catalog_entry", effect: rule.effect, catalogEntryId: rule.value });
    }
  }
  return entries;
}

/**
 * Recover wizard state from stored entries (draft resume / copy a profile).
 * App-include + catalog excludes round-trip back to all / all_except; bare
 * catalog includes become explicit picks; everything else (wildcards, risk
 * levels, cross-app catalog ids) surfaces as an advanced rule.
 */
export function parseEntries(
  groups: AppGroup[],
  entries: ToolProfileEntry[],
): { selections: WizardSelections; advancedRules: AdvancedRule[] } {
  const selections: WizardSelections = {};
  const advancedRules: AdvancedRule[] = [];
  const toolIdToApp = new Map<string, string>();
  for (const group of groups) {
    for (const tool of group.tools) toolIdToApp.set(tool.id, group.appKey);
  }
  const appByApplicationId = new Map<string, AppGroup>();
  const appByConnectionId = new Map<string, AppGroup>();
  for (const group of groups) {
    if (group.applicationId) appByApplicationId.set(group.applicationId, group);
    appByConnectionId.set(group.connectionId, group);
  }

  const appOn = new Set<string>();
  const excludesByApp = new Map<string, Set<string>>();
  const includesByApp = new Map<string, Set<string>>();

  for (const entry of entries) {
    if (entry.effect === "include" && entry.selectorType === "application" && entry.applicationId) {
      const group = appByApplicationId.get(entry.applicationId);
      if (group) appOn.add(group.appKey);
      continue;
    }
    if (entry.effect === "include" && entry.selectorType === "connection" && entry.connectionId) {
      const group = appByConnectionId.get(entry.connectionId);
      if (group && !group.applicationId) appOn.add(group.appKey);
      else advancedRules.push({ id: entry.id, kind: "catalog_entry", value: entry.connectionId, effect: "include" });
      continue;
    }
    if (entry.selectorType === "catalog_entry" && entry.catalogEntryId) {
      const appKey = toolIdToApp.get(entry.catalogEntryId);
      if (!appKey) {
        advancedRules.push({ id: entry.id, kind: "catalog_entry", value: entry.catalogEntryId, effect: entry.effect });
        continue;
      }
      const bucket = entry.effect === "exclude" ? excludesByApp : includesByApp;
      const set = bucket.get(appKey) ?? new Set<string>();
      set.add(entry.catalogEntryId);
      bucket.set(appKey, set);
      continue;
    }
    if (entry.selectorType === "tool_name" && entry.toolName) {
      advancedRules.push({ id: entry.id, kind: "tool_name", value: entry.toolName, effect: entry.effect });
      continue;
    }
    if (entry.selectorType === "risk_level" && entry.riskLevel) {
      advancedRules.push({ id: entry.id, kind: "risk_level", value: entry.riskLevel, riskLevel: entry.riskLevel, effect: entry.effect });
      continue;
    }
  }

  for (const group of groups) {
    const on = appOn.has(group.appKey);
    const excluded = [...(excludesByApp.get(group.appKey) ?? [])].filter((id) =>
      group.tools.some((t) => t.id === id),
    );
    const included = [...(includesByApp.get(group.appKey) ?? [])].filter((id) =>
      group.tools.some((t) => t.id === id),
    );
    if (on) {
      selections[group.appKey] = excluded.length > 0 ? { kind: "all_except", excluded } : { kind: "all" };
    } else if (included.length > 0) {
      selections[group.appKey] =
        included.length >= group.tools.length ? { kind: "all" } : { kind: "some", included };
    } else {
      selections[group.appKey] = { kind: "none" };
    }
  }

  return { selections, advancedRules };
}

// --- Live count ------------------------------------------------------------

/** "Allows 14 of 63 tools" — resolves the assembled selection against the catalog. */
export function countAllowedTools(
  groups: AppGroup[],
  selections: WizardSelections,
  defaultAction: ToolProfileDefaultAction,
  totalToolCount: number,
): { allowed: number; total: number } {
  if (defaultAction === "allow") {
    // "Allowed automatically" — everything except the per-app opt-outs.
    let excluded = 0;
    for (const group of groups) {
      const selection = selections[group.appKey];
      if (selection?.kind === "all_except") excluded += selection.excluded.length;
      else if (selection?.kind === "some") excluded += group.tools.length - selection.included.length;
      else if (selection?.kind === "none") excluded += group.tools.length;
    }
    return { allowed: Math.max(0, totalToolCount - excluded), total: totalToolCount };
  }
  let allowed = 0;
  for (const group of groups) {
    allowed += selectedToolIds(group, selections[group.appKey]).size;
  }
  return { allowed, total: totalToolCount };
}

// --- Step-1 templates ------------------------------------------------------

export type TemplateKey = "read_only" | "everyday" | "full_access" | "scratch" | "copy";

export interface TemplateDef {
  key: TemplateKey;
  title: string;
  description: string;
}

export const TEMPLATES: TemplateDef[] = [
  { key: "read_only", title: "Read-only", description: "See and fetch, but never change anything." },
  { key: "everyday", title: "Everyday work", description: "Read and make routine changes — no destructive tools." },
  { key: "full_access", title: "Full access", description: "Everything every connected app offers." },
  { key: "scratch", title: "Start from scratch", description: "An empty profile you build up tool by tool." },
  { key: "copy", title: "Copy an existing profile", description: "Start from a profile you already have." },
];

function capabilityPredicate(key: TemplateKey): (tool: ToolCatalogEntry) => boolean {
  if (key === "read_only") return (t) => toolCapability(t) === "read";
  if (key === "everyday") return (t) => toolCapability(t) !== "destructive";
  return () => true; // full_access
}

/** Build the initial per-app selection a template implies for the live catalog. */
export function templateSelections(key: TemplateKey, groups: AppGroup[]): WizardSelections {
  const selections: WizardSelections = {};
  if (key === "scratch" || key === "copy") {
    for (const group of groups) selections[group.appKey] = { kind: "none" };
    return selections;
  }
  const matches = capabilityPredicate(key);
  for (const group of groups) {
    const matchingIds = group.tools.filter(matches).map((t) => t.id);
    if (matchingIds.length === 0) selections[group.appKey] = { kind: "none" };
    else if (matchingIds.length === group.tools.length) selections[group.appKey] = { kind: "all" };
    else selections[group.appKey] = { kind: "some", included: matchingIds };
  }
  return selections;
}
