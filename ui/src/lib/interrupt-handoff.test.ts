import { describe, expect, it } from "vitest";
import { buildAgentMentionHref } from "@paperclipai/shared";
import {
  bodyHasAgentMention,
  classifyAssigneeHandoff,
  computePauseAffectsSummary,
  computeComposerHandoffPreview,
  describeReassignInterrupt,
  extractAgentMentionIds,
  findPlainAgentNameCandidate,
  isOperatorInterruptedRun,
  resolveRunStatusPresentation,
  type PauseAffectsIssueLike,
} from "./interrupt-handoff";

const QA_ID = "agent-qa-1111";
const QA_HREF = buildAgentMentionHref(QA_ID, null);
const qaMention = `[@QA](${QA_HREF})`;

describe("isOperatorInterruptedRun", () => {
  it("detects operator interrupts via errorCode", () => {
    expect(isOperatorInterruptedRun(null, "operator_interrupted")).toBe(true);
  });

  it("detects operator interrupts via resultJson flag", () => {
    expect(isOperatorInterruptedRun({ operatorInterrupted: true })).toBe(true);
    expect(isOperatorInterruptedRun({ interruptionSource: "issue_comment_interrupt" })).toBe(true);
  });

  it("does not flag ordinary cancels or failures", () => {
    expect(isOperatorInterruptedRun({ stopReason: "cancelled" }, "cancelled")).toBe(false);
    expect(isOperatorInterruptedRun(null, "claude_exit_143")).toBe(false);
    expect(isOperatorInterruptedRun(null)).toBe(false);
  });
});

describe("resolveRunStatusPresentation", () => {
  it("renders an operator-interrupted cancel as amber 'interrupted'", () => {
    const p = resolveRunStatusPresentation("cancelled", { operatorInterrupted: true });
    expect(p.label).toBe("interrupted");
    expect(p.className).toContain("amber");
    expect(p.srHint).toMatch(/board comment/);
  });

  it("renders a plain cancel as muted 'cancelled'", () => {
    const p = resolveRunStatusPresentation("cancelled");
    expect(p.label).toBe("cancelled");
    expect(p.className).toContain("muted");
    expect(p.srHint).toBeNull();
  });

  it("leaves failed/succeeded untouched", () => {
    expect(resolveRunStatusPresentation("failed").className).toContain("red");
    expect(resolveRunStatusPresentation("timed_out").label).toBe("timed out");
  });
});

describe("structured mention vs plain text", () => {
  it("extracts agent ids only from structured agent:// links", () => {
    expect(extractAgentMentionIds(`hey ${qaMention} please look`)).toEqual([QA_ID]);
    expect(bodyHasAgentMention(`hey ${qaMention}`)).toBe(true);
  });

  it("treats a plain QA name as NOT a mention", () => {
    expect(bodyHasAgentMention("QA you take the screenshot")).toBe(false);
    expect(extractAgentMentionIds("ask QA to confirm")).toEqual([]);
  });

  it("flags a plain agent-name candidate for the coach", () => {
    const candidate = findPlainAgentNameCandidate("ask QA to confirm", [
      { agentId: QA_ID, name: "QA" },
    ]);
    expect(candidate?.agentId).toBe(QA_ID);
    expect(candidate?.matchedText).toBe("QA");
  });

  it("does not flag a name that is already a structured chip", () => {
    const candidate = findPlainAgentNameCandidate(`hey ${qaMention} thanks`, [
      { agentId: QA_ID, name: "QA" },
    ]);
    expect(candidate).toBeNull();
  });

  it("matches by role as well as display name", () => {
    const candidate = findPlainAgentNameCandidate("can the reviewer check this", [
      { agentId: "agent-x", name: "Casey", role: "reviewer" },
    ]);
    expect(candidate?.matchedText).toBe("reviewer");
  });
});

describe("computeComposerHandoffPreview", () => {
  const base = {
    currentAssigneeValue: "agent:claude-1",
    hasActiveRun: true,
    bodyHasAgentMention: false,
    plainNameCandidate: null,
  };

  it("A. reassign to agent with active run = interrupt + handoff", () => {
    const p = computeComposerHandoffPreview({ ...base, reassignTarget: `agent:${QA_ID}` });
    expect(p.kind).toBe("interrupt_handoff_agent");
    expect(p.chip).toEqual({ kind: "agent", id: QA_ID });
    expect(p.tone).toBe("neutral");
  });

  it("reassign to agent with no active run = wake", () => {
    const p = computeComposerHandoffPreview({
      ...base,
      hasActiveRun: false,
      reassignTarget: `agent:${QA_ID}`,
    });
    expect(p.kind).toBe("wake_agent");
  });

  it("B. reassign to user = handoff, no agent wake", () => {
    const p = computeComposerHandoffPreview({ ...base, reassignTarget: "user:user-board" });
    expect(p.kind).toBe("user_handoff");
    expect(p.chip).toEqual({ kind: "user", id: "user-board" });
    expect(p.suffix).toMatch(/no agent/i);
  });

  it("clearing the assignee reads as no agent wake", () => {
    const p = computeComposerHandoffPreview({ ...base, reassignTarget: "__none__" });
    expect(p.kind).toBe("clear_assignee");
    expect(p.text).toMatch(/no agent/i);
  });

  it("no reassign + structured mention = notify agent", () => {
    const p = computeComposerHandoffPreview({
      ...base,
      reassignTarget: base.currentAssigneeValue,
      bodyHasAgentMention: true,
      mentionedAgentId: QA_ID,
    });
    expect(p.kind).toBe("notify_agent");
    expect(p.chip).toEqual({ kind: "agent", id: QA_ID });
  });

  it("C. no reassign + plain name only = amber warning, no wake", () => {
    const p = computeComposerHandoffPreview({
      ...base,
      reassignTarget: base.currentAssigneeValue,
      plainNameCandidate: { agentId: QA_ID, matchedText: "QA" },
    });
    expect(p.kind).toBe("plain_text_only");
    expect(p.tone).toBe("warn");
    expect(p.chip).toBeUndefined();
  });

  it("nothing notable = hidden preview", () => {
    const p = computeComposerHandoffPreview({
      ...base,
      reassignTarget: base.currentAssigneeValue,
    });
    expect(p.kind).toBe("none");
  });
});

