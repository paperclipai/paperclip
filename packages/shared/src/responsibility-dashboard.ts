import { z } from "zod";
import type { ProposeDashboardChangesInteraction } from "./types/issue.js";

/**
 * A person's Dashboard, edited by talking to an agent (experimental
 * `enableResponsibilities`). The Dashboard is the areas a person has something
 * in and, under each, the responsibilities they own, each one sentence of what
 * must be true. An agent in the person's dashboard conversation proposes a
 * change set; nothing is applied until a person accepts it, and every applied
 * change is saved as a version the person can go back to.
 */

/** `create`: get to know the person, then draft a first dashboard. `edit`: change the one they have. */
export const RESPONSIBILITY_DASHBOARD_MODES = ["create", "edit"] as const;
export type ResponsibilityDashboardMode = (typeof RESPONSIBILITY_DASHBOARD_MODES)[number];

/** Versions kept per person; older ones are pruned when a new one is saved. */
export const RESPONSIBILITY_DASHBOARD_VERSION_LIMIT = 30;
/** The most changes one proposal may carry. */
export const RESPONSIBILITY_DASHBOARD_CHANGE_LIMIT = 60;
/** A responsibility's sentence is stored as its title, so it shares the title's limit. */
export const RESPONSIBILITY_DASHBOARD_SENTENCE_MAX = 200;
/** How long the Dashboard offers Undo for the latest applied change. */
export const RESPONSIBILITY_DASHBOARD_UNDO_HOURS = 24;

/**
 * Who caused a version. `change_set`: an agent's change, either a proposal a
 * person applied (`interactionId` set) or a change an agent made for the
 * person with its responsibility tools (no `interactionId`). `person`: changes
 * made by hand since the last version (picked up before the next agent change
 * and whenever the version list is opened). `restore`: a person went back to
 * an earlier version.
 */
export const RESPONSIBILITY_DASHBOARD_VERSION_CAUSES = ["change_set", "person", "restore"] as const;
export type ResponsibilityDashboardVersionCause = (typeof RESPONSIBILITY_DASHBOARD_VERSION_CAUSES)[number];

export const RESPONSIBILITY_DASHBOARD_CHANGE_OPS = [
  "add_area",
  "rename_area",
  "remove_area",
  "add_responsibility",
  "reword_responsibility",
  "move_responsibility",
  "remove_responsibility",
] as const;
export type ResponsibilityDashboardChangeOp = (typeof RESPONSIBILITY_DASHBOARD_CHANGE_OPS)[number];

/** Changes that take something away: each must say why. */
export const RESPONSIBILITY_DASHBOARD_REMOVAL_OPS: readonly ResponsibilityDashboardChangeOp[] = ["remove_area", "remove_responsibility"];

// ---------------------------------------------------------------------------
// What the agent sends
// ---------------------------------------------------------------------------

const areaName = z.string().trim().min(1).max(200);
const sentence = z.string().trim().min(1).max(RESPONSIBILITY_DASHBOARD_SENTENCE_MAX);
const optionalReason = z.string().trim().min(1).max(300).optional().nullable();
const requiredReason = z.string().trim().min(1, "Say why in one line (reason)").max(300);
/** A key the agent picks for a new area so later changes in the same proposal can file under it. */
const areaRef = z.string().trim().min(1).max(40);
const id = z.string().uuid();

const addArea = z.object({ op: z.literal("add_area"), ref: areaRef, name: areaName, reason: optionalReason }).strict();
const renameArea = z.object({ op: z.literal("rename_area"), areaId: id, name: areaName, reason: optionalReason }).strict();
const removeArea = z.object({ op: z.literal("remove_area"), areaId: id, reason: requiredReason }).strict();
const addResponsibility = z.object({
  op: z.literal("add_responsibility"),
  /** An existing area, or `areaRef` of an `add_area` earlier in the list. Exactly one. */
  areaId: id.optional(),
  areaRef: areaRef.optional(),
  sentence,
  reason: optionalReason,
}).strict();
const rewordResponsibility = z.object({
  op: z.literal("reword_responsibility"),
  responsibilityId: id,
  sentence,
  reason: optionalReason,
}).strict();
const moveResponsibility = z.object({
  op: z.literal("move_responsibility"),
  responsibilityId: id,
  areaId: id.optional(),
  areaRef: areaRef.optional(),
  reason: optionalReason,
}).strict();
const removeResponsibility = z.object({
  op: z.literal("remove_responsibility"),
  responsibilityId: id,
  reason: requiredReason,
}).strict();

