// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Approval } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalDetail } from "./ApprovalDetail";

const mockApprovalsApi = vi.hoisted(() => ({
  get: vi.fn(),
  listComments: vi.fn(),
  listIssues: vi.fn(),
  addComment: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
}));
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const mockPluginSlotOutlet = vi.hoisted(() => vi.fn());

vi.mock("../api/approvals", () => ({ approvalsApi: mockApprovalsApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", issuePrefix: "EDE" },
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => mockNavigate,
  useParams: () => ({ approvalId: "approval-1" }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));
vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: (props: {
    slotTypes: string[];
    context: Record<string, unknown>;
    componentProps?: {
      approval?: Approval;
      payload?: Record<string, unknown>;
    };
  }) => {
    mockPluginSlotOutlet(props);
    if (!props.slotTypes.includes("approvalCard")) return null;

    const summary = props.componentProps?.payload?.summary;
    const firstLine = typeof summary === "string" ? summary.split(/\r?\n/, 1)[0].trim() : "";
    if (!/^https?:\/\//.test(firstLine)) return null;

    return (
      <section aria-label="Rendered approval deck">
        <a href={firstLine} target="_blank" rel="noreferrer">
          Open source
        </a>
        <iframe title="Approval deck" srcDoc="<h1>Approval deck</h1>" />
      </section>
    );
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function approvalWithPayload(payload: Record<string, unknown>): Approval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    status: "pending",
    payload,
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-07-03T10:00:00.000Z"),
    updatedAt: new Date("2026-07-03T10:00:00.000Z"),
  };
}

async function flushQueries() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ApprovalDetail", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    mockApprovalsApi.get.mockReset();
    mockApprovalsApi.listComments.mockResolvedValue([]);
    mockApprovalsApi.listIssues.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([{ id: "agent-1", name: "Codex" }]);
    mockPluginSlotOutlet.mockClear();
    mockSetBreadcrumbs.mockClear();
    mockSetSelectedCompanyId.mockClear();
    mockNavigate.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
  });

  async function renderDetail(approval: Approval) {
    mockApprovalsApi.get.mockResolvedValue(approval);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ApprovalDetail />
        </QueryClientProvider>,
      );
    });
    await flushQueries();
  }

  it("renders deck URL first-line approvalCard slots inline on the detail page", async () => {
    const deckUrl = "http://127.0.0.1:3199/api/attachments/deck/content";
    const approval = approvalWithPayload({
      title: "Review approval deck",
      summary: `${deckUrl}\nOwner should see this deck inline before deciding.`,
    });

    await renderDetail(approval);

    const deck = container.querySelector("section[aria-label='Rendered approval deck']");
    expect(deck?.textContent).toContain("Open source");
    expect(container.querySelector("iframe[title='Approval deck']")).not.toBeNull();
    expect(container.querySelector<HTMLAnchorElement>("section[aria-label='Rendered approval deck'] a")?.href).toBe(deckUrl);

    const outletCalls = mockPluginSlotOutlet.mock.calls as unknown as Array<[
      {
        slotTypes: string[];
        context: Record<string, unknown>;
        componentProps: Record<string, unknown>;
      },
    ]>;
    const detailApprovalSlot = outletCalls
      .map(([props]) => props)
      .find((props) => props.slotTypes.includes("approvalCard"));

    expect(detailApprovalSlot).toBeDefined();
    expect(detailApprovalSlot?.context).toMatchObject({
      companyId: "company-1",
      companyPrefix: "EDE",
    });
    expect(detailApprovalSlot?.componentProps).toMatchObject({
      approval,
      payload: approval.payload,
    });
  });

  it("renders nothing for non-deck approval payloads on the detail page", async () => {
    await renderDetail(
      approvalWithPayload({
        title: "Plain approval",
        summary: "Approve this request without a deck URL.",
      }),
    );

    expect(container.querySelector("section[aria-label='Rendered approval deck']")).toBeNull();
    expect(container.querySelector("iframe[title='Approval deck']")).toBeNull();
  });
});
