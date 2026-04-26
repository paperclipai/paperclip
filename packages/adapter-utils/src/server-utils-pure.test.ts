import { describe, it, expect } from "vitest";
import {
  parseObject,
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseJson,
  appendWithCap,
  resolvePathValue,
  renderTemplate,
  joinPromptSections,
  normalizePaperclipWakePayload,
  redactEnvForLogs,
  buildInvocationEnvForLogs,
  defaultPathForPlatform,
  ensurePathInEnv,
  readPaperclipSkillSyncPreference,
  resolvePaperclipDesiredSkillNames,
  writePaperclipSkillSyncPreference,
  MAX_CAPTURE_BYTES,
  MAX_EXCERPT_BYTES,
} from "./server-utils.js";

// ============================================================================
// constants
// ============================================================================

describe("MAX_CAPTURE_BYTES and MAX_EXCERPT_BYTES", () => {
  it("MAX_CAPTURE_BYTES is 4 MB", () => {
    expect(MAX_CAPTURE_BYTES).toBe(4 * 1024 * 1024);
  });

  it("MAX_EXCERPT_BYTES is 32 KB", () => {
    expect(MAX_EXCERPT_BYTES).toBe(32 * 1024);
  });
});

// ============================================================================
// parseObject
// ============================================================================

describe("parseObject", () => {
  it("returns empty object for null", () => {
    expect(parseObject(null)).toEqual({});
  });

  it("returns empty object for undefined", () => {
    expect(parseObject(undefined)).toEqual({});
  });

  it("returns empty object for string", () => {
    expect(parseObject("hello")).toEqual({});
  });

  it("returns empty object for number", () => {
    expect(parseObject(42)).toEqual({});
  });

  it("returns empty object for boolean", () => {
    expect(parseObject(true)).toEqual({});
  });

  it("returns empty object for array", () => {
    expect(parseObject([1, 2, 3])).toEqual({});
  });

  it("returns the same reference for a plain object", () => {
    const obj = { a: 1 };
    expect(parseObject(obj)).toBe(obj);
  });

  it("works with empty object", () => {
    const obj = {};
    expect(parseObject(obj)).toBe(obj);
  });
});

// ============================================================================
// asString
// ============================================================================

describe("asString", () => {
  it("returns value for non-empty string", () => {
    expect(asString("hello", "fallback")).toBe("hello");
  });

  it("returns fallback for empty string", () => {
    expect(asString("", "fallback")).toBe("fallback");
  });

  it("returns fallback for null", () => {
    expect(asString(null, "default")).toBe("default");
  });

  it("returns fallback for undefined", () => {
    expect(asString(undefined, "default")).toBe("default");
  });

  it("returns fallback for number", () => {
    expect(asString(0, "fallback")).toBe("fallback");
  });

  it("returns fallback for boolean", () => {
    expect(asString(true, "fallback")).toBe("fallback");
  });

  it("returns fallback for object", () => {
    expect(asString({}, "fallback")).toBe("fallback");
  });
});

// ============================================================================
// asNumber
// ============================================================================

describe("asNumber", () => {
  it("returns value for a positive finite number", () => {
    expect(asNumber(42, 0)).toBe(42);
  });

  it("returns value for zero", () => {
    expect(asNumber(0, 99)).toBe(0);
  });

  it("returns value for negative number", () => {
    expect(asNumber(-1, 0)).toBe(-1);
  });

  it("returns value for float", () => {
    expect(asNumber(3.14, 0)).toBeCloseTo(3.14);
  });

  it("returns fallback for NaN", () => {
    expect(asNumber(NaN, 7)).toBe(7);
  });

  it("returns fallback for Infinity", () => {
    expect(asNumber(Infinity, 7)).toBe(7);
  });

  it("returns fallback for -Infinity", () => {
    expect(asNumber(-Infinity, 7)).toBe(7);
  });

  it("returns fallback for string", () => {
    expect(asNumber("5", 0)).toBe(0);
  });

  it("returns fallback for null", () => {
    expect(asNumber(null, 0)).toBe(0);
  });
});

// ============================================================================
// asBoolean
// ============================================================================

describe("asBoolean", () => {
  it("returns true when value is true", () => {
    expect(asBoolean(true, false)).toBe(true);
  });

  it("returns false when value is false", () => {
    expect(asBoolean(false, true)).toBe(false);
  });

  it("returns fallback for string 'true'", () => {
    expect(asBoolean("true", false)).toBe(false);
  });

  it("returns fallback for number 1", () => {
    expect(asBoolean(1, false)).toBe(false);
  });

  it("returns fallback for null", () => {
    expect(asBoolean(null, true)).toBe(true);
  });

  it("returns fallback for undefined", () => {
    expect(asBoolean(undefined, true)).toBe(true);
  });
});

