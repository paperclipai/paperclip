// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { Issue, RequestConfirmationInteraction } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { IssuePropertiesPlansTab } from "./IssuePropertiesPlansTab";
import { IssuePlanConfirmationActionBar } from "./IssuePlanConfirmationActionBar";

const mockIssuesApi = vi.hoisted(() => ({
  listInteractions: vi.fn(),
  listAcceptedPlanDecompositions: vi.fn(),
  acceptInteraction: vi.fn(),
  rejectInteraction: vi.fn(),
}));

vi.mock("@/api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("@/hooks/useIssuePlanDocument", () => ({
  useIssuePlanDocument: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("../PropertiesPanel", () => ({
  PROPERTIES_PANE_FOOTER_SLOT_ID: "properties-pane-footer-slot",
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const issue = {
  id: "issue-1",
  identifier: "PAP-1",
} as Issue;

const confirmation = {
  id: "confirmation-1",
  companyId: "company-1",
  issueId: issue.id,
  kind: "request_confirmation",
  status: "pending",
  continuationPolicy: "wake_assignee",
  resolverPolicy: "board_only",
  requestedResolverPolicy: "board_only",
  effectiveResolverPolicy: "board_only",
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
  payload: {
    version: 1,
    prompt: "Approve this plan?",
    acceptLabel: "Approve plan",
    rejectLabel: "Request changes",
    rejectRequiresReason: true,
    allowDeclineReason: true,
    target: { type: "issue_document", key: "plan", revisionId: "rev-1" },
  },
} satisfies RequestConfirmationInteraction;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

function render(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.issues.interactions(issue.id), [confirmation]);
  client.setQueryData(queryKeys.issues.acceptedPlanDecompositions(issue.id), []);
  act(() => root?.render(
    <MemoryRouter>
      <QueryClientProvider client={client!}>{element}</QueryClientProvider>
    </MemoryRouter>,
  ));
  return container;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  client?.clear();
  client = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("IssuePlanConfirmationActionBar", () => {
  it("renders a pending plan confirmation even before its plan document exists", () => {
    const rendered = render(<IssuePropertiesPlansTab issue={issue} />);

    expect(rendered.querySelector('[data-testid="plan-pane-action-bar"]')).not.toBeNull();
    expect(rendered.textContent).toContain("Approve plan");
    expect(rendered.textContent).toContain("Request changes");
  });

  it("moves into a footer slot that mounts on the next paint", () => {
    let resolveNextPaint: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      resolveNextPaint = callback;
      return 1;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const rendered = render(<IssuePlanConfirmationActionBar issue={issue} />);
    const footer = document.createElement("div");
    footer.id = "properties-pane-footer-slot";
    document.body.appendChild(footer);

    act(() => resolveNextPaint?.(0));

    expect(rendered.querySelector('[data-testid="plan-pane-action-bar"]')).toBeNull();
    expect(footer.querySelector('[data-testid="plan-pane-action-bar"]')).not.toBeNull();
    footer.remove();
  });
});
