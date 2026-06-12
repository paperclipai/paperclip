// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GateLedger } from "./GateLedger";

const mockIssuesApi = vi.hoisted(() => ({ listApprovals: vi.fn() }));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("../../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../../api/agents", () => ({ agentsApi: mockAgentsApi }));

function approval(over: Partial<Record<string, unknown>>) {
  return {
    id: "a-" + Math.random().toString(36).slice(2),
    companyId: "company-1",
    type: "gate_code_review",
    requestedByAgentId: null,
    requestedByUserId: null,
    status: "pending",
    payload: {},
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-06-12T00:00:00Z"),
    updatedAt: new Date("2026-06-12T00:00:00Z"),
    ...over,
  };
}

async function flushReact() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <GateLedger issueId="issue-1" companyId="company-1" />
      </QueryClientProvider>,
    );
  });
  return { root, container };
}

describe("GateLedger", () => {
  beforeEach(() => {
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-arch", name: "Architect" },
      { id: "agent-cr", name: "Code Reviewer" },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("renders gate rows ordered plan>code>wiring with verdict and agent name", async () => {
    mockIssuesApi.listApprovals.mockResolvedValue([
      approval({
        type: "gate_wiring_review",
        status: "pending",
        payload: { designatedAgentId: "agent-unknown" },
      }),
      approval({
        type: "gate_plan_approval",
        status: "approved",
        decidedAt: new Date("2026-06-12T10:00:00Z"),
        decisionNote: "Looks sound.",
        payload: { designatedAgentId: "agent-arch" },
      }),
      approval({
        type: "gate_code_review",
        status: "rejected",
        payload: { designatedAgentId: "agent-cr" },
      }),
    ]);

    const { container } = render();
    await flushReact();

    const text = container.textContent ?? "";
    expect(text).toContain("Gate ledger");
    expect(text).toContain("Plan approval");
    expect(text).toContain("approved");
    expect(text).toContain("Architect");
    expect(text).toContain("Looks sound.");
    expect(text).toContain("Code review");
    expect(text).toContain("rejected");
    // Plan approval must appear before code review in the DOM order.
    expect(text.indexOf("Plan approval")).toBeLessThan(text.indexOf("Code review"));
    // Unknown designated agent falls back to a short id, never crashes.
    expect(text).toContain("Wiring review");
  });

  it("excludes non-gate approvals", async () => {
    mockIssuesApi.listApprovals.mockResolvedValue([
      approval({ type: "hire_agent", status: "pending" }),
    ]);
    const { container } = render();
    await flushReact();
    expect(container.textContent).not.toContain("Gate ledger");
  });

  it("renders nothing when there are no gates", async () => {
    mockIssuesApi.listApprovals.mockResolvedValue([]);
    const { container } = render();
    await flushReact();
    expect(container.textContent).toBe("");
  });
});
