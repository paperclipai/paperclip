import { afterEach, describe, expect, it, vi } from "vitest";
import { printAgyStreamEvent } from "./format-event.js";
import { AGY_INIT_LINE, AGY_RESULT_LINE, AGY_TOOL_DONE_LINE } from "../test-fixtures.js";

function capture(line: string): string[] {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  printAgyStreamEvent(line, false);
  return spy.mock.calls.map((c) => String(c[0]));
}

describe("printAgyStreamEvent", () => {
  afterEach(() => vi.restoreAllMocks());

  it("formats init", () => {
    expect(capture(AGY_INIT_LINE).join("\n")).toContain("agy init: model=gemini-3.8-flash-low");
  });

  it("formats a tool step", () => {
    expect(capture(AGY_TOOL_DONE_LINE).join("\n")).toContain("tool: ls");
  });

  it("formats result", () => {
    const out = capture(AGY_RESULT_LINE).join("\n");
    expect(out).toContain("assistant: hi");
    expect(out).toContain("result: SUCCESS in=3 out=2");
  });
});
