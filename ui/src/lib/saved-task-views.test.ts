import { describe, expect, it } from "vitest";
import type { SavedTaskView } from "@paperclipai/shared";
import {
  EPHEMERAL_VIEW_STATE_KEYS,
  SAVED_TASK_VIEW_PREFIX,
  STARTER_SAVED_TASK_VIEWS,
  applySavedViewDefinition,
  findSavedTaskView,
  isSavedTaskViewKey,
  missingStarterTaskViews,
  parseSavedTaskViewId,
  savedTaskViewKey,
  savedViewDefinitionRevision,
  savedViewDefinitionsEqual,
  shouldOfferStarterTaskViews,
  suggestSavedViewCopyName,
  toSavedViewDefinition,
} from "./saved-task-views";
import { applyIssueFilters, normalizeIssueFilterState } from "./issue-filters";
import type { Issue } from "@paperclipai/shared";

function view(id: string, name: string, viewState: Record<string, unknown> = {}): SavedTaskView {
  return {
    id,
    name,
    viewState,
    companyId: "company-1",
    collectionKey: "paperclip:issues-view",
    position: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("saved view keys", () => {
  it("round-trips an id through the URL key", () => {
    const key = savedTaskViewKey("abc-123");
    expect(key).toBe(`${SAVED_TASK_VIEW_PREFIX}abc-123`);
    expect(isSavedTaskViewKey(key)).toBe(true);
    expect(parseSavedTaskViewId(key)).toBe("abc-123");
  });

  it("does not mistake a built-in view key, or a bare prefix, for a saved view", () => {
    for (const value of ["active", "backlog", "saved:", "", null, undefined, 7]) {
      expect(isSavedTaskViewKey(value)).toBe(false);
      expect(parseSavedTaskViewId(value)).toBeNull();
    }
  });

  it("resolves a key against the loaded views, and to null when it is gone", () => {
    const views = [view("a", "Ready to start"), view("b", "Done")];
    expect(findSavedTaskView(views, "saved:b")?.name).toBe("Done");
    expect(findSavedTaskView(views, "saved:missing")).toBeNull();
    expect(findSavedTaskView(views, "active")).toBeNull();
    expect(findSavedTaskView(undefined, "saved:a")).toBeNull();
  });
});

describe("view definitions", () => {
  it("stores the definition and drops per-session folding state", () => {
    const definition = toSavedViewDefinition({
      statuses: ["todo"],
      sortField: "priority",
      collapsedGroups: ["todo"],
      collapsedParents: ["issue-1"],
    });

    expect(definition).toEqual({ statuses: ["todo"], sortField: "priority" });
    for (const key of EPHEMERAL_VIEW_STATE_KEYS) {
      expect(key in definition).toBe(false);
    }
  });

  it("stores no task rows — only the fields that rebuild the view", () => {
    for (const starter of STARTER_SAVED_TASK_VIEWS) {
      const definition = toSavedViewDefinition(starter.definition);
      for (const value of Object.values(definition)) {
        const flattened = Array.isArray(value) ? value : [value];
        for (const entry of flattened) {
          // Filter values are scalars; a task object would mean the view had
          // copied state out of the task list.
          expect(["string", "number", "boolean", "undefined"]).toContain(typeof entry);
        }
      }
    }
  });

  it("treats filter order as insignificant but filter content as significant", () => {
    expect(savedViewDefinitionsEqual(
      { statuses: ["todo", "backlog"] },
      { statuses: ["backlog", "todo"] },
    )).toBe(true);
    expect(savedViewDefinitionsEqual(
      { statuses: ["todo", "backlog"] },
      { statuses: ["todo"] },
    )).toBe(false);
    expect(savedViewDefinitionsEqual({ sortDir: "asc" }, { sortDir: "desc" })).toBe(false);
  });

  it("does not call a view edited just because a group was folded", () => {
    const saved = { statuses: ["todo"] };
    const afterFolding = { statuses: ["todo"], collapsedGroups: ["todo"], collapsedParents: [] };
    expect(savedViewDefinitionsEqual(saved, afterFolding)).toBe(true);
  });

  it("compares values exactly, so callers normalize both sides first", () => {
    // A sparse definition written by an older build is not the same *value* as
    // a complete one. Callers run it through the collection's normalizer before
    // comparing — see the next case — so this strictness never surfaces as a
    // false "unsaved changes".
    expect(savedViewDefinitionsEqual({ statuses: [] }, {})).toBe(false);
    expect(savedViewDefinitionsEqual({ statuses: ["todo"] }, {})).toBe(false);
  });

  it("a sparse stored definition matches the state it opens, once normalized", () => {
    const normalize = (value: unknown) => normalizeIssueFilterState(value) as Record<string, unknown>;
    const stored = { statuses: ["todo"] };
    const opened = applySavedViewDefinition({}, stored, normalize);

    expect(savedViewDefinitionsEqual(opened, normalize(stored))).toBe(true);
  });

  it("applies a definition over current state, keeping what the user folded", () => {
    const current = {
      statuses: ["done"],
      sortField: "updated",
      collapsedGroups: ["done"],
      collapsedParents: ["issue-1"],
    };
    const applied = applySavedViewDefinition(
      current,
      { statuses: ["todo"], sortField: "priority" },
      (value) => value as typeof current,
    );

    expect(applied.statuses).toEqual(["todo"]);
    expect(applied.sortField).toBe("priority");
    expect(applied.collapsedGroups).toEqual(["done"]);
    expect(applied.collapsedParents).toEqual(["issue-1"]);
  });
});

describe("suggestSavedViewCopyName", () => {
  it("suggests a free name and steps past the ones in use", () => {
    expect(suggestSavedViewCopyName([], "Ready to start")).toBe("Copy of Ready to start");
    expect(suggestSavedViewCopyName([view("a", "Copy of Done")], "Done")).toBe("Copy of Done 2");
    expect(suggestSavedViewCopyName(
      [view("a", "Copy of Done"), view("b", "Copy of Done 2")],
      "Done",
    )).toBe("Copy of Done 3");
  });

  it("is case-insensitive about names already taken", () => {
    expect(suggestSavedViewCopyName([view("a", "copy of done")], "Done")).toBe("Copy of Done 2");
  });

  it("never suggests a name past the server's length cap", () => {
    const long = "x".repeat(200);
    const views = Array.from({ length: 3 }, (_, index) => view(`v${index}`, `Copy of ${long}`.slice(0, 60)));
    expect(suggestSavedViewCopyName(views, long).length).toBeLessThanOrEqual(60);
  });
});

describe("starter views", () => {
  it("offers distinct names and a 'Ready to start' that means not-yet-started work", () => {
    const names = STARTER_SAVED_TASK_VIEWS.map((starter) => starter.name);
    expect(new Set(names).size).toBe(names.length);

    const readyToStart = STARTER_SAVED_TASK_VIEWS.find((s) => s.name === "Ready to start");
    expect(readyToStart?.definition.statuses).toEqual(["todo", "backlog"]);
  });

  it("names nothing after one instance or one person", () => {
    for (const starter of STARTER_SAVED_TASK_VIEWS) {
      expect(starter.name).toMatch(/^[A-Z][a-z]/);
      expect(JSON.stringify(starter.definition)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    }
  });

  it("every starter view filters with the same function that renders the rows", () => {
    const issues = [
      { id: "1", status: "todo", priority: "high", labelIds: [] },
      { id: "2", status: "in_progress", priority: "low", labelIds: [] },
      { id: "3", status: "done", priority: "low", labelIds: [] },
      { id: "4", status: "backlog", priority: "medium", labelIds: [] },
    ] as unknown as Issue[];

    const readyToStart = STARTER_SAVED_TASK_VIEWS.find((s) => s.name === "Ready to start")!;
    const rows = applyIssueFilters(issues, normalizeIssueFilterState(readyToStart.definition));
    expect(rows.map((issue) => issue.id).sort()).toEqual(["1", "4"]);

    const done = STARTER_SAVED_TASK_VIEWS.find((s) => s.name === "Done")!;
    expect(applyIssueFilters(issues, normalizeIssueFilterState(done.definition)).map((i) => i.id))
      .toEqual(["3"]);
  });

  it("offers the missing starters again after a run that stopped half way", () => {
    const [first, second] = STARTER_SAVED_TASK_VIEWS;
    const partial = [view("a", first!.name), view("b", second!.name)];

    expect(missingStarterTaskViews(partial).map((s) => s.name))
      .toEqual(STARTER_SAVED_TASK_VIEWS.slice(2).map((s) => s.name));
    expect(shouldOfferStarterTaskViews(partial)).toBe(true);

    // Empty is the first-run offer; a complete set is not offered again.
    expect(shouldOfferStarterTaskViews([])).toBe(true);
    const complete = STARTER_SAVED_TASK_VIEWS.map((s, i) => view(`s${i}`, s.name));
    expect(missingStarterTaskViews(complete)).toEqual([]);
    expect(shouldOfferStarterTaskViews(complete)).toBe(false);

    // Only the user's own views, no starters: not a half-finished run.
    expect(shouldOfferStarterTaskViews([view("x", "My week")])).toBe(false);
  });
});

describe("savedViewDefinitionRevision", () => {
  it("ignores a rename and changes when the definition changes", () => {
    const definition = { statuses: ["todo", "backlog"], sortField: "priority" };
    // A rename never touches the definition, so the revision must not move —
    // this is what stops a rename from discarding unsaved filter edits.
    expect(savedViewDefinitionRevision(definition))
      .toBe(savedViewDefinitionRevision({ ...definition }));
    expect(savedViewDefinitionRevision({ ...definition, statuses: ["backlog", "todo"] }))
      .toBe(savedViewDefinitionRevision(definition));
    expect(savedViewDefinitionRevision({ ...definition, statuses: ["todo"] }))
      .not.toBe(savedViewDefinitionRevision(definition));
  });

  it("ignores the ephemeral keys, so folding a group does not re-apply the view", () => {
    const definition = { statuses: ["todo"] };
    expect(savedViewDefinitionRevision({ ...definition, collapsedGroups: ["todo"] }))
      .toBe(savedViewDefinitionRevision(definition));
  });
});
