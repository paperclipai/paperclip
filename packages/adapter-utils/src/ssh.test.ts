import { describe, expect, it } from "vitest";
import { shellQuote } from "./ssh.js";

describe("shellQuote", () => {
  it("wraps a plain string in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes with the standard POSIX form", () => {
    // 'it'\''s' parses back to: it's
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("escapes multiple single quotes", () => {
    expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it("leaves double quotes and backslashes intact", () => {
    expect(shellQuote('say "hi" \\')).toBe("'say \"hi\" \\'");
  });

  it("produces a string that bash parses back to the original value", () => {
    const cases = [
      "hello world",
      "it's a test",
      'printf \'@echo off\\r\\n\'',
      'PSCMD="\\$p = Start-Process -FilePath \\"$NODE_WIN\\""',
      "unclosed'quote'and'more",
    ];
    for (const value of cases) {
      const quoted = shellQuote(value);
      // Round-trip through bash -c echo to prove the quoting survives.
      const { execFileSync } = require("node:child_process");
      const out = execFileSync("bash", ["-c", `printf '%s' ${quoted}`], {
        encoding: "utf8",
      });
      expect(out).toBe(value);
    }
  });
});
