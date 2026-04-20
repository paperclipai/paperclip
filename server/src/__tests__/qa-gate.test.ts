import { describe, expect, it } from "vitest";
import { buildIssueQaGate, isDeliveryScopedAssigneeRole, issueQaGateReasonMessage } from "../services/qa-gate.js";

describe("qa gate helpers", () => {
  it("treats missing assignee role as delivery-scoped", () => {
    expect(isDeliveryScopedAssigneeRole(null)).toBe(true);
    expect(isDeliveryScopedAssigneeRole(undefined)).toBe(true);
  });

  it("treats delivery roles as delivery-scoped and non-delivery roles as exempt", () => {
    expect(isDeliveryScopedAssigneeRole("engineer")).toBe(true);
    expect(isDeliveryScopedAssigneeRole("qa")).toBe(true);
    expect(isDeliveryScopedAssigneeRole("devops")).toBe(true);
    expect(isDeliveryScopedAssigneeRole("cto")).toBe(true);
    expect(isDeliveryScopedAssigneeRole("pm")).toBe(false);
  });

  it("parses summary tokens and computes fail overall from dimensions", () => {
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-1",
          body: "[CQ:pass] [EH:warn] [TC:fail] [CM:pass] [DOC:na]",
          createdAt: new Date("2026-04-11T11:00:00Z"),
        },
      ],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(gate.review).toMatchObject({
      codeQuality: "pass",
      errorHandling: "warn",
      testCoverage: "fail",
      commentQuality: "pass",
      docsImpact: "na",
      overall: "fail",
      stale: false,
    });
  });

  it("uses the latest decision outcome to force fail on changes_requested", () => {
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-1",
          body: "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
          createdAt: new Date("2026-04-11T11:00:00Z"),
        },
      ],
      latestDecisionOutcome: "changes_requested",
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(gate.review.overall).toBe("fail");
    expect(gate.review.latestDecisionOutcome).toBe("changes_requested");
  });

  it("enforces all three delivery gate requirements for shipping", () => {
    const base = buildIssueQaGate({
      issue: { status: "todo" },
      assigneeRole: "engineer",
      qaComments: [],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });
    expect(base.canShip).toBe(false);
    expect(base.missingRequirements).toEqual([
      "qa_gate_requires_in_review",
      "qa_gate_missing_qa_comment",
    ]);

    const ready = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-2",
          body: [
            "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
            "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
            "[QA PASS]",
            "[RELEASE CONFIRMED]",
          ].join("\n"),
          createdAt: new Date("2026-04-11T11:00:00Z"),
        },
      ],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });
    expect(ready.canShip).toBe(true);
    expect(ready.missingRequirements).toEqual([]);
  });

  it("reports missing QA comment before marker-level failures", () => {
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(gate.missingRequirements).toEqual(["qa_gate_missing_qa_comment"]);
  });

  it("treats technical branch work as delivery-scoped even when a non-engineering role is assigned", () => {
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "pm",
      issueText: "COMA-1063 App Merge branches",
      qaComments: [],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(gate.isDeliveryScoped).toBe(true);
    expect(gate.canShip).toBe(false);
    expect(gate.missingRequirements).toEqual(["qa_gate_missing_qa_comment"]);
  });

  it("flags stale review when no recent summary exists", () => {
    const stale = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-1",
          body: "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
          createdAt: new Date("2026-04-10T09:00:00Z"),
        },
      ],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });
    expect(stale.review.stale).toBe(true);
  });

  it("requires the latest QA comment to carry a Smart Review summary before shipping", () => {
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-2",
          body: [
            "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
            "[QA PASS]",
            "[RELEASE CONFIRMED]",
          ].join("\n"),
          createdAt: new Date("2026-04-11T11:30:00Z"),
        },
        {
          id: "comment-1",
          body: "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
          createdAt: new Date("2026-04-11T11:00:00Z"),
        },
      ],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(gate.canShip).toBe(false);
    expect(gate.missingRequirements).toContain("qa_gate_missing_qa_summary");
  });

  it("blocks shipping when the latest QA review is failing even if ship markers are present", () => {
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-1",
          body: [
            "[CQ:pass] [EH:pass] [TC:fail] [CM:pass] [DOC:pass]",
            "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
            "[QA PASS]",
            "[RELEASE CONFIRMED]",
          ].join("\n"),
          createdAt: new Date("2026-04-11T11:00:00Z"),
        },
      ],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(gate.review.overall).toBe("fail");
    expect(gate.canShip).toBe(false);
    expect(gate.missingRequirements).toContain("qa_gate_failing_review");
  });

  it("parses repeated failing QA verdicts deterministically across repeated calls", () => {
    const qaComments = [
      {
        id: "comment-1",
        body: [
          "[CQ:pass] [EH:pass] [TC:fail] [CM:pass] [DOC:pass]",
          "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
          "[QA PASS]",
          "[RELEASE CONFIRMED]",
        ].join("\n"),
        createdAt: new Date("2026-04-11T11:00:00Z"),
      },
    ];

    const first = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments,
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });
    const second = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments,
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(first.review.overall).toBe("fail");
    expect(second.review.overall).toBe("fail");
    expect(first.missingRequirements).toContain("qa_gate_failing_review");
    expect(second.missingRequirements).toContain("qa_gate_failing_review");
  });

  it("requires explicit passing verification tokens on the latest QA verdict before shipping", () => {
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-1",
          body: [
            "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
            "[QA PASS]",
            "[RELEASE CONFIRMED]",
          ].join("\n"),
          createdAt: new Date("2026-04-11T11:00:00Z"),
        },
      ],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(gate.canShip).toBe(false);
    expect(gate.missingRequirements).toContain("qa_gate_missing_verification");
  });

  it("requires a complete Smart Review summary on the latest QA verdict before shipping", () => {
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-1",
          body: [
            "[CQ:pass]",
            "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
            "[QA PASS]",
            "[RELEASE CONFIRMED]",
          ].join("\n"),
          createdAt: new Date("2026-04-11T11:00:00Z"),
        },
      ],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(gate.review.overall).toBe("unknown");
    expect(gate.canShip).toBe(false);
    expect(gate.missingRequirements).toContain("qa_gate_missing_qa_summary");
  });

  it("returns stable reason messages", () => {
    expect(issueQaGateReasonMessage("invalid_status_transition")).toContain("Invalid issue status transition");
    expect(issueQaGateReasonMessage("qa_gate_requires_in_review")).toContain("in_review");
    expect(issueQaGateReasonMessage("qa_gate_missing_qa_comment")).toContain("No QA-authored comment");
    expect(issueQaGateReasonMessage("qa_gate_missing_qa_summary")).toContain("Smart Review");
    expect(issueQaGateReasonMessage("qa_gate_missing_qa_pass")).toContain("[QA PASS]");
    expect(issueQaGateReasonMessage("qa_gate_missing_release_confirmation")).toContain("[RELEASE CONFIRMED]");
    expect(issueQaGateReasonMessage("qa_gate_missing_verification")).toContain("verification");
    expect(issueQaGateReasonMessage("qa_gate_failing_review")).toContain("failing");
  });
});
