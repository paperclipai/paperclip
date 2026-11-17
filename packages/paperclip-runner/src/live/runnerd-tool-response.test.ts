import { describe, expect, it } from "vitest";
import { unwrapToolResponse } from "./runnerd-codex-transport.js";

describe("runnerd semantic tool response", () => {
  it("preserves the validated ACPX terminal acknowledgement envelope", () => {
    const response = { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ ok: true, accepted: true }) }] };
    expect(unwrapToolResponse(response, true)).toEqual({ __paperclipSemanticToolOutcome: true, result: response, isError: false });
    expect(unwrapToolResponse(response)).toEqual({ __paperclipSemanticToolOutcome: true, result: { ok: true, accepted: true }, isError: false });
  });
  it("keeps denial feedback and does not promote rejected terminal reports to success", () => {
    const response = { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ ok: false, denial: { code: "stale_completion_contract" } }) }] };
    expect(unwrapToolResponse(response, true)).toMatchObject({ isError: true, result: { success: false } });
  });

  it.each(["Call connections_search and use the saved draft ID.", '{"error":"Specify exact toolNames"}'])("preserves the provider-facing error envelope: %s", text => {
    const response = { success: false, contentItems: [{ type: "inputText", text }] };
    expect(unwrapToolResponse(response)).toEqual({ __paperclipSemanticToolOutcome: true, isError: true, result: response });
  });

  it("still unwraps successful JSON results", () => {
    expect(unwrapToolResponse({ success: true, contentItems: [{ type: "inputText", text: '{"connectionId":"draft"}' }] }))
      .toMatchObject({ isError: false, result: { connectionId: "draft" } });
  });
});
