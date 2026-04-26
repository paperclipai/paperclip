import { describe, it, expect, vi, afterEach } from "vitest";
import { printHttpStdoutEvent } from "./format-event.js";

describe("printHttpStdoutEvent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the raw line when non-empty", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printHttpStdoutEvent("hello world", false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("hello world");
  });

  it("does not log when the line is empty", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printHttpStdoutEvent("", false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not log when the line is whitespace-only", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printHttpStdoutEvent("   ", false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("trims leading and trailing whitespace before logging", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printHttpStdoutEvent("  trimmed  ", false);
    expect(spy).toHaveBeenCalledWith("trimmed");
  });

  it("ignores the debug flag — always logs non-empty lines", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printHttpStdoutEvent("data", true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("data");
  });

  it("preserves JSON content without modification", () => {
    const json = '{"type":"result","cost":0.001}';
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printHttpStdoutEvent(json, false);
    expect(spy).toHaveBeenCalledWith(json);
  });
});
