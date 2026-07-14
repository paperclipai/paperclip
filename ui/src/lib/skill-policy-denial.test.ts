import { describe, expect, it } from "vitest";

import { ApiError } from "../api/client";
import {
  classifySkillDenial,
  SKILL_PLATFORM_INVARIANT_CODES,
  SKILL_POLICY_ADMIN_CODE,
  SKILL_POLICY_DENIAL_CODE,
} from "./skill-policy-denial";

function apiError(status: number, body: unknown): ApiError {
  return new ApiError("Request failed", status, body);
}

describe("classifySkillDenial", () => {
  it("returns null for non-ApiError inputs (State A / unexpected)", () => {
    expect(classifySkillDenial(new Error("boom"))).toBeNull();
    expect(classifySkillDenial(null)).toBeNull();
    expect(classifySkillDenial("nope")).toBeNull();
  });

  it("returns null for transient errors so the caller keeps the retry toast (State D)", () => {
    expect(classifySkillDenial(apiError(409, { code: "issue_run_conflict" }))).toBeNull();
    expect(classifySkillDenial(apiError(500, { error: "Internal error" }))).toBeNull();
    expect(classifySkillDenial(apiError(422, { error: "This skill does not support updates." }))).toBeNull();
  });

  it("classifies an explicit company-policy denial as State B (policy) with EE remediation", () => {
    const denial = classifySkillDenial(
      apiError(403, {
        code: SKILL_POLICY_DENIAL_CODE,
        reason: "explicit_rule",
        action: "skills.install",
        matchedRuleId: "deny-external-packages",
        remediation: "Contact a company administrator to change the skill policy.",
      }),
      "Installing external skills",
    );
    expect(denial).not.toBeNull();
    expect(denial?.state).toBe("policy");
    expect(denial?.allowsEeRemediation).toBe(true);
    expect(denial?.title).toBe("Installing external skills is restricted by your company policy.");
    expect(denial?.remediation).toBe("Contact a company administrator to change the skill policy.");
  });

  it("recognises a policy denial from reason alone (policy_default) and falls back to default remediation", () => {
    const denial = classifySkillDenial(apiError(403, { reason: "policy_default" }));
    expect(denial?.state).toBe("policy");
    expect(denial?.title).toBe("This action is restricted by your company policy.");
    expect(denial?.remediation).toContain("administrator can change the skill policy");
  });

  it("classifies the policy-admin requirement as State C (platform_admin) but still EE-remediable", () => {
    const denial = classifySkillDenial(apiError(403, { code: SKILL_POLICY_ADMIN_CODE }));
    expect(denial?.state).toBe("platform_admin");
    expect(denial?.allowsEeRemediation).toBe(true);
    expect(denial?.title).toContain("administration access");
  });

  it.each(SKILL_PLATFORM_INVARIANT_CODES)(
    "classifies platform invariant %s as State C with no EE remediation",
    (code) => {
      const denial = classifySkillDenial(apiError(403, { code, reason: "platform_invariant" }));
      expect(denial?.state).toBe("platform");
      expect(denial?.allowsEeRemediation).toBe(false);
      expect(denial?.title.length).toBeGreaterThan(0);
      expect(denial?.remediation.length).toBeGreaterThan(0);
    },
  );

  it("prefers a server-supplied remediation over the default for platform invariants", () => {
    const denial = classifySkillDenial(
      apiError(403, {
        code: "skill_workspace_boundary_denied",
        reason: "platform_invariant",
        remediation: "Import from an approved managed-skill root.",
      }),
    );
    expect(denial?.remediation).toBe("Import from an approved managed-skill root.");
  });

  it("treats reason=platform_invariant without a known code as a generic safety block", () => {
    const denial = classifySkillDenial(apiError(403, { reason: "platform_invariant" }));
    expect(denial?.state).toBe("platform");
    expect(denial?.title).toContain("platform safety rule");
    expect(denial?.allowsEeRemediation).toBe(false);
  });

  it("never surfaces raw rule internals — only title + remediation are exposed", () => {
    const denial = classifySkillDenial(
      apiError(403, {
        code: SKILL_POLICY_DENIAL_CODE,
        reason: "explicit_rule",
        matchedRuleId: "secret-internal-rule-id",
      }),
      "Editing skills",
    );
    // matchedRuleId must not leak into any user-facing string.
    expect(JSON.stringify(denial)).not.toContain("secret-internal-rule-id");
  });
});
