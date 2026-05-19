// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Approval } from "@paperclipai/shared";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Letsmake", issuePrefix: "LET", status: "active" },
    selectedCompanyId: "company-1",
  }),
}));

const approvalsListMock = vi.fn<(companyId: string) => Promise<Approval[]>>();

vi.mock("@/api/approvals", () => ({
  approvalsApi: {
    list: (companyId: string) => approvalsListMock(companyId),
  },
}));

import { ApprovalsQueuePage } from "./ApprovalsQueuePage";

function makeApproval(overrides: Partial<Approval> & { id: string }): Approval {
  return {
    id: overrides.id,
    companyId: "company-1",
    type: overrides.type ?? "hire_agent",
    requestedByAgentId: overrides.requestedByAgentId ?? null,
    requestedByUserId: overrides.requestedByUserId ?? null,
    status: overrides.status ?? "pending",
    payload: overrides.payload ?? {},
    decisionNote: overrides.decisionNote ?? null,
    decidedByUserId: overrides.decidedByUserId ?? null,
    decidedAt: overrides.decidedAt ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-05-19T10:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-05-19T10:00:00Z"),
  } as Approval;
}

let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  approvalsListMock.mockReset();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
});

afterEach(() => {
  if (container) {
    container.remove();
    container = null;
  }
  queryClient.clear();
});

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForMicrotaskAssertion(assertion: () => void, attempts = 30) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
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

async function renderQueue() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const now = new Date("2026-05-19T16:00:00.000Z");
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/eaos/approvals"]}>
          <Routes>
            <Route path="/eaos/approvals" element={<ApprovalsQueuePage now={now} />} />
            <Route path="/approvals/:approvalId" element={<div data-testid="kernel-approval-detail-stub" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("ApprovalsQueuePage (LET-484 working-product slice)", () => {
  it("renders the queue surface (not the EaosZonePlaceholder)", async () => {
    approvalsListMock.mockResolvedValue([]);
    await renderQueue();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-approvals-page"]')).not.toBeNull();
    });
    expect(container?.querySelector('[data-testid="eaos-zone-placeholder"]')).toBeNull();
  });

  it("labels the data layer as backend-backed once the live read succeeds", async () => {
    approvalsListMock.mockResolvedValue([
      makeApproval({ id: "a", status: "pending", type: "hire_agent" }),
    ]);
    await renderQueue();
    await waitForMicrotaskAssertion(() => {
      const posture = container?.querySelector('[data-testid="eaos-approvals-posture"]');
      const text = posture?.textContent ?? "";
      expect(text).toContain("Shell · BACKEND-BACKED");
      expect(text).toContain("Data · BACKEND-BACKED");
      expect(text).toContain("Decisions · APPROVAL REQUIRED");
    });
  });

  it("renders pending / revision / decided buckets with the correct counts and ordering", async () => {
    approvalsListMock.mockResolvedValue([
      makeApproval({
        id: "p-old",
        status: "pending",
        type: "request_board_approval",
        createdAt: new Date("2026-05-15T10:00:00Z"),
      }),
      makeApproval({
        id: "p-new",
        status: "pending",
        type: "hire_agent",
        createdAt: new Date("2026-05-19T09:00:00Z"),
      }),
      makeApproval({
        id: "r",
        status: "revision_requested",
        type: "budget_override_required",
        createdAt: new Date("2026-05-18T10:00:00Z"),
      }),
      makeApproval({
        id: "d",
        status: "approved",
        type: "hire_agent",
        createdAt: new Date("2026-05-12T10:00:00Z"),
        decidedAt: new Date("2026-05-12T11:00:00Z"),
      }),
    ]);
    await renderQueue();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-approvals-summary-total"]')?.textContent).toContain("4");
      expect(container?.querySelector('[data-testid="eaos-approvals-summary-pending"]')?.textContent).toContain("2");
      expect(container?.querySelector('[data-testid="eaos-approvals-summary-revision-requested"]')?.textContent).toContain("1");
      expect(container?.querySelector('[data-testid="eaos-approvals-summary-high-risk"]')?.textContent).toContain("2");

      const pendingRows = container?.querySelectorAll(
        '[data-testid="eaos-approvals-bucket-pending-rows"] [data-testid="eaos-approvals-row"]',
      );
      expect(pendingRows?.length).toBe(2);
      // Oldest-first ordering: p-old appears before p-new.
      expect(pendingRows?.[0].getAttribute("data-approval-id")).toBe("p-old");
      expect(pendingRows?.[1].getAttribute("data-approval-id")).toBe("p-new");

      const revisionRow = container?.querySelector(
        '[data-testid="eaos-approvals-bucket-revision_requested-rows"] [data-testid="eaos-approvals-row"]',
      );
      expect(revisionRow?.getAttribute("data-approval-id")).toBe("r");
      expect(revisionRow?.getAttribute("data-approval-risk")).toBe("high");

      const decidedRow = container?.querySelector(
        '[data-testid="eaos-approvals-bucket-decided-rows"] [data-testid="eaos-approvals-row"]',
      );
      expect(decidedRow?.getAttribute("data-approval-id")).toBe("d");
    });
  });

  it("does NOT render any approval-decision buttons on this surface", async () => {
    approvalsListMock.mockResolvedValue([makeApproval({ id: "a", status: "pending" })]);
    await renderQueue();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-approvals-row"]')).not.toBeNull();
    });
    // Read-only slice — every row points at the kernel detail page, no buttons.
    // /approvals is a per-company board route, so @/lib/router prefixes the
    // current company (selectedCompany.issuePrefix = "LET") onto the href.
    expect(container?.querySelectorAll("button").length).toBe(0);
    const kernelLink = container?.querySelector('[data-testid="eaos-approvals-row-kernel-link"]');
    expect(kernelLink?.getAttribute("href")).toBe("/LET/approvals/a");
  });

  it("redacts secret-looking text in approval summaries and decision notes", async () => {
    approvalsListMock.mockResolvedValue([
      makeApproval({
        id: "leak",
        status: "approved",
        type: "hire_agent",
        payload: { reason: "Onboard agent ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII" },
        decisionNote: "Approved with token sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
        decidedAt: new Date("2026-05-19T11:00:00Z"),
      }),
    ]);
    await renderQueue();
    await waitForMicrotaskAssertion(() => {
      const row = container?.querySelector('[data-approval-id="leak"]');
      expect(row).not.toBeNull();
      const text = row?.textContent ?? "";
      expect(text).not.toContain("ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII");
      expect(text).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
    });
  });
});
