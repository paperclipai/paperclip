// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "@paperclipai/shared";
import { CoordinatorNeedsYou } from "./CoordinatorNeedsYou";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  items: [] as AttentionItem[],
  openPanel: vi.fn(),
  closePanel: vi.fn(),
  setPanelVisible: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@/api/inboxDismissals", () => ({
  inboxDismissalsApi: { restore: vi.fn(async () => ({})), dismiss: vi.fn(async () => ({})) },
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("@/context/PanelContext", () => ({
  usePanel: () => ({
    openPanel: fixture.openPanel,
    closePanel: fixture.closePanel,
    setPanelVisible: fixture.setPanelVisible,
    panelVisible: false,
  }),
}));
vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: true }),
}));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({
  useCoordinatorWorkspaceEnabled: () => ({ userId: "reviewer" }),
}));
vi.mock("@/lib/router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/router")>()),
  useNavigate: () => fixture.navigate,
}));
vi.mock("@/api/agents", () => ({
  agentsApi: { list: async () => [] },
}));
vi.mock("@/api/projects", () => ({
  projectsApi: { list: async () => [] },
}));
vi.mock("@/api/access", () => ({
  accessApi: {
    listUserDirectory: async () => ({ users: [] }),
    getCurrentBoardAccess: async () => ({
      userId: "reviewer",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "admin", status: "active" }],
    }),
  },
}));
vi.mock("@/api/attention", () => ({
  attentionApi: {
    claim: vi.fn(async () => ({})),
    close: vi.fn(async () => ({ until: null })),
    list: async () => ({
      items: fixture.items,
      viewCounts: { mine: fixture.items.length, unassigned: 0, company: 0, archived: 0, all: fixture.items.length },
      receipts: [],
    }),
    history: async () => ({ items: [], nextCursor: null }),
    runHistory: async () => ({ items: [], nextCursor: null }),
  },
}));
vi.mock("motion/react", () => ({
  LayoutGroup: ({ children }: { children: ReactNode }) => children,
  useReducedMotion: () => true,
  motion: {
    div: ({ children, id, tabIndex }: { children: ReactNode; id?: string; tabIndex?: number }) => (
      <div id={id} tabIndex={tabIndex}>{children}</div>
    ),
  },
}));
vi.mock("@/components/PropertiesPanel", () => ({
  PROPERTIES_PANE_HEADER_SLOT_ID: "test-sidebar",
}));
vi.mock("@/components/DecisionResolver", () => ({
  DecisionResolver: () => null,
}));
vi.mock("@/components/AttentionInteractionResolver", () => ({
  AttentionInteractionResolver: ({ artifactRow }: { artifactRow?: ReactNode }) => (
    <div data-testid="interaction-resolver">{artifactRow}</div>
  ),
}));
vi.mock("@/components/AttentionQueueRow", () => ({
  ApprovalResolver: ({ onViewDetails }: { onViewDetails?: () => void }) => (
    <button
      type="button"
      data-testid="approval-view-details"
      disabled={!onViewDetails}
      onClick={onViewDetails}
    >
      View details
    </button>
  ),
  JoinRequestResolver: () => null,
}));
vi.mock("./CoordinatorReviewPanel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./CoordinatorReviewPanel")>();
  return {
    ...actual,
    CoordinatorReviewPanel: ({ item, artifact }: { item: AttentionItem; artifact: { kind: string } }) => (
      <div data-testid="review-panel-body">
        Reviewing {item.subject.title} ({artifact.kind})
      </div>
    ),
  };
});

describe("CoordinatorNeedsYou mobile review sheet", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    fixture.items = [];
    fixture.openPanel.mockReset();
    fixture.closePanel.mockReset();
    fixture.setPanelVisible.mockReset();
    fixture.navigate.mockReset();
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });

  async function renderInbox() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/decisions"]}>
            <CoordinatorNeedsYou />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("opens approval details inside a mobile Sheet instead of disabling onViewDetails", async () => {
    fixture.items = [
      {
        id: "approval-1",
        sourceKind: "approval",
        inlineResolvable: true,
        subject: {
          id: "apr-1",
          kind: "approval",
          title: "Approve production deploy",
          href: "/PAP/approvals/apr-1",
          metadata: { type: "merge_pr" },
        },
        relatedIssue: {
          id: "issue-1",
          identifier: "PAP-101",
          title: "Deploy release",
          href: "/PAP/issues/PAP-101",
        },
        project: null,
        originAgentName: null,
        activityAt: new Date("2026-08-02T14:00:00Z").toISOString(),
        audience: { kind: "user", userId: "reviewer", reason: "addressee" },
      } as unknown as AttentionItem,
    ];

    await renderInbox();

    const button = container.querySelector<HTMLButtonElement>('[data-testid="approval-view-details"]');
    expect(button).not.toBeNull();
    expect(button!.disabled).toBe(false);

    await act(async () => {
      button!.click();
    });

    const sheet = document.querySelector('[data-testid="mobile-coordinator-review-sheet"]');
    expect(sheet).not.toBeNull();
    expect(sheet!.textContent).toContain("Reviewing Approve production deploy (approval)");
    expect(fixture.openPanel).not.toHaveBeenCalled();
  });

  it("renders artifact rows on mobile and opens the artifact preview inside the mobile Sheet", async () => {
    fixture.items = [
      {
        id: "plan-1",
        sourceKind: "issue_thread_interaction",
        inlineResolvable: true,
        subject: {
          id: "intx-1",
          kind: "interaction",
          title: "Approve rollout plan",
          href: "/PAP/issues/PAP-102#plan",
          metadata: { kind: "request_confirmation", issueId: "issue-2", targetDocumentKey: "plan" },
        },
        relatedIssue: {
          id: "issue-2",
          identifier: "PAP-102",
          title: "Rollout plan",
          href: "/PAP/issues/PAP-102",
        },
        project: null,
        originAgentName: null,
        activityAt: new Date("2026-08-02T14:30:00Z").toISOString(),
        audience: { kind: "user", userId: "reviewer", reason: "addressee" },
      } as unknown as AttentionItem,
    ];

    await renderInbox();

    const openArtifactButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open Plan"]');
    expect(openArtifactButton).not.toBeNull();

    await act(async () => {
      openArtifactButton!.click();
    });

    const sheet = document.querySelector('[data-testid="mobile-coordinator-review-sheet"]');
    expect(sheet).not.toBeNull();
    expect(sheet!.textContent).toContain("Reviewing Approve rollout plan (document)");
    expect(fixture.openPanel).not.toHaveBeenCalled();
  });
});
