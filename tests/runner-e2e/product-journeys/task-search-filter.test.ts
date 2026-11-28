import { describe, expect, it, vi } from "vitest";
import { taskSearchFilter } from "./task-search-filter.js";
import type { JourneyContext, JourneyEvidence, TargetSession } from "./types.js";
import type { SearchTask } from "./task-search-evidence.js";

// Use immediate assertions for this deterministic UI port. Live Playwright still
// owns browser rendering, locator compatibility, and asynchronous convergence.
vi.mock("@playwright/test", () => ({ expect: Object.assign(
  (locator: { isVisible(): Promise<boolean>; inputValue(): Promise<string> }) => ({
    async toBeVisible() { expect(await locator.isVisible()).toBe(true); },
    async toHaveValue(value: string) { expect(await locator.inputValue()).toBe(value); },
  }),
  { poll: (read: () => Promise<unknown>) => ({ async toEqual(value: unknown) { expect(await read()).toEqual(value); } }) },
) }));

type Fault = "ignore-search" | "ignore-status" | "duplicate-result" | "unknown-result" | "reload-query"
  | "reload-status" | "back-query" | "back-status" | "wrong-route" | "reload-content"
  | "saved-company" | "saved-description" | "target-run" | "control-run" | "missing-run-evidence"
  | "intent" | "receipt" | "missing-identifier" | "ignore-named-view" | "detached-snapshot";
type UiNode = { key: string; role?: string; name?: string; title?: string; text?: string; href?: string;
  visible?: boolean; connected?: boolean; children?: UiNode[]; click?(): void; fill?(value: string): void; check?(): void;
  value?(): string; checked?(): boolean };
type CollectionState = { query: string; backlog: boolean };

/** A stateful task-list port, not an always-successful locator stub. Search and
 * filters compute their results from the same owned records that the API stores.
 * Navigation can lose UI state independently of saved state and model activity. */
