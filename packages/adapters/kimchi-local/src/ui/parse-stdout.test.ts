import { describe, expect, it } from "vitest";
import { parseKimchiStdoutLine } from "./parse-stdout.js";

const ts = "2026-07-19T00:00:00.000Z";

describe("parseKimchiStdoutLine ACP delegation", () => {
  it("delegates acpx.* events to the shared acpx transcript parser", () => {
    const line = JSON.stringify({ type: "acpx.tool_call", name: "Terminal", status: "pending", text: "Terminal (pending)" });
    const entries = parseKimchiStdoutLine(line, ts);
    // The shared parser produces a structured entry, not the raw stdout fallback.
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.kind !== "stdout")).toBe(true);
  });
});

describe("parseKimchiStdoutLine fallbacks", () => {
  it("renders plain non-JSON lines as raw stdout entries", () => {
    expect(parseKimchiStdoutLine("kimchi says hi", ts)).toEqual([
      { kind: "stdout", ts, text: "kimchi says hi" },
    ]);
  });

  it("renders error events as stderr entries", () => {
    const line = JSON.stringify({ type: "error", message: "boom" });
    expect(parseKimchiStdoutLine(line, ts)).toEqual([
      { kind: "stderr", ts, text: "boom" },
    ]);
  });
});
