import { afterAll, describe, expect, it, vi } from "vitest";
import type { NativeEvidenceAssessment } from "./evidence-classifier.js";
const originalFetch = vi.hoisted(() => { const original = globalThis.fetch; globalThis.fetch = async () => { throw new Error("Pure finalization test forbids network"); }; return original; });
afterAll(() => { globalThis.fetch = originalFetch; });
import { resolveNativeFinalizerStatus } from "./native-run-finalizer.js";

const outcome = () => ({
  run: { id: "run", companyId: "company", agentId: "worker", nativeIssueId: "task", nativeSessionId: "session",
    runtimeMode: "native", completionContractId: "contract", completionContractSha256: "hash",
    runnerProfileJson: { nativeExecutionInput: { schema: "paperclip.native-execution-input.v1",
      provider: { kind: "opencode", model: "openrouter/test-model" }, binding: { runId: "run", companyId: "company", agentId: "worker", issueId: "task", executionWorkspaceId: "run" },
      task: { identifier: "task", title: "Task", description: null, prompt: "Finish", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null }, interactionResponses: [], credentialBindings: [],
      session: { driverKind: "opencode_server", normalizedSessionId: "session", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: "contract", sha256: "hash", schemaVersion: "paperclip.completion-contract.v1", contract: { revision: "test-v1", objective: "Finish", criteria: [{ id: "objective", requirement: "Finish" }] } } } } },
  terminal: { schema: "paperclip.prp.terminal.v1", provider: "opencode", turnTerminalState: "completed", runTerminalState: "succeeded",
    reportedWorkDisposition: "needs_review", workOutcomeReason: "missing_semantic_result_and_assistant_text" },
});
function assessment(overrides: Partial<NativeEvidenceAssessment> = {}): NativeEvidenceAssessment {
  return { objectiveClaimSatisfied: false, objectiveSatisfied: false, allCriteriaSatisfied: false, verificationPassed: false,
    hasFailedVerification: false, hasBlockingRemainingWork: true, reportedDisposition: "needs_review", summary: "Task completion is unverified.",
    contractRevisionMatches: true, criterionAssessments: [], verificationAssessments: [], verificationCaveats: [], acceptedEvidenceRefs: [],
    missingRequirements: ["objective"], rejectedEvidence: [], unverifiableEvidence: [], blocker: null, continuation: null,
    attentionRequests: [], ignoredAttentionRequests: [], ...overrides };
}
function input() {
  return { assessment: assessment(), terminalState: "succeeded" as const, workspaceFinalizeStatus: "succeeded" as const,
    agentId: "worker", priorIssueStatus: "in_progress" as "in_progress" | "in_review", nativeTerminal: outcome() };
}
describe("textless OpenCode finalization safety", () => {
  it.each(["in_progress", "in_review"] as const)("preserves %s without retrying an unverified textless completion", priorIssueStatus => {
    const actual = resolveNativeFinalizerStatus({ ...input(), priorIssueStatus });
    expect(actual.effects.filter(effect => ["enqueue_continuation", "schedule_retry", "create_interaction", "notify_owner"].includes(effect.kind))).toEqual([]);
    expect(actual).toMatchObject({ statusAction: "preserve", toStatus: priorIssueStatus,
      effects: [{ kind: "record_finalization_error", cause: "native_textless_completion_unresolved", terminal: true }] });
  });
  it("keeps ordinary incomplete-result recovery", () => {
    const { nativeTerminal: _context, ...ordinary } = input();
    expect(resolveNativeFinalizerStatus(ordinary)).toMatchObject({ reasonCode: "completion_evidence_incomplete",
      effects: [expect.objectContaining({ kind: "enqueue_continuation", continuationKind: "same_agent" })] });
  });
  it("keeps an explicit human review request authoritative", () => {
    const ordinary = input(); ordinary.assessment = assessment({ attentionRequests: [{ kind: "review", summary: "Review the delivered change", ownerClass: "human", targetAgentId: null,
      sourceIndex: 0, sourceKind: "review", legacy: false }] });
    expect(resolveNativeFinalizerStatus(ordinary)).toMatchObject({ toStatus: "in_review", reasonCode: "actionable_attention_pending" });
  });
  it("does not let a contradictory marker suppress an accepted completion", () => {
    const actual = input(); actual.assessment = assessment({ reportedDisposition: "done", objectiveClaimSatisfied: true, objectiveSatisfied: true,
      allCriteriaSatisfied: true, verificationPassed: true, hasBlockingRemainingWork: false, acceptedEvidenceRefs: ["event:final"], missingRequirements: [] });
    expect(resolveNativeFinalizerStatus(actual)).toMatchObject({ toStatus: "done" });
  });
  it("does not apply an OpenCode marker to another driver", () => {
    const actual = input(); actual.nativeTerminal.run.runnerProfileJson.nativeExecutionInput.session.driverKind = "codex_app_server";
    expect(resolveNativeFinalizerStatus(actual).effects).toEqual([expect.objectContaining({ kind: "enqueue_continuation" })]);
  });
  it.each(["run", "company", "agent", "task", "session", "contract", "hash", "reason", "terminal"])("does not trust mismatched %s evidence", field => {
    const actual = input(); const execution = actual.nativeTerminal.run.runnerProfileJson.nativeExecutionInput;
    if (field === "run") execution.binding.runId = "foreign";
    if (field === "company") execution.binding.companyId = "foreign";
    if (field === "agent") execution.binding.agentId = "foreign";
    if (field === "task") execution.binding.issueId = "foreign";
    if (field === "session") execution.session.normalizedSessionId = "foreign";
    if (field === "contract") execution.completionContract.id = "foreign";
    if (field === "hash") execution.completionContract.sha256 = "foreign";
    if (field === "reason") actual.nativeTerminal.terminal.workOutcomeReason = "unknown";
    if (field === "terminal") actual.nativeTerminal.terminal.turnTerminalState = "failed";
    expect(resolveNativeFinalizerStatus(actual).effects).toEqual([expect.objectContaining({ kind: "enqueue_continuation" })]);
  });
  it("preserves the actual pending governance gate", () => {
    expect(resolveNativeFinalizerStatus({ ...input(), governanceGate: { kind: "interaction", id: "actual-gate" } })).toMatchObject({
      toStatus: "in_review", reasonCode: "governed_gate_pending", effects: expect.arrayContaining([expect.objectContaining({ kind: "create_interaction", gate: expect.objectContaining({ id: "actual-gate" }) })]) });
  });
});
