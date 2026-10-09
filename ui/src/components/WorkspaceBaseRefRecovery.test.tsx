// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Issue, IssueCommentMetadata } from "@paperclipai/shared";
import { WorkspaceBaseRefRecoveryProvider, useWorkspaceBaseRefRecovery } from "./WorkspaceBaseRefRecovery";
import { WorkspaceBaseRefRecoveryNotice } from "./WorkspaceBaseRefRecoveryNotice";

const mocks = vi.hoisted(() => ({ get: vi.fn(), resolve: vi.fn() }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { get: mocks.get } }));
vi.mock("../api/issues", () => ({ issuesApi: { resolveRecoveryAction: mocks.resolve } }));
const issue = { id: "issue", companyId: "company", status: "blocked", assigneeAgentId: "agent",
  executionWorkspaceSettings: { workspaceStrategy: { baseRef: "main" } },
  activeRecoveryAction: { id: "action", status: "active", cause: "configuration_incomplete", returnOwnerAgentId: "agent", evidence: { latestRunId: "run" } },
} as unknown as Issue;
const metadata: IssueCommentMetadata = { version: 1, sourceRunId: "run", sections: [{ rows: [{ type: "key_value", label: "Recovery action", value: "action" }] }] };
function Consumer({ data = metadata }: { data?: IssueCommentMetadata }) {
  const value = useWorkspaceBaseRefRecovery(data);
  return value ? <WorkspaceBaseRefRecoveryNotice {...value.props} /> : <p>No repair</p>;
}
let container: HTMLDivElement, root: Root, client: QueryClient;
beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.resolve.mockReset();
  mocks.get.mockResolvedValue({ companyId: "company", agentId: "agent", contextSnapshot: { issueId: "issue" },
    resultJson: { configurationIncomplete: { reason: "workspace_base_ref_unresolved", requestedRef: "main", defaultBranch: "master" } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
async function render(data = metadata, unavailableReason: string | null = null) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><WorkspaceBaseRefRecoveryProvider issue={issue}
      agentMap={new Map([["agent", { name: "Worker", status: "idle" }]])} unavailableReason={unavailableReason} onRepaired={() => {}}>
      <Consumer data={data} /></WorkspaceBaseRefRecoveryProvider></QueryClientProvider>);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
it("binds the repair to the exact notice and sends an atomic recovery request", async () => {
  mocks.resolve.mockResolvedValue({ issue: { ...issue, status: "todo", executionWorkspaceSettings: { workspaceStrategy: { baseRef: "master" } } } });
  await render();
  const button = [...container.querySelectorAll("button")].find(b => b.textContent === "Use master & retry")!;
  await act(async () => button.click());
  expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith("issue", { actionId: "action", outcome: "restored", sourceIssueStatus: "todo", workspaceBaseRef: { requestedRef: "main", branch: "master" } });
  expect(container.textContent).toContain("Branch updated · retry requested");
});
it("does not turn an unrelated notice into a repair", async () => {
  await render({ ...metadata, sourceRunId: "older-run" });
  expect(container.textContent).toBe("No repair");
});
it("does not report success from an incomplete receipt", async () => {
  mocks.resolve.mockResolvedValue({ issue });
  await render();
  await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Use master & retry")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("The task changed while saving");
  expect(container.textContent).not.toContain("Branch updated · retry requested");
});
