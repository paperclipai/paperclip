import { describe, expect, it } from "vitest";
import { PLUGIN_EVENT_TYPES } from "@paperclipai/shared";

/**
 * Regression test for the missing approval.approved / approval.rejected event types.
 *
 * Previously PLUGIN_EVENT_TYPES only contained "approval.decided", which was never
 * emitted by any route. Approvals routes emit "approval.approved" and
 * "approval.rejected" — plugins (e.g. Discord) subscribing to those events would
 * never receive them because the event bus filtered them out.
 */
describe("approval plugin event types", () => {
  it("includes approval.approved so plugins can subscribe to approval decisions", () => {
    expect(PLUGIN_EVENT_TYPES).toContain("approval.approved");
  });

  it("includes approval.rejected so plugins can subscribe to approval rejections", () => {
    expect(PLUGIN_EVENT_TYPES).toContain("approval.rejected");
  });
});
