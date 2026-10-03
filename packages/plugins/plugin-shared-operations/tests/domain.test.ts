import { describe, expect, it } from "vitest";
import { applyCommand, DomainError, emptyState } from "../src/domain.js";
import type { Actor, Command, CompanyState, EvaluationSpec, PolicyBundle } from "../src/domain.js";

const board: Actor = { id: "local-board", kind: "board" };
const owner: Actor = { id: "owner", kind: "agent" };
const other: Actor = { id: "other", kind: "agent" };
const now = "2026-09-07T10:00:00.000Z";
const deadline = "2026-09-07T11:00:00.000Z";
const evidence = [{ ref: "artifact:original", digest: "a".repeat(64) }];
const newEvidence = [{ ref: "artifact:changed", digest: "b".repeat(64) }];
const bundle: PolicyBundle = { instructions: ["Report evidence"], constraints: ["Board approves spending"], skills: [], hooks: [] };
const spec: EvaluationSpec = {
  checks: ["correctness"], nonRegressionChecks: ["safety"],
  metrics: [
    { name: "latency", direction: "decrease", minimumImprovement: 1, maxRegression: 0 },
    { name: "accuracy", direction: "increase", minimumImprovement: null, maxRegression: 0 },
  ],
};
const run = (state: CompanyState, command: unknown, actor = board, at = now) => applyCommand(state, command, actor, at);
const initial = () => run(emptyState(), { type: "policy.publish", id: "v1", bundle, reason: "Initial board policy" });
const decision = (overrides = {}) => run(initial(), {
  type: "decision.create", id: "d1", title: "Choose approach", ownerId: owner.id,
  requirement: "Ship a reversible local change", riskClass: "low", reversibility: "reversible",
  impacts: [], requiredEvidenceRefs: [evidence[0].ref], evidenceRefs: evidence, maxRounds: 1, deadline, ...overrides,
}, owner);
const resolve = (state: CompanyState, outcome = "proceed", actor = owner) => run(state, {
  type: "decision.resolve", decisionId: "d1", outcome, reason: "Evidence supports this outcome", evidenceRefs: evidence,
}, actor);
const withMemory = () => run(initial(), { type: "memory.put", id: "m1", title: "Constraint", content: "No external spend", provenanceRefs: evidence, expectedRevision: null }, owner);
const snapshot = (state = withMemory()) => run(state, { type: "context.snapshot", id: "s1", receiverId: owner.id, taskId: "task1", taskRevision: "7", memoryIds: ["m1"], omissions: [] });
const proposed = () => run(initial(), {
  type: "improvement.propose", id: "i1", title: "Faster context", baselinePolicyId: "v1", candidatePolicyId: "v2",
  bundle: { ...bundle, instructions: ["Report concise evidence"] }, evaluationSpec: spec, maxTrials: 2,
}, owner);
function evaluation(state: CompanyState, overrides = {}): Command {
  return {
    type: "improvement.evaluate", improvementId: "i1", baselinePolicyId: "v1", specHash: state.improvements[0].specHash,
    evaluatorId: other.id, runRef: "run:1",
    checks: ["correctness", "safety"].map((name) => ({ name, status: "passed", evidenceRefs: evidence })),
    metrics: [
      { name: "latency", status: "passed", baseline: 10, candidate: 8, evidenceRefs: evidence },
      { name: "accuracy", status: "passed", baseline: 99, candidate: 99, evidenceRefs: evidence },
    ], ...overrides,
  } as Command;
}
const promote = (state: CompanyState, actor = board) => run(state, { type: "improvement.promote", improvementId: "i1", reason: "Measured improvement with safety gates passed" }, actor);
function denied(action: () => unknown, code: string, status?: number) {
  try { action(); throw new Error("Expected a domain rejection"); }
  catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    if (status !== undefined) expect((error as DomainError).status).toBe(status);
  }
}

