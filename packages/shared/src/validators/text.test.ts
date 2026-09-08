import { describe, expect, it } from "vitest";

import { multilineTextSchema, normalizeEscapedLineBreaks } from "./text.js";

const BACKSLASH = "\\";

describe("normalizeEscapedLineBreaks", () => {
  it("leaves text without backslashes alone", () => {
    expect(normalizeEscapedLineBreaks("plain prose")).toBe("plain prose");
    expect(normalizeEscapedLineBreaks("")).toBe("");
  });

  it("rewrites a dangling escape into a real line break", () => {
    expect(normalizeEscapedLineBreaks(`one${BACKSLASH}ntwo`)).toBe("one\ntwo");
    expect(normalizeEscapedLineBreaks(`one${BACKSLASH}rtwo`)).toBe("one\ntwo");
  });

  it("collapses an escaped CRLF to a single line break", () => {
    expect(normalizeEscapedLineBreaks(`one${BACKSLASH}r${BACKSLASH}ntwo`)).toBe("one\ntwo");
  });

  it("handles runs of escapes and leading and trailing positions", () => {
    expect(normalizeEscapedLineBreaks(`${BACKSLASH}n${BACKSLASH}n`)).toBe("\n\n");
    expect(normalizeEscapedLineBreaks(`${BACKSLASH}n`)).toBe("\n");
    expect(normalizeEscapedLineBreaks(`end${BACKSLASH}n`)).toBe("end\n");
  });

  it("preserves an escaped backslash followed by the letter n", () => {
    // JUP-26: the old blind substring replace matched the tail of `\\n` and
    // turned a correctly escaped backslash into a real line break.
    const doubled = BACKSLASH + BACKSLASH;
    expect(normalizeEscapedLineBreaks(`${doubled}n`)).toBe(`${doubled}n`);
    expect(normalizeEscapedLineBreaks(`${doubled}r`)).toBe(`${doubled}r`);
    expect(normalizeEscapedLineBreaks(`${doubled}r${doubled}n`)).toBe(`${doubled}r${doubled}n`);
  });

  it("keeps Windows paths and regex sources intact", () => {
    const path = `C:${BACKSLASH}${BACKSLASH}new${BACKSLASH}${BACKSLASH}records`;
    expect(normalizeEscapedLineBreaks(path)).toBe(path);

    const regex = `${BACKSLASH}${BACKSLASH}d+${BACKSLASH}${BACKSLASH}n?`;
    expect(normalizeEscapedLineBreaks(regex)).toBe(regex);
  });

  it("still interprets an escape that follows an escaped backslash", () => {
    const doubled = BACKSLASH + BACKSLASH;
    expect(normalizeEscapedLineBreaks(`${doubled}${BACKSLASH}n`)).toBe(`${doubled}\n`);
    expect(normalizeEscapedLineBreaks(`${doubled}${BACKSLASH}r${BACKSLASH}n`)).toBe(`${doubled}\n`);
  });

  it("leaves escapes it has no opinion about untouched", () => {
    expect(normalizeEscapedLineBreaks(`a${BACKSLASH}tb`)).toBe(`a${BACKSLASH}tb`);
    expect(normalizeEscapedLineBreaks(`say ${BACKSLASH}"hi${BACKSLASH}"`)).toBe(`say ${BACKSLASH}"hi${BACKSLASH}"`);
    expect(normalizeEscapedLineBreaks(`${BACKSLASH}u000a`)).toBe(`${BACKSLASH}u000a`);
    expect(normalizeEscapedLineBreaks(`trailing ${BACKSLASH}`)).toBe(`trailing ${BACKSLASH}`);
  });

  it("keeps real line breaks and carriage returns as they are", () => {
    expect(normalizeEscapedLineBreaks("one\ntwo")).toBe("one\ntwo");
    expect(normalizeEscapedLineBreaks("one\r\ntwo")).toBe("one\r\ntwo");
  });

  it("round-trips NDJSON that carries no dangling escape", () => {
    // JUP-26: every collector stores ActionCandidate NDJSON in a document body.
    // Records whose escapes are all long form or backslash pairs now survive;
    // before this change the pairs alone were enough to corrupt the body.
    const records = [
      { id: 1, rawExcerpt: `C:${BACKSLASH}new${BACKSLASH}temp` },
      { id: 2, rawExcerpt: `a literal ${BACKSLASH}n in the source` },
      { id: 3, rawExcerpt: 'quote " and tab \t' },
      { id: 4, rawExcerpt: `long form ${BACKSLASH}u000a stays put` },
    ];
    const body = records.map((record) => JSON.stringify(record)).join("\n");

    const stored = multilineTextSchema.parse(body);

    expect(stored).toBe(body);
    const lines = stored.split("\n");
    expect(lines).toHaveLength(records.length);
    expect(lines.map((line) => JSON.parse(line))).toEqual(records);
  });

  it("documents the behaviour a real newline in a JSON string still gets", () => {
    // Not fixed here, and deliberately so: interpreting a dangling escape is
    // what this transform is for. A machine-readable body still needs either a
    // verbatim document format or long-form escapes from the writer, because
    // JSON.stringify emits the short form for a real newline.
    const body = JSON.stringify({ rawExcerpt: "line1\nline2" });

    const stored = multilineTextSchema.parse(body);

    expect(stored).not.toBe(body);
    expect(stored.split("\n")).toHaveLength(2);
    expect(() => JSON.parse(stored)).toThrow();
  });

  it("is linear on long runs of backslashes", () => {
    // A parity-aware regex backtracks over each run; a 512 KiB body of
    // backslashes is a realistic worst case for a document body.
    const value = BACKSLASH.repeat(200_000);
    const started = performance.now();
    expect(normalizeEscapedLineBreaks(value)).toBe(value);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
