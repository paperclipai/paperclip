import { describe, expect, it } from "vitest";
import {
  resolveGovernancePolicyBinding,
  type GovernancePolicyTarget,
} from "./company-governance-policy.js";

const target: GovernancePolicyTarget = {
  agentId: "11111111-1111-4111-8111-111111111111",
  role: "Developer",
  adapterType: "codex_local",
};

describe("resolveGovernancePolicyBinding", () => {
  it("uses deterministic priority and preserves an explicit exclusion", () => {
    const binding = resolveGovernancePolicyBinding([
      {
        id: "include-all",
        priority: 20,
        effect: "include",
        subject: { type: "all_agents" },
        scopes: ["heartbeat"],
        adapterTypes: ["codex_local"],
        delivery: "required",
      },
      {
        id: "exclude-developer",
        priority: 10,
        effect: "exclude",
        subject: { type: "roles", roles: ["developer"] },
        scopes: ["heartbeat"],
        adapterTypes: ["codex_local"],
        delivery: "required",
      },
    ], target);

    expect(binding).toMatchObject({ id: "exclude-developer", effect: "exclude" });
  });

  it("only resolves a compatible delivery target", () => {
    const binding = resolveGovernancePolicyBinding([{
      id: "codex-only",
      priority: 1,
      effect: "include",
      subject: { type: "all_agents" },
      scopes: ["heartbeat"],
      adapterTypes: ["codex_local"],
      delivery: "required",
    }], target);

    expect(binding?.id).toBe("codex-only");
    expect(resolveGovernancePolicyBinding([{
      id: "codex-only",
      priority: 1,
      effect: "include",
      subject: { type: "all_agents" },
      scopes: ["heartbeat"],
      adapterTypes: ["codex_local"],
      delivery: "required",
    }], { ...target, adapterType: "process" })).toBeNull();
  });
});
