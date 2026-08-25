import { describe, expect, it } from "vitest";
import {
  resolveRuntimeToolPolicy,
  runtimeToolPolicyAllows,
  runtimeToolPolicyDenies,
  summarizeRuntimeToolPolicy,
} from "./runtime-tool-policy.js";

describe("runtime tool policy resolver", () => {
  it("resolves blind_judge to the full default deny surface", () => {
    const policy = resolveRuntimeToolPolicy({
      agentRuntimeConfig: {
        runtimeToolPolicy: {
          profile: "blind_judge",
          allow: ["web.fetch"],
          deny: ["mcp.server:github"],
        },
      },
    });

    expect(policy.profile).toBe("blind_judge");
    expect(policy.enforcement).toBe("required");
    expect(policy.restricted).toBe(true);
    expect(policy.source).toBe("agent_runtime_config");
    expect(runtimeToolPolicyAllows(policy, "web.fetch")).toBe(true);
    expect(runtimeToolPolicyDenies(policy, "web.search")).toBe(true);
    expect(runtimeToolPolicyDenies(policy, "web.fetch")).toBe(true);
    expect(runtimeToolPolicyDenies(policy, "mcp.server:github")).toBe(true);
    expect(runtimeToolPolicyDenies(policy, "mcp.server:filesystem")).toBe(true);
    expect(runtimeToolPolicyDenies(policy, "connector:gmail")).toBe(true);
    expect(runtimeToolPolicyDenies(policy, "plugin:browser-tools")).toBe(true);
    expect(runtimeToolPolicyDenies(policy, "network.outbound")).toBe(true);
    expect(policy.paperclipReadIssueIds).toEqual([]);
  });

  it("normalizes the blind judge Paperclip document-read scope", () => {
    const policy = resolveRuntimeToolPolicy({
      agentRuntimeConfig: {
        runtimeToolPolicy: {
          profile: "blind_judge",
          paperclipReadIssueIds: [" RES-3 ", "RES-3", "RES-4", 17],
        },
      },
    });

    expect(policy.paperclipReadIssueIds).toEqual(["RES-3", "RES-4"]);
  });

  it("lets context policy override agent runtime config for run-scoped resolution", () => {
    const policy = resolveRuntimeToolPolicy({
      agentRuntimeConfig: { runtimeToolPolicy: { profile: "blind_judge" } },
      context: { paperclipRuntimeToolPolicy: { enforcement: "best_effort" } },
    });

    expect(policy.profile).toBeNull();
    expect(policy.enforcement).toBe("best_effort");
    expect(policy.restricted).toBe(false);
    expect(policy.source).toBe("context");
  });

  it("summarizes the resolved policy for adapter metadata", () => {
    const policy = resolveRuntimeToolPolicy({
      agentRuntimeConfig: { runtimeToolPolicy: { profile: "blind_judge", paperclipReadIssueIds: ["RES-3"] } },
    });

    expect(summarizeRuntimeToolPolicy(policy)).toContain("runtimeToolPolicy(profile=blind_judge");
    expect(summarizeRuntimeToolPolicy(policy)).toContain("network.outbound");
    expect(summarizeRuntimeToolPolicy(policy)).toContain("paperclipReadIssueIds=RES-3");
  });
});
