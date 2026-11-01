// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseDetail as CaseDetailData, CaseHandoffView } from "@/api/cases";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { CaseDetail } from "./CaseDetail";

const cases = vi.hoisted(() => ({
  get: vi.fn(), listChildren: vi.fn(), listEvents: vi.fn(), listHandoffs: vi.fn(),
  getDocument: vi.fn(), listRevisions: vi.fn(), patch: vi.fn(), upsertDocument: vi.fn(),
  deleteDocument: vi.fn(), restoreDocumentRevision: vi.fn(), retryHandoff: vi.fn(), cancelHandoff: vi.fn(),
}));
const agents = vi.hoisted(() => ({ list: vi.fn() }));
const project = vi.hoisted(() => ({ get: vi.fn() }));
const taskDocuments = vi.hoisted(() => ({ getDocument: vi.fn(), listDocumentRevisions: vi.fn() }));
const breadcrumbs = vi.hoisted(() => vi.fn());
const copy = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("@/api/cases", async original => ({ ...(await original<typeof import("@/api/cases")>()), casesApi: cases }));
vi.mock("@/api/agents", () => ({ agentsApi: agents }));
vi.mock("@/api/projects", () => ({ projectsApi: project }));
vi.mock("@/api/issues", () => ({ issuesApi: taskDocuments }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: breadcrumbs }) }));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: copy }));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("@/lib/router", () => ({
  useParams: () => ({ caseIdentifier: "PAP-C7" }),
  useLocation: () => ({ search: "?q=hermes&type=blog_post", hash: "" }),
  Navigate: () => null,
  Link: ({ children, to, disableIssueQuicklook: _quicklook, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; disableIssueQuicklook?: boolean }) => <a href={to} {...props}>{children}</a>,
  useCaseHref: () => (...segments: string[]) => `/PAP/${["cases", ...segments].filter(Boolean).join("/")}`,
}));

function detail(): CaseDetailData {
  return {
    id: "case-1", companyId: "company-1", projectId: null, caseNumber: 7, identifier: "PAP-C7",
    caseType: "blog_post", key: "hermes-agent-post", title: "Hermes agent launch post", summary: "Launch narrative", status: "in_review",
    fields: { title: "Hermes agent launch post", description: "Launch narrative", body: "Superseded body", word_count: 1850, published: false, task_identifiers: ["PAP-12947"] },
    parent: null, parentCaseId: null, createdByAgentId: null, createdByUserId: null, completedAt: null,
    createdAt: "2026-10-19T09:00:00.000Z", updatedAt: "2026-10-19T10:00:00.000Z", labels: [],
    issueLinks: [{ id: "link-1", caseId: "case-1", issueId: "related-task", role: "reference", createdAt: "2026-10-19T09:00:00.000Z", issue: { id: "related-task", identifier: "PAP-12947", title: "Case object exploration", status: "in_progress" } }],
    documents: [{ key: "body", document: { id: "doc-1", companyId: "company-1", title: "Launch draft", format: "markdown", latestBody: "Current draft", latestRevisionId: "rev-2", latestRevisionNumber: 2, createdByAgentId: null, createdByUserId: null, updatedByAgentId: "agent-1", updatedByUserId: null, lockedAt: null, lockedByAgentId: null, lockedByUserId: null, createdAt: "2026-10-19T09:00:00.000Z", updatedAt: "2026-10-19T10:00:00.000Z" } }],
    attachments: [{ id: "attachment-1", asset: { id: "asset-1", contentType: "application/pdf", originalFilename: "Launch report.pdf", byteSize: 1024 }, createdAt: "2026-10-19T09:00:00.000Z", updatedAt: "2026-10-19T09:00:00.000Z" }],
  };
}

function handoff(overrides: Partial<CaseHandoffView> = {}): CaseHandoffView {
  return { id: "handoff-1", companyId: "company-1", caseId: "case-1", issueId: "task-1", version: 1, destinationKind: "agent", completedAt: null, workflowTransition: null, fromAgentId: "agent-1", toAgentId: "agent-2", phase: "verification", instructions: "Check the saved draft independently.", commentId: null, actorType: "agent", actorId: "agent-1", sourceRunId: null, responsibleUserId: null, expectedIssueStatusVersion: 1, appliedIssueStatusVersion: null, wakeupRequestId: "wake-1", idempotencyKey: "handoff-key", inputFingerprint: "fingerprint", state: "awaiting_release", attemptCount: 0, nextAttemptAt: "2026-10-19T10:00:00Z", leaseExpiresAt: null, lastErrorCode: null, lastError: null, createdAt: "2026-10-19T10:00:00Z", assignmentAppliedAt: null, deliveredAt: null, cancelledAt: null, updatedAt: "2026-10-19T10:00:00Z", fromAgentName: "Writer", toAgentName: "Verifier", ...overrides };
}

