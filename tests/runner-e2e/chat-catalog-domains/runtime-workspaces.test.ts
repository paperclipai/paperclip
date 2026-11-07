import { it, expect } from "vitest";
import { gradeLocateFiles } from "./runtime-workspaces.js";
function valid() {
  const task = { id: "website", title: "Website task", companyId: "company", projectId: null, status: "done", assigneeAgentId: "morgan" };
  const view = { workspace: { id: "bound-workspace", companyId: "company", projectId: null, name: "Website task workspace", cwd: "/owned/task-root" } };
  return { scenarioId: "workspaces.locate-files", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { companyPrefix: "ACORN", task, worker: { id: "morgan" }, workspaceBefore: view, workspaceAfter: structuredClone(view), marker: "saved prerequisite",
      fileBefore: "saved prerequisite", fileAfter: "saved prerequisite", fixtureRunId: "setup" },
    agents: [], tasks: [task], links: ["/ACORN/execution-workspaces/bound-workspace"], reply: "The actual files are in /owned/task-root.",
    activity: [], runs: [{ id: "setup", agentId: "morgan", status: "succeeded" }], humanQueries: [] };
}
it("accepts the actual bound projectless directory and files", () => expect(gradeLocateFiles(valid()).passed).toBe(true));
it("rejects missing task workspace evidence", () => expect(gradeLocateFiles(undefined).passed).toBe(false));
it("rejects a plausible agent default directory", () => {
  const o = valid(); o.reply = "The files are probably in Morgan's /default/work directory."; expect(gradeLocateFiles(o).passed).toBe(false);
});
it("rejects linking another workspace", () => {
  const o = valid(); o.links = ["/ACORN/execution-workspaces/other-workspace"]; expect(gradeLocateFiles(o).passed).toBe(false);
});
it("rejects fabricated saved-file setup without its actual worker run", () => {
  const o = valid(); o.runs = []; expect(gradeLocateFiles(o).passed).toBe(false);
});

it("accepts the actual directory and supported view directions without a mandatory href", () => {
  const o = valid(); o.links = []; o.reply = "The bound workspace uses /owned/task-root; open the Workspace view to inspect its files.";
  expect(gradeLocateFiles(o).passed).toBe(true);
});

it("rejects a wrong saved workspace href even before its DOM anchor renders", () => {
  const o = valid(); o.links = []; o.reply = "Workspace files are in /owned/task-root. [Open workspace](/ACORN/execution-workspaces/another).";
  expect(gradeLocateFiles(o).passed).toBe(false);
});
it("rejects correct resource IDs routed through another company or an unsupported tab", () => {
  const o = valid(); o.links = ["/BIRCH/execution-workspaces/bound-workspace"]; expect(gradeLocateFiles(o).passed).toBe(false);
  o.links = ["/ACORN/execution-workspaces/bound-workspace/not-a-tab"]; expect(gradeLocateFiles(o).passed).toBe(false);
});
it("accepts the supported same-resource issues tab without demanding a different heading", () => {
  const o = valid(); o.links = ["/ACORN/execution-workspaces/bound-workspace/issues"];
  expect(gradeLocateFiles(o).passed).toBe(true);
});
