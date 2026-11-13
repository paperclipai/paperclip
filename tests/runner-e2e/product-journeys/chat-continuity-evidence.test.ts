import { describe, expect, it } from "vitest";
import { CHAT_CONTINUITY_CHECKS, chatContinuityIssueId, chatContinuityScenario, gradeChatContinuity,
  } from "./chat-continuity-evidence.js";

import { chatContinuityFixture, compactChatContinuityFixture } from "./chat-continuity.test-fixture.js";
import { parseTargetConfig } from "./catalog.js";
import { journeyRequiredChecks } from "./success-contract.js";

type Row = Record<string, any>;
const allPass = (f: ReturnType<typeof chatContinuityFixture>) => gradeChatContinuity(f.scope, f.points).every(check => check.passed);

describe("chat reload and new-session evidence", () => {
  it("requires the actual three-turn outcome, one reset and run-bound reloaded replies", () => {
    const f = chatContinuityFixture();
    expect(gradeChatContinuity(f.scope, f.points).map(row => row.id)).toEqual(CHAT_CONTINUITY_CHECKS);
    expect(allPass(f)).toBe(true);
  });
  it("accepts normal compact run details only with bound native-final events and the original reset summary", () => {
    expect(allPass(compactChatContinuityFixture())).toBe(true);
  });
  it("rejects an unscoped activity response even below the truncation limit", () => {
    const f = chatContinuityFixture();
    f.points[5]!.activity.push({ id: "foreign-event", companyId: "foreign", agentId: "other-agent", action: "project.created",
      entityType: "project", entityId: "foreign-project", runId: "other-run" });
    expect(allPass(f)).toBe(false);
  });
  it("requires the fresh agent's pre-send empty-history receipt", () => {
    const f = chatContinuityFixture(); delete f.scope.agentHistory;
    expect(allPass(f)).toBe(false);
  });
  it("never supplies the old phrase in the recall or fresh-context request", () => {
    const s = chatContinuityScenario("random-123");
    expect(s.remember).toContain(s.remembered);
    expect(s.recall).not.toContain(s.remembered);
    expect(s.fresh).not.toContain(s.remembered);
    expect(s.reset).toBe("/new");
  });
  it("registers the exact measured checks and counts all four persisted runs", () => {
    expect(journeyRequiredChecks["chat-continuity"]).toEqual(CHAT_CONTINUITY_CHECKS);
    const config = { version: 1, id: "qa-chat", mode: "existing-cloud", adapterModule: "/private/provider.mjs",
      executionEnvironment: "daytona", journeys: ["chat-continuity"], baseline: { features: {}, connections: [] },
      limits: { durationMs: 900_000, maxRuns: 4, modelBudgetCents: 500 } };
    expect(parseTargetConfig(config).limits.maxRuns).toBe(4);
    for (const maxRuns of [0, 3, 5]) expect(() => parseTargetConfig({ ...config, limits: { ...config.limits, maxRuns } })).toThrow("agent_journeys_require_bounded_runs");
  });
  const mutants: ReadonlyArray<readonly [string, (f: ReturnType<typeof chatContinuityFixture>) => void]> = [
    ["missing point", (f: ReturnType<typeof chatContinuityFixture>) => { f.points.pop(); }],
    ["duplicate phase", (f) => { f.points[5]!.phase = "fresh"; }],
    ["foreign chat", (f) => { f.points[1]!.chat.companyId = "foreign"; }],
    ["different user", (f) => { f.points[3]!.chat.conversationUserId = "foreign"; }],
    ["replaced backing issue", (f) => { f.points[5]!.chat.id = "replacement"; }],
    ["active conversation", (f) => { f.points[5]!.chat.conversationState = "running"; }],
    ["scheduled retry", (f) => { f.points[5]!.chat.scheduledRetry = { state: "pending" }; }],
    ["duplicate user send", (f) => { f.points[5]!.comments.push({ ...f.points[5]!.comments[0], id: "duplicate" }); }],
    ["foreign author", (f) => { f.points[5]!.comments[0]!.authorUserId = "foreign"; }],
    ["wrong remembered phrase", (f) => { f.points[2]!.reply!.body = "I do not remember"; }],
    ["unbound first reply", (f) => { f.points[0]!.reply!.anchor = "unbound"; }],
    ["first reply missing after reopen", (f) => { delete f.points[1]!.reply; }],
    ["stale recall response", (f) => { f.points[2]!.reply!.runId = "run-0"; }],
    ["foreign recall run", (f) => { f.points[2]!.runs[1]!.agentId = "foreign"; }],
    ["different provider", (f) => { f.points[2]!.runs[1]!.runnerProfileJson.nativeExecutionInput.provider.kind = "other"; }],
    ["different model", (f) => { f.points[5]!.runs[3]!.runnerProfileJson.nativeExecutionInput.provider.model = "other"; }],
    ["different environment", (f) => { f.points[5]!.runs[3]!.contextSnapshot.paperclipEnvironment.id = "other"; }],
    ["uncommitted native phase", (f) => { f.points[5]!.runs[3]!.nativePhase = "finalizing"; }],
    ["missing session proof", (f) => { delete f.points[0]!.runs[0]!.nativeSessionId; }],
    ["unintended session replacement on reload", (f) => { f.points[2]!.runs[1]!.nativeSessionId = "replacement"; }],
    ["reset generation absent", (f) => { f.points[3]!.chat.conversationSessionGeneration = 0; }],
    ["fresh run generation stale", (f) => { f.points[4]!.runs[3]!.contextSnapshot.conversationSessionGeneration = 0; }],
    ["fresh turn resumes old session", (f) => { f.points[4]!.runs[3]!.nativeSessionId = "original-session"; }],
    ["previous session supplied on fresh admission", (f) => { f.points[4]!.runs[3]!.sessionIdBefore = "original-session"; }],
    ["missing fresh-admission session evidence", (f) => { delete f.points[4]!.runs[3]!.sessionIdBefore; }],
    ["undefined fresh-admission session evidence", (f) => { f.points[4]!.runs[3]!.sessionIdBefore = undefined; }],
    ["empty fresh-admission session evidence", (f) => { f.points[4]!.runs[3]!.sessionIdBefore = ""; }],
    ["old phrase leaked in native context", (f) => { f.points[4]!.runs[3]!.contextSnapshot.paperclipTaskMarkdown += f.scenario.remembered; }],
    ["old phrase returned after reset", (f) => { f.points[4]!.reply!.body = f.scenario.remembered; }],
    ["fresh marker absent", (f) => { f.points[4]!.reply!.body = "I have no phrase"; }],
    ["extra run", (f) => { f.points[5]!.runs.push({ ...f.points[5]!.runs[3], id: "extra" }); }],
    ["duplicate run ID", (f) => { f.points[5]!.runs[3]!.id = "run-0"; }],
    ["missing reset", (f) => { f.points[5]!.runs.splice(2, 1); }],
    ["missing synthetic reset receipt", (f) => { f.points[5]!.resetReceipts.splice(0); }],
    ["foreign reset summary agent", (f) => { f.points[5]!.resetReceipts[0]!.agentId = "foreign"; }],
    ["foreign reset summary company", (f) => { f.points[5]!.resetReceipts[0]!.companyId = "foreign"; }],
    ["foreign reset summary issue", (f) => { f.points[5]!.resetReceipts[0]!.contextIssueId = "foreign"; }],
    ["wrong reset summary run", (f) => { f.points[5]!.resetReceipts[0]!.runId = "run-0"; }],
    ["wrong reset summary wake", (f) => { f.points[5]!.resetReceipts[0]!.wakeCommentId = "user-0"; }],
    ["reset summary not successful", (f) => { f.points[5]!.resetReceipts[0]!.status = "running"; }],
    ["contradictory reset detail", (f) => { f.points[5]!.runs[2]!.resultJson.conversationReset = false; }],
    ["provider work disguised as reset", (f) => { f.points[5]!.runs[2]!.runnerProfileJson = { nativeExecutionInput: { provider: { kind: f.scope.provider, model: f.scope.model } } }; }],
    ["native session attached to synthetic reset", (f) => { f.points[5]!.runs[2]!.nativeSessionId = "unexpected-provider-session"; }],
    ["reset publishes an answer", (f) => { f.points[5]!.comments.push({ id: "reset-answer", authorAgentId: f.scope.agentId, createdByRunId: "run-2", body: "Hi" }); }],
    ["unrequested completion callback", (f) => { f.points[5]!.runs[3]!.contextSnapshot.source = "automation"; }],
    ["wrong wake comment", (f) => { f.points[5]!.runs[3]!.contextSnapshot.wakeCommentId = "user-0"; }],
    ["run has conflicting issue IDs", (f) => { f.points[5]!.runs[3]!.issueId = "foreign"; }],
    ["changed original history", (f) => { f.points[5]!.comments[0]!.body = "changed"; }],
    ["missing original history", (f) => { f.points[5]!.comments.splice(1, 1); }],
    ["reopen repeats the send", (f) => { f.points[5]!.runs.push({ ...f.points[5]!.runs[3], id: "repeated" }); }],
    ["reply not observed after reload", (f) => { f.points[5]!.reply!.observedAfterReload = false; }],
    ["hidden final reply", (f) => { f.points[5]!.reply!.visible = false; }],
    ["created work", (f) => { f.points[5]!.tasks.push({ id: "unexpected" }); }],
    ["created project", (f) => { f.points[5]!.activity.push({ id: "created-project", companyId: f.scope.companyId, agentId: f.scope.agentId,
      runId: "run-1", action: "project.created", entityType: "project", entityId: "unexpected" }); }],
    ["truncated creation history", (f) => { f.points[5]!.activity = Array.from({ length: 500 }, () => ({})); }],
    ["missing run collection", (f) => { f.points[5]!.runs = undefined as unknown as Row[]; }],
    ["malformed history row", (f) => { f.points[5]!.comments.push(null as unknown as Row); }],
  ];
  it.each(mutants)("rejects %s", (_name, mutate) => {
    const f = chatContinuityFixture();
    mutate(f);
    expect(allPass(f)).toBe(false);
  });
  it("rejects another agent's activity rather than filtering an unscoped response", () => {
    const f = chatContinuityFixture();
    f.points[5]!.activity.push({ companyId: f.scope.companyId, agentId: "other-agent", runId: "other-run", action: "project.created" });
    expect(allPass(f)).toBe(false);
  });
  it("accepts complete owned activity and rejects unaccounted creation by that same agent", () => {
    const f = chatContinuityFixture();
    const row = { id: "owned-event", companyId: f.scope.companyId, agentId: f.scope.agentId,
      runId: "run-0", action: "heartbeat.run_completed", entityType: "heartbeat_run", entityId: "run-0" };
    f.points[5]!.activity.push(row);
    expect(allPass(f)).toBe(true);
    row.action = "project.created"; row.runId = "unaccounted-owned-run";
    expect(allPass(f)).toBe(false);
  });
  it("does not treat a compact run as sufficient without actual native output proof", () => {
    const f = compactChatContinuityFixture();
    f.points[5]!.events = [];
    expect(allPass(f)).toBe(false);
  });
  it("retains backward-compatible issue aliases only when they agree", () => {
    expect(chatContinuityIssueId({ nativeIssueId: "chat", contextSnapshot: { issueId: "chat" } })).toBe("chat");
    expect(chatContinuityIssueId({ issueId: "foreign", nativeIssueId: "chat" })).toBeUndefined();
    expect(chatContinuityIssueId({})).toBeUndefined();
  });
});
