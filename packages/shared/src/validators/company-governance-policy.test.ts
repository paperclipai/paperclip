import { describe, expect, it } from "vitest";
import {
  governancePolicyDocumentSchema,
  restoreGovernancePolicyRevisionSchema,
} from "./company-governance-policy.js";

const binding = {
  id: "all-protected-runners",
  priority: 100,
  effect: "include",
  subject: { type: "all_agents" },
  scopes: ["heartbeat"],
  delivery: "required",
} as const;

describe("company governance policy validation", () => {
  it("accepts each adapter with a protected policy delivery implementation", () => {
    for (const adapterType of ["codex_local", "paperclip_runner"] as const) {
      expect(governancePolicyDocumentSchema.parse({
        schemaVersion: 1,
        body: "# Policy",
        bindings: [{ ...binding, adapterTypes: [adapterType] }],
      }).bindings[0]?.adapterTypes).toEqual([adapterType]);
    }
  });

  it("rejects duplicate adapter bindings and unsupported delivery targets", () => {
    expect(() => governancePolicyDocumentSchema.parse({
      schemaVersion: 1,
      body: "# Policy",
      bindings: [{ ...binding, adapterTypes: ["paperclip_runner", "paperclip_runner"] }],
    })).toThrow(/unique/i);
    expect(() => governancePolicyDocumentSchema.parse({
      schemaVersion: 1,
      body: "# Policy",
      bindings: [{ ...binding, adapterTypes: ["claude_local"] }],
    })).toThrow();
  });

  it("requires a positive active revision for immutable restore", () => {
    expect(restoreGovernancePolicyRevisionSchema.parse({ expectedRevision: 1 }))
      .toEqual({ expectedRevision: 1 });
    expect(() => restoreGovernancePolicyRevisionSchema.parse({ expectedRevision: 0 })).toThrow();
  });
});