export const responsibilityDashboardChangeInputSchema = z.discriminatedUnion("op", [
  addArea,
  renameArea,
  removeArea,
  addResponsibility,
  rewordResponsibility,
  moveResponsibility,
  removeResponsibility,
]);
export type ResponsibilityDashboardChangeInput = z.infer<typeof responsibilityDashboardChangeInputSchema>;

/**
 * The checks a change set passes on its own, without reading any data: each
 * new area's ref is unique and used only after it is added; add and move name
 * exactly one area; nothing is changed twice in contradictory ways.
 */
export function responsibilityDashboardChangeSetIssues(
  changes: readonly ResponsibilityDashboardChangeInput[],
): Array<{ index: number; message: string }> {
  const issues: Array<{ index: number; message: string }> = [];
  const refs = new Map<string, number>();
  const newNames = new Set<string>();
  const touched = new Map<string, Set<ResponsibilityDashboardChangeOp>>();
  const areaOps = new Map<string, Set<ResponsibilityDashboardChangeOp>>();
  const areaChanges = new Map<string, ResponsibilityDashboardChangeOp[]>();
  const note = (map: Map<string, Set<ResponsibilityDashboardChangeOp>>, key: string, op: ResponsibilityDashboardChangeOp) => {
    const set = map.get(key) ?? new Set();
    set.add(op);
    map.set(key, set);
    return set;
  };
  changes.forEach((change, index) => {
    if (change.op === "add_area") {
      if (refs.has(change.ref)) issues.push({ index, message: `Two new areas use the ref "${change.ref}"; give each its own` });
      refs.set(change.ref, index);
      const key = change.name.trim().toLowerCase();
      if (newNames.has(key)) issues.push({ index, message: `"${change.name}" is added twice` });
      newNames.add(key);
      return;
    }
    if (change.op === "add_responsibility" || change.op === "move_responsibility") {
      const both = change.areaId !== undefined && change.areaRef !== undefined;
      const neither = change.areaId === undefined && change.areaRef === undefined;
      if (both || neither) issues.push({ index, message: "Name the area with exactly one of areaId (an existing area) or areaRef (a new one added earlier in this list)" });
      if (change.areaRef !== undefined && !refs.has(change.areaRef)) {
        issues.push({ index, message: `No add_area earlier in this list has the ref "${change.areaRef}"` });
      }
      if (change.areaId) note(areaOps, change.areaId, change.op);
    }
    if (change.op === "rename_area" || change.op === "remove_area") {
      const seen = areaChanges.get(change.areaId) ?? [];
      if (seen.includes(change.op)) {
        issues.push({ index, message: change.op === "rename_area" ? "This area is renamed twice" : "This area is removed twice" });
      }
      if (seen.includes(change.op === "rename_area" ? "remove_area" : "rename_area")) {
        issues.push({ index, message: "An area cannot be renamed and removed in the same proposal" });
      }
      seen.push(change.op);
      areaChanges.set(change.areaId, seen);
      note(areaOps, change.areaId, change.op);
    }
    if ("responsibilityId" in change) {
      const ops = touched.get(change.responsibilityId) ?? new Set();
      if (ops.has(change.op)) issues.push({ index, message: "This responsibility already has that change in this proposal" });
      if (change.op === "remove_responsibility" ? ops.size > 0 : ops.has("remove_responsibility")) {
        issues.push({ index, message: "A responsibility that is removed cannot also be reworded or moved" });
      }
      ops.add(change.op);
      touched.set(change.responsibilityId, ops);
    }
  });
  for (const [areaId, ops] of areaOps) {
    if (!ops.has("remove_area")) continue;
    if (ops.has("add_responsibility") || ops.has("move_responsibility")) {
      const index = changes.findIndex((change) => change.op === "remove_area" && change.areaId === areaId);
      issues.push({ index, message: "An area that is removed cannot also receive a responsibility" });
    }
  }
  return issues;
}

