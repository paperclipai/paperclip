// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { i18n, t } from "@/i18n";
import { defaultIssueFilterState } from "@/lib/issue-filters";
import { TaskListViewport, TaskListColumnHeader, taskColumnAnnouncements, type TaskListColumnId, type TaskListSort } from "./TaskListColumns";
import { IssueFilterPanel } from "./IssueFilterPanel";
import { ProjectAccessNotice } from "./ProjectAccessNotice";

afterEach(async () => { await i18n.changeLanguage("en"); });

it("keeps column order and sort values canonical through locale changes and keyboard reorder", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const reorder = vi.fn(), sortChange = vi.fn();
  function Columns() {
    const [order, setOrder] = useState<readonly TaskListColumnId[]>(["task", "project", "assignee"]);
    const [sort, setSort] = useState<TaskListSort>({ column: "project", direction: "descending" });
    return <TaskListViewport visibleColumns={order} columnOrder={order}><TaskListColumnHeader sort={sort} onSortChange={v => { sortChange(v); setSort(v); }} onColumnOrderChange={v => { reorder(v); setOrder(v); }} /></TaskListViewport>;
  }
  try {
    await act(async () => root.render(<Columns />));
    const button = host.querySelector<HTMLButtonElement>('[data-column="project"] button')!;
    for (const language of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      expect(host.querySelector('[data-column="project"] button')).toBe(button);
      expect(button.getAttribute("aria-label")).toBe(t("oct26Ui.columns.sortAscending", { label: t("oct26Ui.columns.project") }));
      expect(host.querySelector('[data-column="project"]')?.getAttribute("aria-sort")).toBe("descending");
      expect([...host.querySelectorAll('[data-column]')].map(el => el.getAttribute("data-column"))).toEqual(["task", "project", "assignee"]);
      expect(sortChange).not.toHaveBeenCalled(); expect(reorder).not.toHaveBeenCalled();
      expect(taskColumnAnnouncements.onDragStart({ active: { id: "project" } as never })).toBe(t("oct26Ui.columns.dragStart", { label: t("oct26Ui.columns.project") }));
      expect(taskColumnAnnouncements.onDragStart({ active: { id: "{{RAW}} <column>" } as never })).toContain("{{RAW}} <column>");
    }
    await act(async () => { button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true })); });
    expect(reorder).toHaveBeenCalledExactlyOnceWith(["task", "assignee", "project"]);
    await act(async () => button.click());
    expect(sortChange).toHaveBeenCalledExactlyOnceWith({ column: "project", direction: "ascending" });
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("preserves selected filters, search draft and raw names while localizing complete search labels", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const change = vi.fn(), clear = vi.fn(); const rawName = "{{RAW}} <project>";
  try {
    await act(async () => root.render(<IssueFilterPanel state={{ ...defaultIssueFilterState, projects: ["project-id"] }} activeFilterCount={1} onChange={change} onClear={clear} projects={[{ id: "project-id", name: rawName }]} />));
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search projects"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "RAW"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    for (const language of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      expect(host.querySelector(`input[aria-label="${t("oct26Ui.filters.searchProjects")}"]`)).toBe(input);
      expect(input.value).toBe("RAW"); expect(input.placeholder).toBe(t("oct26Ui.filters.searchProjectsPlaceholder"));
      expect(host.textContent).toContain(rawName);
      expect(host.querySelector('[data-filter-options="projects"] [role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");
      expect(change).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
    }
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("keeps raw access errors and names intact without retrying during a language switch", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const retry = vi.fn(), manage = vi.fn(), rawName = "{{RAW}} <name>", error = new Error("provider: {{RAW}} <error>");
  try {
    await act(async () => root.render(<ProjectAccessNotice ready={false} canManage={false} canRetry agentName={rawName} projectName={rawName} error={error} onManage={manage} onRetry={retry} />));
    for (const language of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      expect(host.textContent).toContain(t("oct26Ui.access.deniedNamed", { project: rawName }));
      expect(host.textContent).toContain(error.message); expect(retry).not.toHaveBeenCalled(); expect(manage).not.toHaveBeenCalled();
    }
    await act(async () => root.render(<ProjectAccessNotice ready canManage={false} canRetry onManage={manage} onRetry={retry} />));
    await act(async () => host.querySelector("button")!.click()); expect(retry).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