describe("canonical policy versions", () => {
  it("records an immutable board-published initial policy and attribution", () => {
    const input = emptyState();
    const result = run(input, { type: "policy.publish", id: "v1", bundle, reason: "Initial" });
    expect(input.policies).toEqual([]);
    expect(result.activePolicyId).toBe("v1");
    expect(result.policies[0].digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.events[0]).toMatchObject({ actor: board, at: now, reason: "Initial" });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    bundle.instructions.push("Temporary input mutation");
    expect(result.policies[0].bundle.instructions).toEqual(["Report evidence"]);
    bundle.instructions.pop();
  });
  it("denies agent publishing, replacement publishing, and unapproved candidate activation", () => {
    denied(() => run(emptyState(), { type: "policy.publish", id: "v1", bundle, reason: "Initial" }, owner), "BOARD_REQUIRED", 403);
    denied(() => run(initial(), { type: "policy.publish", id: "v3", bundle, reason: "Bypass evaluation" }), "POLICY_ALREADY_INITIALISED", 409);
    denied(() => run(proposed(), { type: "policy.activate", policyId: "v2", reason: "Bypass" }), "UNAPPROVED_POLICY", 409);
  });
});

describe("bounded decisions", () => {
  it("allows the owner to resolve from required evidence without a vote", () => {
    expect(resolve(decision()).decisions[0].resolution).toMatchObject({ outcome: "proceed", actor: owner, at: now });
  });
  it("requires an agent creator to own the decision and enforces resolution ownership", () => {
    denied(() => decision({ ownerId: other.id }), "OWNER_REQUIRED", 403);
    denied(() => resolve(decision(), "proceed", other), "OWNER_REQUIRED", 403);
  });
  it.each([
    { reversibility: "irreversible" }, { riskClass: "high" },
    { impacts: ["external_publication"] }, { impacts: ["spend"] }, { impacts: ["account_change"] },
  ])("requires board authority for a governed proceed: %j", (risk) => {
    denied(() => resolve(decision(risk)), "BOARD_REQUIRED", 403);
    expect(resolve(decision(risk), "escalate").decisions[0].resolution?.outcome).toBe("escalate");
    expect(resolve(decision(risk), "proceed", board).decisions[0].resolution?.actor).toEqual(board);
  });
  it("does not allow missing evidence to become a proceed", () => {
    denied(() => run(decision({ evidenceRefs: [] }), { type: "decision.resolve", decisionId: "d1", outcome: "proceed", reason: "Insufficient evidence", evidenceRefs: [] }, owner), "EVIDENCE_REQUIRED", 422);
    expect(resolve(decision({ evidenceRefs: [] }), "defer").decisions[0].resolution?.outcome).toBe("defer");
  });
  it("lets the board adjudicate an escalation without manufacturing new evidence", () => {
    const escalated = resolve(decision({ impacts: ["spend"] }), "escalate");
    denied(() => resolve(escalated), "DECISION_CLOSED", 409);
    const adjudicated = resolve(escalated, "proceed", board);
    expect(adjudicated.decisions[0].resolution?.outcome).toBe("proceed");
    expect(adjudicated.events.filter((event) => event.type === "decision.resolve").map((event) => (event.command as Extract<Command, { type: "decision.resolve" }>).outcome)).toEqual(["escalate", "proceed"]);
  });
  it("rejects debate after the round cap, at the deadline, and after resolution", () => {
    const consult = { type: "decision.consult", decisionId: "d1", summary: "One consultation", evidenceRefs: evidence };
    const state = run(decision(), consult, other);
    denied(() => run(state, consult, other), "DEBATE_CLOSED", 409);
    denied(() => run(decision(), consult, other, deadline), "DEBATE_CLOSED", 409);
    denied(() => run(resolve(decision()), consult, other), "DECISION_CLOSED", 409);
    expect(resolve(state, "no_change").decisions[0].resolution?.outcome).toBe("no_change");
  });
  it("requires changed material evidence or a changed requirement to reopen", () => {
    const state = resolve(decision());
    const reopen = { type: "decision.reopen", decisionId: "d1", requirement: state.decisions[0].requirement, evidenceRefs: evidence, reason: "Reconsider", deadline };
    denied(() => run(state, reopen, owner), "NO_MATERIAL_CHANGE", 409);
    denied(() => run(state, { ...reopen, evidenceRefs: [{ ...evidence[0], ref: "renamed:same-content" }] }, owner), "NO_MATERIAL_CHANGE", 409);
    denied(() => run(state, { ...reopen, evidenceRefs: newEvidence }, other), "OWNER_REQUIRED", 403);
    const reopened = run(state, { ...reopen, evidenceRefs: newEvidence }, owner);
    expect(reopened.decisions[0].resolution).toBeNull();
    expect(reopened.decisions[0].reopenHistory).toHaveLength(1);
    expect(run(state, { ...reopen, requirement: "Changed business requirement" }, owner).decisions[0].resolution).toBeNull();
  });
});

