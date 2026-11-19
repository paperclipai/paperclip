import { describe, expect, it } from "vitest";
import { defaultRoutineView, readRoutineView, writeRoutineViewParams, filterRoutines, routineViewStorageKey } from "./routine-list-view";

describe("routine list views", () => {
  it("uses linked filters instead of the recipient's saved filters", () => {
    const saved = { ...defaultRoutineView, query: "saved", projects: ["other"], statuses: ["paused"] };
    const linked = readRoutineView(new URLSearchParams("projects=p1&agents=a1"), saved);
    expect(linked).toMatchObject({ query: "", projects: ["p1"], agents: ["a1"], statuses: [] });
  });
  it("round trips an explicitly cleared view and preserves unrelated URL state", () => {
    const params = writeRoutineViewParams(new URLSearchParams("folder=one&tab=routines"), defaultRoutineView);
    expect(params.get("folder")).toBe("one");
    expect(readRoutineView(params, { ...defaultRoutineView, projects: ["saved"] }).projects).toEqual([]);
  });
  it("validates malformed saved state and URL values", () => {
    const view = readRoutineView(new URLSearchParams("sortField=oops&groupBy=oops&statuses=active,invalid"), { columns: ["project", "oops"], collapsedGroups: null });
    expect(view.sortField).toBe("title");
    expect(view.groupBy).toBe("folder");
    expect(view.columns).toEqual(["project"]);
    expect(view.collapsedGroups).toEqual([]);
    expect(view.statuses).toEqual(["active"]);
  });
  it("applies AND across filter categories and OR within each category", () => {
    const rows = [
      { title: "Weekly review", description: "company", projectId: "p1", assigneeAgentId: "a1", responsibleUserId: "u1", status: "active", originKind: "manual" },
      { title: "Weekly review", description: "company", projectId: "p1", assigneeAgentId: "a2", responsibleUserId: "u2", status: "paused", originKind: "manual" },
    ];
    expect(filterRoutines(rows, { ...defaultRoutineView, query: "company weekly", agents: ["a1", "a2"], responsibleUsers: ["u1"], statuses: ["active"] })).toEqual([rows[0]]);
    expect(filterRoutines(rows, { ...defaultRoutineView, projects: ["__none"] })).toEqual([]);
  });
  it("keeps preferences separate for each person and company", () => {
    expect(routineViewStorageKey("c1", "u1")).not.toBe(routineViewStorageKey("c1", "u2"));
    expect(routineViewStorageKey("c1", "u1")).not.toBe(routineViewStorageKey("c2", "u1"));
  });
});
