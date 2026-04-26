import { describe, it, expect, vi, afterEach } from "vitest";
import { printProcessStdoutEvent } from "./format-event.js";

describe("printProcessStdoutEvent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the raw line when non-empty", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printProcessStdoutEvent("process output", false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("process output");
  });

  it("does not log when the line is empty", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printProcessStdoutEvent("", false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not log when the line is whitespace-only", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printProcessStdoutEvent("   \t\n", false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("trims leading and trailing whitespace before logging", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printProcessStdoutEvent("\n  trimmed content\n", false);
    expect(spy).toHaveBeenCalledWith("trimmed content");
  });

  it("ignores the debug flag — always logs non-empty lines", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printProcessStdoutEvent("event data", true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("event data");
  });

  it("preserves special characters in the content", () => {
    const content = '[error] process exited with code 1 — "SIGTERM"';
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printProcessStdoutEvent(content, false);
    expect(spy).toHaveBeenCalledWith(content);
  });
});
