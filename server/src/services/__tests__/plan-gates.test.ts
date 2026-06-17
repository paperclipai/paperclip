import { describe, expect, it } from "vitest";
import { GATE_APPROVAL_TYPES } from "@paperclipai/shared";
import {
  buildGateApprovalsForActivation,
  buildGateWorkspaceContext,
  gatePrecedence,
  gateTypeToReason,
  isGateApprovalType,
  GATE_DESIGNATED_URL_KEY,
} from "../plan-gates.js";

describe("plan-gates", () => {
  it("recognises only the three gate approval types", () => {
    expect(isGateApprovalType("gate_plan_approval")).toBe(true);
    expect(isGateApprovalType("gate_code_review")).toBe(true);
    expect(isGateApprovalType("gate_wiring_review")).toBe(true);
    expect(isGateApprovalType("hire_agent")).toBe(false);
    expect(isGateApprovalType("board_decision")).toBe(false);
  });

  it("maps gate types to blocked-inbox reasons", () => {
    expect(gateTypeToReason(GATE_APPROVAL_TYPES.planApproval)).toBe("pending_plan_approval");
    expect(gateTypeToReason(GATE_APPROVAL_TYPES.codeReview)).toBe("pending_code_review");
    expect(gateTypeToReason(GATE_APPROVAL_TYPES.wiringReview)).toBe("pending_wiring_review");
  });

  it("orders precedence plan > code > wiring; non-gate is lowest", () => {
    expect(gatePrecedence(GATE_APPROVAL_TYPES.planApproval)).toBeLessThan(
      gatePrecedence(GATE_APPROVAL_TYPES.codeReview),
    );
    expect(gatePrecedence(GATE_APPROVAL_TYPES.codeReview)).toBeLessThan(
      gatePrecedence(GATE_APPROVAL_TYPES.wiringReview),
    );
    expect(gatePrecedence("hire_agent")).toBe(Number.POSITIVE_INFINITY);
  });

  it("routes each gate to the right designated urlKey", () => {
    expect(GATE_DESIGNATED_URL_KEY[GATE_APPROVAL_TYPES.planApproval]).toBe("architect");
    expect(GATE_DESIGNATED_URL_KEY[GATE_APPROVAL_TYPES.codeReview]).toBe("code-reviewer");
    expect(GATE_DESIGNATED_URL_KEY[GATE_APPROVAL_TYPES.wiringReview]).toBe("wiring-expert");
  });

  it("builds one plan-approval gate plus code+wiring per leaf with resolved agents", () => {
    const specs = buildGateApprovalsForActivation({
      planRootIssueId: "root",
      leafIssueIds: ["leaf-a", "leaf-b"],
      designatedByUrlKey: {
        architect: "agent-arch",
        "code-reviewer": "agent-cr",
        "wiring-expert": "agent-we",
      },
    });

    // dev_team profile: 1 plan-approval + per leaf (3 code-review lenses + 1 wiring
    // + 1 completeness) = 1 + 2 × 5 = 11.
    expect(specs).toHaveLength(11);
    const plan = specs.find((s) => s.type === GATE_APPROVAL_TYPES.planApproval);
    expect(plan).toMatchObject({ issueId: "root", designatedAgentId: "agent-arch" });

    const leafGates = specs.filter((s) => s.issueId === "leaf-a");
    expect(leafGates).toHaveLength(5);
    expect(leafGates.filter((s) => s.type === GATE_APPROVAL_TYPES.codeReview)).toHaveLength(3);
    expect(leafGates.filter((s) => s.type === GATE_APPROVAL_TYPES.wiringReview)).toHaveLength(1);
    expect(
      leafGates.filter((s) => s.type === GATE_APPROVAL_TYPES.completenessReview),
    ).toHaveLength(1);
    expect(specs.find((s) => s.type === GATE_APPROVAL_TYPES.codeReview)?.designatedAgentId).toBe(
      "agent-cr",
    );
    expect(specs.find((s) => s.type === GATE_APPROVAL_TYPES.wiringReview)?.designatedAgentId).toBe(
      "agent-we",
    );
  });

  it("falls back to null designatedAgentId when a role is unstaffed", () => {
    const specs = buildGateApprovalsForActivation({
      planRootIssueId: "root",
      leafIssueIds: ["leaf"],
      designatedByUrlKey: { architect: null },
    });
    expect(specs.every((s) => s.designatedAgentId === null)).toBe(true);
  });

  it("creates zero leaf gates when there are no leaves", () => {
    const specs = buildGateApprovalsForActivation({
      planRootIssueId: "root",
      leafIssueIds: [],
      designatedByUrlKey: { architect: "a" },
    });
    expect(specs).toHaveLength(1);
    expect(specs[0]!.type).toBe(GATE_APPROVAL_TYPES.planApproval);
  });

  describe("buildGateWorkspaceContext", () => {
    it("includes only the present worktree binding fields", () => {
      expect(
        buildGateWorkspaceContext({
          executionWorkspaceId: "ew-1",
          projectId: "p-1",
          projectWorkspaceId: "pw-1",
        }),
      ).toEqual({
        executionWorkspaceId: "ew-1",
        projectId: "p-1",
        projectWorkspaceId: "pw-1",
      });
    });

    it("omits null/absent fields (no worktree at plan activation)", () => {
      expect(
        buildGateWorkspaceContext({ executionWorkspaceId: null, projectId: "p-1", projectWorkspaceId: null }),
      ).toEqual({ projectId: "p-1" });
      expect(buildGateWorkspaceContext({})).toEqual({});
    });
  });
});
