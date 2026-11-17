// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceReconstructionRecovery } from "./WorkspaceReconstructionRecovery";
import { queryKeys } from "../lib/queryKeys";
const api = vi.hoisted(() => ({ listAttachments: vi.fn(), reconstructWorkspace: vi.fn() }));
vi.mock("../api/issues", () => ({ issuesApi: api }));

describe("rebuild a destroyed workspace from partial sources", () => {
  let root: Root, container: HTMLDivElement, client: QueryClient;
  const onRecorded = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    api.listAttachments.mockResolvedValue([{ id: "source", originalFilename: "baseline.ts", byteSize: 100 }]);
    api.reconstructWorkspace.mockResolvedValue({ status: "queued" });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  async function mount(canManage = true) {
    await act(async () => root.render(<QueryClientProvider client={client}><WorkspaceReconstructionRecovery issueId="task" canManage={canManage}
      blocker={{ recoveryActionId: "recovery", runId: "lost-run", agentId: "agent", cause: "native_workspace_sync_out_unrecoverable", nextAction: "", workspaceRecoveryStatusVersion: 3 }} onRecorded={onRecorded} />
    </QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  async function fill() {
    await act(async () => {
      for (const area of container.querySelectorAll("textarea")) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "Verified source and receipts show what must be rebuilt without repeating published work.");
        area.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const checkboxes = container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]');
      checkboxes[0].click(); checkboxes[1].click();
    });
  }
  it("requires surviving sources, lost-work acknowledgement and outcome evidence without claiming original-file recovery", async () => {
    await mount();
    const button = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Rebuild and continue")!;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain("missing edits have not been recovered");
    expect(container.textContent).toContain("Existing work limits still apply");
    await fill(); expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(api.reconstructWorkspace).toHaveBeenCalledWith("task", expect.objectContaining({ runId: "lost-run", expectedStatusVersion: 3, attachmentIds: ["source"], acknowledgeLostWork: true, actionOutcome: "mixed" }));
    expect(onRecorded).toHaveBeenCalledOnce();
  });
  it("preserves the reconstruction decision when current source checks reject it", async () => {
    api.reconstructWorkspace.mockRejectedValue(new Error("The source owner changed."));
    await mount(); await fill();
    await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Rebuild and continue")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("source owner changed");
    expect(container.querySelector("textarea")?.value).toContain("Verified source");
    expect(onRecorded).not.toHaveBeenCalled();
  });
  it("offers no reconstruction form to a reader without runtime management authority", async () => {
    await mount(false); expect(container.querySelector("button")).toBeNull();
    expect(api.listAttachments).not.toHaveBeenCalled(); expect(api.reconstructWorkspace).not.toHaveBeenCalled();
  });
  it("refreshes uploaded sources with the task attachment cache and drops deleted selections", async () => {
    await mount(); await fill();
    await act(async () => client.setQueryData(queryKeys.issues.attachments("task"), [
      { id: "new-source", originalFilename: "uploaded-source.ts", byteSize: 200 },
    ]));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.textContent).toContain("uploaded-source.ts");
    expect(container.textContent).not.toContain("baseline.ts");
    const button = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Rebuild and continue")!;
    expect(button.disabled).toBe(true);
    expect(api.reconstructWorkspace).not.toHaveBeenCalled();
  });
});