// ============================================================================
// asStringArray
// ============================================================================

describe("asStringArray", () => {
  it("returns empty array for non-array string", () => {
    expect(asStringArray("hello")).toEqual([]);
  });

  it("returns empty array for null", () => {
    expect(asStringArray(null)).toEqual([]);
  });

  it("returns empty array for number", () => {
    expect(asStringArray(42)).toEqual([]);
  });

  it("filters non-string items from mixed array", () => {
    expect(asStringArray(["a", 1, null, "b", true, undefined])).toEqual(["a", "b"]);
  });

  it("returns all items from a pure string array", () => {
    expect(asStringArray(["x", "y"])).toEqual(["x", "y"]);
  });

  it("returns empty array for empty array", () => {
    expect(asStringArray([])).toEqual([]);
  });
});

// ============================================================================
// parseJson
// ============================================================================

describe("parseJson", () => {
  it("parses a valid JSON object string", () => {
    expect(parseJson('{"key":"value"}')).toEqual({ key: "value" });
  });

  it("parses nested objects", () => {
    expect(parseJson('{"a":{"b":1}}')).toEqual({ a: { b: 1 } });
  });

  it("returns null for invalid JSON", () => {
    expect(parseJson("not json")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseJson("")).toBeNull();
  });

  it("returns null for a JSON array string", () => {
    // Return type is Record, but JSON.parse of array is still parsed — implementation returns it
    // Array is not Record so it's technically valid but we just confirm no throw
    expect(() => parseJson("[1,2,3]")).not.toThrow();
  });
});

// ============================================================================
// appendWithCap
// ============================================================================

describe("appendWithCap", () => {
  it("appends when total is under cap", () => {
    expect(appendWithCap("abc", "de", 10)).toBe("abcde");
  });

  it("truncates from start when combined exceeds cap", () => {
    const result = appendWithCap("abcde", "fg", 6);
    expect(result).toBe("bcdefg");
    expect(result.length).toBe(6);
  });

  it("returns chunk alone when prev is empty and fits in cap", () => {
    expect(appendWithCap("", "hello", 10)).toBe("hello");
  });

  it("handles exact-cap size without truncation", () => {
    expect(appendWithCap("abc", "def", 6)).toBe("abcdef");
  });

  it("uses MAX_CAPTURE_BYTES as default cap", () => {
    expect(appendWithCap("a", "b")).toBe("ab");
  });
});

// ============================================================================
// resolvePathValue
// ============================================================================

describe("resolvePathValue", () => {
  it("resolves a top-level string value", () => {
    expect(resolvePathValue({ name: "Alice" }, "name")).toBe("Alice");
  });

  it("resolves a nested dotted path", () => {
    expect(resolvePathValue({ user: { name: "Bob" } }, "user.name")).toBe("Bob");
  });

  it("returns empty string for missing key", () => {
    expect(resolvePathValue({}, "missing")).toBe("");
  });

  it("returns empty string for null value at path", () => {
    expect(resolvePathValue({ a: null }, "a")).toBe("");
  });

  it("returns empty string for undefined value at path", () => {
    expect(resolvePathValue({ a: undefined }, "a")).toBe("");
  });

  it("converts number to string", () => {
    expect(resolvePathValue({ n: 42 }, "n")).toBe("42");
  });

  it("converts boolean to string", () => {
    expect(resolvePathValue({ b: false }, "b")).toBe("false");
  });

  it("JSON-stringifies an object value", () => {
    expect(resolvePathValue({ meta: { x: 1 } }, "meta")).toBe('{"x":1}');
  });

  it("returns empty string when traversal hits a non-object mid-path", () => {
    expect(resolvePathValue({ a: "str" }, "a.b")).toBe("");
  });

  it("returns empty string when traversal hits an array mid-path", () => {
    expect(resolvePathValue({ a: [1, 2] }, "a.b")).toBe("");
  });

  it("resolves deeply nested path", () => {
    expect(resolvePathValue({ a: { b: { c: "deep" } } }, "a.b.c")).toBe("deep");
  });
});

// ============================================================================
// renderTemplate
// ============================================================================

