import { describe, expect, it } from "vitest";
import { createStreamingUtf8Accumulator } from "./ssh.js";

describe("createStreamingUtf8Accumulator", () => {
  it("keeps multilingual text exact across writes", () => {
    const expected = "مرحبا / Привет / 체크리스트 / 你好 / 😀";
    const acc = createStreamingUtf8Accumulator();
    acc.write(Buffer.from(expected, "utf8"));
    expect(acc.flush()).toBe(expected);
    expect(acc.flush()).not.toContain("?");
    expect(acc.flush()).not.toContain("\uFFFD");
  });

  it("reassembles a 3-byte UTF-8 glyph split across Buffer chunks", () => {
    const bytes = Buffer.from("你", "utf8");
    expect(bytes.length).toBe(3);
    const acc = createStreamingUtf8Accumulator();
    acc.write(bytes.subarray(0, 1));
    expect(acc.text).toBe("");
    acc.write(bytes.subarray(1));
    expect(acc.flush()).toBe("你");
    expect(acc.flush()).not.toContain("\uFFFD");
    expect(acc.flush()).not.toContain("?");
  });

  it("leaves ASCII-only output unchanged", () => {
    const acc = createStreamingUtf8Accumulator();
    acc.write(Buffer.from("hello world", "utf8"));
    acc.write(" and more");
    expect(acc.flush()).toBe("hello world and more");
  });
});
