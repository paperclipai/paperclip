import { describe, expect, it } from "vitest";
import {
  parseClassificationBlock,
  detectInconsistencies,
  isT3Issue,
  hasGrantedApprovalId,
} from "../lib/authority-classification.ts";

const VALID_T3_DESCRIPTION = `
## Authority Classification

\`\`\`markdown
Authority Classification:
T3

T3 Trigger Check:
- Security-sensitive: Yes
- Real-world cost: No
- Environment integrity risk: No
- Public/reputational action: No
- Strategic fork: No

Approval Required:
Yes

Approval ID:
apr-abc123

Decision Packet Required:
No
\`\`\`
`;

const VALID_T2_DESCRIPTION = `
## Authority Classification

\`\`\`markdown
Authority Classification:
T2

T3 Trigger Check:
- Security-sensitive: No
- Real-world cost: No
- Environment integrity risk: No
- Public/reputational action: No
- Strategic fork: No

Approval Required:
Yes

Approval ID:
(Dranak to approve at PR review)

Decision Packet Required:
No
\`\`\`
`;

const VALID_T1_DESCRIPTION = `
\`\`\`markdown
Authority Classification:
T1

T3 Trigger Check:
- Security-sensitive: No
- Real-world cost: No
- Environment integrity risk: No
- Public/reputational action: No
- Strategic fork: No

Approval Required:
No

Approval ID:

Decision Packet Required:
No
\`\`\`
`;

const NO_BLOCK_DESCRIPTION = `
## Some Issue

This issue has no authority classification block.
`;

const T3_MISSING_APPROVAL_ID = `
\`\`\`markdown
Authority Classification:
T3

T3 Trigger Check:
- Security-sensitive: Yes
- Real-world cost: No
- Environment integrity risk: No
- Public/reputational action: No
- Strategic fork: No

Approval Required:
Yes

Approval ID:
(Required if Approval Required = Yes)

Decision Packet Required:
No
\`\`\`
`;

const INCONSISTENT_TRIGGERS_T2 = `
\`\`\`markdown
Authority Classification:
T2

T3 Trigger Check:
- Security-sensitive: Yes
- Real-world cost: No
- Environment integrity risk: No
- Public/reputational action: No
- Strategic fork: No

Approval Required:
Yes

Approval ID:
some-id

Decision Packet Required:
No
\`\`\`
`;

describe("parseClassificationBlock", () => {
  it("returns found=false when no block is present", () => {
    const result = parseClassificationBlock(NO_BLOCK_DESCRIPTION);
    expect(result.found).toBe(false);
    expect(result.block).toBeNull();
  });

  it("parses a valid T3 block correctly", () => {
    const result = parseClassificationBlock(VALID_T3_DESCRIPTION);
    expect(result.found).toBe(true);
    expect(result.block?.tier).toBe("T3");
    expect(result.block?.t3Triggers.securitySensitive).toBe(true);
    expect(result.block?.t3Triggers.realWorldCost).toBe(false);
    expect(result.block?.approvalRequired).toBe(true);
    expect(result.block?.approvalId).toBe("apr-abc123");
    expect(result.inconsistencies).toHaveLength(0);
  });

  it("parses a valid T2 block correctly", () => {
    const result = parseClassificationBlock(VALID_T2_DESCRIPTION);
    expect(result.found).toBe(true);
    expect(result.block?.tier).toBe("T2");
    expect(result.block?.t3Triggers.securitySensitive).toBe(false);
    expect(result.block?.approvalId).toBeNull(); // placeholder stripped
    expect(result.inconsistencies).toHaveLength(0);
  });

  it("parses a valid T1 block correctly", () => {
    const result = parseClassificationBlock(VALID_T1_DESCRIPTION);
    expect(result.found).toBe(true);
    expect(result.block?.tier).toBe("T1");
    expect(result.block?.approvalRequired).toBe(false);
    expect(result.inconsistencies).toHaveLength(0);
  });

  it("detects missing approval ID on T3 with approvalRequired=Yes", () => {
    const result = parseClassificationBlock(T3_MISSING_APPROVAL_ID);
    expect(result.found).toBe(true);
    expect(result.block?.tier).toBe("T3");
    expect(result.block?.approvalId).toBeNull();
    expect(result.inconsistencies).toContain(
      "Approval Required is Yes but Approval ID is missing or placeholder",
    );
  });

  it("detects T3 trigger active but tier < T3 inconsistency", () => {
    const result = parseClassificationBlock(INCONSISTENT_TRIGGERS_T2);
    expect(result.found).toBe(true);
    expect(result.block?.tier).toBe("T2");
    expect(result.inconsistencies.some((i) => i.includes("T3 triggers are active"))).toBe(true);
  });

  it("handles empty description gracefully", () => {
    const result = parseClassificationBlock("");
    expect(result.found).toBe(false);
    expect(result.block).toBeNull();
  });
});

describe("isT3Issue", () => {
  it("returns true for T3 classified issues", () => {
    const result = parseClassificationBlock(VALID_T3_DESCRIPTION);
    expect(isT3Issue(result)).toBe(true);
  });

  it("returns false for T2 classified issues", () => {
    const result = parseClassificationBlock(VALID_T2_DESCRIPTION);
    expect(isT3Issue(result)).toBe(false);
  });

  it("returns false for T1 classified issues", () => {
    const result = parseClassificationBlock(VALID_T1_DESCRIPTION);
    expect(isT3Issue(result)).toBe(false);
  });

  it("returns false when no block is present", () => {
    const result = parseClassificationBlock(NO_BLOCK_DESCRIPTION);
    expect(isT3Issue(result)).toBe(false);
  });
});

describe("hasGrantedApprovalId", () => {
  it("returns true when a non-placeholder approvalId is present", () => {
    const result = parseClassificationBlock(VALID_T3_DESCRIPTION);
    expect(hasGrantedApprovalId(result)).toBe(true);
  });

  it("returns false when approvalId is a placeholder", () => {
    const result = parseClassificationBlock(T3_MISSING_APPROVAL_ID);
    expect(hasGrantedApprovalId(result)).toBe(false);
  });

  it("returns false for T2 with placeholder approvalId", () => {
    const result = parseClassificationBlock(VALID_T2_DESCRIPTION);
    expect(hasGrantedApprovalId(result)).toBe(false);
  });
});

describe("detectInconsistencies", () => {
  it("reports no inconsistencies for a clean T1 block", () => {
    const result = parseClassificationBlock(VALID_T1_DESCRIPTION);
    expect(detectInconsistencies(result.block!)).toHaveLength(0);
  });

  it("reports T3-tier-with-no-active-triggers inconsistency", () => {
    const block = {
      tier: "T3" as const,
      t3Triggers: {
        securitySensitive: false,
        realWorldCost: false,
        environmentIntegrityRisk: false,
        publicReputationalAction: false,
        strategicFork: false,
      },
      approvalRequired: true,
      approvalId: "some-id",
      decisionPacketRequired: false,
    };
    const issues = detectInconsistencies(block);
    expect(issues.some((i) => i.includes("no T3 triggers are active"))).toBe(true);
  });
});
