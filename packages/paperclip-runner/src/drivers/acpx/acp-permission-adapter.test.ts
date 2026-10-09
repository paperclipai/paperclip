import { describe, expect, it } from "vitest";
import type { AcpPermissionRequest } from "acpx/runtime";
import { normalizeAcpxPermission } from "./acp-permission-adapter.js";

function request(kinds = ["allow_once", "allow_always", "reject_once"]): AcpPermissionRequest {
  return { sessionId: "session", inferredKind: "edit", raw: {
    sessionId: "session", toolCall: { toolCallId: "call", title: "Edit source" },
    options: kinds.map((kind, i) => ({ kind, optionId: `option-${i}`, name: kind })),
  } } as AcpPermissionRequest;
}
describe("ACP permission normalization", () => {
  it("keeps requests answerable when a provider omits its operation title", () => {
    for (const title of [undefined, "", "   "]) {
      const value = request();
      value.raw.toolCall.title = title;
      expect(normalizeAcpxPermission(value).title).toBe("Approve provider operation");
    }
  });
  it("offers only native choices and preserves cancellation", () => {
    const value = normalizeAcpxPermission(request(["allow_once"]));
    expect(value.choices.map(c => c.key)).toEqual(["accept", "cancel"]);
    expect(value.resolve({ action: "accept" })).toEqual({ outcome: "allow_once" });
    expect(value.resolve({ action: "cancel" })).toEqual({ outcome: "cancel" });
    expect(() => value.resolve({ action: "accept_for_session" })).toThrow("offered choice");
    expect(() => value.resolve({ action: "submit", content: { accept: true } })).toThrow("offered choice");
  });
  it("maps once, session and denial distinctly", () => {
    const value = normalizeAcpxPermission(request(), { allowAlwaysScope: "session" });
    expect(value.resolve({ action: "accept_for_session" })).toEqual({ outcome: "allow_always" });
    expect(value.resolve({ action: "decline" })).toEqual({ outcome: "reject_once" });
  });
  it("does not label an unverified persistent allowance as session-only", () => {
    const value = normalizeAcpxPermission(request());
    expect(value.choices.map(choice => choice.key)).toEqual(["accept", "decline", "cancel"]);
    expect(() => value.resolve({ action: "accept_for_session" })).toThrow("offered choice");
  });
  it("does not turn a one-time denial into permanent rejection", () => {
    expect(normalizeAcpxPermission(request(["reject_always"])).choices).toEqual([{ key: "cancel", label: "Cancel" }]);
  });
  it("rejects ambiguous provider choices before any resolution", () => {
    expect(() => normalizeAcpxPermission(request(["allow_once", "allow_once"]))).toThrow("ambiguous");
    const duplicate = request(); duplicate.raw.options[1]!.optionId = duplicate.raw.options[0]!.optionId;
    expect(() => normalizeAcpxPermission(duplicate)).toThrow("ambiguous");
  });
});
