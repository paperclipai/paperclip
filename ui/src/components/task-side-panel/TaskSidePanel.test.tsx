// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueDocument } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  taskPanelDocumentTab,
  taskPanelPropertiesTab,
  writeTaskSidePanelState,
} from "@/lib/task-side-panel-state";
import { TaskSidePanel } from "./TaskSidePanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const fixture = vi.hoisted(() => ({
  documents: [] as IssueDocument[] | undefined,
  plan: null as IssueDocument | null | undefined,
}));

const routeFixture = vi.hoisted(() => ({
  location: {
    pathname: "/issues/PAP-1",
    search: "",
    hash: "",
    state: null as unknown,
  },
  navigate: vi.fn(),
}));

vi.mock("@/hooks/useIssueDocuments", () => ({
  useIssueDocuments: () => ({ data: fixture.documents }),
}));

vi.mock("@/hooks/useIssuePlanDocument", () => ({
  useIssuePlanDocument: () => ({ data: fixture.plan }),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => routeFixture.location,
  useNavigate: () => routeFixture.navigate,
}));

vi.mock("@/components/IssueProperties", () => ({
  IssueProperties: () => <div>Properties content</div>,
}));

vi.mock("@/components/issue-properties/IssuePropertiesArtifactsTab", () => ({
  IssuePropertiesArtifactsTab: () => <div>Artifacts content</div>,
}));

vi.mock("@/components/issue-properties/IssuePropertiesPlansTab", () => ({
  IssuePropertiesPlansTab: () => <div>Plan content</div>,
}));

vi.mock("@/components/WorkspaceFileBrowser", () => ({
  WorkspaceFileBrowser: () => <div>Files browser</div>,
}));

vi.mock("./TaskDocumentPanel", () => ({
  TaskDocumentPanel: ({ documentKey }: { documentKey: string }) => <div>{`Document ${documentKey}`}</div>,
}));

vi.mock("./TaskWorkspaceFilePanel", () => ({
  TaskWorkspaceFilePanel: () => <div>Workspace file</div>,
}));

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "task-1",
    companyId: "company-1",
    title: "Portable tabs",
    workMode: "agent",
    ...overrides,
  } as Issue;
}

function issueDocument(key: string, title: string): IssueDocument {
  return {
    id: `document-${key}`,
    issueId: "task-1",
    key,
    title,
    body: `# ${title}`,
    latestRevisionNumber: 1,
    createdAt: "2026-08-23T12:00:00.000Z",
    updatedAt: "2026-08-23T12:00:00.000Z",
  } as unknown as IssueDocument;
}

