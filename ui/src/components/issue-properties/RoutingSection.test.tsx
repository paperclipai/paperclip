// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { RoutingSection } from "./RoutingSection";

const mockRoutingApi = vi.hoisted(() => ({
  getIssueRouting: vi.fn(),
  listProfiles: vi.fn(),
  routeIssue: vi.fn(),
  dispatch: vi.fn(),
  escalate: vi.fn(),
  rescue: vi.fn(),
  override: vi.fn(),
  requestReview: vi.fn(),
  releaseClaim: vi.fn(),
}));

vi.mock("../../api/routing", () => ({
  routingApi: mockRoutingApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void) {
  let lastError: unknown;
  for (let i = 0; i < 20; i += 1) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function findAction(root: ParentNode, label: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>("button")).find(
    (element) => element.textContent?.trim() === label,
  );
}

function click(element: Element | null | undefined) {
  element?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

const DECISION = {
  id: "decision-1",
  companyId: "company-1",
  issueId: "issue-1",
  revision: 4,
  supersedesDecisionId: null,
  revisionKind: "initial",
  policyVersion: "routing-policy/v1",
  taskClass: "feature_critical",
  effectiveTaskClass: "feature_critical",
  facts: null,
  state: "reviewer-unavailable",
  worker: {
    profileId: "profile-1",
    agentId: "agent-1",
    providerFamily: "anthropic",
    model: "claude-fable-5",
    effort: "high",
  },
  advisor: null,
  advisorMode: "none",
  reviewer: null,
  reviewerFallback: null,
  rescue: null,
  requireCrossFamilyReview: true,
  maxAttempts: 3,
  maxWallClockMinutes: 120,
  maxCostCents: null,
  reasonCodes: ["cross-layer"],
  escalationReason: null,
  note: null,
  createdByType: "system",
  createdByUserId: null,
  createdByAgentId: null,
  createdAt: new Date("2026-09-10T00:00:00.000Z"),
};

const ROUTING = {
  issueId: "issue-1",
  current: DECISION,
  history: [DECISION],
  activeClaims: [],
  reviewIssueId: null,
  advisorRoundsUsed: 0,
};

describe("RoutingSection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockRoutingApi.getIssueRouting.mockResolvedValue(ROUTING);
    mockRoutingApi.listProfiles.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function render(queryClient: QueryClient) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <RoutingSection issueId="issue-1" companyId="company-1" />
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  it("renders the explicit reviewer-unavailable state text", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(render(queryClient));
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("reviewer-unavailable");
      expect(container.textContent).toContain("feature_critical");
      expect(container.textContent).toContain("routing-policy/v1");
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("shows the current-revision conflict message when an override returns 409", async () => {
    mockRoutingApi.override.mockRejectedValue(
      new ApiError("Route revision conflict", 409, {
        error: "Route revision conflict",
        details: { code: "route_revision_conflict", currentRevision: 7 },
      }),
    );
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    await act(async () => {
      root.render(render(queryClient));
    });
    await waitForAssertion(() => expect(container.textContent).toContain("reviewer-unavailable"));

    await act(async () => {
      click(findAction(container, "Override"));
    });
    await flushReact();

    const noteInput = container.querySelector<HTMLInputElement>("input[aria-label='Override note']");
    expect(noteInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(noteInput, "swap reviewer");
      noteInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    await act(async () => {
      click(findAction(container, "Apply override"));
    });

    await waitForAssertion(() => {
      expect(mockRoutingApi.override).toHaveBeenCalledWith(
        "issue-1",
        expect.objectContaining({ expectedRevision: 4, note: "swap reviewer" }),
      );
      expect(container.textContent).toContain(
        "Route changed to revision 7; reload before retrying.",
      );
    });

    await act(async () => {
      root.unmount();
    });
  });
});
