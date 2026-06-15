/**
 * B1 distinct-lens parallel reviewers — unit tests.
 *   - buildGateApprovalsForActivation produces per-lens code-review specs for dev_team
 *   - reviewGateAgentIdsFromApprovals returns per-approval wake targets with lensKey
 *   - code-reviewer AGENTS.md contains lens-mode section and all three lens keys
 */

import { describe, expect, it } from "vitest";
import { GATE_APPROVAL_TYPES } from "@paperclipai/shared";
import {
  buildGateApprovalsForActivation,
  reviewGateAgentIdsFromApprovals,
  REVIEW_GATE_LENSES,
} from "../services/plan-gates.js";
import { loadDefaultAgentInstructionsBundle } from "../services/default-agent-instructions.js";

const BASE = {
  planRootIssueId: "root",
  leafIssueIds: ["leaf-1"],
  designatedByUrlKey: {
    architect: "arch",
    "code-reviewer": "cr",
    "wiring-expert": "we",
  },
};

describe("B1 — buildGateApprovalsForActivation: dev_team creates per-lens code-review specs", () => {
  it("creates one code-review spec per lens per leaf", () => {
    const specs = buildGateApprovalsForActivation({ ...BASE, gateProfile: "dev_team" });
    const crSpecs = specs.filter((s) => s.type === GATE_APPROVAL_TYPES.codeReview);
    expect(crSpecs).toHaveLength(REVIEW_GATE_LENSES.length);
    const lensKeys = crSpecs.map((s) => s.lensKey).sort();
    expect(lensKeys).toEqual([...REVIEW_GATE_LENSES].sort());
  });

  it("each code-review spec has a non-null lensKey for dev_team", () => {
    const specs = buildGateApprovalsForActivation({ ...BASE, gateProfile: "dev_team" });
    const crSpecs = specs.filter((s) => s.type === GATE_APPROVAL_TYPES.codeReview);
    expect(crSpecs.every((s) => s.lensKey != null)).toBe(true);
  });

  it("light profile: single generalist code-review (no lensKey)", () => {
    const specs = buildGateApprovalsForActivation({ ...BASE, gateProfile: "light" });
    expect(specs).toHaveLength(1);
    expect(specs[0]?.type).toBe(GATE_APPROVAL_TYPES.codeReview);
    expect(specs[0]?.lensKey).toBeUndefined();
  });

  it("wiring-review spec never has a lensKey", () => {
    const specs = buildGateApprovalsForActivation({ ...BASE, gateProfile: "dev_team" });
    const wiringSpecs = specs.filter((s) => s.type === GATE_APPROVAL_TYPES.wiringReview);
    expect(wiringSpecs).toHaveLength(1);
    expect(wiringSpecs[0]?.lensKey).toBeUndefined();
  });

  it("scalability lens is present (catches unbounded queries)", () => {
    const specs = buildGateApprovalsForActivation({ ...BASE, gateProfile: "dev_team" });
    const scalabilitySpec = specs.find(
      (s) => s.type === GATE_APPROVAL_TYPES.codeReview && s.lensKey === "scalability",
    );
    expect(scalabilitySpec).toBeDefined();
    expect(scalabilitySpec?.designatedAgentId).toBe("cr");
  });
});

describe("B1 — reviewGateAgentIdsFromApprovals: per-approval wake targets with lensKey", () => {
  it("returns one target per pending lens approval (3 lenses = 3 targets for same agent)", () => {
    let id = 0;
    const approvals = REVIEW_GATE_LENSES.map((lensKey) => ({
      id: `appr-${++id}`,
      type: GATE_APPROVAL_TYPES.codeReview,
      status: "pending",
      payload: { gate: true, designatedAgentId: "cr", lensKey } as Record<string, unknown>,
    }));
    const targets = reviewGateAgentIdsFromApprovals(approvals);
    expect(targets).toHaveLength(REVIEW_GATE_LENSES.length);
    expect(targets.every((t) => t.agentId === "cr")).toBe(true);
    const returnedLenses = targets.map((t) => t.lensKey).sort();
    expect(returnedLenses).toEqual([...REVIEW_GATE_LENSES].sort());
  });

  it("each target includes approvalId matching the source approval", () => {
    const approvals = [
      {
        id: "approval-xyz",
        type: GATE_APPROVAL_TYPES.codeReview,
        status: "pending",
        payload: { designatedAgentId: "cr", lensKey: "scalability" } as Record<string, unknown>,
      },
    ];
    const targets = reviewGateAgentIdsFromApprovals(approvals);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.approvalId).toBe("approval-xyz");
    expect(targets[0]?.lensKey).toBe("scalability");
  });

  it("wiring-review target has lensKey: null (no lens on wiring gate)", () => {
    const approvals = [
      {
        id: "wiring-appr",
        type: GATE_APPROVAL_TYPES.wiringReview,
        status: "pending",
        payload: { designatedAgentId: "we" } as Record<string, unknown>,
      },
    ];
    const targets = reviewGateAgentIdsFromApprovals(approvals);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.lensKey).toBeNull();
  });
});

describe("B1 — code-reviewer AGENTS.md contains lens-mode instructions", () => {
  it("onboarding-assets AGENTS.md includes the lens-mode section header", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("code-reviewer");
    const content = bundle["AGENTS.md"] ?? "";
    expect(content, "missing lens-mode section").toContain("Lens mode");
  });

  it("all three lens keys are documented in AGENTS.md", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("code-reviewer");
    const content = bundle["AGENTS.md"] ?? "";
    for (const lensKey of REVIEW_GATE_LENSES) {
      expect(content, `missing lens key '${lensKey}'`).toContain(lensKey);
    }
  });

  it("scalability lens mentions unbounded queries and LIMIT", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("code-reviewer");
    const content = bundle["AGENTS.md"] ?? "";
    const lensSection = content.slice(content.indexOf("scalability"));
    expect(lensSection).toContain("LIMIT");
  });
});
