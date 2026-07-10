import type { AgentSkillEntry } from "@paperclipai/shared";

export interface AgentSkillDraftState {
  draft: string[];
  lastSaved: string[];
  hasHydratedSnapshot: boolean;
}

export interface AgentSkillSnapshotApplyResult extends AgentSkillDraftState {
  shouldSkipAutosave: boolean;
}

export function arraysEqual(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/**
 * Order-independent equality for a desired-skill selection. A skill selection is
 * conceptually a set, and the server may return keys in a different order than
 * the client sent them (it canonicalizes references and re-groups stale keys).
 * Comparing as sets keeps "is this saved?" honest across those reorderings —
 * without it, a persisted-but-reordered response reads as "still dirty" and the
 * autosave re-fires forever (a benign-looking sibling of the PAP-13222 storm).
 */
export function sameSkillSelection(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const key of setA) {
    if (!setB.has(key)) return false;
  }
  return true;
}

export function applyAgentSkillSnapshot(
  state: AgentSkillDraftState,
  desiredSkills: string[],
): AgentSkillSnapshotApplyResult {
  const shouldReplaceDraft = !state.hasHydratedSnapshot || arraysEqual(state.draft, state.lastSaved);

  return {
    draft: shouldReplaceDraft ? desiredSkills : state.draft,
    lastSaved: desiredSkills,
    hasHydratedSnapshot: true,
    shouldSkipAutosave: shouldReplaceDraft,
  };
}

/**
 * Decide whether the autosave effect should (re)schedule a sync for the current
 * draft. Returns false when the draft is already saved, or when it exactly
 * matches a payload that just failed — the latter is what prevents the infinite
 * 422 retry storm (PAP-13222). A failed payload only becomes sendable again once
 * the user edits the draft into something new.
 */
export function shouldScheduleSkillAutosave(params: {
  draft: string[];
  lastSaved: string[];
  failedDraft: string[] | null;
}): boolean {
  if (sameSkillSelection(params.draft, params.lastSaved)) return false;
  if (params.failedDraft && sameSkillSelection(params.draft, params.failedDraft)) return false;
  return true;
}

export function isReadOnlyUnmanagedSkillEntry(
  entry: AgentSkillEntry,
  companySkillKeys: Set<string>,
): boolean {
  if (companySkillKeys.has(entry.key)) return false;
  if (entry.origin === "user_installed" || entry.origin === "external_unknown") return true;
  return entry.managed === false && entry.state === "external";
}
