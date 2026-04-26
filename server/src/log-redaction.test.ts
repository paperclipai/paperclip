// @vitest-environment node
import { describe, expect, it } from "vitest";
import { maskUserNameForLogs, redactCurrentUserText, redactCurrentUserValue } from "./log-redaction.js";

// ============================================================================
// maskUserNameForLogs
// ============================================================================

describe("maskUserNameForLogs", () => {
  it("masks all but the first character", () => {
    expect(maskUserNameForLogs("alice")).toBe("a****");
  });

  it("preserves the first character", () => {
    const result = maskUserNameForLogs("bob");
    expect(result.startsWith("b")).toBe(true);
  });

  it("masks a single-character username with one asterisk", () => {
    expect(maskUserNameForLogs("a")).toBe("a*");
  });

  it("returns fallback for empty string", () => {
    expect(maskUserNameForLogs("")).toBe("*");
  });

  it("returns fallback for whitespace-only string", () => {
    expect(maskUserNameForLogs("   ")).toBe("*");
  });

  it("accepts a custom fallback", () => {
    expect(maskUserNameForLogs("", "[redacted]")).toBe("[redacted]");
  });

  it("trims leading/trailing whitespace before masking", () => {
    expect(maskUserNameForLogs("  alice  ")).toBe("a****");
  });

  it("produces the correct number of asterisks", () => {
    const result = maskUserNameForLogs("charlie");
    expect(result).toBe("c******");
  });
});

// ============================================================================
// redactCurrentUserText — tested with explicit opts to avoid OS dependency
// ============================================================================

describe("redactCurrentUserText", () => {
  it("returns empty string unchanged", () => {
    expect(redactCurrentUserText("", { userNames: ["alice"], homeDirs: ["/home/alice"] })).toBe("");
  });

  it("returns input unchanged when enabled=false", () => {
    const input = "/home/alice/project";
    expect(redactCurrentUserText(input, { enabled: false })).toBe(input);
  });

  it("replaces home directory with masked version", () => {
    const result = redactCurrentUserText("/home/alice/project", {
      userNames: ["alice"],
      homeDirs: ["/home/alice"],
    });
    expect(result).not.toContain("/home/alice");
    expect(result).toContain("/home/");
  });

  it("replaces standalone username with masked version", () => {
    const result = redactCurrentUserText("Hello alice, how are you?", {
      userNames: ["alice"],
      homeDirs: [],
    });
    expect(result).not.toContain("alice");
    expect(result).toContain("a****");
  });

  it("does not replace username that is part of a longer word", () => {
    const result = redactCurrentUserText("invalice or alices", {
      userNames: ["alice"],
      homeDirs: [],
    });
    // "invalice" contains "alice" as substring preceded by letter — should NOT be replaced
    // "alices" contains "alice" followed by letter — should NOT be replaced
    expect(result).toBe("invalice or alices");
  });

  it("handles Windows-style home directory paths", () => {
    const result = redactCurrentUserText("C:\\Users\\alice\\Documents", {
      userNames: ["alice"],
      homeDirs: ["C:\\Users\\alice"],
    });
    expect(result).not.toContain("C:\\Users\\alice");
  });

  it("redacts home directory using masked username, not replacing alice literally", () => {
    const result = redactCurrentUserText("path /home/alice/file", {
      userNames: ["alice"],
      homeDirs: ["/home/alice"],
    });
    // The home path is replaced with a masked version of the last segment
    expect(result).not.toContain("/home/alice/");
    expect(result).toContain("a****");
  });

  it("handles multiple usernames, replacing all occurrences", () => {
    const result = redactCurrentUserText("alice and bob are users", {
      userNames: ["alice", "bob"],
      homeDirs: [],
    });
    expect(result).not.toContain("alice");
    expect(result).not.toContain("bob");
  });
});

// ============================================================================
// redactCurrentUserValue — typed recursive redaction
// ============================================================================

describe("redactCurrentUserValue", () => {
  const opts = { userNames: ["alice"], homeDirs: ["/home/alice"] };

  it("returns non-string primitives unchanged", () => {
    expect(redactCurrentUserValue(42, opts)).toBe(42);
    expect(redactCurrentUserValue(true, opts)).toBe(true);
    expect(redactCurrentUserValue(null, opts)).toBeNull();
  });

  it("redacts strings", () => {
    const result = redactCurrentUserValue("path: /home/alice/code", opts);
    expect(result).not.toContain("/home/alice");
  });

  it("recursively redacts strings in arrays", () => {
    const result = redactCurrentUserValue(["/home/alice/a", "/home/alice/b"], opts);
    expect(result[0]).not.toContain("/home/alice");
    expect(result[1]).not.toContain("/home/alice");
  });

  it("recursively redacts strings in plain objects", () => {
    const result = redactCurrentUserValue({ path: "/home/alice/project" }, opts);
    expect(result.path).not.toContain("/home/alice");
  });

  it("recursively redacts nested objects", () => {
    const result = redactCurrentUserValue(
      { outer: { inner: "/home/alice/deep" } },
      opts,
    );
    expect(result.outer.inner).not.toContain("/home/alice");
  });

  it("does not redact class instances (non-plain objects)", () => {
    class MyClass {
      value = "/home/alice/path";
    }
    const instance = new MyClass();
    const result = redactCurrentUserValue(instance, opts);
    // Should return the instance unchanged since it's not a plain object
    expect(result).toBe(instance);
  });
});