describe("shared context", () => {
  it("versions provenance-backed memory and rejects concurrent overwrites", () => {
    const state = withMemory();
    const update = { type: "memory.put", id: "m1", title: "Constraint", content: "Updated", provenanceRefs: newEvidence, expectedRevision: 1 };
    const updated = run(state, update, owner);
    expect(updated.memories[0]).toMatchObject({ revision: 2, content: "Updated", provenanceRefs: newEvidence, actor: owner });
    expect(state.memories[0].content).toBe("No external spend");
    denied(() => run(updated, update, owner), "STALE_REVISION", 409);
    denied(() => run(state, { ...update, provenanceRefs: [] }), "INVALID_INPUT", 400);
  });
  it("makes omissions explicit and only records a receipt with the exact digest from its receiver", () => {
    const state = snapshot(run(withMemory(), { type: "memory.put", id: "m2", title: "Other", content: "Not needed", provenanceRefs: evidence, expectedRevision: null }));
    expect(state.snapshots[0].omissions).toContainEqual({ ref: "memory:m2", reason: "Not selected for this context snapshot" });
    const receive = { type: "context.receive", snapshotId: "s1", digest: state.snapshots[0].digest, taskRevision: "7" };
    denied(() => run(state, receive, other), "RECEIVER_REQUIRED", 403);
    denied(() => run(state, receive, board), "RECEIVER_REQUIRED", 403);
    denied(() => run(state, { ...receive, digest: "f".repeat(64) }, owner), "SNAPSHOT_MISMATCH", 409);
    const received = run(state, receive, owner);
    expect(received.snapshots[0].receipt).toMatchObject({ actor: owner, digest: state.snapshots[0].digest, taskRevision: "7" });
  });
  it("rejects stale task and memory handoffs", () => {
    const state = snapshot();
    const receive = { type: "context.receive", snapshotId: "s1", digest: state.snapshots[0].digest, taskRevision: "7" };
    denied(() => run(state, { ...receive, taskRevision: "8" }, owner), "STALE_CONTEXT", 409);
    const updated = run(state, { type: "memory.status", memoryId: "m1", status: "contested", reason: "Conflicting evidence", expectedRevision: 1 });
    denied(() => run(updated, receive, owner), "STALE_CONTEXT", 409);
    denied(() => run(updated, { type: "context.snapshot", id: "s2", receiverId: owner.id, taskId: "task1", taskRevision: "7", memoryIds: ["m1"], omissions: [] }), "MEMORY_NOT_CURRENT", 409);
  });
  it("rejects a handoff after the active policy changes", () => {
    let state = snapshot(run(proposed(), { type: "memory.put", id: "m1", title: "Context", content: "Shared", provenanceRefs: evidence, expectedRevision: null }));
    state = promote(run(state, evaluation(state)));
    denied(() => run(state, { type: "context.receive", snapshotId: "s1", digest: state.snapshots[0].digest, taskRevision: "7" }, owner), "STALE_CONTEXT", 409);
  });
  it("rejects contradictory omissions and oversized snapshots without changing memory", () => {
    const command = { type: "context.snapshot", id: "s1", receiverId: owner.id, taskId: "task1", taskRevision: "7", memoryIds: ["m1"], omissions: [{ ref: "memory:m1", reason: "Omitted" }] };
    denied(() => run(withMemory(), command), "INVALID_INPUT", 400);
    let state = initial();
    for (let index = 0; index < 4; index++) state = run(state, { type: "memory.put", id: `large${index}`, title: "Large context", content: "x".repeat(8192), provenanceRefs: evidence, expectedRevision: null });
    denied(() => run(state, { ...command, memoryIds: state.memories.map((memory) => memory.id), omissions: [] }), "CONTEXT_TOO_LARGE", 422);
    expect(state.snapshots).toHaveLength(0);
    expect(state.memories).toHaveLength(4);
  });
});

