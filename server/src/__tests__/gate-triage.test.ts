import { describe, expect, it } from "vitest";
import { GATE_APPROVAL_TYPES } from "@paperclipai/shared";
import {
  forceFullIf,
  resolveEffectiveGateProfile,
  GATE_TRIAGE_MAX_FILES_BEFORE_FULL,
} from "../services/gate-triage.js";
import {
  buildGateApprovalsForActivation,
  planApprovalAgentIds,
  reviewGateAgentIdsFromApprovals,
} from "../services/plan-gates.js";

describe("gate triage — Layer 0 hard-rule floor", () => {
  it("forces full for high-risk surfaces regardless of file count", () => {
    expect(forceFullIf({ touchedPaths: ["server/src/services/auth.ts"] })).toBe(true);
    expect(forceFullIf({ touchedPaths: ["packages/db/src/migrations/004.sql"] })).toBe(true);
    expect(forceFullIf({ touchedPaths: ["server/src/billing/charge.ts"] })).toBe(true);
    expect(forceFullIf({ touchedPaths: ["server/src/routes/issues.ts"] })).toBe(true);
    expect(forceFullIf({ touchedPaths: ["server/src/openapi.ts"] })).toBe(true);
    expect(forceFullIf({ touchedPaths: ["server/src/services/session-token.ts"] })).toBe(true);
  });

  it("does not force full for a benign small change", () => {
    expect(forceFullIf({ touchedPaths: ["CHANGELOG.md", "docs/readme.md"] })).toBe(false);
  });

  it("forces full when file count exceeds the threshold", () => {
    const many = Array.from({ length: GATE_TRIAGE_MAX_FILES_BEFORE_FULL + 1 }, (_, i) => `docs/n${i}.md`);
    expect(forceFullIf({ touchedPaths: many })).toBe(true);
    expect(forceFullIf({ fileCount: GATE_TRIAGE_MAX_FILES_BEFORE_FULL + 1 })).toBe(true);
    expect(forceFullIf({ fileCount: GATE_TRIAGE_MAX_FILES_BEFORE_FULL })).toBe(false);
  });

  it("treats an empty scope as no floor", () => {
    expect(forceFullIf({})).toBe(false);
  });
});

describe("gate triage — resolveEffectiveGateProfile precedence", () => {
  it("raises a downgraded request up to dev_team when the floor fires", () => {
    expect(resolveEffectiveGateProfile("solo", { touchedPaths: ["server/src/services/auth.ts"] }))
      .toBe("dev_team");
    expect(resolveEffectiveGateProfile("light", { fileCount: 99 })).toBe("dev_team");
  });

  it("keeps the requested profile when no floor fires", () => {
    expect(resolveEffectiveGateProfile("solo", { touchedPaths: ["CHANGELOG.md"] })).toBe("solo");
    expect(resolveEffectiveGateProfile("light", {})).toBe("light");
  });

  it("defaults a missing request to none", () => {
    expect(resolveEffectiveGateProfile(undefined, {})).toBe("none");
    expect(resolveEffectiveGateProfile(null, {})).toBe("none");
  });

  it("never lowers an already-full request", () => {
    expect(resolveEffectiveGateProfile("dev_team", {})).toBe("dev_team");
  });
});

describe("gate triage — Layer 2 buildGateApprovalsForActivation by profile", () => {
  const base = {
    planRootIssueId: "root",
    leafIssueIds: ["leaf-1", "leaf-2"],
    designatedByUrlKey: {},
  };

  it("emits no gates for solo or none", () => {
    expect(buildGateApprovalsForActivation({ ...base, gateProfile: "solo" })).toEqual([]);
    expect(buildGateApprovalsForActivation({ ...base, gateProfile: "none" })).toEqual([]);
  });

  it("emits one code-review gate per leaf for light — no plan-approval, no wiring", () => {
    const specs = buildGateApprovalsForActivation({ ...base, gateProfile: "light" });
    expect(specs).toHaveLength(2);
    expect(specs.every((s) => s.type === GATE_APPROVAL_TYPES.codeReview)).toBe(true);
    expect(specs.map((s) => s.issueId)).toEqual(["leaf-1", "leaf-2"]);
  });

  it("emits plan-approval + code-review + wiring for dev_team", () => {
    const specs = buildGateApprovalsForActivation({ ...base, gateProfile: "dev_team" });
    // 1 plan-approval + 2 leaves x (code-review + wiring) = 5
    expect(specs).toHaveLength(5);
    expect(specs.filter((s) => s.type === GATE_APPROVAL_TYPES.planApproval)).toHaveLength(1);
    expect(specs.filter((s) => s.type === GATE_APPROVAL_TYPES.codeReview)).toHaveLength(2);
    expect(specs.filter((s) => s.type === GATE_APPROVAL_TYPES.wiringReview)).toHaveLength(2);
  });

  it("defaults to the full set when no profile is given (back-compat)", () => {
    const specs = buildGateApprovalsForActivation(base);
    expect(specs).toHaveLength(5);
  });
});