async function settle() {
  for (let i = 0; i < 5; i++) { await new Promise(resolve => setTimeout(resolve, 0)); }
  flushSync(() => {});
}
async function waitFor(assertion: () => void) {
  for (let i = 0; i < 30; i++) {
    try { assertion(); return; } catch (error) { if (i === 29) throw error; await settle(); }
  }
}
function button(name: string) {
  const match = Array.from(document.body.querySelectorAll("button")).find(item => item.textContent?.trim() === name);
  expect(match, `button ${name}`).toBeTruthy();
  return match!;
}
function click(element: HTMLElement) { flushSync(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true }))); }
function expand(name: string) {
  const summary = Array.from(document.body.querySelectorAll("summary")).find(item => item.textContent?.trim() === name);
  expect(summary, `disclosure ${name}`).toBeTruthy();
  flushSync(() => {
    const details = summary!.parentElement as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

describe("read-only CaseDetail", () => {
  let container: HTMLDivElement;
  let root: Root;
  const clients: QueryClient[] = [];
  function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    clients.push(client);
    flushSync(() => root.render(<QueryClientProvider client={client}><CaseDetail /></QueryClientProvider>));
  }
  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    cases.get.mockResolvedValue(detail()); cases.listChildren.mockResolvedValue([]); cases.listEvents.mockResolvedValue([]);
    cases.listHandoffs.mockResolvedValue({ items: [], nextCursor: null });
    cases.getDocument.mockResolvedValue({ ...detail().documents[0]!.document, key: "body", body: "Current authorized draft" });
    cases.listRevisions.mockResolvedValue({ key: "body", document: { id: "doc-1", title: "Launch draft", format: "markdown", latestRevisionId: "rev-2", latestRevisionNumber: 2 }, revisions: [{ id: "rev-1", revisionNumber: 1, title: "Launch draft", format: "markdown", body: "Earlier draft", changeSummary: "First version", createdAt: "2026-10-19T09:00:00Z", createdByAgentId: "agent-1", createdByUserId: null, createdByRunId: null, actorAgentName: "Writer", issue: null }] });
    agents.list.mockResolvedValue([{ id: "agent-1", name: "Writer", status: "idle" }, { id: "agent-2", name: "Verifier", status: "paused" }]);
    project.get.mockResolvedValue({ id: "project-1", name: "Paperclip" });
  });
  afterEach(() => { flushSync(() => root.unmount()); container.remove(); clients.splice(0).forEach(client => client.clear()); });

  it("shows saved facts, passive work, readable references and preserves browse context without editing", async () => {
    render();
    await waitFor(() => expect(container.textContent).toContain("Hermes agent launch post"));
    const table = container.querySelector('table[aria-label="Case fields"]')!;
    const wordCount = Array.from(table.querySelectorAll("th")).find(item => item.textContent === "word_count");
    expect(wordCount?.nextElementSibling?.textContent).toBe("1850");
    const published = Array.from(table.querySelectorAll("th")).find(item => item.textContent === "published");
    expect(published?.nextElementSibling?.textContent).toBe("false");
    expect(container.textContent).toContain("No task linked");
    expect(container.textContent).not.toContain("Superseded body");
    expect(container.querySelector('a[href="/api/assets/asset-1/content"]')?.textContent).toContain("Launch report.pdf");
    expect(container.querySelector('a[href="/issues/PAP-12947"]')).not.toBeNull();
    expect(breadcrumbs).toHaveBeenLastCalledWith([{ label: "Cases", href: "/PAP/cases?q=hermes&type=blog_post" }, { label: "PAP-C7" }]);
    expect(container.querySelector('input,textarea,[contenteditable="true"]')).toBeNull();
    expect(Array.from(container.querySelectorAll("button")).some(item => /edit|delete|restore|change case status|retry handoff|cancel handoff/i.test(item.getAttribute("aria-label") ?? item.textContent ?? ""))).toBe(false);
    expect(cases.listHandoffs).not.toHaveBeenCalled();
    expect(cases.listEvents).not.toHaveBeenCalled();
  });

  it("shows Work before Details and reads nested fields as compact dotted key/value rows", async () => {
    const items = [{ quantity: 2, unitPrice: 3 }];
    const metadata = { source: { name: "Coffee shop", reference: "receipt-1" }, verified: true };
    cases.get.mockResolvedValue({ ...detail(), fields: { ...detail().fields, items, metadata } });
    render();
    await waitFor(() => expect(container.querySelector('table[aria-label="Case fields"]')).not.toBeNull());
    const table = container.querySelector('table[aria-label="Case fields"]')!;
    const values = Object.fromEntries(Array.from(table.querySelectorAll("tr")).map(row => [
      row.querySelector("th")?.textContent, row.querySelector("td")?.textContent,
    ]));
    expect(values).toMatchObject({
      "items.quantity": "2", "items.unitPrice": "3",
      "metadata.source.name": "Coffee shop", "metadata.source.reference": "receipt-1", "metadata.verified": "true",
    });
    expect(table.querySelector("pre")).toBeNull();
    const sections = Array.from(container.querySelectorAll("section"));
    expect(sections.findIndex(section => section.getAttribute("aria-label") === "Case work"))
      .toBeLessThan(sections.findIndex(section => section.getAttribute("aria-label") === "Case details"));
    expect(container.querySelector('a[href="/issues/PAP-12947"]')).not.toBeNull();
  });

  it("reads current documents and older revisions without offering a restore path", async () => {
    render(); await waitFor(() => expect(container.textContent).toContain("Launch draft"));
    click(button("Launch draft"));
    await waitFor(() => expect(document.body.textContent).toContain("Current authorized draft"));
    expect(cases.getDocument).toHaveBeenCalledWith("PAP-C7", "body");
    expect(cases.listRevisions).not.toHaveBeenCalled();
    expand("Revision history");
    await waitFor(() => expect(document.body.textContent).toContain("Earlier draft"));
    expect(cases.listRevisions).toHaveBeenCalledWith("PAP-C7", "body");
    expect(Array.from(document.body.querySelectorAll("button")).some(item => /restore|edit|delete/i.test(item.textContent ?? ""))).toBe(false);
    expect(cases.restoreDocumentRevision).not.toHaveBeenCalled();
  });

  it("reads same-key task and historical case documents from their own owners without editing controls", async () => {
    const legacy = detail().documents[0]!;
    const { latestBody: _body, ...metadata } = legacy.document;
    cases.get.mockResolvedValue({ ...detail(), taskDocuments: [{ id: "issue:task-1:body", sourceKind: "issue", taskId: "task-1",
      taskIdentifier: "PAP-123", scope: "primary", key: "body", document: { ...metadata, id: "task-document", title: "Task launch draft" },
      readPath: "/api/issues/task-1/documents/body" }] });
    taskDocuments.getDocument.mockResolvedValue({ ...metadata, id: "task-document", issueId: "task-1", key: "body", body: "Current authorized task draft" });
    taskDocuments.listDocumentRevisions.mockResolvedValue([2, 1].map(number => ({ id: `task-revision-${number}`, companyId: "company-1", documentId: "task-document",
      issueId: "task-1", key: "body", revisionNumber: number, title: "Task launch draft", format: "markdown",
      body: number === 2 ? "Current authorized task draft" : "Earlier authorized task draft", changeSummary: null,
      createdAt: `2026-10-19T0${number}:00:00Z`, createdByAgentId: "agent-1", createdByUserId: null })));
    render();
    await waitFor(() => expect(container.querySelector('button[aria-label="Task launch draft"]')).not.toBeNull());
    expect(container.querySelector('button[aria-label="Launch draft"]')).not.toBeNull();
    click(container.querySelector('button[aria-label="Task launch draft"]')!);
    await waitFor(() => expect(document.body.textContent).toContain("Current authorized task draft"));
    expect(taskDocuments.getDocument).toHaveBeenCalledWith("task-1", "body");
    expect(cases.getDocument).not.toHaveBeenCalled();
    expect(document.body.querySelector('a[href="/issues/PAP-123#document-body"]')).not.toBeNull();
    expect(taskDocuments.listDocumentRevisions).not.toHaveBeenCalled();
    expand("Revision history");
    await waitFor(() => expect(document.body.textContent).toContain("rev 1"));
    expect(taskDocuments.listDocumentRevisions).toHaveBeenCalledWith("task-1", "body");
    expect(cases.listRevisions).not.toHaveBeenCalled();
    const earlier = Array.from(document.body.querySelectorAll("button")).find(item => /^rev 1/.test(item.textContent ?? ""));
    click(earlier!);
    await waitFor(() => expect(document.body.textContent).toContain("Earlier authorized task draft"));
    click(button("Diff"));
    await waitFor(() => expect(document.body.textContent).toContain("Old"));
    expect(document.body.textContent).toContain("Earlier authorized task draft");
    expect(document.body.textContent).toContain("Current authorized task draft");
    expect(Array.from(document.body.querySelectorAll("button")).some(item => /restore|edit|delete/i.test(item.textContent ?? ""))).toBe(false);
  });

  it("retains parent and child navigation with the original list filters", async () => {
    const parent = { id: "parent-1", identifier: "PAP-C2", title: "Launch campaign", caseType: "campaign", status: "approved" as const };
    cases.get.mockResolvedValue({ ...detail(), parentCaseId: parent.id, parent });
    cases.listChildren.mockResolvedValue([{ ...detail(), id: "child-1", identifier: "PAP-C8", title: "Launch images", parentCaseId: "case-1" }]);
    render();
    await waitFor(() => expect(container.querySelector('a[href="/PAP/cases/PAP-C8?q=hermes&type=blog_post"]')).not.toBeNull());
    expect(container.querySelector('a[href="/PAP/cases/PAP-C2?q=hermes&type=blog_post"]')).not.toBeNull();
    expect(cases.listChildren).toHaveBeenCalledWith("company-1", "case-1");
  });

  it("keeps a failed document read visible without displaying cached document contents", async () => {
    cases.getDocument.mockRejectedValue(new ApiError("Denied", 404, {}));
    render(); await waitFor(() => expect(container.textContent).toContain("Launch draft")); click(button("Launch draft"));
    await waitFor(() => expect(document.body.textContent).toContain("This document couldn’t be loaded."));
    expect(document.body.textContent).not.toContain("Current draft");
    expect(cases.listRevisions).not.toHaveBeenCalled();
  });

  it("shows assignment separately from a waiting successor and reads paginated handoff history", async () => {
    const pending = handoff({ workflowTransition: { from: { workflowId: "workflow-a", name: "Research before rename", phase: "implementation" },
      to: { workflowId: "workflow-b", name: "Publish", phase: "verification" }, documentRevisionId: "revision-1" } });
    cases.get.mockResolvedValue({ ...detail(), workflowId: "workflow-a", workflow: { id: "workflow-a", name: "Research renamed" }, workIssueId: "task-1", phase: "implementation", workIssue: { id: "task-1", identifier: "PAP-123", title: "Implement the launch", status: "in_progress", statusVersion: 1, assigneeAgentId: "agent-1", assigneeAgentName: "Writer" }, pendingHandoff: pending });
    cases.listHandoffs.mockImplementation((_id: string, cursor: string | null) => Promise.resolve(cursor ? { items: [handoff({ id: "handoff-0", phase: "triage", state: "cancelled" })], nextCursor: null } : { items: [pending], nextCursor: "older" }));
    render(); await waitFor(() => expect(container.textContent).toContain("Waiting for Writer to finish."));
    expect(container.querySelector('a[href="/issues/PAP-123"]')).not.toBeNull();
    const handoffs = container.querySelector('[aria-label="Case handoffs"]')!;
    expect(container.querySelector('[aria-label="Case work"]')?.textContent).toContain("Research renamed");
    expect(container.querySelector('[aria-label="Case work"]')?.textContent).toContain("Next: Publish · verification");
    expect(handoffs.textContent).toContain("Research before rename · implementation → Publish · verification");
    expect(handoffs.textContent).toContain("Pending transfer");
    expect(handoffs.querySelector('a[href="/issues/PAP-123"]')).not.toBeNull();
    click(button("Load older handoffs"));
    await waitFor(() => expect(container.textContent).toContain("Cancelled"));
    expect(cases.listHandoffs).toHaveBeenCalledWith("case-1", "older");
    expect(handoffs.querySelectorAll('a[href="/issues/PAP-123"]')).toHaveLength(2);
    expect(container.textContent).toContain("Check the saved draft independently.");
    expect(cases.retryHandoff).not.toHaveBeenCalled(); expect(cases.cancelHandoff).not.toHaveBeenCalled(); expect(cases.patch).not.toHaveBeenCalled();
  });

  it("shows paused delivery without implying that the recipient is working", async () => {
    cases.get.mockResolvedValue({ ...detail(), workIssueId: "task-1", phase: "verification", workIssue: { id: "task-1", identifier: "PAP-123", title: "Verify the launch", status: "todo", statusVersion: 2, assigneeAgentId: "agent-2", assigneeAgentName: "Verifier" }, pendingHandoff: handoff({ state: "pending_dispatch" }) });
    render(); await waitFor(() => expect(container.textContent).toContain("Verifier is paused."));
    expect(container.textContent).not.toContain("Next: verification");
  });

  it.each(["awaiting_completion", "completed"] as const)("renders a %s terminal handoff without inventing a recipient", async state => {
    const closing = handoff({ destinationKind: "done", toAgentId: null, toAgentName: null,
      phase: "done", state, completedAt: state === "completed" ? "2026-10-19T10:01:00Z" : null });
    cases.get.mockResolvedValue({ ...detail(), status: state === "completed" ? "done" : "in_review",
      workIssueId: "task-1", phase: state === "completed" ? "done" : "verification",
      workIssue: { id: "task-1", identifier: "PAP-123", title: "Verify the launch",
        status: state === "completed" ? "done" : "in_review", statusVersion: 2,
        assigneeAgentId: "agent-1", assigneeAgentName: "Writer" },
      pendingHandoff: state === "completed" ? null : closing });
    cases.listHandoffs.mockResolvedValue({ items: [closing], nextCursor: null });
    render();
    await waitFor(() => expect(container.querySelector('[aria-label="Case handoffs"]')?.textContent).toContain("Done"));
    if (state === "awaiting_completion") {
      expect(container.textContent).toContain("Case will close when the task is complete.");
      expect(container.textContent).toContain("Waiting for task completion");
    } else {
      expect(container.textContent).not.toContain("Waiting for task completion");
      expect(container.textContent).not.toContain("Case will close");
    }
    expect(container.textContent).not.toContain("Waiting for null");
    expect(cases.patch).not.toHaveBeenCalled();
  });

  it("links to the case's filtered Audit view instead of duplicating activity on the case page", async () => {
    render(); await waitFor(() => expect(container.textContent).toContain("Hermes agent launch post"));
    expect(cases.listEvents).not.toHaveBeenCalled();
    expect(Array.from(container.querySelectorAll("summary")).some(item => item.textContent === "Activity")).toBe(false);
    expect(container.querySelector('a[href="/activity?entityType=case&entityId=case-1"]')?.textContent).toBe("View in Audit");
  });

  it("keeps a loaded case visible after a transient background refresh fails", async () => {
    render();
    await waitFor(() => expect(container.textContent).toContain("Hermes agent launch post"));
    cases.get.mockRejectedValue(new ApiError("Rate limited", 429, {}));
    const client = clients.at(-1)!;
    await client.refetchQueries({ queryKey: queryKeys.cases.detail("PAP-C7"), exact: true });
    await waitFor(() => expect(client.getQueryState(queryKeys.cases.detail("PAP-C7"))?.status).toBe("error"));
    await settle();
    expect(container.textContent).toContain("Hermes agent launch post");
    expect(container.querySelector('table[aria-label="Case fields"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Case not found");
  });
  it("uses the same unavailable state for missing and inaccessible cases", async () => {
    cases.get.mockRejectedValue(new ApiError("Denied", 403, {}));
    render(); await waitFor(() => expect(container.textContent).toContain("Case not found"));
    expect(container.textContent).not.toContain("Hermes agent launch post");
    expect(container.querySelector('a[href="/PAP/cases?q=hermes&type=blog_post"]')).not.toBeNull();
    expect(cases.listChildren).not.toHaveBeenCalled();
  });
});