describe("bounded improvement", () => {
  it("allows agent proposals, independent board-recorded evaluation, promotion and historical rollback", () => {
    const proposal = proposed();
    expect(proposal.activePolicyId).toBe("v1");
    const evaluated = run(proposal, evaluation(proposal));
    expect(evaluated.improvements[0].evaluations[0]).toMatchObject({ passed: true, evaluatorId: other.id, actor: board, runRef: "run:1" });
    const promoted = promote(evaluated);
    expect(promoted.activePolicyId).toBe("v2");
    const rolledBack = run(promoted, { type: "policy.activate", policyId: "v1", reason: "Operational rollback" });
    expect(rolledBack.activePolicyId).toBe("v1");
    expect(rolledBack.policies).toEqual(promoted.policies);
    expect(rolledBack.improvements[0].evaluations).toHaveLength(1);
    expect(rolledBack.events.at(-1)?.reason).toBe("Operational rollback");
  });
  it("rejects agent evaluation, self-evaluation and agent self-promotion", () => {
    const state = proposed();
    denied(() => run(state, evaluation(state), other), "BOARD_REQUIRED", 403);
    denied(() => run(state, evaluation(state, { evaluatorId: owner.id })), "EVALUATOR_COLLISION", 403);
    denied(() => promote(run(state, evaluation(state)), owner), "BOARD_REQUIRED", 403);
    denied(() => promote(state), "EVALUATION_REQUIRED", 409);
  });
  it.each(["failed", "skipped"])("never treats a %s gate as passed", (status) => {
    const state = proposed();
    const command = evaluation(state) as Extract<Command, { type: "improvement.evaluate" }>;
    command.checks[1].status = status as "failed" | "skipped";
    const evaluated = run(state, command);
    expect(evaluated.improvements[0].evaluations[0].passed).toBe(false);
    denied(() => promote(evaluated), "EVALUATION_REQUIRED", 409);
  });
  it("fails actual metric regressions even when submitted status says passed", () => {
    const state = proposed();
    const command = evaluation(state) as Extract<Command, { type: "improvement.evaluate" }>;
    command.metrics[1].candidate = 98;
    expect(run(state, command).improvements[0].evaluations[0].passed).toBe(false);
    command.metrics[1].candidate = 99;
    command.metrics[0].candidate = 9.5;
    expect(run(state, command).improvements[0].evaluations[0].passed).toBe(false);
  });
  it("rejects missing gates, changed specifications and reused evaluator runs", () => {
    const state = proposed();
    denied(() => run(state, evaluation(state, { checks: [] })), "GATES_MISMATCH", 422);
    denied(() => run(state, evaluation(state, { specHash: "f".repeat(64) })), "SPEC_MISMATCH", 409);
    const evaluated = run(state, evaluation(state));
    denied(() => run(evaluated, evaluation(state)), "RUN_ALREADY_RECORDED", 409);
  });
  it("does not pass metrics whose numeric difference overflows", () => {
    const state = proposed();
    const command = evaluation(state) as Extract<Command, { type: "improvement.evaluate" }>;
    command.metrics[0].baseline = Number.MAX_VALUE;
    command.metrics[0].candidate = -Number.MAX_VALUE;
    expect(run(state, command).improvements[0].evaluations[0].passed).toBe(false);
  });
  it("caps trials and uses the latest evaluation so a later failure cannot be ignored", () => {
    const state = proposed();
    const first = run(state, evaluation(state));
    const command = evaluation(first, { runRef: "run:2" }) as Extract<Command, { type: "improvement.evaluate" }>;
    command.metrics[0].status = "skipped";
    command.metrics[0].baseline = null;
    command.metrics[0].candidate = null;
    const second = run(first, command);
    denied(() => promote(second), "EVALUATION_REQUIRED", 409);
    denied(() => run(second, evaluation(second, { runRef: "run:3" })), "TRIAL_LIMIT", 409);
  });
  it("does not reset a candidate's trial budget by renaming the proposal", () => {
    const state = proposed();
    denied(() => run(state, {
      type: "improvement.propose", id: "renamed", title: "Try the same candidate again", baselinePolicyId: "v1", candidatePolicyId: "renamed-policy",
      bundle: state.policies[1].bundle, evaluationSpec: spec, maxTrials: 3,
    }, owner), "DUPLICATE_CANDIDATE", 409);
  });
  it("does not reset the same candidate's budget by reordering or changing its evaluation specification", () => {
    const proposal = { type: "improvement.propose", id: "original", title: "One candidate", baselinePolicyId: "v1", candidatePolicyId: "original-policy", bundle, evaluationSpec: { ...spec, checks: ["correctness", "completeness"] }, maxTrials: 1 };
    const state = run(initial(), proposal, owner);
    for (const checks of [["completeness", "correctness"], ["different-test"]]) {
      denied(() => run(state, { ...proposal, id: "renamed", candidatePolicyId: "renamed-policy", evaluationSpec: { ...spec, checks } }, owner), "DUPLICATE_CANDIDATE", 409);
    }
  });
  it("rejects a candidate whose baseline became stale", () => {
    let state = proposed();
    state = run(state, { type: "improvement.propose", id: "i2", title: "Other improvement", baselinePolicyId: "v1", candidatePolicyId: "v3", bundle, evaluationSpec: spec, maxTrials: 1 }, other);
    state = run(state, evaluation(state, { improvementId: "i2", evaluatorId: owner.id, runRef: "run:other" }));
    state = promote(run(state, evaluation(state)));
    denied(() => run(state, { type: "improvement.promote", improvementId: "i2", reason: "Old baseline" }), "STALE_BASELINE", 409);
    denied(() => run(state, evaluation(state, { improvementId: "i2", evaluatorId: owner.id, runRef: "run:new" })), "STALE_BASELINE", 409);
  });
});

