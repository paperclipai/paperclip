// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIssue } from "../../storybook/fixtures/paperclipData";
import { TaskList, topRenderedTaskRefs, type TaskListItem } from "./TaskList";
import { TooltipProvider } from "./ui/tooltip";

const preloads = vi.hoisted(() => [] as Array<{ companyId: string | null | undefined; refs: string[] }>);
vi.mock("../hooks/usePreloadTaskChats", () => ({
  usePreloadTaskChats: (companyId: string | null | undefined, refs: readonly string[]) => { preloads.push({ companyId, refs: [...refs] }); },
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, state: _state, disableIssueQuicklook: _quicklook, issuePrefetch: _prefetch, ...props }:
    ComponentProps<"a"> & { to?: string; state?: unknown; disableIssueQuicklook?: boolean; issuePrefetch?: unknown }) =>
    <a href={to} {...props}>{children}</a>,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const items: TaskListItem[] = Array.from({ length: 14 }, (_, index) => ({
  issue: createIssue({
    id: `task-${index}`,
    identifier: `PAP-${index}`,
    title: `Task ${index}`,
    parentId: null,
    // Newest first is the default order: PAP-13 is the top row.
    updatedAt: new Date(Date.UTC(2026, 10, 1, 0, index)),
  }),
}));

describe("TaskList chat preload", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    preloads.length = 0;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("preloads the top ten rows in display order when the page asks for it", async () => {
    await act(async () => root.render(<TooltipProvider><TaskList items={items} preloadCompanyId="company-1" /></TooltipProvider>));
    const last = preloads.at(-1)!;
    expect(last.companyId).toBe("company-1");
    expect(last.refs).toEqual(Array.from({ length: 10 }, (_, index) => `PAP-${13 - index}`));
  });

  it("keeps display order in a large grouped and nested list", async () => {
    // 600 tasks: 200 parents, each with two children, across two statuses.
    const large: TaskListItem[] = [];
    for (let parent = 0; parent < 200; parent += 1) {
      const updatedAt = new Date(Date.UTC(2026, 10, 1, 0, 0, 600 - parent));
      large.push({ issue: createIssue({ id: `p-${parent}`, identifier: `P-${parent}`, title: `Parent ${parent}`, parentId: null, status: parent % 2 ? "todo" : "in_progress", updatedAt }) });
      for (const child of [0, 1]) {
        large.push({ issue: createIssue({ id: `c-${parent}-${child}`, identifier: `C-${parent}-${child}`, title: `Child ${parent}.${child}`, parentId: `p-${parent}`, status: "todo", updatedAt }) });
      }
    }
    await act(async () => root.render(<TooltipProvider><TaskList items={large} groupBy="status" preloadCompanyId="company-1" /></TooltipProvider>));
    const refs = preloads.at(-1)!.refs;
    expect(refs).toHaveLength(10);
    // Rows in the order the list shows them: the first group's parents, each followed by its children.
    const shown = [...host.querySelectorAll("a[href]")].map((link) => link.getAttribute("href")!.split("/").pop()!);
    expect(refs).toEqual([...new Set(shown.filter((ref) => /^[PC]-/.test(ref)))].slice(0, 10));
  });

  it("reads no row after the last one it preloads", () => {
    let read = 0;
    function* rows() {
      for (let index = 0; index < 1_000; index += 1) {
        read += 1;
        if (read > 12) throw new Error("read past the preload limit");
        yield { id: `t-${index}`, identifier: `T-${index}` };
      }
    }
    // Rows 0 and 1 are not rendered yet, so they are skipped.
    const rendered = new Set(Array.from({ length: 1_000 }, (_, index) => `t-${index}`).slice(2));
    expect(topRenderedTaskRefs(rows(), rendered, 10)).toEqual(Array.from({ length: 10 }, (_, index) => `T-${index + 2}`));
    expect(read).toBe(12);
  });

  it("preloads nothing for a list that does not ask, and needs no query client", async () => {
    await act(async () => root.render(<TooltipProvider><TaskList items={items} /></TooltipProvider>));
    expect(preloads).toEqual([]);
    expect(host.textContent).toContain("Task 13");
  });
});
