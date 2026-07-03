import { afterEach, describe, expect, it, vi } from "vitest";
import { printEveStreamEvent } from "./format-event.js";

describe("printEveStreamEvent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not throw on any wrapper shape or garbage input", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const lines = [
      JSON.stringify({ type: "eve.init", sessionId: "s", baseUrl: "http://x", model: "m" }),
      JSON.stringify({ type: "eve.event", event: { type: "message.appended", data: { delta: "a" } } }),
      JSON.stringify({ type: "eve.event", event: { type: "message.completed", data: { text: "done" } } }),
      JSON.stringify({ type: "eve.event", event: { type: "reasoning.completed", data: { text: "t" } } }),
      JSON.stringify({
        type: "eve.event",
        event: { type: "actions.requested", data: { actions: [{ id: "1", name: "tool" }] } },
      }),
      JSON.stringify({ type: "eve.event", event: { type: "action.result", data: { id: "1", result: "r" } } }),
      JSON.stringify({ type: "eve.event", event: { type: "input.requested", data: { prompt: "?" } } }),
      JSON.stringify({ type: "eve.event", event: { type: "session.failed", data: { message: "x" } } }),
      JSON.stringify({ type: "eve.result", status: "completed", summary: "ok" }),
      JSON.stringify({ type: "eve.result", status: "error", error: "bad" }),
      "complete garbage {not json",
      "",
    ];

    for (const debug of [false, true]) {
      for (const line of lines) {
        expect(() => printEveStreamEvent(line, debug)).not.toThrow();
      }
    }

    expect(log).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
});
