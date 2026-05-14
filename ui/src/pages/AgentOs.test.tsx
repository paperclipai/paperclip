// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentOs } from "./AgentOs";

const breadcrumbState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const toastState = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

const mockApprovalCreate = vi.hoisted(() => vi.fn());

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbState,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "LET", status: "active" },
  }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => toastState,
}));

vi.mock("@/api/approvals", () => ({
  approvalsApi: {
    create: mockApprovalCreate,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("AgentOs page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    breadcrumbState.setBreadcrumbs.mockReset();
    toastState.pushToast.mockReset();
    mockApprovalCreate.mockReset();
    mockApprovalCreate.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders designed frontend previews for all Sprint 6-11 Agent OS surfaces", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AgentOs />
        </QueryClientProvider>,
      );
    });
    await flush();

    expect(container.textContent).toContain("Agent OS command center");
    expect(container.textContent).toContain("approval-gated live apply");
    expect(container.textContent).toContain("no live MCP install/execution");
    expect(container.textContent).toContain("MCP marketplace");
    expect(container.textContent).toContain("blocked_pending_approval");
    expect(container.textContent).toContain("Organization packages");
    expect(container.textContent).toContain("Ready-agent pool");
    expect(container.textContent).toContain("CEO/PM");
    expect(container.textContent).toContain("Final delivery ops");
    expect(container.textContent).toContain("Telegram · chat …0123 · thread …0103");
    expect(container.textContent).not.toContain("demo-chat-0123");
    expect(container.textContent).toContain("Production-safe regression");
    expect(container.textContent).toContain("/api/health");
    expect(container.textContent).toContain("Learning loop");
    expect(container.textContent).toContain("pending_review");
    expect(container.textContent).toContain("ready-agent provisioning applies after board approval");
    expect(breadcrumbState.setBreadcrumbs).toHaveBeenCalledWith([{ label: "Paperclip", href: "/dashboard" }, { label: "Agent OS" }]);

    await act(async () => root.unmount());
  });

  it("creates a sanitized board approval request without live apply or raw routing ids", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AgentOs />
        </QueryClientProvider>,
      );
    });
    await flush();

    expect(container.textContent).toContain("Approval request queue");
    const button = Array.from(container.querySelectorAll("button")).find((entry) =>
      entry.textContent?.includes("Request MCP install approval"),
    );
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockApprovalCreate).toHaveBeenCalledTimes(1);
    const [companyId, approvalInput] = mockApprovalCreate.mock.calls[0];
    expect(companyId).toBe("company-1");
    expect(approvalInput.type).toBe("request_board_approval");
    expect(approvalInput.payload.surface).toBe("agent_os");
    expect(approvalInput.payload.action).toBe("mcp_install_preview");
    expect(approvalInput.payload.liveExecution).toBe(false);
    expect(approvalInput.payload.liveApply).toBe(false);
    expect(approvalInput.payload.requiredSecretNames).toEqual(["GITHUB_TOKEN"]);
    expect(JSON.stringify(approvalInput)).not.toContain("demo-chat-0123");
    expect(JSON.stringify(approvalInput)).not.toContain("demo-topic-0103");
    expect(toastState.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Approval request created", tone: "success" }),
    );
    expect(container.textContent).toContain("Pending approval: approval-1");

    await act(async () => root.unmount());
  });

  it("requests final_delivery retry approval with masked destination only", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AgentOs />
        </QueryClientProvider>,
      );
    });
    await flush();

    const button = Array.from(container.querySelectorAll("button")).find((entry) =>
      entry.textContent?.includes("Request final_delivery retry approval"),
    );
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const [, approvalInput] = mockApprovalCreate.mock.calls[0];
    expect(approvalInput.payload.action).toBe("final_delivery_retry_preview");
    expect(approvalInput.payload.liveExecution).toBe(false);
    expect(approvalInput.payload.liveApply).toBe(false);
    expect(approvalInput.payload.destinationMasked).toBe(true);
    expect(approvalInput.payload.maskedDestination).toContain("Telegram · chat …0123 · thread …0103");
    expect(approvalInput.payload.requiredSecretNames).toEqual([]);
    expect(JSON.stringify(approvalInput)).not.toContain("demo-chat-0123");
    expect(JSON.stringify(approvalInput)).not.toContain("demo-topic-0103");
    expect(JSON.stringify(approvalInput)).not.toContain("demo-message-0456");

    await act(async () => root.unmount());
  });

  it("requests ready-agent provisioning with approval-gated live apply enabled", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AgentOs />
        </QueryClientProvider>,
      );
    });
    await flush();

    const button = Array.from(container.querySelectorAll("button")).find((entry) =>
      entry.textContent?.includes("Request ready-agent approval"),
    );
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const [, approvalInput] = mockApprovalCreate.mock.calls[0];
    expect(approvalInput.payload.action).toBe("ready_agent_provision_preview");
    expect(approvalInput.payload.approvalScope).toBe("ready_agent_provisioning");
    expect(approvalInput.payload.approvalOnly).toBe(false);
    expect(approvalInput.payload.liveApply).toBe(true);
    expect(approvalInput.payload.liveExecution).toBe(false);
    expect(approvalInput.payload.liveExternalActions).toBe(false);
    expect(approvalInput.payload.safetyPosture).toContain("provisions an internal ready-agent");
    expect(approvalInput.payload.blueprint).toMatchObject({ key: "ceo-pm", title: "CEO/PM" });

    await act(async () => root.unmount());
  });
});
