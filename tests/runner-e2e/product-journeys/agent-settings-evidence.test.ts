import { describe, expect, it } from "vitest";
import { AGENT_SETTINGS_CHECKS, gradeAgentSettings, settingsProofHeading, settingsTaskPrompt, settingsResultMatches } from "./agent-settings-evidence.js";
import { settingsEvidenceFixture } from "./agent-settings-test-fixture.js";
import { agentJourneyRunCountValid, journeyRequiredChecks } from "./success-contract.js";
import { parseTargetConfig } from "./catalog.js";

describe("saved agent settings independent evidence", () => {
  it.each([["ask-question", "agent-settings-persistence"], ["agent-settings-persistence", "ask-question"]])(
    "rejects a shared paid campaign before target acquisition: %j", (...journeys) => {
      expect(() => parseTargetConfig({ version: 1, id: "settings-target", mode: "managed-self-hosted", journeys,
        executionEnvironment: "local", baseline: { features: {}, connections: [] },
        limits: { durationMs: 30000, modelBudgetCents: 500, maxRuns: 2 } })).toThrow("agent_settings_requires_dedicated_campaign");
    });
  it("permits browser-only journeys with the dedicated settings campaign", () => {
    expect(parseTargetConfig({ version: 1, id: "settings-target", mode: "managed-self-hosted",
      journeys: ["task-create", "agent-settings-persistence"], executionEnvironment: "local",
      baseline: { features: {}, connections: [] }, limits: { durationMs: 30000, modelBudgetCents: 500, maxRuns: 1 } }).journeys)
      .toEqual(["task-create", "agent-settings-persistence"]);
  });
  it("requires every independent check and exactly one work run in retained results", () => {
    expect(journeyRequiredChecks["agent-settings-persistence"]).toEqual(AGENT_SETTINGS_CHECKS);
    expect(agentJourneyRunCountValid("agent-settings-persistence", 1)).toBe(true);
    for (const count of [undefined, 0, 2, -1, 1.5, "1"]) {
      expect(agentJourneyRunCountValid("agent-settings-persistence", count)).toBe(false);
    }
  });
  it("accepts the actual content-token contract, board save audits and one bound result", () => {
    const f = settingsEvidenceFixture();
    expect(gradeAgentSettings(f.scope, f.evidence)).toEqual(AGENT_SETTINGS_CHECKS.map(id => ({ id, passed: true })));
    expect(f.evidence.restored!.file.revision.id).toBe(f.evidence.original!.file.revision.id);
    expect(settingsTaskPrompt).not.toContain(f.scope.reference);
  });
  it.each([null, {}, { result: "bounded output" }])("accepts committed current-run evidence when resultJson is %j", resultJson => {
    const f = settingsEvidenceFixture();
    Object.assign(f.run, { resultJson });
    expect(gradeAgentSettings(f.scope, f.evidence).every(row => row.passed)).toBe(true);
  });
  it("accepts committed current-run evidence when resultJson is omitted", () => {
    const f = settingsEvidenceFixture();
    delete (f.run as Record<string, unknown>).resultJson;
    expect(gradeAgentSettings(f.scope, f.evidence).every(row => row.passed)).toBe(true);
  });
  it("rejects an internally consistent baseline containing a previous QA proof block", () => {
    const f = settingsEvidenceFixture(undefined, `# Agent\n${settingsProofHeading}\nStale previous reference\n`);
    expect(gradeAgentSettings(f.scope, f.evidence).every(row => row.passed)).toBe(false);
  });
  const changes: Array<[string, (f: ReturnType<typeof settingsEvidenceFixture>) => void]> = [
    ["foreign company", f => { f.evidence.original!.agent.companyId = "foreign"; }],
    ["missing campaign-bearing target name", f => { f.scope.agentName = "Agent without campaign name"; f.evidence.original!.agent.name = f.scope.agentName; }],
    ["past work", f => { f.evidence.original!.runs.push(f.run); }],
    ["wrong instruction entry", f => { f.evidence.saved!.bundle.entryFile = "OTHER.md"; }],
    ["false content hash", f => { f.evidence.saved!.file.contentHash = "0".repeat(64); }],
    ["wrong saved bytes", f => { f.evidence.saved!.file.content += "wrong"; }],
    ["missing save audit", f => { f.evidence.saved!.activity = []; }],
    ["unscoped activity response", f => { f.evidence.original!.activity.push({ ...f.firstSave, entityId: "foreign-agent" }); }],
    ["full owned activity page", f => { f.evidence.original!.activity = Array.from({ length: 200 }, (_, index) => ({ ...f.firstSave, id: `old-${index}` })); }],
    ["foreign board actor", f => { f.firstSave.actorId = "someone-else"; }],
    ["foreign audit entity", f => { f.firstSave.entityId = "other-agent"; }],
    ["duplicate save evidence", f => { f.evidence.saved!.activity.push({ ...f.firstSave, id: "duplicate" }); }],
    ["rendered draft only", f => { f.evidence.reloaded!.file.content = f.original; }],
    ["missing rendered content", f => { delete f.evidence.reloaded!.renderedContent; }],
    ["prompt leaks reference", f => { f.evidence.task!.issue.description += f.scope.reference; }],
    ["foreign task", f => { f.evidence.task!.issue.companyId = "other"; }],
    ["wrong assignee", f => { f.evidence.task!.issue.assigneeAgentId = "other"; }],
    ["incomplete task", f => { f.evidence.task!.issue.status = "in_progress"; }],
    ["active checkout", f => { f.evidence.task!.issue.executionRunId = "active"; }],
    ["recovery pending", f => { f.evidence.task!.issue.activeRecoveryAction = {}; }],
    ["question pending", f => { f.evidence.task!.interactions = [{ status: "pending" }]; }],
    ["extra run", f => { f.evidence.task!.runs.push({ ...f.run, id: "extra" }); }],
    ["failed run", f => { f.run.status = "failed"; }],
    ["uncommitted run", f => { f.run.nativePhase = "applied"; }],
    ["missing committed phase", f => { delete (f.run as Record<string, unknown>).nativePhase; }],
    ["uncommitted run with omitted result", f => { f.run.nativePhase = "applied"; Object.assign(f.run, { resultJson: null }); }],
    ["legacy run", f => { f.run.runtimeMode = "legacy"; }],
    ["conflicting issue bindings", f => { Object.assign(f.run, { issueId: "foreign" }); }],
    ["wrong provider", f => { f.run.runnerProfileJson.nativeExecutionInput.provider.kind = "other"; }],
    ["wrong model", f => { f.run.runnerProfileJson.nativeExecutionInput.provider.model = "other"; }],
    ["wrong environment", f => { f.run.contextSnapshot.paperclipEnvironment.id = "other"; }],
    ["wrong nonce", f => { f.evidence.task!.document.body = JSON.stringify({ reference: "wrong", settingsSaved: true }); }],
    ["human-authored output", f => { f.evidence.task!.document.createdByUserId = "user"; }],
    ["foreign revision", f => { f.evidence.task!.revision.createdByRunId = "other"; }],
    ["task changes instructions", f => { f.evidence.afterWork!.file.content = "changed"; }],
    ["wrong reopened revision", f => { f.evidence.task!.reopenedDocument!.latestRevisionId = "old"; }],
    ["missing rendered result", f => { delete f.evidence.task!.renderedReference; }],
    ["unrestored instructions", f => { f.evidence.restored!.file.content = f.saved; }],
    ["missing restore audit", f => { f.evidence.restored!.activity = [f.firstSave]; }],
    ["extra work during restore", f => { f.evidence.restored!.runs.push({ ...f.run, id: "later" }); }],
  ];
  it.each(changes)("rejects %s", (_name, change) => {
    const f = settingsEvidenceFixture(); change(f);
    expect(gradeAgentSettings(f.scope, f.evidence).every(row => row.passed)).toBe(false);
  });
  it.each(["original", "saved", "reloaded", "afterWork", "restored", "task"] as const)("rejects missing %s evidence", key => {
    const f = settingsEvidenceFixture(); delete f.evidence[key];
    expect(gradeAgentSettings(f.scope, f.evidence).every(row => row.passed)).toBe(false);
  });
  it("rejects plausible malformed result bodies and accepts one optional JSON fence", () => {
    expect(settingsResultMatches('```json\n{"reference":"r","settingsSaved":true}\n```', "r")).toBe(true);
    for (const body of [null, "", "not json", "[]", '{"reference":"r"}', '{"reference":"r","settingsSaved":"true"}',
      '{"reference":"r","settingsSaved":true,"extra":1}']) expect(settingsResultMatches(body, "r")).toBe(false);
  });
});
