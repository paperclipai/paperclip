import { describe, expect, it } from "vitest";
import {
  SAVED_VIEWS_LIMIT,
  createSavedView,
  deleteSavedView,
  loadSavedViews,
  normalizeSavedViewName,
  persistSavedViews,
  renameSavedView,
  savedViewsStorageKey,
} from "./saved-issue-views";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

type ViewState = { sort: "updated" | "created"; statuses: string[] };
type Column = "status" | "id" | "updated";

const defaults: ViewState = { sort: "updated", statuses: [] };
const defaultColumns: Column[] = ["status", "id", "updated"];
const normalizeViewState = (value: unknown): ViewState => {
  const candidate = value as Partial<ViewState> | null;
  return {
    sort: candidate?.sort === "created" ? "created" : "updated",
    statuses: Array.isArray(candidate?.statuses)
      ? candidate.statuses.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
};
const normalizeColumns = (value: unknown): Column[] => Array.isArray(value)
  ? (value as unknown[]).filter((entry): entry is Column =>
    entry === "status" || entry === "id" || entry === "updated")
  : [...defaultColumns];
const normalizers = { normalizeViewState, normalizeColumns };
const location = { companyId: "company-a", collectionKey: "tasks" };

function seed(overrides: { name?: string; id?: string } = {}) {
  return {
    name: overrides.name ?? "Blocked work",
    viewState: { ...defaults, statuses: ["blocked"] },
    columns: [...defaultColumns] as Column[],
  };
}

describe("saved issue views", () => {
  it("scopes the storage key per company and collection", () => {
    expect(savedViewsStorageKey(location)).toBe("paperclip:saved-views:v1:company-a:tasks");
    expect(savedViewsStorageKey({ companyId: "b", collectionKey: "tasks" })).not.toBe(
      savedViewsStorageKey(location),
    );
  });

  it("normalizes names by collapsing whitespace and trimming length", () => {
    expect(normalizeSavedViewName("  my   view\t")).toBe("my view");
    expect(normalizeSavedViewName("x".repeat(200)).length).toBeLessThanOrEqual(80);
  });

  it("creates views newest-first and round-trips through storage", () => {
    const storage = new MemoryStorage();
    let views = loadSavedViews(location, normalizers, storage);
    expect(views).toEqual([]);

    const first = createSavedView(views, seed({ name: "First" }), {
      generateId: () => "view-1",
      nowIso: () => "2026-01-01T00:00:00.000Z",
    });
    const second = createSavedView("views" in first ? first.views : [], seed({ name: "Second" }), {
      generateId: () => "view-2",
      nowIso: () => "2026-01-02T00:00:00.000Z",
    });
    if (!("views" in second)) throw new Error("expected second create to succeed");
    persistSavedViews(location, second.views, storage);

    const loaded = loadSavedViews(location, normalizers, storage);
    expect(loaded.map((view) => view.id)).toEqual(["view-2", "view-1"]);
    expect(loaded[0]).toMatchObject({ name: "Second", createdAt: "2026-01-02T00:00:00.000Z" });
    expect(loaded[1]?.viewState).toEqual({ sort: "updated", statuses: ["blocked"] });
  });

  it("rejects blank names, duplicate names, and overflow past the limit", () => {
    const storage = new MemoryStorage();
    expect(createSavedView([], seed({ name: "   " }))).toEqual({ error: "name-required" });

    const created = createSavedView([], seed({ name: "Mine" }), { generateId: () => "v-1" });
    if (!("views" in created)) throw new Error("expected create to succeed");
    expect(createSavedView(created.views, seed({ name: "mine" }))).toEqual({ error: "duplicate-name" });

    const full = Array.from({ length: SAVED_VIEWS_LIMIT }, (_, index) => ({
      id: `v-${index}`,
      name: `View ${index}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      viewState: { ...defaults },
      columns: [...defaultColumns] as Column[],
    }));
    expect(createSavedView(full, seed({ name: "One more" }))).toEqual({ error: "limit-reached" });
    void storage;
  });

  it("renames in place and deletes by id", () => {
    const created = createSavedView([], seed({ name: "Old" }), { generateId: () => "v-1" });
    if (!("views" in created)) throw new Error("expected create to succeed");
    const added = createSavedView(created.views, seed({ name: "Other" }), { generateId: () => "v-2" });
    if (!("views" in added)) throw new Error("expected second create to succeed");

    const renamed = renameSavedView(added.views, "v-1", "  New name ", {
      nowIso: () => "2026-02-01T00:00:00.000Z",
    });
    if (!("views" in renamed)) throw new Error("expected rename to succeed");
    expect(renamed.views.map((view) => view.id)).toEqual(["v-2", "v-1"]);
    expect(renamed.views[1]).toMatchObject({ name: "New name", updatedAt: "2026-02-01T00:00:00.000Z" });

    expect(renameSavedView(renamed.views, "v-1", "other")).toEqual({ error: "duplicate-name" });
    expect(renameSavedView(renamed.views, "missing", "Name")).toEqual({ error: "not-found" });
    expect(renameSavedView(renamed.views, "v-1", "  ")).toEqual({ error: "name-required" });

    expect(deleteSavedView(renamed.views, "v-2").map((view) => view.id)).toEqual(["v-1"]);
  });

  it("drops corrupt entries and ignores other companies on load", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      savedViewsStorageKey(location),
      JSON.stringify({
        version: 1,
        companyId: "company-a",
        collectionKey: "tasks",
        views: [
          { id: "good", name: "Good", viewState: { sort: "nope", statuses: "nope" }, columns: ["status", "bogus"] },
          { id: "", name: "Missing id" },
          { id: "good", name: "Duplicate id" },
          { id: "blank", name: "   " },
        ],
      }),
    );
    const loaded = loadSavedViews(location, normalizers, storage);
    expect(loaded.map((view) => view.id)).toEqual(["good"]);
    expect(loaded[0]?.viewState).toEqual(defaults);
    expect(loaded[0]?.columns).toEqual(["status"]);

    expect(loadSavedViews({ companyId: "company-b", collectionKey: "tasks" }, normalizers, storage)).toEqual([]);
  });

  it("returns empty views when storage is corrupt or unavailable", () => {
    const storage = new MemoryStorage();
    storage.setItem(savedViewsStorageKey(location), "not-json{{{");
    expect(loadSavedViews(location, normalizers, storage)).toEqual([]);
    expect(loadSavedViews(location, normalizers, null)).toEqual([]);
  });
});
