export const TASK_COLLECTION_PREFERENCES_VERSION = 1 as const;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export interface TaskCollectionPreferenceEnvelope<TViewState, TColumn extends string> {
  version: typeof TASK_COLLECTION_PREFERENCES_VERSION;
  companyId: string;
  collectionKey: string;
  viewState: TViewState;
  viewStateSource?: "stored" | "default";
  columns: TColumn[];
}

export interface TaskCollectionPreferenceLocation {
  companyId: string;
  collectionKey: string;
  legacyViewStorageKey?: string;
  legacyColumnsStorageKey?: string;
}

export interface LoadTaskCollectionPreferenceOptions<TViewState, TColumn extends string>
  extends TaskCollectionPreferenceLocation {
  storage?: StorageLike | null;
  defaultViewState: TViewState;
  defaultColumns: TColumn[];
  normalizeViewState: (value: unknown) => TViewState;
  normalizeColumns: (value: unknown) => TColumn[];
}

function browserStorage(): StorageLike | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

function parseStoredJson(storage: StorageLike, key: string | undefined): unknown {
  if (!key) return null;
  try {
    const value = storage.getItem(key);
    return value == null ? null : JSON.parse(value);
  } catch {
    return null;
  }
}

export function taskCollectionPreferencesStorageKey({
  companyId,
  collectionKey,
}: Pick<TaskCollectionPreferenceLocation, "companyId" | "collectionKey">): string {
  return `paperclip:task-collection:v${TASK_COLLECTION_PREFERENCES_VERSION}:${encodeURIComponent(companyId)}:${encodeURIComponent(collectionKey)}`;
}

function isCurrentEnvelope<TViewState, TColumn extends string>(
  value: unknown,
  location: TaskCollectionPreferenceLocation,
): value is TaskCollectionPreferenceEnvelope<TViewState, TColumn> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TaskCollectionPreferenceEnvelope<TViewState, TColumn>>;
  return candidate.version === TASK_COLLECTION_PREFERENCES_VERSION
    && candidate.companyId === location.companyId
    && candidate.collectionKey === location.collectionKey
    && "viewState" in candidate
    && Array.isArray(candidate.columns);
}

export function saveTaskCollectionPreferences<TViewState, TColumn extends string>(
  location: TaskCollectionPreferenceLocation,
  value: { viewState: TViewState; columns: TColumn[]; viewStateSource?: "stored" | "default" },
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  const envelope: TaskCollectionPreferenceEnvelope<TViewState, TColumn> = {
    version: TASK_COLLECTION_PREFERENCES_VERSION,
    companyId: location.companyId,
    collectionKey: location.collectionKey,
    viewState: value.viewState,
    viewStateSource: value.viewStateSource ?? "stored",
    columns: value.columns,
  };

  try {
    storage.setItem(taskCollectionPreferencesStorageKey(location), JSON.stringify(envelope));
    // Dual-write during migration so older builds using the same worktree keep
    // reading the latest presentation state.
    if (location.legacyViewStorageKey) {
      storage.setItem(location.legacyViewStorageKey, JSON.stringify(value.viewState));
    }
    if (location.legacyColumnsStorageKey) {
      storage.setItem(location.legacyColumnsStorageKey, JSON.stringify(value.columns));
    }
  } catch {
    // Preferences are an enhancement; storage denial must not break the list.
  }
}

export function loadTaskCollectionPreferences<TViewState, TColumn extends string>({
  storage = browserStorage(),
  defaultViewState,
  defaultColumns,
  normalizeViewState,
  normalizeColumns,
  ...location
}: LoadTaskCollectionPreferenceOptions<TViewState, TColumn>): {
  viewState: TViewState;
  columns: TColumn[];
  migrated: boolean;
  source: "current" | "legacy" | "default";
} {
  if (!storage) {
    return { viewState: defaultViewState, columns: defaultColumns, migrated: false, source: "default" };
  }

  const current = parseStoredJson(storage, taskCollectionPreferencesStorageKey(location));
  if (isCurrentEnvelope<TViewState, TColumn>(current, location)) {
    return {
      viewState: normalizeViewState(current.viewState),
      columns: normalizeColumns(current.columns),
      migrated: false,
      source: current.viewStateSource === "default" ? "default" : "current",
    };
  }

  const legacyView = parseStoredJson(storage, location.legacyViewStorageKey);
  const legacyColumns = parseStoredJson(storage, location.legacyColumnsStorageKey);
  const hasLegacyState = legacyView !== null || legacyColumns !== null;
  const preferences = {
    viewState: legacyView === null ? defaultViewState : normalizeViewState(legacyView),
    columns: legacyColumns === null ? defaultColumns : normalizeColumns(legacyColumns),
  };

  if (hasLegacyState) {
    saveTaskCollectionPreferences(location, {
      ...preferences,
      viewStateSource: legacyView === null ? "default" : "stored",
    }, storage);
  }
  return {
    ...preferences,
    migrated: hasLegacyState,
    source: legacyView !== null ? "legacy" : "default",
  };
}
