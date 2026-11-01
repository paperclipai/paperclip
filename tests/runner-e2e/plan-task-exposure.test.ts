import { describe, expect, it } from "vitest";
import { planExposure, planInvocationPrompt } from "./plan-task-exposure.js";

const digest = "a".repeat(64);
function fixture(enabled = true) {
  const skillInputs = enabled ? [{ type: "skill", name: "planning", path: `/private/runtime-context-assets/bundles/${digest}/SKILL.md` }] : [];
  return { runs: [{ id: "lead-run", agentId: "lead", nativeIssueId: "parent", startedAt: "2026-10-05T00:00:00Z" }],
    evidence: [{ runId: "lead-run", events: [
      { runId: "lead-run", eventType: "turn.submitted", payload: { prpEvent: { payload: { skillInputs } } } },
      { runId: "lead-run", eventType: "turn.accepted", payload: { prpEvent: { turnId: "turn", payload: { turnId: "turn" } } } },
      { runId: "lead-run", eventType: "turn.started", payload: { prpEvent: { turnId: "turn", payload: {} } } },
    ] }], leadId: "lead", parentId: "parent", invocations: enabled ? [{ name: "planning", assetDigest: digest }] : [] };
}

describe("planning native invocation evidence", () => {
  it.each([true, false])("accepts exact enabled=%s delivery and accepted-turn receipts", enabled => expect(planExposure(fixture(enabled)).passed).toBe(true));
  it.each(["missing", "wrong-run", "wrong-turn", "wrong-path", "wrong-digest", "wrong-name", "duplicate", "prose-only", "unaccepted"])("rejects %s delivery evidence", problem => {
    const value = fixture();
    const event = value.evidence[0]!.events[0]!;
    const skills = event.payload.prpEvent.payload.skillInputs!;
    if (problem === "missing") value.evidence = [];
    if (problem === "wrong-run") event.runId = "other-run";
    if (problem === "wrong-turn") value.evidence[0]!.events[1]!.payload.prpEvent.turnId = "other-turn";
    if (problem === "wrong-path") skills[0]!.path = `/unverified/${digest}/SKILL.md`;
    if (problem === "wrong-digest") skills[0]!.path = skills[0]!.path.replace(digest, "b".repeat(64));
    if (problem === "wrong-name") skills[0]!.name = "other";
    if (problem === "duplicate") skills.push({ ...skills[0]! });
    if (problem === "prose-only") event.eventType = "agentMessage";
    if (problem === "unaccepted") value.evidence[0]!.events.splice(1, 1);
    expect(planExposure(value).passed).toBe(false);
  });
  it("rejects a disabled control with an actual skill input", () => {
    const value = fixture(); value.invocations = [];
    expect(planExposure(value).passed).toBe(false);
  });
  it("keeps the business prompt intact and invokes only assigned guidance", () => {
    expect(planInvocationPrompt("Business task", [])).toBe("Business task");
    expect(planInvocationPrompt("Business task", [{ name: "planning", assetDigest: digest }]))
      .toBe("Business task\n\nUse the assigned planning guidance: /planning.");
  });
});
