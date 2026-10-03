// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Approval } from "@paperclipai/shared";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "./Approvals";

const mockApprovalsApi = vi.hoisted(() => ({
  list: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockLocation = vi.hoisted(() => ({ pathname: "/approvals/pending" }));

vi.mock("../api/approvals", () => ({
  approvalsApi: mockApprovalsApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({ items }: { items: Array<{ value: string; label: ReactNode }> }) => (
    <div>
      {items.map((item) => (
        <div key={item.value}>{item.label}</div>
      ))}
    </div>
  ),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children?: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useLocation: () => mockLocation,
  useNavigate: () => mockNavigate,
}));

function makeApproval(id: string, status: Approval["status"], title: string): Approval {
  const timestamp = new Date("2026-07-05T10:00:00.000Z");
  return {
    id,
    companyId: "company-1",
    type: "request_board_approval",
    requestedByAgentId: null,
    requestedByUserId: null,
    status,
    payload: {
      title,
      summary: `${title} summary`,
      recommendedAction: `${title} action`,
      risks: [],
    },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitForText(container: HTMLElement, text: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (container.textContent?.includes(text)) return;
    await flushReact();
  }
  expect(container.textContent).toContain(text);
}

function renderApprovals(container: HTMLElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Approvals />
      </QueryClientProvider>,
    );
  });

  return root;
}

describe("Approvals", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockApprovalsApi.list.mockResolvedValue([
      makeApproval("approval-pending", "pending", "Awaiting board"),
      makeApproval("approval-revision", "revision_requested", "Awaiting requester"),
    ]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockNavigate.mockReset();
    mockLocation.pathname = "/approvals/pending";
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("keeps revision-requested approvals out of the pending queue", async () => {
    const root = renderApprovals(container);
    await waitForText(container, "Awaiting board");

    expect(container.textContent).toContain("Awaiting board");
    expect(container.textContent).not.toContain("Awaiting requester");
    expect(container.textContent).toContain("Pending1");

    flushSync(() => {
      root.unmount();
    });
  });
});
