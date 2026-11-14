import { useCallback, useSyncExternalStore } from "react";

/**
 * One "Revise…" draft per decision (PAP-773). On Needs You a plan card and its
 * Review side panel are two views of the same decision; both read and write
 * this store so opening Revise…, typing, cancelling and sending mirror live.
 * The side panel renders through the layout's panel slot, outside the page's
 * React tree, so this is a module store rather than a context.
 *
 * Key by interaction id + target revision id: a newer plan revision gets a
 * fresh, empty draft. Drafts survive closing the panel or switching cards for
 * the session (sessionStorage), and are cleared when the decision resolves.
 */
export type ReviseDraftWork = "accept" | "reject" | "revise";

export interface ReviseDraft {
  revising: boolean;
  reason: string;
  /** Which action one of the views is sending right now; blocks a second send. */
  working: ReviseDraftWork | null;
}

const STORAGE_KEY = "paperclip:revise-drafts";
const EMPTY_DRAFT: ReviseDraft = Object.freeze({ revising: false, reason: "", working: null }) as ReviseDraft;

const drafts = new Map<string, ReviseDraft>();
const listeners = new Set<() => void>();
let hydrated = false;

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, { revising?: unknown; reason?: unknown }>;
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const reason = typeof value.reason === "string" ? value.reason : "";
      const revising = value.revising === true;
      if (revising || reason) drafts.set(key, { revising, reason, working: null });
    }
  } catch {
    // A corrupt or unavailable store only costs the reload persistence.
  }
}

function persist() {
  try {
    const out: Record<string, { revising: boolean; reason: string }> = {};
    for (const [key, draft] of drafts) {
      if (draft.revising || draft.reason) out[key] = { revising: draft.revising, reason: draft.reason };
    }
    if (Object.keys(out).length === 0) globalThis.sessionStorage?.removeItem(STORAGE_KEY);
    else globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {
    // Storage full or blocked: the in-memory draft still syncs both views.
  }
}

function emit() {
  for (const listener of listeners) listener();
}

export function reviseDraftKey(interactionId: string, revisionId?: string | null) {
  return revisionId ? `${interactionId}:${revisionId}` : interactionId;
}

export function getReviseDraft(key: string): ReviseDraft {
  hydrate();
  return drafts.get(key) ?? EMPTY_DRAFT;
}

export function updateReviseDraft(key: string, patch: Partial<ReviseDraft>) {
  hydrate();
  const current = drafts.get(key) ?? EMPTY_DRAFT;
  const next = { ...current, ...patch };
  if (next.revising === current.revising && next.reason === current.reason && next.working === current.working) return;
  if (!next.revising && !next.reason && !next.working) drafts.delete(key);
  else drafts.set(key, next);
  persist();
  emit();
}

export function clearReviseDraft(key: string) {
  hydrate();
  if (!drafts.has(key)) return;
  drafts.delete(key);
  persist();
  emit();
}

/** Start sending from one view. Returns false when another view already is,
 * so one decision can't be resolved twice by two buttons. */
export function claimReviseDraftWork(key: string, working: ReviseDraftWork): boolean {
  if (getReviseDraft(key).working) return false;
  updateReviseDraft(key, { working });
  return true;
}

export function releaseReviseDraftWork(key: string) {
  updateReviseDraft(key, { working: null });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Read and write the shared draft for `key`. A null key means "not shared";
 * callers keep their own local state then. */
export function useReviseDraft(key: string | null) {
  const draft = useSyncExternalStore(
    subscribe,
    () => (key ? getReviseDraft(key) : EMPTY_DRAFT),
    () => EMPTY_DRAFT,
  );
  const update = useCallback((patch: Partial<ReviseDraft>) => {
    if (key) updateReviseDraft(key, patch);
  }, [key]);
  return [draft, update] as const;
}

/** Test-only: forget every draft and the hydration flag. */
export function resetReviseDraftsForTests() {
  drafts.clear();
  hydrated = false;
  emit();
}
