import { describe, expect, it } from "vitest";
import { parseT3CodeStdoutLine } from "./parse-stdout.js";

describe("parseT3CodeStdoutLine", () => {
  it("renders the result line as reply, error, and status", () => {
    const line = JSON.stringify({ threadId: "t1", runId: "r1", status: "failed", reply: null, error: "boom" });
    expect(parseT3CodeStdoutLine(line, "ts")).toEqual([
      { kind: "stderr", ts: "ts", text: "boom" },
      { kind: "system", ts: "ts", text: "T3 Code thread t1: failed" },
    ]);
    const done = JSON.stringify({ threadId: "t1", runId: "r1", status: "completed", reply: "Done", error: null });
    expect(parseT3CodeStdoutLine(done, "ts")[0]).toEqual({ kind: "assistant", ts: "ts", text: "Done" });
  });

  it("passes other lines through", () => {
    expect(parseT3CodeStdoutLine("[paperclip] note", "ts")).toEqual([{ kind: "stdout", ts: "ts", text: "[paperclip] note" }]);
  });
});
