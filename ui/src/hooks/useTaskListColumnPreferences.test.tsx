// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useTaskListColumnPreferences } from "./useTaskListColumnPreferences";
import { allTaskListColumns, defaultTaskListColumns } from "@/lib/task-list";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement("div");
const root = createRoot(host);
let controls: ReturnType<typeof useTaskListColumnPreferences>;
function Probe({ user = "viewer", company = "company" }) {
  controls = useTaskListColumnPreferences({ companyId: company, collectionKey: `coordinator-tasks:${user}` }, defaultTaskListColumns);
  return <output>{JSON.stringify({ columns: controls.columns, order: controls.order })}</output>;
}
afterEach(async () => { await act(() => root.render(null)); localStorage.clear(); vi.restoreAllMocks(); });
it("retains columns and their order across remounts, while isolating each person and company", async () => {
  await act(() => root.render(<Probe />));
  await act(() => { controls.setColumns(["task", "project"]); controls.setOrder([...allTaskListColumns].reverse()); });
  await act(() => root.render(null));
  await act(() => root.render(<Probe />));
  expect(controls.columns).toEqual(["task", "project"]);
  expect(controls.order).toEqual([...allTaskListColumns].reverse());
  await act(() => root.render(<Probe user="someone-else" />));
  expect(controls.columns).toEqual(defaultTaskListColumns);
  await act(() => root.render(<Probe company="another-company" />));
  expect(controls.columns).toEqual(defaultTaskListColumns);
  await act(() => root.render(<Probe />));
  expect(controls.columns).toEqual(["task", "project"]);
  await act(() => { controls.setOrder(allTaskListColumns); controls.setColumns(defaultTaskListColumns); });
  await act(() => root.render(null));
  await act(() => root.render(<Probe />));
  expect(controls.columns).toEqual(defaultTaskListColumns);
  expect(controls.order).toEqual(allTaskListColumns);
});
it("keeps the current controls usable when browser storage is unavailable", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage denied"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage denied"); });
  await act(() => root.render(<Probe />));
  expect(controls.columns).toEqual(defaultTaskListColumns);
  await act(() => controls.setColumns(["task", "assignee"]));
  expect(controls.columns).toEqual(["task", "assignee"]);
});
