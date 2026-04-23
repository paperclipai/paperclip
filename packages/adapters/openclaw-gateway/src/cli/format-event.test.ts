import { describe, expect, it, vi } from "vitest";
import { printOpenClawGatewayStreamEvent } from "./format-event.js";

function capture(raw: string, debug: boolean): string[] {
  const calls: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
    calls.push(args.map(String).join(" "));
  });
  try {
    printOpenClawGatewayStreamEvent(raw, debug);
  } finally {
    spy.mockRestore();
  }
  return calls;
}

describe("printOpenClawGatewayStreamEvent", () => {
  it("does nothing for empty string", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printOpenClawGatewayStreamEvent("", false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does nothing for whitespace-only string", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printOpenClawGatewayStreamEvent("   ", false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("prints raw line when debug=false regardless of content", () => {
    const calls = capture("some event data", false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("some event data");
  });

  it("prints openclaw-gateway:event lines in debug mode", () => {
    const calls = capture("[openclaw-gateway:event] something happened", true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("[openclaw-gateway:event]");
  });

  it("prints openclaw-gateway lines in debug mode", () => {
    const calls = capture("[openclaw-gateway] general log", true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("[openclaw-gateway]");
  });

  it("prints other lines in debug mode", () => {
    const calls = capture("arbitrary debug output", true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("arbitrary debug output");
  });

  it("trims leading whitespace from input before processing", () => {
    // The function trims the raw input — an otherwise non-empty line should print
    const calls = capture("  data  ", false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("data");
  });
});
