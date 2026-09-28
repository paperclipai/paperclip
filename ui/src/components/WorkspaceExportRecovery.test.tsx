// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueRecoveryAction } from "@paperclipai/shared";
import { WorkspaceExportRecovery } from "./WorkspaceExportRecovery";
const retry = vi.hoisted(() => vi.fn());
vi.mock("../api/issues", () => ({ issuesApi: { retryWorkspaceExport: retry } }));
const action = { id: "action", cause: "native_workspace_sync_out_unsafe_archive", status: "active", updatedAt: "2026-01-01T00:00:00Z", ownerType: "board", evidence: { runId: "run" }, wakePolicy: null } as unknown as IssueRecoveryAction;
describe("WorkspaceExportRecovery", () => {
  let root: Root, container: HTMLDivElement, client: QueryClient;
  const onQueued = vi.fn();
  beforeEach(() => {
    retry.mockReset().mockResolvedValue({ status: "queued" }); onQueued.mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  async function mount(overrides: Partial<Parameters<typeof WorkspaceExportRecovery>[0]> = {}) {
    await act(async () => root.render(<QueryClientProvider client={client}><WorkspaceExportRecovery issueId="issue" action={action} canManage onQueued={onQueued} {...overrides} /></QueryClientProvider>));
  }
  async function enterNote() {
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Removed the fixture link while preserving all safe files.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function submit() {
    await act(async () => container.querySelector("button")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  it("requires a repair note and submits only the exact recorded run", async () => {
    await mount(); expect(container.querySelector("button")!.disabled).toBe(true);
    await enterNote(); await submit();
    expect(retry).toHaveBeenCalledWith("issue", { actionId: "action", runId: "run", repairNote: "Removed the fixture link while preserving all safe files." });
    expect(onQueued).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("agent will not repeat its work");
  });
  it("offers repair again when a queued export publishes a new permanent failure", async () => {
    await mount(); await enterNote(); await submit();
    expect(container.querySelector("button")).toBeNull();
    await mount({ action: { ...action, updatedAt: "2026-01-01T00:01:00Z", wakePolicy: null } });
    expect(container.querySelector("button")?.textContent).toBe("Retry workspace export");
  });
  it("keeps unavailable-sandbox errors actionable inline", async () => {
    retry.mockRejectedValueOnce(new Error("Resume the retained sandbox before retrying.")); await mount();
    await enterNote(); await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Resume the retained sandbox");
  });
  it("does not offer the action without runtime access", async () => {
    await mount({ canManage: false }); expect(container.querySelector("button")).toBeNull();
  });
  it("offers saved-result export after transient retries are exhausted without claiming an unsafe link", async () => {
    await mount({ action: { ...action, cause: "native_workspace_sync_out_retry_exhausted" } });
    expect(container.querySelector("button")?.textContent).toBe("Retry workspace export");
    expect(container.textContent).toContain("export failure");
    expect(container.textContent).not.toContain("unsafe link");
    await enterNote(); await submit();
    expect(retry).toHaveBeenCalledWith("issue", expect.objectContaining({ runId: "run" }));
  });
  it("does not offer a second retry while the same export is queued", async () => {
    await mount({ action: { ...action, wakePolicy: { kind: "resume_native_run" } } });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Export is queued"); expect(container.querySelector("button")).toBeNull();
  });
});
