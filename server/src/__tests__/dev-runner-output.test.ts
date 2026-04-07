import { describe, expect, it } from "vitest";
import { createCapturedOutputBuffer } from "../../../scripts/dev-runner-output.mjs";

describe("createCapturedOutputBuffer", () => {
  it("keeps small output unchanged", () => {
    const capture = createCapturedOutputBuffer(32);
    capture.append("hello");
    capture.append(" world");

    expect(capture.finish()).toEqual({
      text: "hello world",
      totalBytes: 11,
      truncated: false,
    });
  });

  it("retains only the bounded tail when output grows large", () => {
    const capture = createCapturedOutputBuffer(8);
    capture.append("abcd");
    capture.append(Buffer.from("efgh"));
    capture.append("ijkl");

    const result = capture.finish();
    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(12);
    expect(result.text).toContain("total 12 bytes");
    expect(result.text.endsWith("efghijkl")).toBe(true);
  });
});
