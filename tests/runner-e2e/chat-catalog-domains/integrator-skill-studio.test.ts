import { describe, expect, it } from "vitest";
import { gradeIntegratorSkillStudio, studioPageInput, studioNativeRunsComplete } from "./integrator-skill-studio.js";
const record = (value: object) => "Checked the supplied page.\n\n```json\n" + JSON.stringify(value) + "\n```\n";
const missingLabel = { check: "Every input has a visible associated label", element: '<input type="email" id="trial-email">' };
function setOutput(o: ReturnType<typeof valid>, output: string) { const run = o.studioRuns[0]!; run.outputBody = output; run.outputSnapshot = output; run.documents[0]!.body = output; }
function valid() {
  const skill = { id: "skill", companyId: "company", currentVersionId: "revision", markdown: "Inspect visible form labels", editable: true };
  const output = record({ passed: 3, failed: 1, failures: [missingLabel] });
  const run = { id: "test", companyId: "company", skillId: "skill", agentId: "morgan", skillVersionId: "revision", skillVersion: { id: "revision", companyId: "company", companySkillId: "skill", authorAgentId: null as string | null, authorUserId: "person", fileInventory: [{ path: "SKILL.md", kind: "markdown" }] },
    inputId: "input", inputSnapshot: studioPageInput, status: "succeeded", issueId: "harness", harnessIssue: { id: "harness", identifier: "COM-2", status: "done" }, harnessContent: { available: true },
    outputBody: output, outputSnapshot: output, outputDocumentKey: "output", documents: [{ key: "output", body: output }], interactions: [] };
  return { scenarioId: "skills.studio-test", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { skill: structuredClone(skill), input: { id: "input" }, worker: { id: "morgan" } },
    tasks: [], projects: [], goals: [], comments: [], documents: [], revisions: [], humanQueries: [], activity: [], links: [],
    runs: [
      { id: "initial", companyId: "company", agentId: "ceo", runtimeMode: "native", status: "succeeded", startedAt: "2026-11-03T00:00:00Z", contextSnapshot: { issueId: "source", commentId: "human" } as Record<string, unknown> },
      { id: "native", companyId: "company", agentId: "morgan", runtimeMode: "native", status: "succeeded", startedAt: "2026-11-03T00:01:00Z", contextSnapshot: { issueId: "harness" } as Record<string, unknown> },
      { id: "completion", companyId: "company", agentId: "ceo", runtimeMode: "native", status: "succeeded", startedAt: "2026-11-03T00:03:00Z", contextSnapshot: { issueId: "source", wakeReason: "chat_task_completed", wakeSource: "automation", chatCompletionDeliveryIds: ["delivery"], chatCompletionUpdates: [{ id: "harness", status: "done", completedAt: "2026-11-03T00:02:00Z" }] } as Record<string, unknown> },
    ], skill, studioRuns: [run], pinnedVersions: { test: { id: "revision", companyId: "company", companySkillId: "skill", authorAgentId: null as string | null, authorUserId: "person", fileInventory: [{ path: "SKILL.md", content: skill.markdown }] } }, sourceIssueId: "source",
    sourceComments: [{ id: "human", authorUserId: "person", body: "Test this skill on our sample landing page.", authorAgentId: null as string | null, createdByRunId: undefined as string | undefined, createdAt: "2026-11-03T00:00:00Z" },
      { id: "completed-reply", authorUserId: undefined, authorAgentId: "ceo", createdByRunId: "completion", createdAt: "2026-11-03T00:04:00Z", body: "The test finished: [COM-2](/COM/issues/COM-2#document-output) has the saved result." }],
    reply: "Started one Studio test on the saved sample and selected accessibility revision. You can inspect the result there; this does not qualify other pages." };
}
describe("one real inspectable Studio test", () => {
  it("accepts genuine sample failure findings under a successful execution", () => {
    expect(gradeIntegratorSkillStudio(valid()).passed).toBe(true);
    expect(gradeIntegratorSkillStudio(undefined).passed).toBe(false);
    const o = valid(); o.studioRuns[0]!.outputBody = "";
    expect(gradeIntegratorSkillStudio(o).passed).toBe(false);
  });
  it("rejects substituted input/revision, duplicate tests, wrong native attribution and unrelated work", () => {
    const wrongInput = valid(); wrongInput.studioRuns[0]!.inputSnapshot = "Another page";
    expect(gradeIntegratorSkillStudio(wrongInput).passed).toBe(false);
    const wrongVersion = valid(); wrongVersion.studioRuns[0]!.skillVersionId = "newer";
    expect(gradeIntegratorSkillStudio(wrongVersion).passed).toBe(false);
    const duplicate = valid(); duplicate.studioRuns.push({ ...duplicate.studioRuns[0]!, id: "extra" });
    expect(gradeIntegratorSkillStudio(duplicate).passed).toBe(false);
    const other = valid(); other.runs[0]!.contextSnapshot.issueId = "other";
    expect(gradeIntegratorSkillStudio(other).passed).toBe(false);
    expect(gradeIntegratorSkillStudio({ ...valid(), tasks: [{ id: "unrelated" }] }).passed).toBe(false);
  });
  it("grades the requested result record and result link, not the review wording", () => {
    const check = (o: ReturnType<typeof valid>, id: string) => gradeIntegratorSkillStudio(o).checks.find(row => row.id === id)?.passed;
    const reworded = valid(); setOutput(reworded, "# Any heading at all\n" + record({ passed: 0, failed: 1, failures: [{ ...missingLabel, check: "Form control naming" }] }));
    expect(gradeIntegratorSkillStudio(reworded).passed).toBe(true);
    const clean = valid(); setOutput(clean, record({ passed: 4, failed: 0, failures: [] }));
    expect(check(clean, "saved-concrete-sample-failure")).toBe(false);
    const wrongElement = valid(); setOutput(wrongElement, record({ passed: 3, failed: 1, failures: [{ check: "labels", element: '<button type="submit">Join trial</button>' }] }));
    expect(check(wrongElement, "saved-concrete-sample-failure")).toBe(false);
    const invented = valid(); setOutput(invented, record({ passed: 2, failed: 2, failures: [missingLabel, { check: "alt", element: '<img src="hero.png">' }] }));
    expect(check(invented, "saved-concrete-sample-failure")).toBe(false);
    const miscounted = valid(); setOutput(miscounted, record({ passed: 3, failed: 2, failures: [missingLabel] }));
    expect(check(miscounted, "saved-concrete-sample-failure")).toBe(false);
    const prose = valid(); setOutput(prose, "The email input trial-email has no visible associated label.");
    expect(check(prose, "saved-concrete-sample-failure")).toBe(false);
    const unlinked = valid(); unlinked.sourceComments[1]!.body = "The test finished; COM-2 has the saved result.";
    expect(check(unlinked, "reply-links-saved-result")).toBe(false);
    const foreign = valid(); foreign.sourceComments[1]!.body = "See [COM-3](/COM/issues/COM-3).";
    expect(check(foreign, "reply-links-saved-result")).toBe(false);
    const studio = valid(); studio.sourceComments[1]!.body = "Open the [Studio run](/COM/skills/studio/skill?run=test).";
    expect(check(studio, "reply-links-saved-result")).toBe(true);
    const absolute = valid(); absolute.sourceComments[1]!.body = "Saved in [COM-2](https://fixture.test/COM/issues/COM-2).";
    expect(check(absolute, "reply-links-saved-result")).toBe(true);
    const elsewhere = valid(); elsewhere.sourceComments[1]!.body = "Saved in [COM-2](https://elsewhere.test/COM/issues/COM-2).";
    expect(check(elsewhere, "reply-links-saved-result")).toBe(false);
    const failed = valid(); failed.studioRuns[0]!.status = "failed";
    expect(gradeIntegratorSkillStudio(failed).passed).toBe(false);
  });
});

