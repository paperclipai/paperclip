import { describe, expect, it, vi } from "vitest";
import { SemanticToolOutcomeUnknownError } from "../../vendor/paperclip-runner/index.js";
import { captureRunnerToolResult, fitRunnerToolResultPage, RUNNER_TOOL_RESULT_MAX_BYTES } from "./runner-tool-results.js";

describe("assigned tool result capture", () => {
  it("leaves small governed results inline without storage admission", async () => {
    const result = { data: { untrusted: true, content: "small result" } };
    const io = { reserveResponseCapture: vi.fn(), saveResponse: vi.fn() };
    expect(await captureRunnerToolResult(result, io)).toBe(result);
    expect(io.reserveResponseCapture).not.toHaveBeenCalled();
    expect(io.saveResponse).not.toHaveBeenCalled();
  });

  it("delivers a 480 KB result inline without extra page reads", async () => {
    const result = { content: "x".repeat(480_000) };
    const io = { reserveResponseCapture: vi.fn(async () => async () => {}),
      saveResponse: vi.fn(async () => ({ artifactId: "saved" })) };
    expect(await captureRunnerToolResult(result, io)).toBe(result);
    expect(io.saveResponse).not.toHaveBeenCalled();
  });

  it.each([500_000, 500_001])("captures only results above the encoded budget (%s bytes)", async byteSize => {
    const result = { content: "x".repeat(byteSize - Buffer.byteLength(JSON.stringify({ content: "" }))) };
    const saveResponse = vi.fn(async (bytes: Buffer) => ({ artifactId: "saved", byteSize: bytes.length }));
    const response = await captureRunnerToolResult(result, {
      reserveResponseCapture: async () => async () => {}, saveResponse,
    });
    if (byteSize === 500_000) {
      expect(response).toBe(result);
      expect(saveResponse).not.toHaveBeenCalled();
    } else {
      expect(response).toMatchObject({ artifact: { byteSize } });
      expect(saveResponse.mock.calls[0]![0].toString("utf8")).toBe(JSON.stringify(result));
    }
  });

  it("fits escape-heavy Unicode pages without losing text or corrupting offsets", () => {
    const original = JSON.stringify({ content: '🧭é"\\\n\u0000'.repeat(60_000), last: "complete-result" });
    const bytes = Buffer.from(original);
    let offsetBytes = 0;
    let restored = "";
    let pages = 0;
    do {
      // Match the HTTP reader's UTF-8-safe raw byte window.
      let end = Math.min(offsetBytes + 500_000, bytes.length);
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
      const response = fitRunnerToolResultPage({ ok: true,
        responseText: { offsetBytes, nextOffsetBytes: end < bytes.length ? end : null, totalBytes: bytes.length },
        data: bytes.subarray(offsetBytes, end).toString("utf8") });
      const encoded = Buffer.byteLength(JSON.stringify(response));
      expect(encoded).toBeLessThanOrEqual(RUNNER_TOOL_RESULT_MAX_BYTES);
      if (response.responseText!.nextOffsetBytes !== null) expect(encoded).toBeGreaterThan(499_980);
      restored += response.data;
      pages++;
      const next = response.responseText!.nextOffsetBytes;
      if (next === null) break;
      expect(next).toBeGreaterThan(offsetBytes);
      expect(next).toBe(Buffer.byteLength(restored));
      offsetBytes = next;
    } while (pages < 20);
    expect(restored).toBe(original);
    expect(JSON.parse(restored)).toEqual(JSON.parse(original));
    expect(pages).toBeLessThan(10);
  });

  it.each(["reserve", "save", "settle"])("preserves completed actions as uncertain when %s fails", async stage => {
    const fail = async () => { throw new Error("private provider response must not be exposed"); };
    const settle = vi.fn(stage === "settle" ? fail : async () => undefined);
    const io = {
      reserveResponseCapture: vi.fn(stage === "reserve" ? fail : async () => settle),
      saveResponse: vi.fn(stage === "save" ? fail : async () => ({ artifactId: "saved" })),
    };
    const error = await captureRunnerToolResult({ content: "x".repeat(600_000) }, io).catch(error => error);
    expect(error).toBeInstanceOf(SemanticToolOutcomeUnknownError);
    expect(error).toMatchObject({ message: "The completed app-tool result could not be saved." });
    expect(io.reserveResponseCapture).toHaveBeenCalledOnce();
    expect(io.saveResponse).toHaveBeenCalledTimes(stage === "reserve" ? 0 : 1);
  });
});
