import { afterEach, describe, expect, it, vi } from "vitest";
import { printGrokStreamEvent } from "./format-event.js";

describe("printGrokStreamEvent", () => {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});

  afterEach(() => {
    spy.mockClear();
  });

  it("prints thought/text/end events", () => {
    printGrokStreamEvent(JSON.stringify({ type: "thought", data: "Plan" }), false);
    printGrokStreamEvent(JSON.stringify({ type: "text", data: "hello" }), false);
    printGrokStreamEvent(JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1" }), false);

    expect(spy.mock.calls.flat()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("thinking: Plan"),
        expect.stringContaining("assistant: hello"),
        expect.stringContaining("Grok run completed"),
      ]),
    );
  });
});