describe("source-bound Studio native accounting", () => {
  it("accepts exactly one completed source notification and retains all three real native runs", () => {
    const o = valid(); expect(studioNativeRunsComplete(o)).toBe(true); expect(o.runs).toHaveLength(3);
    expect(o.studioRuns).toHaveLength(1);
  });
  it("rejects two runs without actual completed source delivery, including invented initial-turn coalescing", () => {
    const o = valid(); const completion = o.runs.pop()!;
    expect(studioNativeRunsComplete(o)).toBe(false); expect(gradeIntegratorSkillStudio(o).passed).toBe(false);
    Object.assign(o.runs[0]!.contextSnapshot, { chatCompletionDeliveryIds: completion.contextSnapshot.chatCompletionDeliveryIds, chatCompletionUpdates: completion.contextSnapshot.chatCompletionUpdates });
    o.sourceComments[1]!.createdByRunId = "initial";
    expect(studioNativeRunsComplete(o)).toBe(false); expect(gradeIntegratorSkillStudio(o).passed).toBe(false);
  });
  it.each(["wrong company", "wrong source", "wrong worker", "extra worker", "missing delivery", "ambiguous delivery", "wrong task", "unfinished task", "wrong wake", "missing response", "early response", "ambiguous response", "cancelled", "unfinished", "wrong human", "before task", "missing detail", "wrong version detail", "foreign version detail", "wrong version author", "wrong summary company"])("rejects %s without hiding extra or incomplete work", fault => {
    const o = valid(), completion = o.runs[2]!, context = completion.contextSnapshot;
    if (fault === "wrong company") completion.companyId = "foreign";
    if (fault === "wrong source") context.issueId = "foreign";
    if (fault === "wrong worker") o.runs[1]!.agentId = "foreign";
    if (fault === "extra worker") o.runs.push({ ...o.runs[1]!, id: "extra" });
    if (fault === "missing delivery") delete context.chatCompletionDeliveryIds;
    if (fault === "ambiguous delivery") context.chatCompletionDeliveryIds = ["delivery", "other"];
    if (fault === "wrong task") context.chatCompletionUpdates = [{ id: "other", status: "done", completedAt: "2026-11-03T00:02:00Z" }];
    if (fault === "unfinished task") o.studioRuns[0]!.harnessIssue.status = "in_progress";
    if (fault === "wrong wake") context.wakeReason = "unrelated_automation";
    if (fault === "missing response") o.sourceComments.pop();
    if (fault === "early response") o.sourceComments[1]!.createdAt = "2026-11-03T00:01:00Z";
    if (fault === "ambiguous response") o.sourceComments.push({ ...o.sourceComments[1]!, id: "duplicate-reply" });
    if (fault === "cancelled") completion.status = "cancelled";
    if (fault === "unfinished") completion.status = "running";
    if (fault === "wrong human") o.runs[0]!.contextSnapshot.commentId = "other-human";
    if (fault === "before task") completion.startedAt = "2026-11-03T00:01:00Z";
    if (fault === "missing detail") delete (o.pinnedVersions as Record<string, unknown>).test;
    if (fault === "wrong version detail") o.pinnedVersions.test.id = "different-version";
    if (fault === "foreign version detail") o.pinnedVersions.test.companyId = "foreign";
    if (fault === "wrong version author") o.pinnedVersions.test.authorUserId = "foreign";
    if (fault === "wrong summary company") o.studioRuns[0]!.skillVersion.companyId = "foreign";
    expect(gradeIntegratorSkillStudio(o).passed).toBe(false);
  });
});
