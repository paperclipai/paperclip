import { describe, expect, it } from "vitest";
import { appendSemanticToolReceipt, parseSemanticToolReceipt, readNativeSemanticReceipt, semanticInputSha256 } from "./semantic-tool-receipt.js";
const call = { tool: "paperclip_finish", callId: "3", arguments: { revision: "current", summary: "private" } };
const original = { content: [{ type: "text" as const, text: '{"accepted":false}' }] };
describe("bounded semantic receipt carrier", () => {
  it("preserves existing content and transport-vs-semantic acceptance", () => {
    const { result, receipt } = appendSemanticToolReceipt(call, original);
    expect(result.content.slice(0, -1)).toEqual(original.content);
    expect(receipt.outcome).toBe("returned");
    expect(JSON.stringify(receipt)).not.toContain("private");
    expect(readNativeSemanticReceipt({ contents: result.content })).toEqual(receipt);
    expect(semanticInputSha256({ a: 1, b: 2 })).toBe(semanticInputSha256({ b: 2, a: 1 }));
  });
  it("preserves error content without converting error into returned acceptance", () => {
    const { result, receipt } = appendSemanticToolReceipt(call, { ...original, isError: true });
    expect(result.isError).toBe(true);
    expect(receipt.outcome).toBe("error");
    expect(readNativeSemanticReceipt({ contents: result.content })).toEqual(receipt);
  });
  it.each(["unknown", "malformed", "oversized", "modified", "duplicate", "missing", "type", "reordered"])("rejects %s native carrier", kind => {
    const { result } = appendSemanticToolReceipt(call, original);
    const blocks = structuredClone(result.content);
    const receipt = JSON.parse(blocks.at(-1)!.text);
    if (kind === "unknown") blocks.at(-1)!.text = JSON.stringify({ ...receipt, extra: "private" });
    if (kind === "malformed") blocks.at(-1)!.text = "{";
    if (kind === "oversized") blocks.at(-1)!.text = "x".repeat(2049);
    if (kind === "modified") blocks[0]!.text = "different";
    if (kind === "duplicate") blocks.unshift(blocks.at(-1)!);
    if (kind === "missing") blocks.pop();
    if (kind === "type") Object.assign(blocks[0]!, { type: "image" });
    if (kind === "reordered") blocks.reverse();
    expect(readNativeSemanticReceipt({ contents: blocks })).toBeNull();
  });
  it("bounds the whole repeated native output while still serializing large-result receipts", () => {
    const bound = appendSemanticToolReceipt(call, { content: [{ type: "text", text: "x".repeat(90_000) }] });
    expect(readNativeSemanticReceipt({ contents: bound.result.content })).toEqual(bound.receipt);
    expect(readNativeSemanticReceipt({ contents: bound.result.content, content: "x".repeat(90_000), detailedContent: "x".repeat(90_000) })).toBeNull();
    expect(bound.result.content.at(-1)!.text.length).toBeLessThan(2048);
  });
  it("rejects unknown fields and unsafe identities without truncation", () => {
    const { receipt } = appendSemanticToolReceipt(call, original);
    expect(parseSemanticToolReceipt({ ...receipt, operationId: "bad\nname" })).toBeNull();
    expect(parseSemanticToolReceipt({ ...receipt, inputSha256: "a".repeat(65) })).toBeNull();
    expect(parseSemanticToolReceipt({ ...receipt, outcome: "accepted" })).toBeNull();
  });
  it("keeps raw and forwarded input identities separate and versions historical receipts honestly", () => {
    const normalizedInputSha256 = semanticInputSha256({ ...call.arguments, schema: "paperclip.run_result.v1" });
    const { receipt, result } = appendSemanticToolReceipt({ ...call, normalizedInputSha256 }, original);
    expect(receipt).toMatchObject({ schema: "paperclip.semantic_tool_receipt.v2", normalizedInputSha256,
      inputSha256: semanticInputSha256(call.arguments) });
    expect(receipt.inputSha256).not.toBe(normalizedInputSha256);
    expect(readNativeSemanticReceipt({ contents: result.content })).toEqual(receipt);
    expect(appendSemanticToolReceipt(call, original).receipt).toHaveProperty("normalizedInputSha256", null);
    const { normalizedInputSha256: _, ...legacyFields } = receipt as typeof receipt & { normalizedInputSha256: unknown };
    const legacy = { ...legacyFields, schema: "paperclip.semantic_tool_receipt.v1" };
    expect(parseSemanticToolReceipt(legacy)).toEqual(legacy);
    expect(parseSemanticToolReceipt({ ...legacy, normalizedInputSha256 })).toBeNull();
    expect(parseSemanticToolReceipt({ ...receipt, normalizedInputSha256: "null" })).toBeNull();
    expect(parseSemanticToolReceipt({ ...receipt, normalizedInputSha256: "a".repeat(65) })).toBeNull();
    expect(parseSemanticToolReceipt({ ...legacyFields, schema: "paperclip.semantic_tool_receipt.v2" })).toBeNull();
  });
});
