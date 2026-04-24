import { describe, expect, it } from "vitest";
import {
  buildIssueQaGate,
  isDeliveryScopedAssigneeRole,
  issueQaGateReasonMessage,
  parseQaSummary,
  parseQaVerification,
  qaCommentHasExplicitSummaryTokens,
  qaCommentHasExplicitTestCoverageVerdict,
  qaCommentHasExplicitVerificationTokens,
} from "../services/qa-gate.js";

describe("qa gate helpers", () => {
  it("does not treat missing assignee role as delivery-scoped by itself", () => {
    expect(isDeliveryScopedAssigneeRole(null)).toBe(false);
    expect(isDeliveryScopedAssigneeRole(undefined)).toBe(false);
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

  it("requires the latest QA verdict to include an explicit [QA PASS] marker before shipping", () => {
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-1",
          body: [
            "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
            "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
            "[RELEASE CONFIRMED]",
          ].join("\n"),
          createdAt: new Date("2026-04-11T11:00:00Z"),
        },
      ],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(gate.canShip).toBe(false);
    expect(gate.missingRequirements).toContain("qa_gate_missing_qa_pass");
  });

  it("requires the latest QA verdict to include an explicit [RELEASE CONFIRMED] marker before shipping", () => {
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-1",
          body: [
            "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
            "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
            "[QA PASS]",
          ].join("\n"),
          createdAt: new Date("2026-04-11T11:00:00Z"),
        },
      ],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(gate.canShip).toBe(false);
    expect(gate.missingRequirements).toContain("qa_gate_missing_release_confirmation");
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

  it("does not treat ticket-authoring audit work as delivery-scoped just because an engineer owns it", () => {
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      issueText: [
        "UI Audit - Review and incrementally improve the cart UI in this workspace using Hermes.",
        "This is a ticket-authoring task, not an implementation task.",
        "Do not change code. Write implementation tickets only.",
      ].join("\n"),
      qaComments: [],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(gate.isDeliveryScoped).toBe(false);
    expect(gate.canShip).toBe(true);
    expect(gate.missingRequirements).toEqual([]);
  });

  it("does not treat trust audits that require creating follow-up issues as delivery-scoped", () => {
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "qa",
      issueText: [
        "Cart trust audit — eliminate any source of doubt.",
        "This is a trust validation and failure detection exercise.",
        "The audit is not complete until concrete issues are created.",
        "For every P0 and P1 issue: create a NEW issue.",
        "If a problem is found but no ticket is created, the review is incomplete.",
      ].join("\n"),
      qaComments: [],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(gate.isDeliveryScoped).toBe(false);
    expect(gate.canShip).toBe(true);
    expect(gate.missingRequirements).toEqual([]);
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

  it("blocks shipping when the latest QA review leaves test coverage at na", () => {
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-1",
          body: [
            "[CQ:pass] [EH:pass] [TC:na] [CM:pass] [DOC:na]",
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

    expect(gate.review.testCoverage).toBe("na");
    expect(gate.review.docsImpact).toBe("na");
    expect(gate.canShip).toBe(false);
    expect(gate.missingRequirements).toContain("qa_gate_missing_test_coverage_verdict");
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

  it("accepts structured prose QA verdicts that include markers and explicit verification evidence", () => {
    const proseVerdict = [
      "[QA PASS]",
      "[RELEASE CONFIRMED]",
      "",
      "Smart Review Summary",
      "Root cause: cart mode label keys were nested under the wrong locale path.",
      "Fix: moved the keys under cart.modeStatus and verified the component wiring.",
      "Tests: 12/12 passing in cart mode coverage.",
      "Files: app/assets/js/pages/cart/page.tsx, app/assets/js/locales/es.json",
      "Verification: build verified and release readiness confirmed.",
    ].join("\n");
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-1",
          body: proseVerdict,
          createdAt: new Date("2026-04-11T11:00:00Z"),
        },
      ],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(gate.review.overall).toBe("pass");
    expect(gate.canShip).toBe(true);
    expect(gate.missingRequirements).toEqual([]);
    expect(parseQaSummary(proseVerdict).hasSummary).toBe(true);
    expect(parseQaVerification(proseVerdict).complete).toBe(true);
    expect(qaCommentHasExplicitSummaryTokens(proseVerdict)).toBe(false);
    expect(qaCommentHasExplicitTestCoverageVerdict(proseVerdict)).toBe(false);
    expect(qaCommentHasExplicitVerificationTokens(proseVerdict)).toBe(false);
  });

  it("uses the latest valid QA verdict instead of a newer transcript-only run comment", () => {
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-2",
          body: [
            "↻ Resumed session 20260421_000731_c4b4df (1 user message, 58 total messages)",
            "",
            "╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮",
            "Let me inspect the current issue state before posting the final verdict.",
            "╰──────────────────────────────────────────────────────────────────────────────╯",
          ].join("\n"),
          createdAt: new Date("2026-04-11T11:30:00Z"),
        },
        {
          id: "comment-1",
          body: [
            "[QA PASS]",
            "[RELEASE CONFIRMED]",
            "",
            "Smart Review Summary",
            "Root cause: modeStatus locale keys were outside the cart namespace.",
            "Fix: moved the keys and verified the component now resolves cart.modeStatus.*.",
            "Tests: 9/9 passing in cart mode regression coverage.",
            "Verification: build verified and release readiness confirmed.",
          ].join("\n"),
          createdAt: new Date("2026-04-11T11:00:00Z"),
        },
      ],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(gate.review.overall).toBe("pass");
    expect(gate.canShip).toBe(true);
    expect(gate.missingRequirements).toEqual([]);
  });

  it("ignores transcript comments that only quote a QA verdict inside a diff payload", () => {
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-2",
          body: [
            "↻ Resumed session 20260421_000731_c4b4df (1 user message, 58 total messages)",
            "",
            "╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮",
            "Need to post the QA comment first.",
            "╰──────────────────────────────────────────────────────────────────────────────╯",
            "┊ review diff",
            "@@ -0,0 +1,3 @@",
            '+  "body": "[QA PASS] [RELEASE CONFIRMED]\\n\\n## Smart Review Summary\\n\\nVerification: build verified."',
          ].join("\n"),
          createdAt: new Date("2026-04-11T11:30:00Z"),
        },
        {
          id: "comment-1",
          body: [
            "[QA PASS]",
            "[RELEASE CONFIRMED]",
            "",
            "Smart Review Summary",
            "Root cause: modeStatus locale keys were outside the cart namespace.",
            "Fix: moved the keys and verified the component now resolves cart.modeStatus.*.",
            "Tests: 9/9 passing in cart mode regression coverage.",
            "Verification: build verified and release readiness confirmed.",
          ].join("\n"),
          createdAt: new Date("2026-04-11T11:00:00Z"),
        },
      ],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(gate.review.overall).toBe("pass");
    expect(gate.canShip).toBe(true);
    expect(gate.missingRequirements).toEqual([]);
  });

  it("accepts DONE-style QA verdicts with pass and release-ready prose", () => {
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-1",
          body: [
            "DONE: QA verification completed for COMA-1322.",
            "Fix confirmed: cart.modeStatus.idle is present in es.json and component wiring verified.",
            "Build blocker COMA-1320 is done.",
            "QA PASS - release readiness confirmed.",
          ].join("\n"),
          createdAt: new Date("2026-04-11T11:00:00Z"),
        },
      ],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(gate.review.overall).toBe("pass");
    expect(gate.canShip).toBe(true);
    expect(gate.missingRequirements).toEqual([]);
  });

  it("treats bold Smart Review Summary headings as real summaries but still requires verification evidence", () => {
    const canonicalVerdict = [
      "[QA PASS] [RELEASE CONFIRMED]",
      "",
      "**Smart Review Summary**",
      "",
      "| Item | Finding |",
      "|------|---------|",
      "| CTA | ✅ |",
      "| Mode | ✅ |",
    ].join("\n");

    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-1",
          body: canonicalVerdict,
          createdAt: new Date("2026-04-11T11:00:00Z"),
        },
      ],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(parseQaSummary(canonicalVerdict).hasSummary).toBe(true);
    expect(parseQaVerification(canonicalVerdict).complete).toBe(false);
    expect(gate.canShip).toBe(false);
    expect(gate.missingRequirements).toContain("qa_gate_missing_verification");
    expect(gate.missingRequirements).not.toContain("qa_gate_missing_qa_summary");
  });

  it("accepts equality-style verification tokens on a structured QA verdict during read-time gate synthesis", () => {
    const canonicalVerdict = [
      "[QA PASS]",
      "[RELEASE CONFIRMED]",
      "",
      "Smart Review Summary",
      "Root cause: the QA parser only accepted bracketed verification tokens.",
      "Fix: accept the existing heartbeat equality form without weakening prose-only gating.",
      "Files: server/src/services/qa-gate.ts",
      "",
      "TYPECHECK=pass",
      "TESTS=pass",
      "BUILD=pass",
      "SMOKE/NA=pass",
    ].join("\n");

    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-1",
          body: canonicalVerdict,
          createdAt: new Date("2026-04-11T11:00:00Z"),
        },
      ],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(parseQaVerification(canonicalVerdict)).toMatchObject({
      complete: true,
      overall: "pass",
      verification: {
        typecheck: "pass",
        tests: "pass",
        build: "pass",
        smoke: "pass",
      },
    });
    expect(qaCommentHasExplicitVerificationTokens(canonicalVerdict)).toBe(false);
    expect(gate.canShip).toBe(true);
    expect(gate.missingRequirements).toEqual([]);
  });

  it("does not treat equality-like prose fragments as passing verification tokens", () => {
    const misleadingVerdict = [
      "[QA PASS]",
      "[RELEASE CONFIRMED]",
      "",
      "Smart Review Summary",
      "TYPECHECK=passive",
      "TESTS=passed",
      "BUILD=passerby",
      "SMOKE/NA=passing",
    ].join("\n");

    expect(parseQaVerification(misleadingVerdict)).toMatchObject({
      complete: false,
      overall: "unknown",
      verification: {
        typecheck: "unknown",
        tests: "unknown",
        build: "unknown",
        smoke: "unknown",
      },
    });
    expect(qaCommentHasExplicitVerificationTokens(misleadingVerdict)).toBe(false);
  });

  it("does not treat aspirational QA PASS prose as the latest valid verdict", () => {
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-2",
          body: [
            "Smart Review Summary",
            "Root cause: Safari checkout smoke is still flaky under the latest patch.",
            "Fix: main code path looks correct, but do not ship yet.",
            "Tests: 8/10 passing locally.",
            "Next step: rerun smoke before QA PASS and release readiness confirmed.",
          ].join("\n"),
          createdAt: new Date("2026-04-11T11:30:00Z"),
        },
        {
          id: "comment-1",
          body: [
            "[QA PASS]",
            "[RELEASE CONFIRMED]",
            "",
            "Smart Review Summary",
            "Root cause: modeStatus locale keys were outside the cart namespace.",
            "Fix: moved the keys and verified the component now resolves cart.modeStatus.*.",
            "Tests: 9/9 passing in cart mode regression coverage.",
            "Verification: build verified and release readiness confirmed.",
          ].join("\n"),
          createdAt: new Date("2026-04-11T11:00:00Z"),
        },
      ],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(gate.review.overall).toBe("pass");
    expect(gate.canShip).toBe(true);
    expect(gate.missingRequirements).toEqual([]);
    expect(gate.lastQaSummaryAt?.toISOString()).toBe("2026-04-11T11:00:00.000Z");
  });

  it("ignores QA markers that only appear inside fenced code blocks", () => {
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-2",
          body: [
            "Here is the payload I tried to post:",
            "```json",
            "{",
            '  "body": "[QA PASS] [RELEASE CONFIRMED]\\n\\nSmart Review Summary\\n\\nVerification: build verified."',
            "}",
            "```",
          ].join("\n"),
          createdAt: new Date("2026-04-11T11:30:00Z"),
        },
        {
          id: "comment-1",
          body: [
            "[QA PASS]",
            "[RELEASE CONFIRMED]",
            "",
            "Smart Review Summary",
            "Root cause: modeStatus locale keys were outside the cart namespace.",
            "Fix: moved the keys and verified the component now resolves cart.modeStatus.*.",
            "Tests: 9/9 passing in cart mode regression coverage.",
            "Verification: build verified and release readiness confirmed.",
          ].join("\n"),
          createdAt: new Date("2026-04-11T11:00:00Z"),
        },
      ],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(gate.review.overall).toBe("pass");
    expect(gate.canShip).toBe(true);
    expect(gate.missingRequirements).toEqual([]);
  });

  it("ignores QA markers that only appear inside blockquotes", () => {
    const gate = buildIssueQaGate({
      issue: { status: "in_review" },
      assigneeRole: "engineer",
      qaComments: [
        {
          id: "comment-2",
          body: [
            "Quoted from the previous run:",
            "> [QA PASS]",
            "> [RELEASE CONFIRMED]",
            ">",
            "> Smart Review Summary",
            "> Verification: build verified and release readiness confirmed.",
          ].join("\n"),
          createdAt: new Date("2026-04-11T11:30:00Z"),
        },
        {
          id: "comment-1",
          body: [
            "[QA PASS]",
            "[RELEASE CONFIRMED]",
            "",
            "Smart Review Summary",
            "Root cause: modeStatus locale keys were outside the cart namespace.",
            "Fix: moved the keys and verified the component now resolves cart.modeStatus.*.",
            "Tests: 9/9 passing in cart mode regression coverage.",
            "Verification: build verified and release readiness confirmed.",
          ].join("\n"),
          createdAt: new Date("2026-04-11T11:00:00Z"),
        },
      ],
      latestDecisionOutcome: null,
      now: new Date("2026-04-11T12:00:00Z"),
    });

    expect(gate.review.overall).toBe("pass");
    expect(gate.canShip).toBe(true);
    expect(gate.missingRequirements).toEqual([]);
  });

  it("returns stable reason messages", () => {
    expect(issueQaGateReasonMessage("invalid_status_transition")).toContain("Invalid issue status transition");
    expect(issueQaGateReasonMessage("qa_gate_requires_in_review")).toContain("in_review");
    expect(issueQaGateReasonMessage("qa_gate_missing_qa_comment")).toContain("No QA-authored comment");
    expect(issueQaGateReasonMessage("qa_gate_missing_qa_summary")).toContain("Smart Review");
    expect(issueQaGateReasonMessage("qa_gate_missing_test_coverage_verdict")).toContain("Test Coverage");
    expect(issueQaGateReasonMessage("qa_gate_missing_qa_pass")).toContain("[QA PASS]");
    expect(issueQaGateReasonMessage("qa_gate_missing_release_confirmation")).toContain("[RELEASE CONFIRMED]");
    expect(issueQaGateReasonMessage("qa_gate_missing_verification")).toContain("verification");
    expect(issueQaGateReasonMessage("qa_gate_failing_review")).toContain("failing");
  });
});