/** Body an agent sends from the dashboard conversation: an ordered list of plain changes. */
export const createDashboardChangeSetSchema = z
  .object({
    /** One plain sentence to the person. */
    message: z.string().trim().min(1).max(500).optional().nullable(),
    changes: z.array(responsibilityDashboardChangeInputSchema).min(1).max(RESPONSIBILITY_DASHBOARD_CHANGE_LIMIT),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const issue of responsibilityDashboardChangeSetIssues(value.changes)) {
      ctx.addIssue({ code: "custom", path: ["changes", issue.index], message: issue.message });
    }
  });
export type CreateDashboardChangeSet = z.infer<typeof createDashboardChangeSetSchema>;

/**
 * Applying a proposal. `keep` lists the changes to apply, by index; the rest
 * are dropped. Leave it out to apply all of them. A kept change may not
 * depend on a dropped one (`dependsOn` on each change says which it needs).
 */
export const acceptDashboardChangeSetSchema = z
  .object({
    keep: z
      .array(z.number().int().min(0).max(RESPONSIBILITY_DASHBOARD_CHANGE_LIMIT - 1))
      .min(1, "Keep at least one change, or say the proposal is not right")
      .max(RESPONSIBILITY_DASHBOARD_CHANGE_LIMIT)
      .refine((indexes) => new Set(indexes).size === indexes.length, "Each kept change is listed once")
      .optional(),
  })
  .strict();
export type AcceptDashboardChangeSet = z.infer<typeof acceptDashboardChangeSetSchema>;

export const declineDashboardChangeSetSchema = z.object({}).strict();
export type DeclineDashboardChangeSet = z.infer<typeof declineDashboardChangeSetSchema>;

/** Start (or reopen) a person's dashboard conversation. Board: `ownerUserId` defaults to the acting user. */
export const startDashboardConversationSchema = z
  .object({
    mode: z.enum(RESPONSIBILITY_DASHBOARD_MODES),
    ownerUserId: z.string().trim().min(1).optional(),
    agentId: z.string().uuid().optional(),
  })
  .strict();
export type StartDashboardConversation = z.infer<typeof startDashboardConversationSchema>;

/** Go back to a saved version. */
export const restoreDashboardVersionSchema = z.object({}).strict();
export type RestoreDashboardVersion = z.infer<typeof restoreDashboardVersionSchema>;

export const responsibilityDashboardQuerySchema = z.object({
  /** Board: defaults to the acting user. Agent: required. */
  ownerUserId: z.string().trim().min(1).optional(),
});
export type ResponsibilityDashboardQuery = z.infer<typeof responsibilityDashboardQuerySchema>;

// ---------------------------------------------------------------------------
// What the card shows (stored on the proposal)
// ---------------------------------------------------------------------------

/** One responsibility as the card names it. */
export interface ResponsibilityDashboardItemRef {
  id: string;
  sentence: string;
}

/**
 * One change as the card shows it, with its words resolved when it was
 * proposed so it reads the same later. Fields a change does not use are null.
 */
export interface ResponsibilityDashboardChange {
  index: number;
  op: ResponsibilityDashboardChangeOp;
  reason: string | null;
  /** Indexes of the changes this one needs: a responsibility filed under a new area needs that area. */
  dependsOn: number[];
  /** The area the card groups it under: an existing area's id, or null for a new one (then `groupRef`). */
  groupAreaId: string | null;
  /** For a new area, its ref; changes filed under it carry the same one. */
  groupRef: string | null;
  /** The group's name as it reads today (a new area's own name). */
  groupName: string;
  /** add_area and rename_area: the name it will have. */
  name: string | null;
  /** rename_area: the name it has today. */
  fromName: string | null;
  responsibilityId: string | null;
  /** add_responsibility and reword_responsibility: the sentence it will read. */
  sentence: string | null;
  /** reword, move and remove: the sentence it reads today. */
  fromSentence: string | null;
  /** move_responsibility: the area it is in today. */
  fromAreaId: string | null;
  fromAreaName: string | null;
  /** remove_area: the person's responsibilities in it that are let go with it, unless another kept change moves or removes them. */
  lettingGo: ResponsibilityDashboardItemRef[];
  /** rename_area: how many other people have responsibilities in this area (it is renamed for them too). */
  sharedWith: number;
}

