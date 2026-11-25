import type { IssueDocument, IssueWorkProduct } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { uploadedDocumentKey } from "@/lib/issue-artifact-upload";
import { QueryClient } from "@tanstack/react-query";
import { createIssue, storybookAgents } from "../../fixtures/paperclipData";

export const issue = createIssue({
  id: "artifact-upload-placeholder", identifier: "PAP-214", issueNumber: 214,
  title: "Instance sleep — engineering handoff", status: "backlog",
  assigneeAgentId: null, assigneeUserId: null, executionRunId: null,
  checkoutRunId: null, executionLockedAt: null, currentExecutionWorkspace: null,
  executionWorkspaceId: null, documentSummaries: [], workProducts: [],
});

export const handoffBody = `# Instance sleep: engineering handoff

Paperclip should release idle database connections and let inactive instances sleep without losing scheduled work, incoming events, accounting, or recovery.

## Start here

The inventory records the remaining work. The implementation notes explain the patterns already in use. Quiet delivery queues alone do not establish whole-instance sleep.

## References

- [Loop inventory](?doc=loop-inventory)
- [Implementation notes](?doc=implementation-notes)

## Current direction

Work caused by a committed change should run from that event. Work caused by the passage of time belongs in one instance-wide scheduler.

## What comes next

1. Migrate the remaining clock-driven work to the scheduler.
2. Prove the full writer-admission and idle/resume boundary.
3. Verify actual app and database sleep with the hosting providers.
`;

export function makeDocument(key: string, title: string, body: string): IssueDocument {
  return {
    id: `document-${key}`, issueId: issue.id, companyId: issue.companyId,
    key, title, format: "markdown", body, latestRevisionId: `revision-${key}`,
    latestRevisionNumber: 1, createdByAgentId: null, updatedByAgentId: null,
    createdByUserId: "user-board", updatedByUserId: "user-board",
    lockedAt: null, lockedByAgentId: null, lockedByUserId: null,
    createdAt: new Date("2026-10-12T15:00:00Z"), updatedAt: new Date("2026-10-12T15:00:00Z"),
  };
}

export const documents = [
  makeDocument("core-handoff", "Instance sleep: engineering handoff", handoffBody),
  makeDocument("loop-inventory", "Loop inventory", "# Loop inventory\n\n| Path | Pattern | Next action |\n| --- | --- | --- |\n| Durable delivery queues | Wake after commit | Verify idle boundary |\n| Routine schedules | Saved deadline | Register with scheduler |\n| Browser live events | Visibility-aware connection | Verify disconnect on hide |\n\n## Completion evidence\n\nRecord the source, change and verification result for each item."),
  makeDocument("implementation-notes", "Implementation notes", "# Implementation notes\n\nDurable queue rows remain authoritative. A producer registers intent before its write; the database owner defers delivery wakes until the outer transaction settles.\n\n## Recovery\n\nKeep startup scans and saved retry deadlines. Empty, settled queues need no recurring scan.\n\n## Boundary\n\nSignals are process-local to one database owner and its dedicated child pools. Cross-process handoff needs separate fencing."),
];

export type PreviewState = "empty" | "populated" | "uploading" | "error" | "long";

/** Enter through the real DOM drag handler so stories show the actual state. */
export function showFileDrag(canvas: HTMLElement, scroll = false) {
  const panel = canvas.querySelector<HTMLElement>('[aria-label="Artifact uploads"]');
  if (!panel) throw new Error("Artifacts drop target is missing");
  if (scroll) {
    const viewport = panel.querySelector<HTMLElement>("[data-side-panel-content-viewport]");
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }
  const transfer = new DataTransfer();
  transfer.items.add(new File(["# New reference\n\nAdded through the Artifacts panel."], "new-reference.md", { type: "text/markdown" }));
  // Include the tab header in the target rather than only the inner file list.
  const target = panel.querySelector("header") ?? panel;
  target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
}