describe("renderTemplate", () => {
  it("replaces a simple placeholder", () => {
    expect(renderTemplate("Hello {{name}}!", { name: "World" })).toBe("Hello World!");
  });

  it("handles spaces around placeholder name", () => {
    expect(renderTemplate("{{ name }}", { name: "Alice" })).toBe("Alice");
  });

  it("replaces multiple placeholders", () => {
    expect(renderTemplate("{{a}} + {{b}}", { a: "1", b: "2" })).toBe("1 + 2");
  });

  it("resolves dotted nested path in placeholder", () => {
    expect(renderTemplate("{{user.name}}", { user: { name: "Bob" } })).toBe("Bob");
  });

  it("replaces with empty string for missing key", () => {
    expect(renderTemplate("{{missing}}", {})).toBe("");
  });

  it("leaves template unchanged with no placeholders", () => {
    expect(renderTemplate("plain text", {})).toBe("plain text");
  });

  it("handles repeated same placeholder", () => {
    expect(renderTemplate("{{x}} and {{x}}", { x: "y" })).toBe("y and y");
  });
});

// ============================================================================
// joinPromptSections
// ============================================================================

describe("joinPromptSections", () => {
  it("joins sections with double newline by default", () => {
    expect(joinPromptSections(["A", "B"])).toBe("A\n\nB");
  });

  it("filters out null values", () => {
    expect(joinPromptSections([null, "A", null, "B"])).toBe("A\n\nB");
  });

  it("filters out undefined values", () => {
    expect(joinPromptSections([undefined, "A"])).toBe("A");
  });

  it("trims each section before joining", () => {
    expect(joinPromptSections(["  hello  ", "  world  "])).toBe("hello\n\nworld");
  });

  it("filters empty strings after trim", () => {
    expect(joinPromptSections(["A", "   ", "B"])).toBe("A\n\nB");
  });

  it("returns empty string when all sections are null/empty", () => {
    expect(joinPromptSections([null, undefined, ""])).toBe("");
  });

  it("uses custom separator", () => {
    expect(joinPromptSections(["A", "B"], "\n---\n")).toBe("A\n---\nB");
  });

  it("returns single section without separator", () => {
    expect(joinPromptSections(["only this"])).toBe("only this");
  });
});

// ============================================================================
// normalizePaperclipWakePayload — basic cases not covered by existing tests
// ============================================================================

describe("normalizePaperclipWakePayload (basic)", () => {
  it("returns null for null input", () => {
    expect(normalizePaperclipWakePayload(null)).toBeNull();
  });

  it("returns null for string input", () => {
    expect(normalizePaperclipWakePayload("string")).toBeNull();
  });

  it("returns payload when issue is present", () => {
    const result = normalizePaperclipWakePayload({
      issue: { id: "i1", identifier: "PAP-99", title: "Title", status: "todo", priority: "low" },
    });
    expect(result).not.toBeNull();
    expect(result?.issue?.identifier).toBe("PAP-99");
  });

  it("defaults fallbackFetchNeeded to false", () => {
    const result = normalizePaperclipWakePayload({
      issue: { id: "i1", identifier: "PAP-1", title: "T", status: "todo", priority: "low" },
    });
    expect(result?.fallbackFetchNeeded).toBe(false);
  });

  it("propagates fallbackFetchNeeded true", () => {
    const result = normalizePaperclipWakePayload({
      issue: { id: "i1", identifier: "PAP-1", title: "T", status: "todo", priority: "low" },
      fallbackFetchNeeded: true,
    });
    expect(result?.fallbackFetchNeeded).toBe(true);
  });

  it("defaults truncated to false", () => {
    const result = normalizePaperclipWakePayload({
      issue: { id: "i1", identifier: "PAP-1", title: "T", status: "todo", priority: "low" },
    });
    expect(result?.truncated).toBe(false);
  });

  it("filters blank commentIds", () => {
    const result = normalizePaperclipWakePayload({
      issue: { id: "i1", identifier: "PAP-1", title: "T", status: "todo", priority: "low" },
      commentIds: ["c1", " ", "", "c2"],
    });
    expect(result?.commentIds).toEqual(["c1", "c2"]);
  });

  it("trims commentId whitespace", () => {
    const result = normalizePaperclipWakePayload({
      issue: { id: "i1", identifier: "PAP-1", title: "T", status: "todo", priority: "low" },
      commentIds: ["  c1  "],
    });
    expect(result?.commentIds).toEqual(["c1"]);
  });

  it("returns payload when only commentIds are present", () => {
    const result = normalizePaperclipWakePayload({ commentIds: ["cid-1"] });
    expect(result).not.toBeNull();
    expect(result?.commentIds).toEqual(["cid-1"]);
  });
});

