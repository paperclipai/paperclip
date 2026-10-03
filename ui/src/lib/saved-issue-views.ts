export const SAVED_VIEWS_VERSION = 1 as const;
export const SAVED_VIEWS_LIMIT = 50 as const;
export const SAVED_VIEW_NAME_LIMIT = 80 as const;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface SavedView<TViewState, TColumn extends string> {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  viewState: TViewState;
  columns: TColumn[];
}

export interface SavedViewsLocation {
  companyId: string;
  collectionKey: string;
}

export interface SavedViewNormalizers<TViewState, TColumn extends string> {
  normalizeViewState: (value: unknown) => TViewState;
  normalizeColumns: (value: unknown) => TColumn[];
}

interface SavedViewsEnvelope {
  version: typeof SAVED_VIEWS_VERSION;
  companyId: string;
  collectionKey: string;
  views: readonly unknown[];
}

function browserStorage(): StorageLike | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

export function savedViewsStorageKey({
  companyId,
  collectionKey,
}: SavedViewsLocation): string {
  return `paperclip:saved-views:v${SAVED_VIEWS_VERSION}:${encodeURIComponent(companyId)}:${encodeURIComponent(collectionKey)}`;
}

export function normalizeSavedViewName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, SAVED_VIEW_NAME_LIMIT);
}

function defaultViewId(): string {
  if (
    typeof crypto !== "undefined"
    && "randomUUID" in crypto
    && typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `view-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

function defaultNowIso(): string {
  return new Date().toISOString();
}

function normalizeStoredView<TViewState, TColumn extends string>(
  value: unknown,
  normalizers: SavedViewNormalizers<TViewState, TColumn>,
): SavedView<TViewState, TColumn> | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<SavedView<TViewState, TColumn>>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return null;
  const name = typeof candidate.name === "string" ? normalizeSavedViewName(candidate.name) : "";
  if (name.length === 0) return null;
  return {
    id: candidate.id,
    name,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : defaultNowIso(),
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : defaultNowIso(),
    viewState: normalizers.normalizeViewState(candidate.viewState),
    columns: normalizers.normalizeColumns(candidate.columns),
  };
}

function isCurrentEnvelope(value: unknown, location: SavedViewsLocation): value is SavedViewsEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SavedViewsEnvelope>;
  return candidate.version === SAVED_VIEWS_VERSION
    && candidate.companyId === location.companyId
    && candidate.collectionKey === location.collectionKey
    && Array.isArray(candidate.views);
}

export function loadSavedViews<TViewState, TColumn extends string>(
  location: SavedViewsLocation,
  normalizers: SavedViewNormalizers<TViewState, TColumn>,
  storage: StorageLike | null = browserStorage(),
): SavedView<TViewState, TColumn>[] {
  if (!storage) return [];
  let parsed: unknown = null;
  try {
    const raw = storage.getItem(savedViewsStorageKey(location));
    parsed = raw == null ? null : JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isCurrentEnvelope(parsed, location)) return [];
  const views: SavedView<TViewState, TColumn>[] = [];
  const seenIds = new Set<string>();
  for (const entry of parsed.views) {
    const view = normalizeStoredView(entry, normalizers);
    if (!view || seenIds.has(view.id)) continue;
    seenIds.add(view.id);
    views.push(view);
  }
  return views;
}

export function persistSavedViews(
  location: SavedViewsLocation,
  views: ReadonlyArray<unknown>,
  storage: StorageLike | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    const envelope: SavedViewsEnvelope = {
      version: SAVED_VIEWS_VERSION,
      companyId: location.companyId,
      collectionKey: location.collectionKey,
      views,
    };
    storage.setItem(savedViewsStorageKey(location), JSON.stringify(envelope));
    return true;
  } catch {
    // Saved views are an enhancement; storage denial must not break the list.
    // Callers surface the false return instead of pretending the write held.
    return false;
  }
}

export type CreateSavedViewError = "name-required" | "duplicate-name" | "limit-reached";

export function createSavedView<TViewState, TColumn extends string>(
  views: ReadonlyArray<SavedView<TViewState, TColumn>>,
  snapshot: { name: string; viewState: TViewState; columns: TColumn[] },
  options: { generateId?: () => string; nowIso?: () => string } = {},
): { views: SavedView<TViewState, TColumn>[]; view: SavedView<TViewState, TColumn> }
| { error: CreateSavedViewError } {
  const name = normalizeSavedViewName(snapshot.name);
  if (name.length === 0) return { error: "name-required" };
  const duplicate = views.some((view) => view.name.toLowerCase() === name.toLowerCase());
  if (duplicate) return { error: "duplicate-name" };
  if (views.length >= SAVED_VIEWS_LIMIT) return { error: "limit-reached" };
  const now = (options.nowIso ?? defaultNowIso)();
  const view: SavedView<TViewState, TColumn> = {
    id: (options.generateId ?? defaultViewId)(),
    name,
    createdAt: now,
    updatedAt: now,
    viewState: snapshot.viewState,
    columns: snapshot.columns,
  };
  return { views: [view, ...views], view };
}

export type RenameSavedViewError = "not-found" | "name-required" | "duplicate-name";

export function renameSavedView<TViewState, TColumn extends string>(
  views: ReadonlyArray<SavedView<TViewState, TColumn>>,
  id: string,
  name: string,
  options: { nowIso?: () => string } = {},
): { views: SavedView<TViewState, TColumn>[] } | { error: RenameSavedViewError } {
  const nextName = normalizeSavedViewName(name);
  if (nextName.length === 0) return { error: "name-required" };
  if (!views.some((view) => view.id === id)) return { error: "not-found" };
  const duplicate = views.some(
    (view) => view.id !== id && view.name.toLowerCase() === nextName.toLowerCase(),
  );
  if (duplicate) return { error: "duplicate-name" };
  const now = (options.nowIso ?? defaultNowIso)();
  return {
    views: views.map((view) => (view.id === id ? { ...view, name: nextName, updatedAt: now } : view)),
  };
}

export function deleteSavedView<TViewState, TColumn extends string>(
  views: ReadonlyArray<SavedView<TViewState, TColumn>>,
  id: string,
): SavedView<TViewState, TColumn>[] {
  return views.filter((view) => view.id !== id);
}