function fixture(fault?: Fault, shell: "coordinator" | "streamlined" | "legacy" = "coordinator") {
  const origin = "https://qa.example.test";
  const tasks: SearchTask[] = [];
  const ownership: Array<{ kind: string; name: string; id?: string; journeyId?: string }> = [];
  const reads: string[] = [];
  const observed: Array<{ event: "reload" | "back"; route: "collection" | "detail"; query: string;
    backlog: boolean; taskIds: string[]; displayedId: string | null; view: string }> = [];
  let pathname = "/QA/issues";
  let collection: CollectionState = { query: "old search", backlog: true };
  let previous: CollectionState | undefined;
  let allTasks = shell !== "streamlined";
  let selectedView = allTasks ? "all" : "mine";
  let viewMenu = false;
  let filterMenu = false;
  let displayedId: string | null = null;
  let lostContent = false;
  let navigated = false;
  const visibleTasks = () => {
    let rows = tasks.filter(task => (fault === "ignore-search" || task.title.includes(collection.query))
      && (fault === "ignore-status" || !collection.backlog || task.status === "backlog"));
    if (fault === "duplicate-result") rows = [...rows, ...rows.slice(0, 1)];
    if (fault === "unknown-result") rows = [...rows, { ...tasks[0]!, id: "foreign", identifier: "QA-999", title: "Other task" }];
    return rows.slice().reverse(); // The journey must not depend on row order.
  };
  const observe = (event: "reload" | "back") => observed.push({ event, route: displayedId ? "detail" : "collection",
    ...collection, taskIds: displayedId ? [] : visibleTasks().map(task => task.id), displayedId, view: selectedView });
  const openTask = (task: SearchTask) => {
    previous = { ...collection };
    // Model a stale prefetched header on an incorrectly bound link destination.
    pathname = `/QA/issues/${fault === "wrong-route" ? tasks[1]!.identifier : task.identifier}`;
    displayedId = task.id;
  };
  const links = (): UiNode[] => displayedId || !allTasks ? [] : visibleTasks().map((task, index) => ({
    key: `task-${task.id}-${index}`, role: "link", name: task.title, text: task.title,
    connected: fault !== "detached-snapshot" || task.id !== "task-2",
    href: `/QA/issues/${task.identifier}`, click: () => openTask(task),
  }));
  const nodes = (): UiNode[] => {
    const shown = tasks.find(task => task.id === displayedId);
    const status: UiNode = { key: "backlog", role: "checkbox", name: shell === "coordinator" ? "Backlog" : "BacklogBacklog", checked: () => collection.backlog,
      check: () => { collection.backlog = true; } };
    const clear: UiNode = { key: "clear", role: "button", name: "Clear", visible: collection.backlog,
      click: () => { collection.backlog = false; } };
    return [
      { key: "main" },
      { key: "views", role: "button", name: shell === "streamlined" ? `Change view — currently ${selectedView}` : "Task view: All tasks",
        visible: !displayedId && shell !== "legacy", click: () => { viewMenu = true; } },
      { key: "all-tasks", role: shell === "streamlined" ? "menuitem" : "menuitemradio", name: "All tasks", visible: viewMenu,
        click: () => { allTasks = true; selectedView = "all"; viewMenu = false; } },
      { key: "backlog-view", role: "menuitem", name: "Backlog Not started yet", visible: viewMenu && shell === "streamlined",
        click: () => {
          if (fault !== "ignore-named-view") selectedView = "backlog";
          collection = { query: "", backlog: true }; viewMenu = false;
        } },
      { key: "search", role: "textbox", name: "Search tasks", visible: allTasks && !displayedId,
        fill: value => { collection.query = value; }, value: () => collection.query },
      { key: "layout", role: "button", name: "List view", visible: allTasks && !displayedId, click: () => {} },
      { key: "filter", role: "button", name: collection.backlog ? "1" : "Filter",
        title: collection.backlog ? "Filters: 1" : "Filter", visible: allTasks && !displayedId,
        click: () => { filterMenu = true; } },
      { key: "filters", role: "dialog", name: "Filters", visible: filterMenu, children: [clear,
        { key: "status-group", children: [{ key: "status-heading", text: "Status" }, status] },
        { key: "responsible-group", children: [{ key: "responsible-heading", text: "Responsible" },
          { key: "responsible-backlog", role: "checkbox", name: "Backlog", checked: () => false,
            check: () => { throw Error("Selected an assignee instead of a status"); } }] },
      ] },
      { key: "heading", role: "heading", name: shown?.title, text: shown?.title, visible: Boolean(shown && !lostContent) },
      { key: "description", text: shown?.description, visible: Boolean(shown && !lostContent) },
      ...links(),
    ];
  };
  const flatten = (input: UiNode[]): UiNode[] => input.flatMap(node => node.visible === false ? [] : [node, ...flatten(node.children ?? [])]);
  const matches = (text: string | undefined, wanted: string | RegExp) => wanted instanceof RegExp ? wanted.test(text ?? "") : text === wanted;
  const locator = (resolve: () => UiNode[]) => {
    const unique = () => {
      const found = resolve();
      if (found.length !== 1) throw Error(`Expected one visible UI control, found ${found.length}`);
      return found[0]!;
    };
    return {
      resolve,
      or(other: { resolve(): UiNode[] }) { return locator(() => [...new Map([...resolve(), ...other.resolve()].map(node => [node.key, node])).values()]); },
      first() { return locator(() => resolve().slice(0, 1)); },
      filter({ hasText, visible }: { hasText?: string; visible?: boolean }) {
        return locator(() => resolve().filter(node => (hasText === undefined || node.text?.includes(hasText))
          && (visible !== true || node.visible !== false)));
      },
      locator(selector: string) {
        if (selector !== "..") throw Error(`Unsupported control-relative selector: ${selector}`);
        return locator(() => {
          const keys = new Set(resolve().map(node => node.key));
          return flatten(nodes()).filter(node => node.children?.some(child => keys.has(child.key)));
        });
      },
      getByText(text: string) {
        return locator(() => flatten(resolve().flatMap(node => node.children ?? [])).filter(node => node.text === text));
      },
      getByRole(role: string, { name }: { name: string | RegExp }) {
        return locator(() => flatten(resolve().flatMap(node => node.children ?? [])).filter(node => node.role === role && matches(node.name, name)));
      },
      async all() { return resolve().map(node => locator(() => [node])); },
      async evaluateAll<R>(read: (nodes: Array<{ isConnected: boolean; getAttribute(name: string): string | null }>) => R) {
        return read(resolve().map(node => ({ isConnected: node.connected !== false,
          getAttribute(name: string) { expect(name).toBe("href"); return node.href ?? null; } })));
      },
      async isVisible() { return resolve().length > 0; },
      async getAttribute(name: string) { expect(name).toBe("href"); return unique().href ?? null; },
      async inputValue() { const read = unique().value; if (!read) throw Error("Not an input"); return read(); },
      async isChecked() { const read = unique().checked; if (!read) throw Error("Not a checkbox"); return read(); },
      async click() { const action = unique().click; if (!action) throw Error("Not clickable"); action(); },
      async fill(value: string) { const action = unique().fill; if (!action) throw Error("Not fillable"); action(value); },
      async check() { const action = unique().check; if (!action) throw Error("Not checkable"); action(); },
    };
  };
  const page = {
    url: () => `${origin}${pathname}`,
    locator(selector: string) {
      if (selector === "main#main-content") return locator(() => [{ key: "main" }]);
      if (selector === "main#main-content a[data-inbox-issue-link]") return locator(links);
      throw Error(`Unsupported product selector: ${selector}`);
    },
    getByRole(role: string, { name }: { name: string | RegExp }) {
      return locator(() => flatten(nodes()).filter(node => node.role === role && matches(node.name, name)));
    },
    getByTitle(title: RegExp) { return locator(() => flatten(nodes()).filter(node => matches(node.title, title))); },
    getByText(text: string) { return locator(() => flatten(nodes()).filter(node => node.text === text)); },
    async goto(url: string) { expect(url).toBe(`${origin}/QA/issues`); navigated = true; },
    keyboard: { async press(key: string) { expect(key).toBe("Escape"); filterMenu = false; } },
    async reload() {
      // Combined Tasks explicitly overrides saved checkbox state with the
      // named view's preset. The journey must choose a supported named view.
      if (!displayedId && shell === "streamlined") collection.backlog = selectedView === "backlog";
      if (!displayedId && fault === "reload-query") collection.query = "";
      if (!displayedId && fault === "reload-status") collection.backlog = false;
      if (displayedId && fault === "reload-content") lostContent = true;
      observe("reload");
    },
    async goBack() {
      if (!displayedId || !previous) throw Error("No previous collection");
      displayedId = null; pathname = "/QA/issues"; collection = { ...previous };
      if (shell === "streamlined") collection.backlog = selectedView === "backlog";
      if (fault === "back-query") collection.query = "";
      if (fault === "back-status") collection.backlog = false;
      observe("back");
    },
  };
  const api = {
    origin,
    async post(route: string, body: Omit<SearchTask, "id" | "identifier" | "companyId">) {
      expect(route).toBe("/api/companies/company-1/issues");
      // A mutation without durable ownership intent is unsafe, even if the
      // browser journey would otherwise produce all its success checks.
      expect(ownership.some(resource => !resource.id && resource.name === body.title)).toBe(true);
      const task = { ...body, companyId: "company-1", id: `task-${tasks.length + 1}`, identifier: `QA-${tasks.length + 1}` };
      tasks.push(task);
      return fault === "missing-identifier" ? { id: task.id } : { id: task.id, identifier: task.identifier };
    },
    async get(route: string) {
      reads.push(route);
      const match = route.match(/^\/api\/issues\/(task-\d)(\/runs)?$/);
      if (!match) throw Error(`Unexpected public read: ${route}`);
      const task = tasks.find(task => task.id === match[1]);
      if (!task) throw Error("Read outside owned task set");
      if (match[2]) {
        if (fault === "missing-run-evidence") return null;
        return (fault === "target-run" && task.id === "task-1") || (fault === "control-run" && task.id === "task-3") ? [{ runId: "unexpected" }] : [];
      }
      return { ...task, ...(fault === "saved-company" && task.id === "task-1" ? { companyId: "other-company" } : {}),
        ...(fault === "saved-description" && task.id === "task-1" ? { description: "Different saved context" } : {}) };
    },
  };
  const session = { async own(resource: (typeof ownership)[number]) {
    if ((fault === "intent" && !resource.id) || (fault === "receipt" && resource.id)) throw Error("Ownership storage unavailable");
    ownership.push(resource);
  } } as unknown as TargetSession;
  const evidence = { checks: [] } as unknown as JourneyEvidence;
  const context = { page, api, company: { id: "company-1", issuePrefix: "QA" }, user: { id: "user-1", name: "Board" },
    capabilities: ["company", "board-user", "task-write"] } as unknown as JourneyContext;
  return { run: () => taskSearchFilter(context, session, "campaign-1", evidence), tasks, ownership, reads, observed, evidence,
    navigated: () => navigated, context };
}