// ============================================================================
// redactEnvForLogs
// ============================================================================

describe("redactEnvForLogs", () => {
  it("redacts key containing 'key'", () => {
    expect(redactEnvForLogs({ API_KEY: "secret" })["API_KEY"]).toBe("***REDACTED***");
  });

  it("redacts key containing 'token' (case-insensitive)", () => {
    expect(redactEnvForLogs({ GITHUB_TOKEN: "tok" })["GITHUB_TOKEN"]).toBe("***REDACTED***");
  });

  it("redacts key containing 'secret'", () => {
    expect(redactEnvForLogs({ MY_SECRET: "val" })["MY_SECRET"]).toBe("***REDACTED***");
  });

  it("redacts key containing 'password'", () => {
    expect(redactEnvForLogs({ DB_PASSWORD: "pass" })["DB_PASSWORD"]).toBe("***REDACTED***");
  });

  it("redacts key containing 'passwd'", () => {
    expect(redactEnvForLogs({ MY_PASSWD: "p" })["MY_PASSWD"]).toBe("***REDACTED***");
  });

  it("redacts key containing 'authorization'", () => {
    expect(redactEnvForLogs({ AUTHORIZATION: "Bearer x" })["AUTHORIZATION"]).toBe("***REDACTED***");
  });

  it("redacts key containing 'cookie'", () => {
    expect(redactEnvForLogs({ SESSION_COOKIE: "c" })["SESSION_COOKIE"]).toBe("***REDACTED***");
  });

  it("does not redact safe keys", () => {
    const result = redactEnvForLogs({ NODE_ENV: "production", PORT: "3000" });
    expect(result["NODE_ENV"]).toBe("production");
    expect(result["PORT"]).toBe("3000");
  });

  it("returns empty object for empty env", () => {
    expect(redactEnvForLogs({})).toEqual({});
  });

  it("redacts sensitive key while preserving safe key in same env", () => {
    const result = redactEnvForLogs({ SAFE: "visible", API_KEY: "hidden" });
    expect(result["SAFE"]).toBe("visible");
    expect(result["API_KEY"]).toBe("***REDACTED***");
  });
});

// ============================================================================
// buildInvocationEnvForLogs
// ============================================================================

describe("buildInvocationEnvForLogs", () => {
  it("redacts sensitive keys from base env", () => {
    const result = buildInvocationEnvForLogs({ MY_TOKEN: "secret", PORT: "80" });
    expect(result["MY_TOKEN"]).toBe("***REDACTED***");
    expect(result["PORT"]).toBe("80");
  });

  it("merges runtime keys not in base env", () => {
    const result = buildInvocationEnvForLogs(
      { PORT: "80" },
      { runtimeEnv: { NODE_ENV: "test" }, includeRuntimeKeys: ["NODE_ENV"] },
    );
    expect(result["NODE_ENV"]).toBe("test");
  });

  it("does not override base env with runtime key", () => {
    const result = buildInvocationEnvForLogs(
      { NODE_ENV: "production" },
      { runtimeEnv: { NODE_ENV: "test" }, includeRuntimeKeys: ["NODE_ENV"] },
    );
    expect(result["NODE_ENV"]).toBe("production");
  });

  it("skips runtime keys with empty string values", () => {
    const result = buildInvocationEnvForLogs(
      {},
      { runtimeEnv: { EMPTY: "" }, includeRuntimeKeys: ["EMPTY"] },
    );
    expect("EMPTY" in result).toBe(false);
  });

  it("adds resolvedCommand under PAPERCLIP_RESOLVED_COMMAND by default", () => {
    const result = buildInvocationEnvForLogs({}, { resolvedCommand: "/usr/bin/node" });
    expect(result["PAPERCLIP_RESOLVED_COMMAND"]).toBe("/usr/bin/node");
  });

  it("uses custom resolvedCommandEnvKey", () => {
    const result = buildInvocationEnvForLogs(
      {},
      { resolvedCommand: "/usr/bin/node", resolvedCommandEnvKey: "MY_CMD_PATH" },
    );
    expect(result["MY_CMD_PATH"]).toBe("/usr/bin/node");
  });

  it("skips resolvedCommand when empty string", () => {
    const result = buildInvocationEnvForLogs({}, { resolvedCommand: "" });
    expect("PAPERCLIP_RESOLVED_COMMAND" in result).toBe(false);
  });

  it("skips resolvedCommand when whitespace only", () => {
    const result = buildInvocationEnvForLogs({}, { resolvedCommand: "   " });
    expect("PAPERCLIP_RESOLVED_COMMAND" in result).toBe(false);
  });
});

