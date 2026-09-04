import { describe, expect, it } from "vitest";
import { parseDevinStdoutLine } from "./parse-stdout.js";

const TS = "2026-07-23T03:00:00.000Z";

describe("parseDevinStdoutLine", () => {
  it("returns assistant text for plain markdown lines", () => {
    const result = parseDevinStdoutLine("This is the answer.", TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "assistant", ts: TS, text: "This is the answer." });
  });

  it("classifies adapter bookkeeping lines as system", () => {
    const result = parseDevinStdoutLine("[adapter] posted response", TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "system", ts: TS, text: "[adapter] posted response" });
  });

  it("strips black-foreground ANSI so review prompts remain readable", () => {
    const black = "\x1b[30mPlease review and approve or request changes.\x1b[0m";
    const result = parseDevinStdoutLine(black, TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("text", "Please review and approve or request changes.");
    expect((result[0] as { text: string }).text).not.toMatch(/\x1b\[/);
  });

  it("strips ANSI from adapter bookkeeping lines before classification", () => {
    const result = parseDevinStdoutLine("\x1b[90m[adapter]\x1b[0m posted", TS);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "system", ts: TS, text: "[adapter] posted" });
  });

  it("ignores lines that are empty after ANSI stripping", () => {
    const result = parseDevinStdoutLine("\x1b[0m   \x1b[0m", TS);
    expect(result).toHaveLength(0);
  });
});