export interface ProposeDashboardChangesPayload {
  version: 1;
  ownerUserId: string;
  mode: ResponsibilityDashboardMode;
  message: string | null;
  changes: ResponsibilityDashboardChange[];
}

/**
 * `replaced`: a newer proposal took its place. `issue_closed`: the
 * conversation was cancelled. `withdrawn` and `addressee_deleted` are the
 * administrative outcomes every conversation card can reach.
 */
export const PROPOSE_DASHBOARD_CHANGES_OUTCOMES = [
  "accepted",
  "declined",
  "replaced",
  "issue_closed",
  "withdrawn",
  "addressee_deleted",
] as const;
export type ProposeDashboardChangesOutcome = (typeof PROPOSE_DASHBOARD_CHANGES_OUTCOMES)[number];

export interface ProposeDashboardChangesResult {
  version: 1;
  outcome: ProposeDashboardChangesOutcome;
  reason?: string | null;
  replacedByInteractionId?: string | null;
  /** For `accepted`: the indexes of the changes the person dropped. */
  dropped?: number[] | null;
  /** For `accepted`: the version saved after applying (and the one before it, which Undo restores). */
  versionId?: string | null;
  previousVersionId?: string | null;
  /** For `accepted`: what changed, in one line. */
  summary?: string | null;
}

const changePayloadSchema = z.object({
  index: z.number().int().min(0),
  op: z.enum(RESPONSIBILITY_DASHBOARD_CHANGE_OPS),
  reason: z.string().nullable(),
  dependsOn: z.array(z.number().int().min(0)),
  groupAreaId: z.string().nullable(),
  groupRef: z.string().nullable(),
  groupName: z.string(),
  name: z.string().nullable(),
  fromName: z.string().nullable(),
  responsibilityId: z.string().nullable(),
  sentence: z.string().nullable(),
  fromSentence: z.string().nullable(),
  fromAreaId: z.string().nullable(),
  fromAreaName: z.string().nullable(),
  lettingGo: z.array(z.object({ id: z.string(), sentence: z.string() })),
  sharedWith: z.number().int().min(0),
});

export const proposeDashboardChangesPayloadSchema = z.object({
  version: z.literal(1),
  ownerUserId: z.string(),
  mode: z.enum(RESPONSIBILITY_DASHBOARD_MODES),
  message: z.string().nullable(),
  changes: z.array(changePayloadSchema).min(1),
});

export const proposeDashboardChangesResultSchema = z.object({
  version: z.literal(1),
  outcome: z.enum(PROPOSE_DASHBOARD_CHANGES_OUTCOMES),
  reason: z.string().nullable().optional(),
  replacedByInteractionId: z.string().nullable().optional(),
  dropped: z.array(z.number().int()).nullable().optional(),
  versionId: z.string().nullable().optional(),
  previousVersionId: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
});

/**
 * The changes that go when `index` is dropped (it and everything that needs
 * it, transitively), and the ones that come back with it when kept (it and
 * everything it needs). The card uses both so a person never keeps a change
 * whose area was dropped.
 */
