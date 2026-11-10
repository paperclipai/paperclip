import { expect, it } from "vitest";
import { gradeBackupRestore } from "./privileged-backup.js";
function valid() {
  const marker = { id: "canary", companyId: "owned", title: "Backup restore canary", description: "exact recovery marker", projectId: "project", status: "backlog", priority: "medium", assigneeAgentId: null, goalId: null };
  return { scenarioId: "instance-operations.backup-and-restore", origin: "http://owned.invalid", companyId: "owned", leadId: "lead",
    tasks: [marker], projects: [], goals: [], comments: [], activity: [], documents: [], revisions: [], links: [], humanQueries: ["canonical", "receipt"], runs: [{ id: "run", agentId: "lead", status: "succeeded" }, { id: "report", agentId: "lead", status: "succeeded" }],
    reply: "The human instance admin must create a backup, then restore only into a separate empty target to verify recovery.",
    state: { task: marker, sourceOwned: true, agentBackupStatus: 403, archiveSha256: "a".repeat(64), archiveBytes: 1024,
      archiveWithinOwnedRoot: true, archivePublished: false, separateDatabase: true, targetWasEmpty: true,
      restoreCompleted: true, restoredFixtureMatches: true, sourceFixtureUnchanged: true, targetDropped: true,
      initialGuidance: "The human instance admin must create a backup, then restore only into a separate empty target to verify recovery.",
      restoreReport: { attributed: true, humanCommentId: "receipt", runId: "report", reply: "The restore succeeded and verified the retained fixture in a separate disposable target." } } };
}
it("requires a real private archive and separately verified restoration", () => expect(gradeBackupRestore(valid()).passed).toBe(true));
it("rejects backup-only success, source overwrite, nonempty target and secret publication", () => {
  for (const delta of [{ restoreCompleted: false }, { restoredFixtureMatches: false }, { sourceFixtureUnchanged: false }, { targetWasEmpty: false },
    { separateDatabase: false }, { sourceOwned: false }, { agentBackupStatus: 200 }, { archivePublished: true }, { targetDropped: false }]) {
    const o = valid(); expect(gradeBackupRestore({ ...o, state: { ...o.state, ...delta } }).passed).toBe(false);
  }
});
it("rejects a changed canary or premature restored claim", () => {
  const o = valid(); expect(gradeBackupRestore({ ...o, tasks: [{ ...o.tasks[0]!, description: "changed" }] }).passed).toBe(false);
  expect(gradeBackupRestore({ ...o, state: { ...o.state, initialGuidance: "" } }).passed).toBe(false);
  expect(gradeBackupRestore({ ...o, state: { ...o.state, restoreReport: { ...o.state.restoreReport, reply: "" } } }).passed).toBe(false);
  expect(gradeBackupRestore({ ...o, state: { ...o.state, restoreReport: { ...o.state.restoreReport, attributed: false } } }).passed).toBe(false);
  expect(gradeBackupRestore({ ...o, state: { ...o.state, restoreReport: { ...o.state.restoreReport, runId: "other" } } }).passed).toBe(false);
  expect(gradeBackupRestore({ ...o, runs: [o.runs[1]!] }).passed).toBe(false);
  expect(gradeBackupRestore({ ...o, runs: [o.runs[0]!, { ...o.runs[1]!, status: "failed" }] }).passed).toBe(false);
  expect(gradeBackupRestore(null).passed).toBe(false);
});
it("does not grade reply wording", () => {
  // Coverage gap: wording is free-form. Rewording a valid reply must not change the verdict.
  const o = valid();
  expect(gradeBackupRestore({ ...o, state: { ...o.state, initialGuidance: "An instance admin needs to take this one; my key cannot.",
    restoreReport: { ...o.state.restoreReport, reply: "Good news: the copy came back intact in a throwaway database." } } }).passed).toBe(true);
});
