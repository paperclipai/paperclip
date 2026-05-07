import { describe, expect, it } from "vitest";
import {
  REDACTED_HOME_PATH_USER,
  redactHomePathUserSegments,
  redactHomePathUserSegmentsInValue,
  redactTranscriptEntryPaths,
} from "./log-redaction.js";
import type { TranscriptEntry } from "./types.js";

describe("redactHomePathUserSegments", () => {
  it("masks /Users/<name> POSIX paths preserving first char + length", () => {
    expect(redactHomePathUserSegments("/Users/alice/repos")).toBe("/Users/a****/repos");
  });

  it("masks /home/<name> Linux paths", () => {
    expect(redactHomePathUserSegments("/home/spooty/code")).toBe("/home/s*****/code");
  });

  it("masks Windows C:\\Users\\<name> paths preserving drive letter + prefix", () => {
    expect(redactHomePathUserSegments("C:\\Users\\Bob\\Desktop")).toBe("C:\\Users\\B**\\Desktop");
    expect(redactHomePathUserSegments("D:\\Users\\Alice\\Docs")).toBe("D:\\Users\\A****\\Docs");
  });

  it("masks every occurrence in a single string (regex global flag)", () => {
    const input = "/home/alice/x and /home/bob/y";
    expect(redactHomePathUserSegments(input)).toBe("/home/a****/x and /home/b**/y");
  });

  it("guarantees at least one '*' even for single-char users (Math.max floor)", () => {
    expect(redactHomePathUserSegments("/Users/a/file")).toBe("/Users/a*/file");
  });

  it("falls back to the bare REDACTED sentinel for an empty user segment", () => {
    // The pattern requires at least one non-slash char so an empty segment
    // can't actually match -- but the helper itself accepts whitespace-only
    // input via maskHomePathUserSegment and returns the sentinel.
    expect(REDACTED_HOME_PATH_USER).toBe("*");
  });

  it("counts grapheme length not byte length (Array.from + spread)", () => {
    // 4 visible chars but multi-byte; mask stays char-accurate.
    const out = redactHomePathUserSegments("/home/josé/file");
    // 'j' kept, 3 stars for 'osé'.
    expect(out).toBe("/home/j***/file");
  });

  it("returns the input unchanged when opts.enabled === false", () => {
    expect(
      redactHomePathUserSegments("/home/alice/x", { enabled: false }),
    ).toBe("/home/alice/x");
  });

  it("redacts when opts is omitted (default-on)", () => {
    expect(redactHomePathUserSegments("/home/alice/x")).toBe("/home/a****/x");
  });

  it("leaves non-home paths untouched", () => {
    expect(redactHomePathUserSegments("/etc/passwd")).toBe("/etc/passwd");
    expect(redactHomePathUserSegments("/var/log/foo")).toBe("/var/log/foo");
  });
});

describe("redactHomePathUserSegmentsInValue", () => {
  it("redacts inside a top-level string", () => {
    expect(redactHomePathUserSegmentsInValue("/home/alice")).toBe("/home/a****");
  });

  it("recurses into arrays preserving order", () => {
    const out = redactHomePathUserSegmentsInValue([
      "/home/alice/a",
      "/Users/bob/b",
    ]);
    expect(out).toEqual(["/home/a****/a", "/Users/b**/b"]);
  });

  it("recurses into plain objects redacting every string value", () => {
    const out = redactHomePathUserSegmentsInValue({
      cwd: "/home/alice/repo",
      meta: { home: "/Users/bob" },
    });
    expect(out).toEqual({
      cwd: "/home/a****/repo",
      meta: { home: "/Users/b**" },
    });
  });

  it("returns numbers / booleans / null untouched (passthrough for primitives)", () => {
    expect(redactHomePathUserSegmentsInValue(42)).toBe(42);
    expect(redactHomePathUserSegmentsInValue(true)).toBe(true);
    expect(redactHomePathUserSegmentsInValue(null)).toBe(null);
  });

  it("does NOT recurse into class instances (only plain objects)", () => {
    class Holder {
      home = "/home/alice";
    }
    const inst = new Holder();
    const out = redactHomePathUserSegmentsInValue(inst);
    // Identity preserved -- isPlainObject rejects non-Object prototypes
    // so the instance falls through unmodified.
    expect(out).toBe(inst);
    expect(out.home).toBe("/home/alice");
  });

  it("respects opts.enabled across recursion", () => {
    const out = redactHomePathUserSegmentsInValue(
      { cwd: "/home/alice" },
      { enabled: false },
    );
    expect(out).toEqual({ cwd: "/home/alice" });
  });
});

