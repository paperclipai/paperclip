// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolConnectionStoredContent } from "@paperclipai/shared";

const api = vi.hoisted(() => ({
  getStoredContent: vi.fn(),
  getStoredContentDeletion: vi.fn(),
  deleteStoredContent: vi.fn(),
}));
vi.mock("@/api/tools", () => ({ toolsApi: api }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));

import { StoredContentDeletionDialog, storedContentStatus, storedContentSummary } from "./StoredContentDeletion";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const counts = { toolCalls: 0, approvals: 0, auditEvents: 0, appViews: 0, runs: 0, runsInProgress: 0, itemsInProgress: 0 };
const stored: ToolConnectionStoredContent = {
  stored: { toolCalls: 12, approvals: 2, appViews: 0, runs: 3, runsInProgress: 1 },
  deletion: null,
};

let container: HTMLDivElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

async function flush() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("stored content deletion", () => {
  it("describes how much will be deleted in plain words", () => {
    expect(storedContentSummary(stored, "Google Workspace")).toBe(
      "Paperclip will delete what it saved from 12 tool calls, 2 approval requests and the full transcripts of 3 runs that used Google Workspace or received its results.",
    );
    expect(storedContentSummary({ ...stored, stored: { toolCalls: 0, approvals: 0, appViews: 1, runs: 0, runsInProgress: 0 } }, "Docs"))
      .toBe("Paperclip will delete what it saved from 1 app view that used Docs.");
    expect(storedContentSummary({ ...stored, stored: { toolCalls: 0, approvals: 0, appViews: 0, runs: 0, runsInProgress: 0 } }, "Docs"))
      .toBe("Paperclip found no saved data from Docs's tool calls. You can still delete to check again.");
    expect(storedContentStatus({ ...stored, deletion: { id: "d", status: "pending", requestedAt: "", completedAt: null, retrying: true, counts } }))
      .toBe("Deleting was interrupted. Paperclip keeps trying until it finishes.");
  });

  it("confirms with counts, warns about running work, and starts the deletion", async () => {
    api.getStoredContent.mockResolvedValue(stored);
    const pendingDeletion = { id: "d", status: "pending" as const, requestedAt: new Date().toISOString(), completedAt: null, retrying: false, counts };
    api.deleteStoredContent.mockResolvedValue({ deletion: pendingDeletion });
    api.getStoredContentDeletion.mockResolvedValue({ deletion: pendingDeletion });
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <StoredContentDeletionDialog connectionId="connection-1" appName="Google Workspace" onClose={() => undefined} />
        </QueryClientProvider>,
      );
    });
    await flush();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Delete data read through Google Workspace?");
    expect(text).toContain("12 tool calls");
    expect(text).toContain("1 run is still working and will be skipped.");
    expect(text).toContain("This cannot be undone.");
    expect(text).not.toContain("connection-1");

    const confirm = Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent === "Delete data");
    await act(async () => { confirm!.click(); });
    await flush();
    expect(api.deleteStoredContent).toHaveBeenCalledWith("connection-1");
    expect(document.body.textContent).toContain("Deleting now. You can close this window.");
    expect(api.getStoredContent).toHaveBeenCalledTimes(1);
    await act(async () => { root.unmount(); });
  });
});