describe("taskSearchFilter browser journey", () => {
  it.each(["coordinator", "streamlined", "legacy"] as const)("checks owned UI results and persisted content in the %s task shell", async shell => {
    const test = fixture(undefined, shell);
    await test.run();
    expect(test.evidence.checks).toEqual([
      { id: "task-search-results-exact", passed: true }, { id: "task-status-filter-excludes-controls", passed: true },
      { id: "task-search-filter-reloaded", passed: true }, { id: "task-search-result-reopened", passed: true },
      { id: "no-agent-work", passed: true },
    ]);
    for (const task of test.tasks) {
      expect(test.ownership).toContainEqual({ kind: "issue", name: task.title, journeyId: "task-search-filter" });
      expect(test.ownership).toContainEqual({ kind: "issue", name: task.title, id: task.id, journeyId: "task-search-filter" });
      expect(test.reads).toContain(`/api/issues/${task.id}`);
      expect(test.reads).toContain(`/api/issues/${task.id}/runs`);
    }
    const filtered = { query: "needle-campaign-1", backlog: true, taskIds: ["task-1"], displayedId: null,
      view: shell === "streamlined" ? "backlog" : "all" };
    expect(test.observed).toContainEqual({ event: "reload", route: "collection", ...filtered });
    expect(test.observed).toContainEqual({ event: "back", route: "collection", ...filtered });
    expect(test.observed.filter(view => view.event === "reload" && view.route === "detail").map(view => view.displayedId))
      .toEqual(["task-1", "task-1"]);
  });
  it("requires the streamlined named status view when All tasks clears temporary filters on mount", async () => {
    const test = fixture("ignore-named-view", "streamlined");
    await expect(test.run()).rejects.toThrow();
    expect(test.observed).toContainEqual(expect.objectContaining({ event: "reload", view: "all", backlog: false,
      taskIds: ["task-2", "task-1"] }));
    expect(test.evidence.checks).toEqual([]);
  });
  it.each<Fault>(["ignore-search", "ignore-status", "duplicate-result", "unknown-result", "reload-query", "reload-status",
    "back-query", "back-status", "reload-content", "detached-snapshot"])("does not report success when the UI has %s", async fault => {
    const test = fixture(fault);
    await expect(test.run()).rejects.toThrow();
    expect(test.evidence.checks.some(check => check.passed)).toBe(false);
  });
  it.each<Fault>(["wrong-route", "saved-company", "saved-description", "target-run", "control-run", "missing-run-evidence"])
    ("fails independent verification for %s after otherwise valid UI actions", async fault => {
      const test = fixture(fault);
      await expect(test.run()).rejects.toMatchObject({ outcome: "failed", code: "task_search_evidence_mismatch" });
      expect(test.evidence.checks.some(check => !check.passed)).toBe(true);
    });
  it.each<Fault>(["intent", "receipt", "missing-identifier"])("stops setup safely on %s failure", async fault => {
    const test = fixture(fault);
    await expect(test.run()).rejects.toThrow();
    expect(test.tasks).toHaveLength(fault === "intent" ? 0 : 1);
    expect(test.navigated()).toBe(false);
    expect(test.evidence.checks).toEqual([]);
    if (fault === "missing-identifier") expect(test.ownership.at(-1)).toMatchObject({ id: "task-1" });
  });
  it("rejects unsupported capability before creating resources", async () => {
    const test = fixture(); test.context.capabilities = ["company", "board-user"];
    await expect(test.run()).rejects.toMatchObject({ outcome: "unsupported", code: "missing_task-write" });
    expect(test.tasks).toEqual([]);
    expect(test.ownership).toEqual([]);
  });
  it.each([
    ["intent", "prepare"], ["ignore-search", "search_results"], ["ignore-status", "apply_status"],
    ["reload-query", "reload_collection"], ["reload-content", "reload_result"], ["back-query", "return_collection"],
  ] as const)("retains only a closed stage code for %s failure", async (fault, stage) => {
    const test = fixture(fault);
    await expect(test.run()).rejects.toMatchObject({ outcome: "failed", code: `task_search_${stage}_failed`,
      message: `task_search_${stage}_failed` });
    expect(test.evidence.checks).toEqual([]);
  });
});
