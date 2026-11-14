import { describe, expect, it } from "vitest";
import {
  isT3CommandUnsupported,
  isT3ProjectNotFound,
  isT3ServerUnavailable,
  isT3ThreadNotFound,
  parseT3RunResult,
  parseT3StopStatus,
  parseT3ThreadList,
} from "./parse.js";

describe("t3 CLI output parsing", () => {
  it("takes the last JSON result line and ignores log lines", () => {
    const stdout = [
      "{\"note\":\"not a result\"}",
      "starting",
      JSON.stringify({ threadId: "t1", runId: "r1", status: "completed", reply: "hi", error: null }),
      "",
    ].join("\n");
    expect(parseT3RunResult(stdout)).toEqual({ threadId: "t1", runId: "r1", status: "completed", reply: "hi", error: null });
    expect(parseT3RunResult("No JSON here\n{broken")).toBeNull();
  });

  it("reads stop statuses and thread lists", () => {
    expect(parseT3StopStatus(`${JSON.stringify({ threadId: "t1", runId: null, status: "no_active_run" })}\n`)).toBe("no_active_run");
    expect(parseT3StopStatus("")).toBeNull();
    expect(parseT3ThreadList(`${JSON.stringify([{ threadId: "t1", title: "A" }, { nope: 1 }])}\n`)).toEqual([{ threadId: "t1", title: "A" }]);
    expect(parseT3ThreadList("[]\n")).toEqual([]);
    expect(parseT3ThreadList("error\n")).toBeNull();
  });

  it("classifies the CLI's error messages", () => {
    expect(isT3ServerUnavailable("No running T3 Code server uses /home/u/.t3. Start T3 Code, then retry.")).toBe(true);
    expect(isT3ServerUnavailable("Could not reach the T3 Code server at http://127.0.0.1:3773.")).toBe(true);
    expect(isT3ProjectNotFound("No T3 Code project matches '/w'. Pass a project id or a path inside a project.")).toBe(true);
    expect(isT3ThreadNotFound("Thread abc was not found.")).toBe(true);
    expect(isT3ThreadNotFound("'x y' is not a thread id.")).toBe(true);
    expect(isT3ThreadNotFound("Thread abc stopped with status failed")).toBe(false);
    expect(isT3CommandUnsupported('Unknown subcommand "stop" for "t3 thread"')).toBe(true);
    expect(isT3CommandUnsupported("Unrecognized command: stop")).toBe(true);
    expect(isT3CommandUnsupported("Thread abc was not found.")).toBe(false);
  });
});