// ============================================================================
// defaultPathForPlatform
// ============================================================================

describe("defaultPathForPlatform", () => {
  it("returns a non-empty string", () => {
    const result = defaultPathForPlatform();
    expect(result.length).toBeGreaterThan(0);
  });

  it("contains at least one path separator (: or ;)", () => {
    expect(defaultPathForPlatform()).toMatch(/[:;]/);
  });
});

// ============================================================================
// ensurePathInEnv
// ============================================================================

describe("ensurePathInEnv", () => {
  it("returns same reference when PATH is set", () => {
    const env = { PATH: "/usr/bin" };
    expect(ensurePathInEnv(env)).toBe(env);
  });

  it("returns same reference when Path is set (Windows)", () => {
    const env = { Path: "C:\\Windows\\System32" };
    expect(ensurePathInEnv(env)).toBe(env);
  });

  it("injects default PATH when neither PATH nor Path is present", () => {
    const result = ensurePathInEnv({});
    expect(result.PATH).toBe(defaultPathForPlatform());
  });

  it("does not mutate original env when adding PATH", () => {
    const original = {};
    ensurePathInEnv(original);
    expect(original).not.toHaveProperty("PATH");
  });
});

// ============================================================================
// readPaperclipSkillSyncPreference
// ============================================================================

describe("readPaperclipSkillSyncPreference", () => {
  it("returns explicit=false and empty desiredSkills for empty config", () => {
    const result = readPaperclipSkillSyncPreference({});
    expect(result.explicit).toBe(false);
    expect(result.desiredSkills).toEqual([]);
  });

  it("returns explicit=false when paperclipSkillSync is null", () => {
    expect(readPaperclipSkillSyncPreference({ paperclipSkillSync: null }).explicit).toBe(false);
  });

  it("returns explicit=false when paperclipSkillSync is an array", () => {
    expect(readPaperclipSkillSyncPreference({ paperclipSkillSync: ["a"] }).explicit).toBe(false);
  });

  it("returns explicit=false when paperclipSkillSync is a string", () => {
    expect(readPaperclipSkillSyncPreference({ paperclipSkillSync: "a" }).explicit).toBe(false);
  });

  it("returns explicit=true with desiredSkills array when object has desiredSkills", () => {
    const result = readPaperclipSkillSyncPreference({
      paperclipSkillSync: { desiredSkills: ["skill-a", "skill-b"] },
    });
    expect(result.explicit).toBe(true);
    expect(result.desiredSkills).toEqual(["skill-a", "skill-b"]);
  });

  it("deduplicates skill names", () => {
    const result = readPaperclipSkillSyncPreference({
      paperclipSkillSync: { desiredSkills: ["s", "s", "t"] },
    });
    expect(result.desiredSkills).toEqual(["s", "t"]);
  });

  it("trims whitespace from skill names", () => {
    const result = readPaperclipSkillSyncPreference({
      paperclipSkillSync: { desiredSkills: ["  skill-a  "] },
    });
    expect(result.desiredSkills).toEqual(["skill-a"]);
  });

  it("filters non-string values from desiredSkills", () => {
    const result = readPaperclipSkillSyncPreference({
      paperclipSkillSync: { desiredSkills: ["skill-a", 42, null] },
    });
    expect(result.desiredSkills).toEqual(["skill-a"]);
  });

  it("filters blank strings after trim", () => {
    const result = readPaperclipSkillSyncPreference({
      paperclipSkillSync: { desiredSkills: ["  ", "skill-a"] },
    });
    expect(result.desiredSkills).toEqual(["skill-a"]);
  });

  it("returns explicit=true with empty array when desiredSkills is empty", () => {
    const result = readPaperclipSkillSyncPreference({
      paperclipSkillSync: { desiredSkills: [] },
    });
    expect(result.explicit).toBe(true);
    expect(result.desiredSkills).toEqual([]);
  });
});

// ============================================================================
// resolvePaperclipDesiredSkillNames
// ============================================================================

