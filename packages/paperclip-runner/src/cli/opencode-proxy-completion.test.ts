import { describe, expect, it, vi } from "vitest";
import { openCodeProxyCompletionFeedback } from "./opencode-proxy-input.js";
import type { PrpStructuredRunResult } from "../protocol/replay-contract.js";

const result = { reportedWorkDisposition: "done" } as PrpStructuredRunResult;
const call = { tool: "paperclip_finish", callId: "call-finish", threadId: "thread", turnId: "turn" };

describe("OpenCode controller completion feedback", () => {
  it.each(["paperclip_finish", "paperclip_block"])("preserves %s identity and exact accepted response text", async tool => {
    const feedback = "Include [Saved document](/PAP/issues/PAP-1#document-plan) in your final response.";
    const request = vi.fn().mockResolvedValue({ success: true, contentItems: [{ type: "inputText", text: feedback }] });
    await expect(openCodeProxyCompletionFeedback(request)(result, { ...call, tool })).resolves.toBe(feedback);
    expect(request).toHaveBeenCalledExactlyOnceWith("item/tool/call", { ...call, tool, arguments: result });
  });

  it("preserves the controller rejection for same-turn correction", async () => {
    const request = vi.fn().mockResolvedValue({ success: false, contentItems: [{ type: "inputText", text: "Resolve the pending approval first." }] });
    await expect(openCodeProxyCompletionFeedback(request)(result, call)).rejects.toThrow("Resolve the pending approval first.");
  });

  it.each([null, { accepted: true }, { success: true }, { success: true, contentItems: [{ type: "inputText", text: "" }] }, { success: true, contentItems: [{ type: "image", text: "accepted" }] }])("fails closed for malformed acceptance %j", async response => {
    await expect(openCodeProxyCompletionFeedback(vi.fn().mockResolvedValue(response))(result, call)).rejects.toThrow(/Completion controller/);
  });
});
