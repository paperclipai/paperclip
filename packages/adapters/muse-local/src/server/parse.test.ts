import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isMuseAuthError, parseMuseJsonl } from "./parse.js";

const fixture = (name: string) =>
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", name), "utf8");

describe("parseMuseJsonl", () => {
  it("reads the basic run", () => {
    const parsed = parseMuseJsonl(fixture("exec-basic.jsonl"));
    expect(parsed.sessionId).toBe("01a0df95-ddaf-7cd0-91f4-246c59f925e8");
    expect(parsed.model).toBe("muse-spark-1.3");
    expect(parsed.summary).toBe("MUSE OK");
    expect(parsed.terminal).toBe("completed");
    expect(parsed.reason).toBeNull();
    expect(parsed.toolResultCount).toBe(0);
  });

  it("reads a tool run", () => {
    const parsed = parseMuseJsonl(fixture("exec-tool.jsonl"));
    expect(parsed.summary).toBe("Files: a.txt\n\nDONE");
    expect(parsed.terminal).toBe("completed");
    expect(parsed.toolResultCount).toBe(1);
  });

  it("reads a failed auth run", () => {
    const parsed = parseMuseJsonl(fixture("exec-badkey.jsonl"));
    expect(parsed.terminal).toBe("failed");
    expect(parsed.summary).toBe("");
    expect(parsed.reason).toBe("your API key from META_API_KEY was rejected — update or unset it");
    expect(isMuseAuthError(parsed.reason!)).toBe(true);
  });

  it("falls back to joined deltas when the terminal record is missing", () => {
    const basic = fixture("exec-basic.jsonl").split("\n").filter(Boolean);
    const truncated = basic.filter((line) => !line.includes('"run.terminal.completed"')).join("\n");
    const parsed = parseMuseJsonl(truncated);
    expect(parsed.terminal).toBeNull();
    expect(parsed.summary).toBe("MUSE OK");
  });

  it("ignores garbage lines", () => {
    const parsed = parseMuseJsonl("muse: hello\nnot json\n");
    expect(parsed).toEqual({ sessionId: null, model: null, summary: "", terminal: null, reason: null, toolResultCount: 0 });
  });
});

describe("isMuseAuthError", () => {
  it.each([
    "your API key from META_API_KEY was rejected — update or unset it",
    "No Meta credentials were found. Your message was not sent. Quit Muse Code and run `muse login`.",
    "Your saved Meta credentials are invalid. Your message was not sent.",
    "missing meta credentials: run `muse login` or set META_API_KEY, or save credentials at /home/user/.config/muse/auth.json",
    "missing meta credentials",
  ])("detects %s", (text) => expect(isMuseAuthError(text)).toBe(true));

  it("ignores unrelated errors", () => expect(isMuseAuthError("model overloaded, retry later")).toBe(false));
});
