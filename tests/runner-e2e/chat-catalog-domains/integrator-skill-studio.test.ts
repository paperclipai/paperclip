import { describe, expect, it } from "vitest";
import { gradeIntegratorSkillStudio, studioPageInput, studioNativeRunsComplete } from "./integrator-skill-studio.js";
function valid() {
  const skill = { id: "skill", companyId: "company", currentVersionId: "revision", markdown: "Inspect visible form labels", editable: true };
  const output = "The email input trial-email has no visible associated label. This accessibility check fails on the sample; add a label linked to its id.";
  const run = { id: "test", companyId: "company", skillId: "skill", agentId: "morgan", skillVersionId: "revision", skillVersion: { id: "revision", companyId: "company", companySkillId: "skill", authorAgentId: null as string | null, authorUserId: "person", fileInventory: [{ path: "SKILL.md", kind: "markdown" }] },
    inputId: "input", inputSnapshot: studioPageInput, status: "succeeded", issueId: "harness", harnessIssue: { id: "harness", status: "done" }, harnessContent: { available: true },
    outputBody: output, outputSnapshot: output, outputDocumentKey: "output", documents: [{ key: "output", body: output }], interactions: [] };
  return { scenarioId: "skills.studio-test", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { skill: structuredClone(skill), input: { id: "input" }, worker: { id: "morgan" } },
    tasks: [], projects: [], goals: [], comments: [], documents: [], revisions: [], humanQueries: [], activity: [], links: [],
    runs: [
      { id: "initial", companyId: "company", agentId: "ceo", runtimeMode: "native", status: "succeeded", startedAt: "2026-11-03T00:00:00Z", contextSnapshot: { issueId: "source", commentId: "human" } as Record<string, unknown> },
      { id: "native", companyId: "company", agentId: "morgan", runtimeMode: "native", status: "succeeded", startedAt: "2026-11-03T00:01:00Z", contextSnapshot: { issueId: "harness" } as Record<string, unknown> },
      { id: "completion", companyId: "company", agentId: "ceo", runtimeMode: "native", status: "succeeded", startedAt: "2026-11-03T00:03:00Z", contextSnapshot: { issueId: "source", wakeReason: "chat_task_completed", wakeSource: "automation", chatCompletionDeliveryIds: ["delivery"], chatCompletionUpdates: [{ id: "harness", status: "done", completedAt: "2026-11-03T00:02:00Z" }] } as Record<string, unknown> },
    ], skill, studioRuns: [run], pinnedVersions: { test: { id: "revision", companyId: "company", companySkillId: "skill", authorAgentId: null as string | null, authorUserId: "person", fileInventory: [{ path: "SKILL.md", content: skill.markdown }] } }, sourceIssueId: "source",
    sourceComments: [{ id: "human", authorUserId: "person", body: "Test this skill on our sample landing page.", authorAgentId: null as string | null, createdByRunId: undefined as string | undefined, createdAt: "2026-11-03T00:00:00Z" },
      { id: "completed-reply", authorUserId: undefined, authorAgentId: "ceo", createdByRunId: "completion", createdAt: "2026-11-03T00:04:00Z", body: "The Studio result is saved for inspection." }],
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
  it("accepts substantive paraphrase and rejects false sample or universal success", () => {
    const o = valid();
    const paraphrase = "The email field is unlabeled; it fails the visible-label requirement. Associate a visible label with trial-email.";
    o.studioRuns[0]!.outputBody = paraphrase; o.studioRuns[0]!.outputSnapshot = paraphrase; o.studioRuns[0]!.documents[0]!.body = paraphrase;
    expect(gradeIntegratorSkillStudio(o).passed).toBe(true);
    const falsePage = valid(); const wrong = "The email input trial-email has a visible label; no accessibility failures.";
    falsePage.studioRuns[0]!.outputBody = wrong; falsePage.studioRuns[0]!.outputSnapshot = wrong; falsePage.studioRuns[0]!.documents[0]!.body = wrong;
    expect(gradeIntegratorSkillStudio(falsePage).passed).toBe(false);
    expect(gradeIntegratorSkillStudio({ ...o, reply: "Every production agent is qualified and all pages are verified." }).passed).toBe(false);
    const failed = valid(); failed.studioRuns[0]!.status = "failed";
    expect(gradeIntegratorSkillStudio({ ...failed, reply: "The test passed." }).passed).toBe(false);
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
