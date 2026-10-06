// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalDetail } from "./ApprovalDetail";
import { queryKeys } from "../lib/queryKeys";
import { setLocale } from "../i18n";

const mutation = vi.hoisted(() => vi.fn());
vi.mock("../api/approvals", () => ({ approvalsApi: { approve: mutation, reject: mutation, requestRevision: mutation, resubmit: mutation, addComment: mutation } }));
vi.mock("../api/agents", () => ({ agentsApi: { remove: mutation } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-qa", setSelectedCompanyId: mutation }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode; className?: string }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => mutation,
  useParams: () => ({ approvalId: "approval-qa" }),
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock("../components/ApprovalPayload", () => ({
  approvalLabel: () => "Budget override", typeIcon: {}, defaultTypeIcon: () => null, ApprovalPayloadRenderer: () => null,
}));
vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="raw-approval-comment">{children}</div>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ApprovalDetail budget navigation localization", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setLocale("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    setLocale("en");
    vi.clearAllMocks();
  });

  it("keeps a real costs link and does not resolve the approval on language changes", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    client.setQueryData(queryKeys.approvals.detail("approval-qa"), {
      id: "approval-qa", companyId: "company-qa", type: "budget_override_required", status: "pending", payload: {},
    });
    client.setQueryData(queryKeys.approvals.comments("approval-qa"), []);
    client.setQueryData(queryKeys.approvals.issues("approval-qa"), []);
    client.setQueryData(queryKeys.agents.list("company-qa"), []);
    await act(async () => root.render(<QueryClientProvider client={client}><ApprovalDetail /></QueryClientProvider>));
    const link = () => container.querySelector<HTMLAnchorElement>('a[href="/costs"]')!;
    expect(link().textContent).toBe("/costs");
    expect(link().parentElement?.textContent).toBe("Resolve this budget stop from the budget controls on /costs.");
    await act(async () => setLocale("ru"));
    expect(link().parentElement?.textContent).toBe("Снять бюджетную блокировку можно в разделе управления бюджетом: /costs.");
    expect(container.textContent).not.toContain("<link>");
    expect(container.textContent).not.toContain("[object Object]");
    expect(mutation).not.toHaveBeenCalled();
    await act(async () => setLocale("en"));
    expect(link().getAttribute("href")).toBe("/costs");
    expect(mutation).not.toHaveBeenCalled();
  });

  it("updates human fallback and comment dates without rewriting bodies, agent names, IDs or a draft", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const createdAt = "2026-08-17T13:24:00.000Z";
    const comments = [
      { id: "raw-human-comment", authorAgentId: null, authorUserId: "raw-human-id", createdAt, body: "English user body with `raw_id` and {{prompt}}" },
      { id: "raw-agent-comment", authorAgentId: "raw-agent-id", authorUserId: null, createdAt, body: "English agent body stays unchanged" },
    ];
    const before = JSON.stringify(comments);
    client.setQueryData(queryKeys.approvals.detail("approval-qa"), {
      id: "approval-qa", companyId: "company-qa", type: "budget_override_required", status: "pending", payload: { rawId: "RAW_ID" },
    });
    client.setQueryData(queryKeys.approvals.comments("approval-qa"), comments);
    client.setQueryData(queryKeys.approvals.issues("approval-qa"), []);
    client.setQueryData(queryKeys.agents.list("company-qa"), [{ id: "raw-agent-id", name: "Board" }]);
    await act(async () => root.render(<QueryClientProvider client={client}><ApprovalDetail /></QueryClientProvider>));
    const bodies = [...container.querySelectorAll('[data-testid="raw-approval-comment"]')];
    const humanHeader = bodies[0].previousElementSibling!;
    const agentLink = container.querySelector('a[href="/agents/raw-agent-id"]')!;
    const textarea = container.querySelector("textarea")!;
    const draft = "Unsubmitted English draft {{raw_variable}}";
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, draft);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    for (const [locale, human] of [["en", "Board"], ["ru", "Руководство"], ["en", "Board"]] as const) {
      await act(async () => setLocale(locale));
      expect(humanHeader.textContent).toContain(human);
      expect(humanHeader.lastElementChild?.textContent).toBe(new Date(createdAt).toLocaleString(locale));
      expect(bodies.map((body) => body.textContent)).toEqual(comments.map((comment) => comment.body));
      expect(container.querySelector('a[href="/agents/raw-agent-id"]')).toBe(agentLink);
      expect(agentLink.textContent).toContain("Board");
      expect(agentLink.textContent).not.toContain("Руководство");
      expect(container.querySelector("textarea")).toBe(textarea);
      expect(textarea.value).toBe(draft);
      expect(JSON.stringify(client.getQueryData(queryKeys.approvals.comments("approval-qa")))).toBe(before);
      expect(mutation).not.toHaveBeenCalled();
    }
    client.clear();
  });
});