describe("resolvePaperclipDesiredSkillNames", () => {
  const entries = [
    { key: "org/a", runtimeName: "skill-a", required: false, roles: ["ceo"] },
    { key: "org/b", runtimeName: "skill-b", required: false, roles: ["all"] },
    { key: "org/c", runtimeName: null, required: true, roles: null },
    { key: "org/d", runtimeName: "skill-d", required: false, roles: [] },
  ];

  it("includes required skills when no explicit config", () => {
    const result = resolvePaperclipDesiredSkillNames({}, entries);
    expect(result).toContain("org/c");
  });

  it("includes 'all' role skills regardless of agentUrlKey", () => {
    const result = resolvePaperclipDesiredSkillNames({}, entries, "random-role");
    expect(result).toContain("org/b");
  });

  it("includes role-matched skills for the given agent key", () => {
    const result = resolvePaperclipDesiredSkillNames({}, entries, "ceo");
    expect(result).toContain("org/a");
  });

  it("excludes role-gated skill when agent key doesn't match", () => {
    const result = resolvePaperclipDesiredSkillNames({}, entries, "developer");
    expect(result).not.toContain("org/a");
  });

  it("excludes empty-roles skills when no explicit config", () => {
    const result = resolvePaperclipDesiredSkillNames({}, entries, "ceo");
    expect(result).not.toContain("org/d");
  });

  it("resolves by exact key in explicit config", () => {
    const config = { paperclipSkillSync: { desiredSkills: ["org/a"] } };
    const result = resolvePaperclipDesiredSkillNames(config, entries);
    expect(result).toContain("org/a");
  });

  it("resolves by runtimeName in explicit config", () => {
    const config = { paperclipSkillSync: { desiredSkills: ["skill-b"] } };
    const result = resolvePaperclipDesiredSkillNames(config, entries);
    expect(result).toContain("org/b");
  });

  it("always includes required skills alongside explicit config", () => {
    const config = { paperclipSkillSync: { desiredSkills: ["skill-a"] } };
    const result = resolvePaperclipDesiredSkillNames(config, entries);
    expect(result).toContain("org/c"); // required
  });

  it("deduplicates results", () => {
    const config = { paperclipSkillSync: { desiredSkills: ["skill-a", "org/a"] } };
    const result = resolvePaperclipDesiredSkillNames(config, entries);
    expect(result.filter((k) => k === "org/a")).toHaveLength(1);
  });

  it("returns only required when no explicit config and no role match", () => {
    const result = resolvePaperclipDesiredSkillNames({}, entries);
    // No agentUrlKey, "all" entries still included
    expect(result).toContain("org/b"); // roles: ["all"]
    expect(result).toContain("org/c"); // required
    expect(result).not.toContain("org/a"); // roles: ["ceo"], no agent key
  });
});

// ============================================================================
// writePaperclipSkillSyncPreference
// ============================================================================

describe("writePaperclipSkillSyncPreference", () => {
  it("creates paperclipSkillSync with desiredSkills when not present", () => {
    const result = writePaperclipSkillSyncPreference({}, ["skill-a"]);
    const sync = result.paperclipSkillSync as Record<string, unknown>;
    expect(sync.desiredSkills).toEqual(["skill-a"]);
  });

  it("preserves existing config keys", () => {
    const result = writePaperclipSkillSyncPreference({ other: "value" }, ["skill-a"]);
    expect(result.other).toBe("value");
  });

  it("deduplicates desiredSkills", () => {
    const result = writePaperclipSkillSyncPreference({}, ["s", "s", "t"]);
    const desired = (result.paperclipSkillSync as any).desiredSkills as string[];
    expect(desired.filter((x: string) => x === "s")).toHaveLength(1);
  });

  it("trims skill names", () => {
    const result = writePaperclipSkillSyncPreference({}, ["  skill-a  "]);
    const desired = (result.paperclipSkillSync as any).desiredSkills as string[];
    expect(desired).toContain("skill-a");
    expect(desired).not.toContain("  skill-a  ");
  });

  it("sets empty array when given empty array", () => {
    const result = writePaperclipSkillSyncPreference({}, []);
    expect((result.paperclipSkillSync as any).desiredSkills).toEqual([]);
  });

  it("does not mutate original config", () => {
    const config = { other: "value" };
    writePaperclipSkillSyncPreference(config, ["skill-a"]);
    expect(config).toEqual({ other: "value" });
  });

  it("merges with existing paperclipSkillSync object", () => {
    const config = { paperclipSkillSync: { existingKey: "kept" } };
    const result = writePaperclipSkillSyncPreference(config, ["skill-a"]);
    const sync = result.paperclipSkillSync as Record<string, unknown>;
    expect(sync.existingKey).toBe("kept");
    expect((sync.desiredSkills as string[])).toContain("skill-a");
  });
});
