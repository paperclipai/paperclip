// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "@paperclipai/shared";
import { pendingRequestConfirmationInteraction } from "@/fixtures/issueThreadInteractionFixtures";
import { issuesApi } from "@/api/issues";
import { ThemeProvider } from "@/context/ThemeContext";
import { approvalsApi } from "@/api/approvals";
import { ApprovalResolver } from "@/components/AttentionQueueRow";
import { CoordinatorReviewPanel, needsYouArtifact, needsYouMentionedArtifact } from "./CoordinatorReviewPanel";

vi.mock("@/api/issues", () => ({ issuesApi: { getDocument: vi.fn(), getDocumentRevision: vi.fn(), listInteractions: vi.fn() } }));
vi.mock("@/components/AttentionInteractionResolver", () => ({ AttentionInteractionResolver: () => <div data-testid="panel-interaction-resolver" /> }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn(async () => [{ id: "mgr", name: "Dottabot" }]) } }));
vi.mock("@/api/approvals", () => ({ approvalsApi: { approve: vi.fn(), reject: vi.fn(), requestRevision: vi.fn(), get: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("needsYouMentionedArtifact (PAP-775)", () => {
  it("reads a task document, an approval and an attachment from a card's links", () => {
    expect(needsYouMentionedArtifact("/NEE/issues/NEE-12#document-design", "design notes"))
      .toMatchObject({ kind: "document", issueId: "NEE-12", key: "design", title: "design notes" });
    expect(needsYouMentionedArtifact("/NEE/approvals/appr-1")).toEqual({ kind: "approval", approvalId: "appr-1" });
    expect(needsYouMentionedArtifact("/api/attachments/att-1/content", "screenshot.png"))
      .toEqual({ kind: "attachment", assetId: "att-1", name: "screenshot.png" });
  });

  it("preserves pinned document revisions, annotations, and the document owner", () => {
    expect(needsYouMentionedArtifact("/NEE/issues/NEE-12#document-launch%20plan&revision=rev-1&interaction=req-1&documentIssue=NEE-9&thread=thread-2"))
      .toMatchObject({ kind: "document", issueId: "NEE-9", key: "launch plan", documentTarget: { revisionId: "rev-1", interactionId: "req-1", threadId: "thread-2", documentIssueId: "NEE-9" } });
    expect(needsYouMentionedArtifact("/NEE/issues/NEE-12#document-%invalid")).toBeNull();
  });

  it.each(["notes.pdf", "notes.txt", "clip.mp4", "Download file", undefined])("keeps unsupported attachment %s as a normal browser link", name => {
    expect(needsYouMentionedArtifact("/api/attachments/att-1/content", name)).toBeNull();
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

  it.each([["ask_user_questions", false, null], ["request_checkbox_confirmation", false, null], ["request_item_verdicts", false, null], ["suggest_tasks", false, null], ["request_confirmation", true, null], ["request_confirmation", true, "deliverable"], ["request_confirmation", false, "tool_action"], ["request_confirmation", false, "secret"], ["request_confirmation", false, "connection"]] as const)("shares only synchronized %s actions in the artifact panel", async (kind, shared, requestKind) => {
    const question = { ...item, sourceKind: "issue_thread_interaction", subject: { ...item.subject, metadata: { issueId: "task", kind, requestKind } } } as AttentionItem;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}>
      <CoordinatorReviewPanel companyId="company" item={question} artifact={{ kind: "images" }} agentMap={new Map()} currentUserId="scott"
        onOpenTask={vi.fn()} onResolved={vi.fn()} />
    </QueryClientProvider>));
    expect(Boolean(container.querySelector('[data-testid="panel-interaction-resolver"]'))).toBe(shared);
    expect(container.textContent?.includes("Answer on the inbox card")).toBe(!shared);
    client.clear();
  });

  it("opens the original attachment through a browser link instead of task navigation", async () => {
    const onOpen = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}>
      <CoordinatorReviewPanel companyId="company" item={item} artifact={{ kind: "attachment", assetId: "image with spaces", name: "screenshot.png" }}
        agentMap={new Map()} currentUserId="scott" onOpenTask={onOpen} onResolved={vi.fn()} />
    </QueryClientProvider>));
    await act(async () => container.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("This file cannot be previewed.");
    const link = [...container.querySelectorAll<HTMLAnchorElement>("a")].find(entry => entry.textContent === "Open file");
    expect(link?.getAttribute("href")).toBe("/api/attachments/image%20with%20spaces/content");
    expect(link?.target).toBe("_blank");
    expect(onOpen).not.toHaveBeenCalled();
    client.clear();
  });

  it("loads the pinned revision and retains the full document link", async () => {
    vi.mocked(issuesApi.getDocumentRevision).mockResolvedValue({ title: "Pinned plan", body: "Revision under review" } as never);
    const artifact = needsYouMentionedArtifact("/NEE/issues/NEE-12#document-plan&revision=rev-1&interaction=req-1&documentIssue=NEE-9&thread=thread-2")!;
    const onOpen = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ThemeProvider><CoordinatorReviewPanel companyId="company" item={item} artifact={artifact} agentMap={new Map()} currentUserId="scott" onOpenTask={onOpen} onResolved={vi.fn()} /></ThemeProvider>
    </QueryClientProvider>));
    for (let tick = 0; tick < 3; tick++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(issuesApi.getDocumentRevision).toHaveBeenCalledExactlyOnceWith("NEE-9", "plan", "rev-1");
    expect(issuesApi.getDocument).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Revision under review");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Open in"))!.click());
    expect(onOpen.mock.calls[0]?.[0]).toContain("#document-plan&thread=thread-2&revision=rev-1&interaction=req-1&documentIssue=NEE-9");
    client.clear();
  });

  it("reviews the exact target of a plan request owned by another task", async () => {
    const request = { ...pendingRequestConfirmationInteraction, id: "request-1", issueId: "request-task", payload: {
      ...pendingRequestConfirmationInteraction.payload, target: { type: "issue_document" as const, issueId: "document-owner", key: "plan", revisionId: "pinned-revision" },
    } };
    vi.mocked(issuesApi.listInteractions).mockResolvedValue([request]);
    vi.mocked(issuesApi.getDocumentRevision).mockClear().mockResolvedValue({ title: "Correct plan", body: "The plan being approved" } as never);
    vi.mocked(issuesApi.getDocument).mockClear().mockResolvedValue({ title: "Wrong plan", body: "The request task's current plan" } as never);
    const plan = { ...item, id: "plan-request", sourceKind: "issue_thread_interaction", subject: { ...item.subject, id: request.id, metadata: { issueId: "request-task", targetDocumentKey: "plan" } },
      relatedIssue: { id: "request-task", kind: "issue", companyId: "company", title: "Request task", identifier: "NEE-12", status: "in_progress", href: "/NEE/issues/NEE-12", metadata: {} } } as AttentionItem;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><ThemeProvider>
      <CoordinatorReviewPanel companyId="company" item={plan} artifact={needsYouArtifact(plan)!} agentMap={new Map()} currentUserId="scott" onOpenTask={vi.fn()} onResolved={vi.fn()} />
    </ThemeProvider></QueryClientProvider>));
    for (let tick = 0; tick < 5; tick++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(issuesApi.getDocumentRevision).toHaveBeenCalledExactlyOnceWith("document-owner", "plan", "pinned-revision");
    expect(issuesApi.getDocument).not.toHaveBeenCalled();
    expect(container.textContent).toContain("The plan being approved");
    client.clear();
  });

  it("confirms before the panel answers another person's request", async () => {
    vi.mocked(approvalsApi.approve).mockClear().mockResolvedValue({} as never);
    const other = { ...item, inlineResolvable: true, audience: { kind: "user", userId: "dotta", reason: "requester" } } as AttentionItem;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}>
      <CoordinatorReviewPanel companyId="company" item={other} artifact={{ kind: "images" }} agentMap={new Map()} currentUserId="scott"
        userLabelMap={new Map([["dotta", "Dotta"]])} onOpenTask={vi.fn()} onResolved={vi.fn()} />
    </QueryClientProvider>));
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(entry => entry.textContent === label)!;
    await act(async () => button("Approve").click());
    expect(approvalsApi.approve).not.toHaveBeenCalled();
    expect(container.textContent).toContain("This is for @Dotta");
    await act(async () => button("Continue").click());
    expect(approvalsApi.approve).toHaveBeenCalledTimes(1);
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
