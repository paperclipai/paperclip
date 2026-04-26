import { describe, it, expect, vi, afterEach } from "vitest";
import { printPaperclipCliBanner } from "./banner.js";

describe("printPaperclipCliBanner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls console.log exactly once", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printPaperclipCliBanner();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("output includes box-drawing ASCII art characters", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printPaperclipCliBanner();
    const output = spy.mock.calls[0]?.[0] as string;
    // The banner renders PAPERCLIP using block/box-drawing glyphs, not literal text
    expect(output).toContain("██████");
  });

  it("output contains the tagline text", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printPaperclipCliBanner();
    const output = spy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Open-source orchestration for zero-human companies");
  });

  it("output spans multiple lines (newlines present)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printPaperclipCliBanner();
    const output = spy.mock.calls[0]?.[0] as string;
    expect(output.split("\n").length).toBeGreaterThan(5);
  });

  it("output starts and ends with empty lines for spacing", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printPaperclipCliBanner();
    const output = spy.mock.calls[0]?.[0] as string;
    const lines = output.split("\n");
    expect(lines[0]).toBe("");
    expect(lines[lines.length - 1]).toBe("");
  });
});
