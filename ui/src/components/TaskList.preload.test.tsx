// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIssue } from "../../storybook/fixtures/paperclipData";
import { TaskList, type TaskListItem } from "./TaskList";
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

  it("preloads nothing for a list that does not ask, and needs no query client", async () => {
    await act(async () => root.render(<TooltipProvider><TaskList items={items} /></TooltipProvider>));
    expect(preloads).toEqual([]);
    expect(host.textContent).toContain("Task 13");
  });
});
