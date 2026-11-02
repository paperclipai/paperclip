// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIssue } from "../../storybook/fixtures/paperclipData";
import type { TaskListItem } from "@/components/TaskList";
import { taskListViewStorageKey } from "@/lib/task-list-views";
import { useTaskListCollection } from "./useTaskListCollection";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const items: TaskListItem[] = [
  { issue: createIssue({ id: "parent", companyId: "company", parentId: null, title: "Connector reliability", createdByAgentId: null, createdByUserId: "same", assigneeUserId: null }), createdBy: "Scott", assignee: "CodexCoder" },
  { issue: createIssue({ id: "child", companyId: "company", parentId: "parent", title: "Review connector states", status: "in_review", createdByAgentId: "same", createdByUserId: null }), createdBy: "CodexCoder", unread: true },
  { issue: createIssue({ id: "grandchild", companyId: "company", parentId: "child", title: "Recover expired credentials", status: "todo", createdByAgentId: "same", createdByUserId: null }), createdBy: "CodexCoder" },
  { issue: createIssue({ id: "foreign", companyId: "other-company", parentId: null, createdByUserId: "foreign-user", createdByAgentId: null }), createdBy: "Another organization" },
];
const key = taskListViewStorageKey("collection-hook-test", "same");
type Options = Parameters<typeof useTaskListCollection>[0];
let collection: ReturnType<typeof useTaskListCollection>;
let root: Root;
let host: HTMLDivElement;
function Harness(props: Options) { collection = useTaskListCollection(props); return null; }
function render(overrides: Partial<Options> = {}) {
  act(() => root.render(<Harness items={items} companyId="company" userId="same" viewStorageKey={key} {...overrides} />));
}
beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  render();
});
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); });

describe("shared task-list collection behavior", () => {
  it("uses current live IDs for matching while retaining ancestor context", () => {
    render({ liveIssueIds: new Set(["child", "foreign"]) });
    act(() => collection.updateFilters({ liveOnly: true }));
    expect(collection.matchingItems.map(item => item.issue.id)).toEqual(["child"]);
    expect(collection.visibleItems.map(item => item.issue.id)).toEqual(["parent", "child"]);
    render({ liveIssueIds: new Set() });
    expect(collection.matchingItems).toEqual([]);
  });
  it("distinguishes human and agent creators with the same raw ID and excludes other companies", () => {
    expect(collection.creators).toEqual([
      { id: "user:same", label: "Scott", kind: "user" },
      { id: "agent:same", label: "CodexCoder", kind: "agent" },
    ]);
    act(() => collection.updateFilters({ creators: ["user:same"] }));
    expect(collection.matchingItems.map(item => item.issue.id)).toEqual(["parent"]);
    act(() => collection.updateFilters({ creators: ["agent:same"] }));
    expect(collection.matchingItems.map(item => item.issue.id)).toEqual(["child", "grandchild"]);
    expect(collection.visibleItems.map(item => item.issue.id)).toEqual(["parent", "child", "grandchild"]);
    act(() => collection.updateFilters({ creators: ["user:same", "agent:same"] }));
    expect(collection.matchingItems).toHaveLength(3);
  });

  it("reveals a searched descendant after its ancestors were collapsed", () => {
    act(() => collection.toggleExpanded());
    expect(collection.collapsedIds.has("parent")).toBe(true);
    act(() => collection.setQuery("expired credentials"));
    expect(collection.matchingItems.map(item => item.issue.id)).toEqual(["grandchild"]);
    expect(collection.visibleItems.map(item => item.issue.id)).toEqual(["parent", "child", "grandchild"]);
    expect(collection.collapsedIds.size).toBe(0);
  });

  it("expands matching families when filters or views change, and distinguishes matches from contextual parents", () => {
    act(() => collection.toggleExpanded());
    act(() => collection.updateFilters({ statuses: ["in_review"] }));
    expect(collection.collapsedIds.size).toBe(0);
    expect(collection.matchingItems.map(item => item.issue.id)).toEqual(["child"]);
    expect(collection.visibleItems.map(item => item.issue.id)).toEqual(["parent", "child"]);
    act(() => { collection.clear(); });
    act(() => collection.toggleExpanded());
    act(() => collection.setView("unread"));
    expect(collection.collapsedIds.size).toBe(0);
    expect(collection.matchingItems.map(item => item.issue.id)).toEqual(["child"]);
  });

  it("searches metadata as well as titles, and ignores whitespace-only queries", () => {
    act(() => collection.setQuery("Scott"));
    expect(collection.matchingItems.map(item => item.issue.id)).toEqual(["parent"]);
    act(() => collection.setQuery("CodexCoder"));
    expect(collection.matchingItems).toHaveLength(3);
    act(() => collection.setQuery("   "));
    expect(collection.narrowed).toBe(false);
    expect(collection.matchingItems).toHaveLength(3);
  });

  it("trusts server search while preserving company, status, and view filters", () => {
    render({ query: "document-only match", searchMode: "server" });
    expect(collection.query).toBe("document-only match");
    expect(collection.matchingItems.map(item => item.issue.id)).toEqual(["parent", "child", "grandchild"]);
    act(() => collection.updateFilters({ statuses: ["in_review"] }));
    expect(collection.matchingItems.map(item => item.issue.id)).toEqual(["child"]);
    expect(collection.visibleItems.map(item => item.issue.id)).toEqual(["parent", "child"]);
    act(() => { collection.updateFilters({ statuses: [] }); collection.setView("unread"); });
    expect(collection.matchingItems.map(item => item.issue.id)).toEqual(["child"]);
  });

  it("keeps view preferences isolated and clears the active collection without losing layout", () => {
    act(() => collection.setView("unread"));
    act(() => collection.setLayout("board"));
    render({ viewStorageKey: taskListViewStorageKey("another-trial", "same") });
    expect(collection.view).toBe("all");
    render();
    expect(collection.view).toBe("unread");
    act(() => collection.clear());
    expect(collection.view).toBe("all");
    expect(collection.query).toBe("");
    expect(collection.narrowed).toBe(false);
    expect(collection.layout).toBe("board");
    expect(localStorage.getItem(key)).toBe("all");
  });

  it("never includes foreign tasks or ancestor context when the company changes", () => {
    act(() => collection.toggleExpanded());
    render({ companyId: "other-company" });
    expect(collection.companyItems.map(item => item.issue.id)).toEqual(["foreign"]);
    expect(collection.visibleItems.map(item => item.issue.id)).toEqual(["foreign"]);
    expect(collection.creators.map(creator => creator.id)).toEqual(["user:foreign-user"]);
    expect(collection.collapsedIds.size).toBe(0);
  });
});