describe("redactTranscriptEntryPaths", () => {
  it("redacts text on assistant/thinking/user/stderr/system/stdout/diff", () => {
    const kinds = ["assistant", "thinking", "user", "stderr", "system", "stdout"] as const;
    for (const kind of kinds) {
      const entry = { kind, ts: "t", text: "/home/alice/x" } as TranscriptEntry;
      const out = redactTranscriptEntryPaths(entry);
      expect((out as { text: string }).text).toBe("/home/a****/x");
    }

    const diff: TranscriptEntry = {
      kind: "diff",
      ts: "t",
      changeType: "add",
      text: "/home/alice/y",
    };
    const out = redactTranscriptEntryPaths(diff);
    expect((out as { text: string }).text).toBe("/home/a****/y");
  });

  it("redacts both name and structured input on tool_call entries", () => {
    const entry: TranscriptEntry = {
      kind: "tool_call",
      ts: "t",
      name: "/home/alice/bin/tool",
      input: { cwd: "/Users/bob/x" },
    };
    const out = redactTranscriptEntryPaths(entry);
    expect(out.kind).toBe("tool_call");
    if (out.kind === "tool_call") {
      expect(out.name).toBe("/home/a****/bin/tool");
      expect(out.input).toEqual({ cwd: "/Users/b**/x" });
    }
  });

  it("redacts the content blob on tool_result entries", () => {
    const entry: TranscriptEntry = {
      kind: "tool_result",
      ts: "t",
      toolUseId: "u1",
      content: "ran in /home/alice/repo",
      isError: false,
    };
    const out = redactTranscriptEntryPaths(entry);
    if (out.kind === "tool_result") {
      expect(out.content).toBe("ran in /home/a****/repo");
    }
  });

  it("redacts model + sessionId on init entries", () => {
    const entry: TranscriptEntry = {
      kind: "init",
      ts: "t",
      model: "/home/alice/model",
      sessionId: "/Users/bob/session",
    };
    const out = redactTranscriptEntryPaths(entry);
    if (out.kind === "init") {
      expect(out.model).toBe("/home/a****/model");
      expect(out.sessionId).toBe("/Users/b**/session");
    }
  });

  it("redacts text + subtype + every error string on result entries", () => {
    const entry: TranscriptEntry = {
      kind: "result",
      ts: "t",
      text: "/home/alice/done",
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
      costUsd: 0,
      subtype: "/Users/bob/sub",
      isError: true,
      errors: ["/home/eve/oops", "no path here"],
    };
    const out = redactTranscriptEntryPaths(entry);
    if (out.kind === "result") {
      expect(out.text).toBe("/home/a****/done");
      expect(out.subtype).toBe("/Users/b**/sub");
      expect(out.errors).toEqual(["/home/e**/oops", "no path here"]);
    }
  });

  it("returns input unchanged when redaction disabled", () => {
    const entry: TranscriptEntry = {
      kind: "user",
      ts: "t",
      text: "/home/alice/x",
    };
    const out = redactTranscriptEntryPaths(entry, { enabled: false });
    expect((out as { text: string }).text).toBe("/home/alice/x");
  });
});
