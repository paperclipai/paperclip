// @vitest-environment jsdom

import { act } from "react";
import type React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutonomyInbox } from "./AutonomyInbox";

const mockAutonomyApi = vi.hoisted(() => ({
  inbox: vi.fn(),
}));
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("../api/autonomy", () => ({
  autonomyApi: mockAutonomyApi,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    to,
    children,
    disableIssueQuicklook: _disableIssueQuicklook,
    ...props
  }: {
    to: string;
    children: React.ReactNode;
    disableIssueQuicklook?: boolean;
  }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("AutonomyInbox", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAutonomyApi.inbox.mockResolvedValue([
      {
        id: "approval-1",
        companyId: "company-1",
        kind: "approval_gate",
        severity: "warning",
        status: "pending",
        title: "Autonomy approval required",
        summary: "deploy_production requires approval.",
        laneKey: "deploy",
        runId: "run-1",
        issueId: "issue-1",
        agentId: "agent-1",
        incident: null,
        approvalGate: { id: "gate-1", approvalId: "approval-1" },
        evidenceEntry: null,
        createdAt: "2026-05-07T00:00:00.000Z",
        updatedAt: "2026-05-07T00:00:00.000Z",
      },
      {
        id: "incident-1",
        companyId: "company-1",
        kind: "incident",
        severity: "critical",
        status: "open",
        title: "Run stopped",
        summary: "Evidence missing.",
        laneKey: "triage",
        runId: "run-2",
        issueId: null,
        agentId: "agent-2",
        incident: { id: "incident-1" },
        approvalGate: null,
        evidenceEntry: null,
        createdAt: "2026-05-07T00:00:00.000Z",
        updatedAt: "2026-05-07T00:00:00.000Z",
      },
    ]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders operator-readable autonomy inbox rows and filter counts", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AutonomyInbox />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(mockAutonomyApi.inbox).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Autonomy inbox");
    expect(container.textContent).toContain("Autonomy approval required");
    expect(container.textContent).toContain("deploy_production requires approval.");
    expect(container.textContent).toContain("Run stopped");
    expect(container.textContent).toContain("Approvals1");
    expect(container.querySelector('a[href="/approvals/approval-1"]')).not.toBeNull();
  });
});