describe("TaskSidePanel", () => {
  let root: Root;
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    window.localStorage.clear();
    fixture.documents = [];
    fixture.plan = null;
    routeFixture.location.search = "";
    window.history.replaceState(null, "", routeFixture.location.pathname);
    routeFixture.navigate.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    Element.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
    vi.restoreAllMocks();
  });

  async function render(node: ReactNode) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>{node}</TooltipProvider>
        </QueryClientProvider>,
      );
    });
  }

  function panel(props: Partial<Parameters<typeof TaskSidePanel>[0]> = {}) {
    return (
      <TaskSidePanel
        issue={issue()}
        accountScope="user-1"
        onUpdate={() => {}}
        fileTabsEnabled={false}
        inline
        {...props}
      />
    );
  }

  it("opens Properties on first visit", async () => {
    await render(panel());
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Properties");
    expect(container.textContent).toContain("Properties content");
  });

  it("does not create a Plan tab for planning mode before a plan exists", async () => {
    await render(panel({ issue: issue({ workMode: "planning" }) }));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Properties");
    expect(container.querySelector('[data-side-panel-tab-target="document:plan"]')).toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open a new tab"]')?.click());
    expect(Array.from(container.querySelectorAll('[role="option"]')).some((item) => item.textContent?.includes("Plan"))).toBe(false);
  });

  it("opens a newly materialized plan until the user has interacted", async () => {
    await render(panel());
    fixture.plan = issueDocument("plan", "Plan");
    fixture.documents = [fixture.plan];
    await render(panel());
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Plan");
  });

  it("opens a plan deep link without looping while document metadata loads", async () => {
    fixture.documents = undefined;
    fixture.plan = undefined;

    await render(panel({
      issue: issue({ workMode: "planning" }),
      documentDeepLink: { requestId: 1, documentKey: "plan" },
    }));

    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Plan");
  });

  it("does not auto-open a plan after manual tab interaction", async () => {
    await render(panel());
    await act(async () => container.querySelector<HTMLButtonElement>('#side-panel-tab-properties')?.click());
    fixture.plan = issueDocument("plan", "Plan");
    fixture.documents = [fixture.plan];
    await render(panel());
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Properties");
    expect(container.querySelector('[data-side-panel-tab-target="document:plan"]')).toBeNull();
  });

  it("lets a persisted intentionally empty state win over defaults", async () => {
    writeTaskSidePanelState("user-1", "company-1", "task-1", {
      state: { tabs: [], activeTabId: null },
      launcherOpen: false,
      userInteracted: true,
      autoPlanHandled: true,
      updatedAt: 1,
    });
    await render(panel({ issue: issue({ workMode: "planning" }) }));
    expect(container.querySelector('[role="tab"]')).toBeNull();
    expect(container.getElementsByTagName("input")[0]?.getAttribute("aria-label")).toBe("Search tabs and resources…");
  });

  it("removes a Plan tab persisted before a plan document existed", async () => {
    writeTaskSidePanelState("user-1", "company-1", "task-1", {
      state: {
        tabs: [taskPanelPropertiesTab(), taskPanelDocumentTab("plan", "Plan")],
        activeTabId: "document:plan",
      },
      launcherOpen: false,
      userInteracted: false,
      autoPlanHandled: false,
      updatedAt: 1,
    });

    await render(panel({ issue: issue({ workMode: "planning" }) }));

    expect(container.querySelector('[data-side-panel-tab-target="document:plan"]')).toBeNull();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Properties");
  });

  it("opens an ordinary document deep link in a deduplicated document tab", async () => {
    fixture.documents = [issueDocument("brief", "Implementation brief")];
    await render(panel({ documentDeepLink: { requestId: 1, documentKey: "brief" } }));
    expect(container.querySelectorAll('[data-side-panel-tab-target="document:brief"]')).toHaveLength(1);
    expect(container.textContent).toContain("Document brief");
    await render(panel({ documentDeepLink: { requestId: 2, documentKey: "brief" } }));
    expect(container.querySelectorAll('[data-side-panel-tab-target="document:brief"]')).toHaveLength(1);
  });

  it("keeps Files out of the launcher when the experiment is disabled", async () => {
    writeTaskSidePanelState("user-1", "company-1", "task-1", {
      state: { tabs: [], activeTabId: null },
      launcherOpen: false,
      userInteracted: true,
      autoPlanHandled: true,
      updatedAt: 1,
    });
    await render(panel());
    expect(Array.from(container.querySelectorAll('[role="option"]')).some((item) => item.textContent?.includes("Files"))).toBe(false);
  });

  it("restores a persisted Properties tab", async () => {
    writeTaskSidePanelState("user-1", "company-1", "task-1", {
      state: { tabs: [taskPanelPropertiesTab()], activeTabId: "properties" },
      launcherOpen: false,
      userInteracted: true,
      autoPlanHandled: true,
      updatedAt: 1,
    });
    await render(panel({ issue: issue({ workMode: "planning" }) }));
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(container.textContent).toContain("Properties content");
  });

  it("opens a URL-backed workspace file tab outside file-viewer provider ancestry", async () => {
    routeFixture.location.search = "?file=ui%2Fsrc%2FApp.tsx&line=7&workspace=project";
    window.history.replaceState(null, "", `${routeFixture.location.pathname}${routeFixture.location.search}`);
    await render(panel({ fileTabsEnabled: true }));

    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("App.tsx");
    expect(container.textContent).toContain("Workspace file");
  });

  it("clears file-viewer URL state when switching to a non-file tab", async () => {
    routeFixture.location.search = "?file=ui%2Fsrc%2FApp.tsx&line=7&workspace=project";
    window.history.replaceState(null, "", `${routeFixture.location.pathname}${routeFixture.location.search}`);
    await render(panel({ fileTabsEnabled: true }));

    await act(async () => container.querySelector<HTMLButtonElement>("#side-panel-tab-properties")?.click());

    expect(routeFixture.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/issues/PAP-1", search: "" }),
      expect.objectContaining({ replace: false }),
    );
  });
});
