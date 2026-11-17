import { describe, expect, it } from "vitest";
import { firstCursorDiagnosticLine } from "./parse.js";

describe("Cursor diagnostic selection", () => {
  it("skips trace announcements with CRLF, whitespace and ANSI color", () => {
    expect(firstCursorDiagnosticLine("\r\n\x1b[90m cursor-retrieval: tracing to '/tmp/fixture.log' \x1b[0m\r\ncursor-retrieval: tracing to \"/tmp/second.log\"\r\nAuthentication failed\r\nmore detail"))
      .toBe("Authentication failed");
  });

  it("keeps retrieval failures and unknown diagnostic formats", () => {
    for (const line of [
      "cursor-retrieval: failed to open trace file",
      "cursor-retrieval: tracing to '/tmp/fixture.log' failed: permission denied",
      "unknown warning: preserve this diagnostic",
    ]) expect(firstCursorDiagnosticLine(line)).toBe(line);
  });

  it("leaves no diagnostic when only a trace location was printed", () => {
    expect(firstCursorDiagnosticLine("cursor-retrieval: tracing to '/tmp/fixture.log'\n")).toBe("");
    expect(firstCursorDiagnosticLine("\n\r\n")).toBe("");
  });
});