describe("untrusted command validation", () => {
  it.each([null, [], "policy.publish", {}, { type: "unknown" }, { type: "memory.put", id: 7 }])("rejects malformed input %j", (input) => {
    denied(() => run(emptyState(), input), "INVALID_INPUT", 400);
  });
  it("rejects unknown fields, oversized content, executable hook fields and invalid numbers", () => {
    denied(() => run(emptyState(), { type: "policy.publish", id: "v1", bundle, reason: "Initial", actor: board }), "INVALID_INPUT", 400);
    denied(() => run(emptyState(), { type: "policy.publish", id: "v1", bundle: { ...bundle, hooks: [{ event: "run", instruction: "Review", command: "sh unsafe" }] }, reason: "Initial" }), "INVALID_INPUT", 400);
    denied(() => decision({ maxRounds: 4 }), "INVALID_INPUT", 400);
    denied(() => decision({ maxRounds: NaN }), "INVALID_INPUT", 400);
    denied(() => decision({ deadline: "yesterday" }), "INVALID_INPUT", 400);
    denied(() => decision({ deadline: "2027-02-30T11:00:00.000Z" }), "INVALID_INPUT", 400);
    denied(() => decision({ title: "x".repeat(501) }), "INVALID_INPUT", 400);
    denied(() => run(emptyState(), { type: "memory.put", id: "m", title: "Huge", content: "x".repeat(9000), provenanceRefs: evidence, expectedRevision: null }), "INVALID_INPUT", 400);
  });
  it("rejects duplicate references, omitted fields, invalid actors and unbounded trial requests", () => {
    denied(() => decision({ evidenceRefs: [evidence[0], evidence[0]] }), "INVALID_INPUT", 400);
    denied(() => decision({ requiredEvidenceRefs: [] }), "INVALID_INPUT", 400);
    denied(() => run(emptyState(), { type: "policy.publish", id: "v1", bundle, reason: "Initial" }, { id: "intruder", kind: "system" } as unknown as Actor), "INVALID_INPUT", 400);
    denied(() => run(initial(), { type: "improvement.propose", id: "i1", title: "Unbounded", baselinePolicyId: "v1", candidatePolicyId: "v2", bundle, evaluationSpec: spec, maxTrials: 4 }), "INVALID_INPUT", 400);
    denied(() => run(initial(), { type: "improvement.propose", id: "i1", title: "No safety controls", baselinePolicyId: "v1", candidatePolicyId: "v2", bundle, evaluationSpec: { ...spec, nonRegressionChecks: [] }, maxTrials: 1 }), "INVALID_INPUT", 400);
  });
});
