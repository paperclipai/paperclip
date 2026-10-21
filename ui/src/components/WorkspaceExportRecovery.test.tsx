// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IssueRecoveryAction } from "@paperclipai/shared";
import { WorkspaceExportRecovery } from "./WorkspaceExportRecovery";
const action = { cause: "native_workspace_finalization_owner_unverified", status: "escalated", ownerType: "board", evidence: { runId: "run", owner: { token: "owner", hostname: "secret-host", pid: 2 } }, wakePolicy: null } as unknown as IssueRecoveryAction;
describe("WorkspaceExportRecovery", () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  async function mount(value: IssueRecoveryAction | null) {
    await act(async () => root.render(<WorkspaceExportRecovery action={value} />));
    expect(container.querySelector("textarea, button, details, input")).toBeNull();
    expect(container.textContent).not.toContain("secret-host");
  }
  it("shows a quiet status while the harness restores work", async () => {
    await mount({ ...action, evidence: { ...action.evidence, workspaceOwnerRecovery: { state: "resuming" } } });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Restoring saved work…");
  });
  it("does not mistake platform identity for confirmed recovery", async () => {
    await mount({ ...action, evidence: { ...action.evidence, owner: { ...(action.evidence.owner as object), worker: { provider: "railway", deploymentId: "old" } } } });
    expect(container.textContent).toContain("operator assistance");
  });
  it("states that an operator is needed for legacy receipts", async () => {
    await mount(action);
    expect(container.textContent).toContain("Workspace recovery needs operator assistance");
  });
  it("keeps export repair out of the task", async () => {
    const cause = "native_workspace_sync_out_retry_exhausted";
    await mount({ ...action, cause });
    expect(container.textContent).toContain("operator assistance");
  });
  it("removes the status when recovery resolves, including updates in place", async () => {
    await mount({ ...action, evidence: { ...action.evidence, workspaceOwnerStop: {} } });
    expect(container.textContent).toBe("Restoring saved work…");
    await mount({ ...action, status: "resolved" }); expect(container.textContent).toBe("");
    await mount(null); expect(container.textContent).toBe("");
  });
  it("does not show unrelated or historical unsafe-export notices", async () => {
    await mount({ ...action, cause: "no_live_path", evidence: {} }); expect(container.textContent).toBe("");
    await mount({ ...action, cause: "native_workspace_sync_out_unsafe_archive" }); expect(container.textContent).toBe("");
  });
});
