// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "@paperclipai/shared";
import { approvalsApi } from "@/api/approvals";
import { ApprovalResolver } from "@/components/AttentionQueueRow";
import { needsYouMentionedArtifact } from "./CoordinatorReviewPanel";

vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn(async () => [{ id: "mgr", name: "Dottabot" }]) } }));
vi.mock("@/api/approvals", () => ({ approvalsApi: { approve: vi.fn(), reject: vi.fn(), requestRevision: vi.fn(), get: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("needsYouMentionedArtifact (PAP-775)", () => {
  it("reads a task document, an approval and an attachment from a card's links", () => {
    expect(needsYouMentionedArtifact("/NEE/issues/NEE-12#document-design", "design notes"))
      .toEqual({ kind: "document", issueId: "NEE-12", key: "design", title: "design notes" });
    expect(needsYouMentionedArtifact("/NEE/approvals/appr-1")).toEqual({ kind: "approval", approvalId: "appr-1" });
    expect(needsYouMentionedArtifact("/api/attachments/att-1/content", "screenshot.png"))
      .toEqual({ kind: "attachment", assetId: "att-1", name: "screenshot.png" });
  });

  it("leaves every other link alone", () => {
    expect(needsYouMentionedArtifact("/NEE/issues/NEE-12")).toBeNull();
    expect(needsYouMentionedArtifact("https://example.com/issues/X-1#document-plan")).toBeNull();
  });
});

describe("ApprovalResolver shared between a card and its side panel (PAP-775)", () => {
  let container: HTMLDivElement;
  let root: Root;
  const item = { id: "approval", sourceKind: "approval", updatedAt: "2026-11-04T00:00:00.000Z",
    subject: { id: "appr-1", kind: "approval", title: "Ship it", metadata: {} } } as unknown as AttentionItem;

  beforeEach(() => {
    sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("mirrors the decision note and sends the approval once", async () => {
    let resolveApprove!: (value: unknown) => void;
    vi.mocked(approvalsApi.approve).mockImplementation(() => new Promise(resolve => { resolveApprove = resolve; }) as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}>
      <div data-view="card"><ApprovalResolver item={item} companyId="company" toggle={null} shareDraft /></div>
      <div data-view="panel"><ApprovalResolver item={item} companyId="company" toggle={null} shareDraft /></div>
    </QueryClientProvider>));
    const note = (view: string) => container.querySelector<HTMLTextAreaElement>(`[data-view="${view}"] textarea`)!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(note("card"), "Looks right");
      note("card").dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(note("panel").value).toBe("Looks right");

    const approve = (view: string) => [...container.querySelectorAll<HTMLButtonElement>(`[data-view="${view}"] button`)].find(button => button.textContent === "Approve")!;
    await act(async () => approve("card").click());
    // Sending from one view disables the other, so nothing is sent twice.
    expect(approve("panel").disabled).toBe(true);
    await act(async () => approve("panel").click());
    expect(approvalsApi.approve).toHaveBeenCalledTimes(1);
    expect(approvalsApi.approve).toHaveBeenCalledWith("appr-1", "Looks right");
    await act(async () => resolveApprove({}));
    client.clear();
  });

  it("shows the hire on a card with View configuration, Reject and Approve hire, and no note", async () => {
    vi.mocked(approvalsApi.get).mockResolvedValue({ payload: { name: "Researcher", role: "researcher", reportsTo: "mgr", budgetMonthlyCents: 5000 } } as never);
    const hire = { ...item, subject: { ...item.subject, metadata: { type: "hire_agent" } } } as AttentionItem;
    const onViewDetails = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ApprovalResolver item={hire} companyId="company" toggle={null} presentation="card" onViewDetails={onViewDetails} shareDraft />
    </QueryClientProvider>));
    for (let tick = 0; tick < 3; tick++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(container.querySelector("textarea")).toBeNull();
    const panel = container.querySelector("[data-needs-you-panel]")!;
    expect(panel.textContent).toContain("Researcher · $50 / month");
    expect(panel.textContent).toContain("Reports to Dottabot");
    const labels = [...container.querySelectorAll("[data-decision-actions] button")].map(button => button.textContent);
    expect(labels).toEqual(["View configuration", "Reject", "Approve hire"]);
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("[data-decision-actions] button")][0]!.click());
    expect(onViewDetails).toHaveBeenCalledTimes(1);
    client.clear();
  });
});
