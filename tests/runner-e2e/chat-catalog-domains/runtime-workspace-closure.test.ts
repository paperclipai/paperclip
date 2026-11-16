import { it, expect } from "vitest";
import { gradeWorkspaceClosure } from "./runtime-workspace-closure.js";
function valid() {
  const closingWorkspace = { id: "target", companyId: "company", status: "active", sourceIssueId: "website", rootIssueId: "website", repoUrl: null, branchName: null };
  const task = { id: "website", title: "Website task", status: "done", assigneeAgentId: "morgan" };
  const artifact = { contentVerified: true, content: "Actual saved marker", sha256: "bytes", attachmentId: "attachment", workProductId: "product" };
  return { scenarioId: "workspaces.close-and-reopen", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { closingWorkspace, closedWorkspace: { ...closingWorkspace, status: "archived", closedAt: "2026-10-26T12:00:00Z" },
      closeReadyBeforeQuery: true, artifact, retainedArtifact: { ...artifact }, fileBefore: artifact.content, marker: artifact.content,
      task, otherWorkspacesUnchanged: true, otherFileRetained: true },
    agents: [], tasks: [task, { id: "other", status: "done" }], links: [], humanQueries: [], reply: "The workspace is closed. Your saved file remains available as an artifact download.",
    activity: [{ id: "close", action: "execution_workspace.updated", entityId: "target", agentId: "ceo", details: { changedKeys: ["status"] } }],
    runs: ["morgan", "riley", "ceo", "ceo"].map((agentId, index) => ({ id: String(index), agentId, status: "succeeded" })) };
}
it("accepts real closed state with retained artifact retrieval and untouched other work", () => expect(gradeWorkspaceClosure(valid()).passed).toBe(true));
it("accepts natural closed-workspace retrieval guidance", () => { const o = valid(); o.reply = "I archived this workspace. The earlier artifact remains available to download, so you can still retrieve the saved file."; expect(gradeWorkspaceClosure(o).passed).toBe(true); });
it("rejects missing closure evidence", () => expect(gradeWorkspaceClosure(undefined).passed).toBe(false));
it("rejects a friendly acknowledgement while the workspace remains active", () => { const o = valid(); o.state.closedWorkspace.status = "active"; expect(gradeWorkspaceClosure(o).passed).toBe(false); });
it("rejects retaining only an attachment row without verified saved bytes", () => { const o = valid(); o.state.retainedArtifact.contentVerified = false; expect(gradeWorkspaceClosure(o).passed).toBe(false); });
it("rejects closing a different workspace", () => { const o = valid(); o.state.closedWorkspace.id = "other"; expect(gradeWorkspaceClosure(o).passed).toBe(false); });
it("rejects losing source references", () => { const o = valid(); o.state.closedWorkspace.sourceIssueId = "replacement"; expect(gradeWorkspaceClosure(o).passed).toBe(false); });
it("rejects affecting an unrelated workspace", () => { const o = valid(); o.state.otherWorkspacesUnchanged = false; expect(gradeWorkspaceClosure(o).passed).toBe(false); });
it("rejects losing the unrelated existing file", () => { const o = valid(); o.state.otherFileRetained = false; expect(gradeWorkspaceClosure(o).passed).toBe(false); });
