import { describe, expect, it } from "vitest";
import { acpxAttachmentInput, parseNativeUserAttachments, MAX_NATIVE_ATTACHMENT_BYTES, MAX_NATIVE_USER_MESSAGE_JSON_BYTES, validateNativeUserMessageSize } from "./user-attachments.js";
describe("authorized native attachment contract", () => {
  const text = { schema: "paperclip.user_attachment.v1", kind: "text", mediaType: "text/markdown", name: "notes.md", text: "Inspect this document" };
  it("keeps ordinary message calls backward compatible", () => {
    expect(acpxAttachmentInput("Hello", undefined)).toEqual({ text: "Hello" });
    expect(acpxAttachmentInput("Read", [text]).text).toContain(text.text);
  });
  it.each([
    { ...text, url: "https://example.com/private" },
    { ...text, path: "/private/file" }, { ...text, mediaType: "application/pdf" },
    { ...text, text: "a".repeat(MAX_NATIVE_ATTACHMENT_BYTES + 1) },
    { ...text, kind: "image", data: "%%%", mediaType: "image/png", text: undefined },
  ])("rejects unsupported resources and oversized content before provider dispatch", attachment => {
    expect(() => parseNativeUserAttachments([attachment])).toThrow();
  });
  it("returns independent content and applies a total bound", () => {
    expect(parseNativeUserAttachments([text])[0]).not.toBe(text);
    expect(() => parseNativeUserAttachments(Array(5).fill({ ...text, text: "a".repeat(MAX_NATIVE_ATTACHMENT_BYTES) }))).toThrow();
  });
  it.each(["\\", "\u0001"])("rejects encoded text expansion before provider dispatch (%j)", character => {
    // Raw content stays within both limits; JSON escaping exceeds the wire budget.
    const attachments = Array(2).fill({ ...text, text: character.repeat(MAX_NATIVE_ATTACHMENT_BYTES) });
    expect(() => parseNativeUserAttachments(attachments)).toThrow("encoded content limit");
  });
  it("counts the message and attachment metadata in the same encoded budget", () => {
    const attachments = parseNativeUserAttachments([{ ...text, text: "a".repeat(MAX_NATIVE_ATTACHMENT_BYTES) }]);
    const message = "\u0001".repeat(1024 * 1024);
    expect(() => validateNativeUserMessageSize(message, attachments)).toThrow("encoded content limit");
    expect(() => acpxAttachmentInput(message, attachments)).toThrow("encoded content limit");
    const boundary = "a".repeat(MAX_NATIVE_USER_MESSAGE_JSON_BYTES - Buffer.byteLength(JSON.stringify({ text: "", attachments })));
    expect(() => validateNativeUserMessageSize(boundary, attachments)).not.toThrow();
    expect(() => validateNativeUserMessageSize(boundary + "a", attachments)).toThrow("encoded content limit");
  });
});