describe("classifyAssigneeHandoff", () => {
  it("A. to agent = queued wake", () => {
    const info = classifyAssigneeHandoff({ agentId: QA_ID, userId: null }, { agentName: "QA" });
    expect(info.kind).toBe("agent_wake");
    expect(info.wakeText).toMatch(/queued for QA/);
  });

  it("agent wake notes attached interrupted run when present", () => {
    const info = classifyAssigneeHandoff(
      { agentId: QA_ID, userId: null },
      { agentName: "QA", interruptedRunAttached: true },
    );
    expect(info.wakeText).toMatch(/interrupted run attached/);
  });

  it("B. to user = no wake, board handoff", () => {
    const info = classifyAssigneeHandoff({ agentId: null, userId: "user-board" });
    expect(info.kind).toBe("user_handoff");
    expect(info.wakeText).toMatch(/not created/);
  });

  it("C. unassigned = no wake, needs explicit agent", () => {
    const info = classifyAssigneeHandoff({ agentId: null, userId: null });
    expect(info.kind).toBe("unassigned");
    expect(info.wakeText).toMatch(/no agent selected/);
  });
});

describe("describeReassignInterrupt", () => {
  it("names the running agent in the banner and confirm", () => {
    const copy = describeReassignInterrupt({ runningAgentName: "ClaudeCoder" });
    expect(copy.banner).toBe("ClaudeCoder is running — changing the assignee will interrupt this run.");
    expect(copy.confirmAction).toBe("Interrupt & assign");
    expect(copy.cancelAction).toBe("Cancel");
  });

  it("falls back to a generic subject when no name is known", () => {
    expect(describeReassignInterrupt().banner).toMatch(/^An agent is running/);
    expect(describeReassignInterrupt({ runningAgentName: "  " }).banner).toMatch(/^An agent is running/);
  });
});

describe("computePauseAffectsSummary", () => {
  const issue = (over: Partial<PauseAffectsIssueLike>): PauseAffectsIssueLike => ({
    assigneeAgentId: null,
    assigneeUserId: null,
    activeRun: null,
    ...over,
  });
  const bucket = (summary: ReturnType<typeof computePauseAffectsSummary>, key: string) =>
    summary.buckets.find((b) => b.key === key)!;

  it("partitions affected issues into disjoint buckets", () => {
    const summary = computePauseAffectsSummary([
      issue({ assigneeAgentId: "a1", activeRun: { status: "running" } }),
      issue({ assigneeAgentId: "a2", activeRun: { status: "queued" } }),
      issue({ assigneeAgentId: "a3" }),
      issue({ assigneeUserId: "u1" }),
      issue({}),
    ]);
    expect(bucket(summary, "live_runs").count).toBe(1);
    expect(bucket(summary, "queued_wakes").count).toBe(1);
    expect(bucket(summary, "agent_owned").count).toBe(1);
    expect(bucket(summary, "human_owned").count).toBe(1);
    expect(bucket(summary, "static").count).toBe(1);
    expect(summary.affectedIssueCount).toBe(5);
    expect(summary.nothingLive).toBe(false);
  });

  it("ignores skipped issues", () => {
    const summary = computePauseAffectsSummary([
      issue({ assigneeAgentId: "a1", activeRun: { status: "running" }, skipped: true }),
      issue({ assigneeUserId: "u1" }),
    ]);
    expect(summary.affectedIssueCount).toBe(1);
    expect(bucket(summary, "live_runs").count).toBe(0);
    expect(bucket(summary, "human_owned").count).toBe(1);
  });

  it("flags nothingLive when no run is live or queued", () => {
    const summary = computePauseAffectsSummary([issue({ assigneeUserId: "u1" }), issue({})]);
    expect(summary.nothingLive).toBe(true);
  });

  it("an active run wins over the issue's owner bucket", () => {
    const summary = computePauseAffectsSummary([
      issue({ assigneeAgentId: "a1", activeRun: { status: "running" } }),
    ]);
    expect(bucket(summary, "live_runs").count).toBe(1);
    expect(bucket(summary, "agent_owned").count).toBe(0);
  });
});