export function dashboardChangesDroppedWith(changes: readonly Pick<ResponsibilityDashboardChange, "index" | "dependsOn">[], index: number): number[] {
  const out = new Set<number>([index]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const change of changes) {
      if (!out.has(change.index) && change.dependsOn.some((needed) => out.has(needed))) {
        out.add(change.index);
        grew = true;
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function dashboardChangesKeptWith(changes: readonly Pick<ResponsibilityDashboardChange, "index" | "dependsOn">[], index: number): number[] {
  const byIndex = new Map(changes.map((change) => [change.index, change]));
  const out = new Set<number>();
  const visit = (current: number) => {
    if (out.has(current)) return;
    out.add(current);
    for (const needed of byIndex.get(current)?.dependsOn ?? []) visit(needed);
  };
  visit(index);
  return [...out].sort((a, b) => a - b);
}

/** Kept changes that need a dropped one; empty when the kept set stands on its own. */
export function dashboardChangesMissingDependencies(
  changes: readonly Pick<ResponsibilityDashboardChange, "index" | "dependsOn">[],
  keep: ReadonlySet<number>,
): Array<{ index: number; needs: number }> {
  const missing: Array<{ index: number; needs: number }> = [];
  for (const change of changes) {
    if (!keep.has(change.index)) continue;
    for (const needed of change.dependsOn) if (!keep.has(needed)) missing.push({ index: change.index, needs: needed });
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** One area as a version holds it. Versions saved since agents could change areas also hold its description. */
export interface ResponsibilityDashboardSnapshotArea {
  id: string;
  title: string;
  status: string;
  sortOrder: number;
  description?: string | null;
}

/** The projects, tasks, routines and skills filed directly under a responsibility, each sorted. */
export interface ResponsibilityDashboardSnapshotLinks {
  projectIds: string[];
  issueIds: string[];
  routineIds: string[];
  /** Absent in versions saved before skills could be filed; restoring one leaves filed skills as they are. */
  skillIds?: string[];
}

/**
 * One responsibility as a version holds it: its sentence fields, area, status
 * and order. Versions saved since agents could change responsibilities for a
 * person also hold what is filed under it, its description and the agent that
 * runs it; restoring an older version leaves those as they are.
 */
export interface ResponsibilityDashboardSnapshotResponsibility {
  id: string;
  title: string;
  standard: string | null;
  areaId: string | null;
  status: string;
  sortOrder: number;
  links?: ResponsibilityDashboardSnapshotLinks;
  description?: string | null;
  runByAgentId?: string | null;
  evidence?: string | null;
  healthOverride?: string | null;
  healthNote?: string | null;
}

/**
 * A person's dashboard at one moment: every area they have an active
 * responsibility in (plus empty areas their dashboard changes created that are
 * still there), and every responsibility they own that is active. Sorted by id
 * so identical dashboards compare equal.
 */
export interface ResponsibilityDashboardSnapshot {
  version: 1;
  areas: ResponsibilityDashboardSnapshotArea[];
  responsibilities: ResponsibilityDashboardSnapshotResponsibility[];
  /**
   * Areas the change that produced this version created or changed; while
   * they are not archived they stay on the dashboard (an empty one too), so
   * the change can be undone.
   */
  createdAreaIds: string[];
}

export const responsibilityDashboardSnapshotSchema = z.object({
  version: z.literal(1),
  areas: z.array(z.object({
    id: z.string(), title: z.string(), status: z.string(), sortOrder: z.number(), description: z.string().nullable().optional(),
  })),
  responsibilities: z.array(z.object({
    id: z.string(),
    title: z.string(),
    standard: z.string().nullable(),
    areaId: z.string().nullable(),
    status: z.string(),
    sortOrder: z.number(),
    links: z.object({
      projectIds: z.array(z.string()),
      issueIds: z.array(z.string()),
      routineIds: z.array(z.string()),
      skillIds: z.array(z.string()).optional(),
    }).optional(),
    description: z.string().nullable().optional(),
    runByAgentId: z.string().nullable().optional(),
    evidence: z.string().nullable().optional(),
    healthOverride: z.string().nullable().optional(),
    healthNote: z.string().nullable().optional(),
  })),
  createdAreaIds: z.array(z.string()).default([]),
});

/** One saved version in the list: when, who, what changed. */
export interface ResponsibilityDashboardVersionSummary {
  id: string;
  cause: ResponsibilityDashboardVersionCause;
  /** One plain line of what changed since the version before it. */
  summary: string;
  actorUserId: string | null;
  /** For `change_set`: the agent that proposed it, or that made it for the person. */
  actorAgentId: string | null;
  /** For `change_set`: the proposal a person applied; null when the agent made the change for them. */
  interactionId: string | null;
  /** The version this one followed: Undo restores it. */
  previousVersionId: string | null;
  /** For `restore`: the version that was restored. */
  restoredFromVersionId: string | null;
  createdAt: Date;
}

/** `GET /api/companies/:companyId/responsibility-dashboard/versions`. Newest first; the first is the dashboard as it is now. */
export interface ResponsibilityDashboardVersionList {
  ownerUserId: string;
  versions: ResponsibilityDashboardVersionSummary[];
}

/** Where a person's dashboard conversation stands. */
export const RESPONSIBILITY_DASHBOARD_CONVERSATION_STATES = ["none", "discussing", "proposal_waiting", "settled"] as const;
export type ResponsibilityDashboardConversationState = (typeof RESPONSIBILITY_DASHBOARD_CONVERSATION_STATES)[number];

/** `GET /api/companies/:companyId/responsibility-dashboard`: what the Dashboard's edit module shows. */
export interface ResponsibilityDashboardState {
  ownerUserId: string;
  /** True when the person owns no active responsibility and none is proposed. */
  empty: boolean;
  /**
   * `proposal_waiting`: proposed changes wait for the person. `discussing`:
   * the conversation is open with no proposal waiting. `settled`: the latest
   * conversation is finished, or its latest proposal was applied. `none`:
   * there has been no conversation.
   */
  state: ResponsibilityDashboardConversationState;
  /** The agent a new conversation would be held with; null when no agent in the company can hold one. */
  defaultAgentId: string | null;
  /** The latest conversation that was not cancelled. */
  conversation: {
    issueId: string;
    identifier: string | null;
    title: string;
    status: string;
    agentId: string | null;
    mode: ResponsibilityDashboardMode;
    createdAt: Date;
  } | null;
  /** The pending proposal, if any (at most one is pending at a time). */
  proposal: ProposeDashboardChangesInteraction | null;
  /**
   * The latest version when it is an applied change set or a restore saved in
   * the last `RESPONSIBILITY_DASHBOARD_UNDO_HOURS`: the Dashboard shows what
   * changed and offers Undo (restore `previousVersionId`). Null otherwise.
   */
  latestChange: ResponsibilityDashboardVersionSummary | null;
}

/** `POST /api/issues/:id/dashboard-changes/:interactionId/accept`. */
export interface AcceptedDashboardChangeSet {
  interaction: ProposeDashboardChangesInteraction;
  version: ResponsibilityDashboardVersionSummary;
}

/** `POST /api/responsibility-dashboard-versions/:id/restore`. */
export interface RestoredDashboardVersion {
  version: ResponsibilityDashboardVersionSummary;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** The one sentence a responsibility reads as on the Dashboard: its bar sentence, or its title when there is none. */
export function responsibilityDashboardSentence(row: { standard: string | null; title: string }): string {
  return row.standard?.trim() || row.title;
}

/** One key per filed item, such as `routine:<id>`, for comparing two versions. */
export function snapshotLinkKeys(links: ResponsibilityDashboardSnapshotLinks): string[] {
  return [
    ...links.projectIds.map((id) => `project:${id}`),
    ...links.issueIds.map((id) => `issue:${id}`),
    ...links.routineIds.map((id) => `routine:${id}`),
    ...(links.skillIds ?? []).map((id) => `skill:${id}`),
  ];
}

function count(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

function joinWords(parts: string[]) {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * One plain line of what changed from one snapshot to the next, e.g. "Added 2
 * areas and 5 responsibilities, let go of 1 responsibility". With no earlier
 * snapshot it says what the dashboard holds.
 */
export function responsibilityDashboardChangeSummary(
  before: ResponsibilityDashboardSnapshot | null,
  after: ResponsibilityDashboardSnapshot,
): string {
  const liveAreas = (snapshot: ResponsibilityDashboardSnapshot) =>
    new Map(snapshot.areas.filter((area) => area.status !== "archived").map((area) => [area.id, area]));
  const afterAreas = liveAreas(after);
  if (!before) {
    if (after.responsibilities.length === 0 && afterAreas.size === 0) return "Empty";
    return `${count(afterAreas.size, "area", "areas")}, ${count(after.responsibilities.length, "responsibility", "responsibilities")}`;
  }
  const beforeAreas = liveAreas(before);
  const beforeItems = new Map(before.responsibilities.map((item) => [item.id, item]));
  const afterItems = new Map(after.responsibilities.map((item) => [item.id, item]));
  let addedAreas = 0;
  let renamedAreas = 0;
  let removedAreas = 0;
  let describedAreas = 0;
  for (const [areaId, area] of afterAreas) {
    const was = beforeAreas.get(areaId);
    if (!was) addedAreas += 1;
    else if (was.title !== area.title) renamedAreas += 1;
    if (was && was.description !== undefined && area.description !== undefined && was.description !== area.description) describedAreas += 1;
  }
  for (const areaId of beforeAreas.keys()) if (!afterAreas.has(areaId)) removedAreas += 1;
  let added = 0;
  let reworded = 0;
  let moved = 0;
  let letGo = 0;
  let filed = 0;
  let unfiled = 0;
  let detailed = 0;
  for (const [itemId, item] of afterItems) {
    const was = beforeItems.get(itemId);
    if (!was) {
      added += 1;
      continue;
    }
    if (responsibilityDashboardSentence(was) !== responsibilityDashboardSentence(item)) reworded += 1;
    if (was.areaId !== item.areaId) moved += 1;
    // Only versions that both hold these can be compared; an older version holds none.
    if (was.links && item.links) {
      // Skills compare only when both versions hold them.
      const skills = was.links.skillIds !== undefined && item.links.skillIds !== undefined;
      const before = new Set(snapshotLinkKeys(skills ? was.links : { ...was.links, skillIds: undefined }));
      const after = new Set(snapshotLinkKeys(skills ? item.links : { ...item.links, skillIds: undefined }));
      for (const key of after) if (!before.has(key)) filed += 1;
      for (const key of before) if (!after.has(key)) unfiled += 1;
    }
    // Details compare only when both versions hold them.
    const detailChanged = (["description", "runByAgentId", "evidence", "healthOverride", "healthNote"] as const)
      .some((key) => was[key] !== undefined && item[key] !== undefined && was[key] !== item[key]);
    if (detailChanged) detailed += 1;
  }
  for (const itemId of beforeItems.keys()) if (!afterItems.has(itemId)) letGo += 1;
  const verbs: string[] = [];
  const addedParts = [
    addedAreas > 0 ? count(addedAreas, "area", "areas") : null,
    added > 0 ? count(added, "responsibility", "responsibilities") : null,
  ].filter((part): part is string => part !== null);
  if (addedParts.length > 0) verbs.push(`added ${joinWords(addedParts)}`);
  if (renamedAreas > 0) verbs.push(`renamed ${count(renamedAreas, "area", "areas")}`);
  if (describedAreas > 0) verbs.push(`changed the description of ${count(describedAreas, "area", "areas")}`);
  if (reworded > 0) verbs.push(`reworded ${count(reworded, "responsibility", "responsibilities")}`);
  if (moved > 0) verbs.push(`moved ${count(moved, "responsibility", "responsibilities")}`);
  if (removedAreas > 0) verbs.push(`removed ${count(removedAreas, "area", "areas")}`);
  if (letGo > 0) verbs.push(`let go of ${count(letGo, "responsibility", "responsibilities")}`);
  if (filed > 0) verbs.push(`filed ${count(filed, "item", "items")}`);
  if (unfiled > 0) verbs.push(`unfiled ${count(unfiled, "item", "items")}`);
  if (detailed > 0) verbs.push(`changed the details of ${count(detailed, "responsibility", "responsibilities")}`);
  if (verbs.length === 0) return "No changes";
  const line = joinWords(verbs);
  return line.charAt(0).toUpperCase() + line.slice(1);
}
