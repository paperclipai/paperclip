// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionBlocker, Issue } from "@paperclipai/shared";
import { WorkspaceFileRecovery } from "./WorkspaceFileRecovery";
const resolve = vi.hoisted(() => vi.fn());
vi.mock("../api/issues", () => ({ issuesApi: { resolveRecoveryAction: resolve } }));
const blocker = { recoveryActionId: "held-source", runId: "original-run", cause: "legacy_execution_requires_reconciliation",
  workspaceRepairRequired: true, canRecordWorkspaceRepair: true, canRetry: false, canContinue: false, nextAction: "Recover the original files." } as ExecutionBlocker;

describe("workspace file recovery", () => {
  let root: Root, container: HTMLDivElement, client: QueryClient;
  const onRecorded = vi.fn();
  beforeEach(() => {
    resolve.mockReset().mockResolvedValue({}); onRecorded.mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  async function mount(overrides: Partial<Parameters<typeof WorkspaceFileRecovery>[0]> = {}) {
    await act(async () => root.render(<QueryClientProvider client={client}><WorkspaceFileRecovery
      issueId="task" issueStatus="in_progress" blocker={blocker} canManage onRecorded={onRecorded} {...overrides} />
    </QueryClientProvider>));
  }
  async function enterEvidence() {
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea,
        "Recovered and verified both repository patches in the linked backup artifact.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function confirm() { await act(async () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click()); }
  async function submit() {
    await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Record file recovery")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  it.each(["in_progress", "in_review", "done", "cancelled"] as Issue["status"][])("records verified source files without changing the %s task", async issueStatus => {
    await mount({ issueStatus });
    const button = Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Record file recovery")!;
    expect(button.disabled).toBe(true); await enterEvidence(); expect(button.disabled).toBe(true);
    await confirm(); expect(button.disabled).toBe(false); await submit();
    expect(resolve).toHaveBeenCalledWith("task", expect.objectContaining({ actionId: "held-source", sourceIssueStatus: issueStatus,
      outcome: "restored", executionReconciliation: expect.objectContaining({ runId: "original-run", providerStopped: true,
        workspaceRepairEvidence: "Recovered and verified both repository patches in the linked backup artifact." }) }));
    expect(onRecorded).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("task status is unchanged");
  });
  it("keeps the hold and entered evidence when the server rejects unverified shutdown", async () => {
    resolve.mockRejectedValueOnce(new Error("The original workspace has not confirmed that it stopped."));
    await mount(); await enterEvidence(); await confirm(); await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("not confirmed");
    expect(container.querySelector("textarea")?.value).toContain("both repository patches");
    expect(onRecorded).not.toHaveBeenCalled();
  });
  it("does not offer attestation without board runtime access", async () => {
    await mount({ canManage: false }); expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("board member with runtime access"); expect(resolve).not.toHaveBeenCalled();
  });
  it.each([
    { workspaceRepairRequired: false }, { canRecordWorkspaceRepair: false }, { cause: "native_workspace_sync_out_retry_exhausted" },
    { recoveryActionId: null }, { runId: null },
  ])("does not expose file-only repair for other or unbound holds: %j", async patch => {
    await mount({ blocker: { ...blocker, ...patch } }); expect(container.textContent).toBe("");
    expect(resolve).not.toHaveBeenCalled();
  });
});
