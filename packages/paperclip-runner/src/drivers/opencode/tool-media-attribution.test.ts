import { describe, expect, it } from "vitest";
import { attributeUnsupportedToolMedia, OPENCODE_SYNTHETIC_ATTACHMENT_PROMPT } from "./tool-media-attribution.js";

const header = { type: "text", text: OPENCODE_SYNTHETIC_ATTACHMENT_PROMPT };
const imageError = { type: "text", text: "ERROR: Cannot read image (this model does not support image input). Inform the user." };
const assistantCall = (ids: string[]) => ({
  role: "assistant",
  content: "",
  tool_calls: ids.map(id => ({ id, type: "function", function: { name: "read", arguments: "{}" } })),
});

describe("attributeUnsupportedToolMedia", () => {
  it("moves the unreadable-image notice into the producing tool result", () => {
    const payload = { messages: [
      { role: "user", content: "verify the page" },
      assistantCall(["a"]),
      { role: "tool", tool_call_id: "a", content: "Image read successfully" },
      { role: "user", content: [header, imageError] },
    ] };
    expect(attributeUnsupportedToolMedia(payload)).toBe(true);
    expect(payload.messages).toHaveLength(3);
    expect(payload.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "a",
      content: expect.stringMatching(/^Image read successfully\n\n\[Paperclip runner: This tool result included an image attachment that this model cannot read because it does not accept image input, so it was not shown to you\. .* not from the user, and needs no reply\.\]$/),
    });
  });

  it("names the file and keeps readable media in the synthetic message", () => {
    const pdf = { type: "file", file: { filename: "brief.pdf", file_data: "data:application/pdf;base64,AA==" } };
    const payload = { messages: [
      { role: "user", content: "go" },
      assistantCall(["a", "b"]),
      { role: "tool", tool_call_id: "a", content: "PDF read successfully" },
      { role: "tool", tool_call_id: "b", content: "Image read successfully" },
      { role: "user", content: [header, pdf, { type: "text", text: "ERROR: Cannot read \"shot.png\" (this model does not support image input). Inform the user." }] },
      { role: "assistant", content: "next step" },
    ] };
    expect(attributeUnsupportedToolMedia(payload)).toBe(true);
    expect(payload.messages[2].content).toBe("PDF read successfully");
    expect(payload.messages[3].content).toContain("A tool result in this step included an image attachment (shot.png)");
    expect(payload.messages[4]).toEqual({ role: "user", content: [header, pdf] });
    expect(payload.messages[5]).toEqual({ role: "assistant", content: "next step" });
  });

  it("is deterministic across repeated requests for the same history", () => {
    const build = () => ({ messages: [
      assistantCall(["a"]),
      { role: "tool", tool_call_id: "a", content: "Image read successfully" },
      { role: "user", content: [header, imageError] },
    ] });
    const first = build();
    const second = build();
    attributeUnsupportedToolMedia(first);
    attributeUnsupportedToolMedia(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(attributeUnsupportedToolMedia(first)).toBe(false);
  });

  it("leaves person-authored messages and unrelated payloads untouched", () => {
    const personImage = { messages: [
      { role: "user", content: [{ type: "text", text: "what is in this?" }, imageError] },
    ] };
    const unanchored = { messages: [
      { role: "assistant", content: "hi" },
      { role: "user", content: [header, imageError] },
    ] };
    const snapshot = JSON.stringify([personImage, unanchored]);
    expect(attributeUnsupportedToolMedia(personImage)).toBe(false);
    expect(attributeUnsupportedToolMedia(unanchored)).toBe(false);
    expect(attributeUnsupportedToolMedia({ messages: [{ role: "user", content: "hi" }] })).toBe(false);
    expect(attributeUnsupportedToolMedia({})).toBe(false);
    expect(JSON.stringify([personImage, unanchored])).toBe(snapshot);
  });
});
