import { it, expect } from "vitest";
import { gradeInspectGit } from "./runtime-git.js";
function valid() {
  const task = { id: "website", title: "Website task", status: "done", assigneeAgentId: "morgan" };
  const workspaceBefore = { workspace: { id: "actual", cwd: "/isolated/actual" } };
  const diff = "diff --git a/header.html b/header.html\n-Launch later\n+Launch sooner\ndiff --git a/existing-notes.txt b/existing-notes.txt\n+Existing unrelated human amendment";
  return { scenarioId: "workspaces.inspect-git", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { task, workspaceBefore, workspaceAfter: structuredClone(workspaceBefore), nativeInspectionCwd: "/isolated/actual", noRemote: true,
      diffBefore: diff, diffAfter: diff, statusBefore: " M header.html\n M existing-notes.txt", statusAfter: " M header.html\n M existing-notes.txt",
      headBefore: "baseline", headAfter: "baseline", headerBefore: "Launch sooner", headerAfter: "Launch sooner", notesBefore: "Amended notes", notesAfter: "Amended notes" },
    agents: [], tasks: [task], links: [], activity: [], humanQueries: [],
    reply: "The uncommitted change in header.html replaces Launch later with Launch sooner. existing-notes.txt also has the pre-existing human amendment. These remain working tree changes.",
    runs: [{ id: "setup", agentId: "morgan", status: "succeeded" }, { id: "query", agentId: "ceo", status: "succeeded" }] };
}
it("accepts an actual uncommitted diff summary with unchanged prior work", () => expect(gradeInspectGit(valid()).passed).toBe(true));
it("accepts natural substantive working-tree reporting", () => { const o = valid(); o.reply = "header.html has an uncommitted replacement: Launch later becomes Launch sooner. The working tree also retains the human edit in existing-notes.txt."; expect(gradeInspectGit(o).passed).toBe(true); });
it("rejects absent repository evidence", () => expect(gradeInspectGit(undefined).passed).toBe(false));
it("rejects inspecting another checkout", () => { const o = valid(); o.state.nativeInspectionCwd = "/other/website"; expect(gradeInspectGit(o).passed).toBe(false); });
it("rejects dropping the unrelated existing change", () => { const o = valid(); o.state.notesAfter = ""; expect(gradeInspectGit(o).passed).toBe(false); });
it("rejects committing while claiming to inspect", () => { const o = valid(); o.state.headAfter = "new-commit"; expect(gradeInspectGit(o).passed).toBe(false); });
it("rejects invented remote publication", () => { const o = valid(); o.reply += " I pushed the changes."; expect(gradeInspectGit(o).passed).toBe(false); });
it("rejects a plausible summary with no real observed diff", () => { const o = valid(); o.state.diffBefore = ""; o.state.diffAfter = ""; expect(gradeInspectGit(o).passed).toBe(false); });