describe("gate triage — W5a planApprovalAgentIds (activation-actionable wake targets)", () => {
  const base = {
    planRootIssueId: "root",
    leafIssueIds: ["leaf-1"],
    designatedByUrlKey: { architect: "arch-agent", "code-reviewer": "cr-agent", "wiring-expert": "we-agent" },
  };

  it("returns the architect for a dev_team plan (plan-approval gate is actionable now)", () => {
    const specs = buildGateApprovalsForActivation({ ...base, gateProfile: "dev_team" });
    expect(planApprovalAgentIds(specs)).toEqual(["arch-agent"]);
  });

  it("returns nothing for light or solo (no plan-approval gate)", () => {
    expect(planApprovalAgentIds(buildGateApprovalsForActivation({ ...base, gateProfile: "light" }))).toEqual([]);
    expect(planApprovalAgentIds(buildGateApprovalsForActivation({ ...base, gateProfile: "solo" }))).toEqual([]);
  });

  it("ignores a null designated agent (unstaffed architect role)", () => {
    const specs = buildGateApprovalsForActivation({
      ...base,
      designatedByUrlKey: {},
      gateProfile: "dev_team",
    });
    expect(planApprovalAgentIds(specs)).toEqual([]);
  });
});

describe("gate triage — W5b reviewGateAgentIdsFromApprovals (in_review wake targets)", () => {
  const pending = (type: string, designatedAgentId: unknown) => ({
    type,
    status: "pending",
    payload: { gate: true, designatedAgentId } as Record<string, unknown>,
  });

  it("returns the designated code-review + wiring agents for pending review gates, deduped", () => {
    const approvals = [
      pending(GATE_APPROVAL_TYPES.planApproval, "arch"),
      pending(GATE_APPROVAL_TYPES.codeReview, "cr"),
      pending(GATE_APPROVAL_TYPES.wiringReview, "we"),
    ];
    expect(reviewGateAgentIdsFromApprovals(approvals).sort()).toEqual(["cr", "we"]);
  });

  it("excludes the plan-approval gate (architect is woken at activation, W5a)", () => {
    expect(
      reviewGateAgentIdsFromApprovals([pending(GATE_APPROVAL_TYPES.planApproval, "arch")]),
    ).toEqual([]);
  });

  it("ignores non-pending review gates (already decided)", () => {
    const approvals = [
      { type: GATE_APPROVAL_TYPES.codeReview, status: "approved", payload: { designatedAgentId: "cr" } },
      { type: GATE_APPROVAL_TYPES.wiringReview, status: "rejected", payload: { designatedAgentId: "we" } },
    ];
    expect(reviewGateAgentIdsFromApprovals(approvals)).toEqual([]);
  });

  it("ignores null / missing / empty designatedAgentId (board-routed gate)", () => {
    const approvals = [
      pending(GATE_APPROVAL_TYPES.codeReview, null),
      pending(GATE_APPROVAL_TYPES.wiringReview, ""),
      { type: GATE_APPROVAL_TYPES.codeReview, status: "pending", payload: {} as Record<string, unknown> },
      { type: GATE_APPROVAL_TYPES.wiringReview, status: "pending", payload: null },
    ];
    expect(reviewGateAgentIdsFromApprovals(approvals)).toEqual([]);
  });

  it("dedups when the same agent holds both review gates (light/solo staffing)", () => {
    const approvals = [
      pending(GATE_APPROVAL_TYPES.codeReview, "same"),
      pending(GATE_APPROVAL_TYPES.wiringReview, "same"),
    ];
    expect(reviewGateAgentIdsFromApprovals(approvals)).toEqual(["same"]);
  });

  it("returns [] when there are no review gates", () => {
    expect(reviewGateAgentIdsFromApprovals([])).toEqual([]);
    expect(
      reviewGateAgentIdsFromApprovals([pending(GATE_APPROVAL_TYPES.planApproval, "arch")]),
    ).toEqual([]);
  });
});
