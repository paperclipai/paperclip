import { describe, expect, it } from "vitest";

import { resolveDurableGoalAcpxPermissionMode } from "../services/heartbeat.js";

describe("resolveDurableGoalAcpxPermissionMode", () => {
  it.each([
    ["canonical native", { acpxPermissionMode: "deny-all" }, "deny-all"],
    ["current direct-adapter", { permissionMode: "approve-reads" }, "approve-reads"],
    ["legacy direct-adapter", { acpPermissionMode: "deny-all" }, "deny-all"],
    ["explicit unrestricted", { permissionMode: "approve-all" }, "approve-all"],
  ])("inherits the %s policy", (_label, config, expected) => {
    expect(resolveDurableGoalAcpxPermissionMode(config)).toBe(expected);
  });

  it("prefers the canonical native policy over compatibility aliases", () => {
    expect(resolveDurableGoalAcpxPermissionMode({
      acpxPermissionMode: "deny-all",
      permissionMode: "approve-all",
      acpPermissionMode: "approve-all",
    })).toBe("deny-all");
  });

  it.each([{}, { permissionMode: "unexpected" }, null])(
    "defaults missing or invalid policy to approve-reads",
    (config) => {
      expect(resolveDurableGoalAcpxPermissionMode(config)).toBe("approve-reads");
    },
  );
});