export function createPreviewClient(state: PreviewState) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData([...queryKeys.issues.documents(issue.id), "list"], state === "empty" ? [] : state === "long" ? [...documents, makeDocument("long-reference", "Database transaction recovery and instance sleep: detailed engineering reference with verification evidence", Array.from({ length: 20 }, (_, index) => `## Investigation ${index + 1}\n\nCheck the transaction outcome before retrying uncertain writes. Preserve the durable receipt and current task state.`).join("\n\n"))] : documents);
  client.setQueryData(queryKeys.issues.attachments(issue.id), []);
  client.setQueryData(queryKeys.issues.workProducts(issue.id), []);
  client.setQueryData(queryKeys.issues.runs(issue.id), []);
  client.setQueryData(queryKeys.agents.list(issue.companyId), storybookAgents);
  return client;
}

// File bytes and mutations stay in this preview's memory. No live task changes.
export async function addPreviewFile(client: QueryClient, file: File, id: string) {
  if (/\.(md|markdown)$/i.test(file.name) || file.type === "text/markdown") {
    const body = await file.text();
    const current = client.getQueryData<IssueDocument[]>([...queryKeys.issues.documents(issue.id), "list"]) ?? [];
    const title = file.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
    const key = uploadedDocumentKey(file.name, current.map(document => document.key));
    client.setQueryData([...queryKeys.issues.documents(issue.id), "list"], [makeDocument(key, title, body), ...current]);
    return;
  }
  client.setQueryData(["storybook-upload-file", id], file);
  const contentPath = `/api/attachments/${id}/content`;
  const product: IssueWorkProduct = {
    id, companyId: issue.companyId, issueId: issue.id, projectId: issue.projectId,
    executionWorkspaceId: null, runtimeServiceId: null, type: "artifact", provider: "paperclip",
    externalId: null, title: file.name, url: null, status: "active", reviewState: "none",
    isPrimary: false, healthStatus: "healthy", summary: null, createdByRunId: null,
    metadata: { attachmentId: id, contentType: file.type || "application/octet-stream", byteSize: file.size, contentPath, openPath: contentPath, downloadPath: `${contentPath}?download=1`, originalFilename: file.name },
    createdAt: new Date("2026-10-12T15:01:00Z"), updatedAt: new Date("2026-10-12T15:01:00Z"),
  };
  client.setQueryData<IssueWorkProduct[]>(queryKeys.issues.workProducts(issue.id), (current = []) => [product, ...current]);
}

export function installPreviewApi(client: QueryClient) {
  const originalFetch = window.fetch;
  const fixtureFetch: typeof window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    const base = `/api/issues/${issue.id}`;
    const attachmentMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)\/content$/);
    if (attachmentMatch) {
      const file = client.getQueryData<File>(["storybook-upload-file", attachmentMatch[1]]);
      if (file) return new Response(file, { headers: { "Content-Type": file.type || "application/octet-stream" } });
    }
    if (url.pathname === `${base}/work-products`) return Response.json(client.getQueryData(queryKeys.issues.workProducts(issue.id)) ?? []);
    if (url.pathname === `${base}/attachments`) return Response.json([]);
    if (url.pathname === `${base}/documents`) return Response.json(client.getQueryData([...queryKeys.issues.documents(issue.id), "list"]) ?? []);
    if (url.pathname.startsWith(`${base}/documents/`)) {
      if (url.pathname.endsWith("/annotations")) return Response.json([]);
      const key = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const document = (client.getQueryData<IssueDocument[]>([...queryKeys.issues.documents(issue.id), "list"]) ?? []).find((doc) => doc.key === key);
      return document ? Response.json(document) : Response.json({ error: "Document not found" }, { status: 404 });
    }
    return originalFetch(input, init);
  };
  window.fetch = fixtureFetch;
  return () => { if (window.fetch === fixtureFetch) window.fetch = originalFetch; };
}
