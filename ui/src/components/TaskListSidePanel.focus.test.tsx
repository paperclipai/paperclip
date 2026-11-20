// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskListSplit, type TaskListSidePanelPresentation } from "./TaskListSidePanel";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, disableIssueQuicklook: _quicklook, ...props }: { to: string; children: ReactNode; disableIssueQuicklook?: boolean }) =>
    <a href={to} {...props}>{children}</a>,
  useLocation: () => ({ key: "list", pathname: "/issues", search: "" }),
  useNavigationType: () => "PUSH",
}));
vi.mock("../context/BreadcrumbContext", () => ({
  BreadcrumbProvider: ({ children }: { children: ReactNode }) => children,
  useBreadcrumbs: () => ({ breadcrumbs: [], breadcrumbPanelControl: null, breadcrumbToolbar: null }),
}));
vi.mock("../pages/IssueDetail", () => ({
  TaskDetailSurface: ({ embeddedIssueRef }: { embeddedIssueRef: string }) => <p>Detail {embeddedIssueRef}</p>,
}));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("TaskListSplit focus beside and under the panel", () => {
  let host: HTMLDivElement, root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  async function render(taskRef: string | null, presentation: TaskListSidePanelPresentation) {
    await act(async () => root.render(
      <TaskListSplit taskRef={taskRef} onClose={() => {}} presentation={presentation}>
        <button type="button">Task row</button>
      </TaskListSplit>,
    ));
  }
  const list = () => host.querySelector("[data-testid='task-list-split'] > div")!;
  const row = () => host.querySelector("button")!;
  const panel = () => host.querySelector("section[aria-label='Task PAP-1']");

  it("moves focus into the overlay, keeps the covered list inert, and returns focus on close", async () => {
    await render(null, "overlay");
    row().focus();
    await render("PAP-1", "overlay");
    expect(list().hasAttribute("inert")).toBe(true);
    expect(panel()?.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(panel());
    await render(null, "overlay");
    expect(list().hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(row());
  });

  it("leaves the list live and focus in place beside a docked panel", async () => {
    await render(null, "docked");
    row().focus();
    await render("PAP-1", "docked");
    expect(list().hasAttribute("inert")).toBe(false);
    expect(panel()?.hasAttribute("tabindex")).toBe(false);
    expect(document.activeElement).toBe(row());
  });
});
