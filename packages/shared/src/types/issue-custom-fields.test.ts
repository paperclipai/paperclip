import { describe, expect, it } from "vitest";
import { PLUGIN_CAPABILITIES } from "../constants.js";
import { pluginCustomFieldDeclarationSchema } from "../validators/index.js";

describe("WS-4 capability constants", () => {
  it("includes issue.custom-fields.read capability", () => {
    expect(PLUGIN_CAPABILITIES).toContain("issue.custom-fields.read");
  });

  it("includes issue.custom-fields.write capability", () => {
    expect(PLUGIN_CAPABILITIES).toContain("issue.custom-fields.write");
  });
});

describe("IssueCustomFieldDeclaration type contract", () => {
  it("field key regex accepts valid keys", () => {
    const validKeys = ["workstream", "my-field", "field123", "a", "x1-y2"];
    const regex = /^[a-z][a-z0-9_-]*$/;
    for (const key of validKeys) {
      expect(regex.test(key), `Expected ${key} to be valid`).toBe(true);
    }
  });

  it("field key regex rejects keys with dots", () => {
    const regex = /^[a-z][a-z0-9_-]*$/;
    expect(regex.test("bad.key")).toBe(false);
    expect(regex.test("plugin.field")).toBe(false);
    expect(regex.test("a.b.c")).toBe(false);
  });

  it("field key regex rejects keys starting with uppercase", () => {
    const regex = /^[a-z][a-z0-9_-]*$/;
    expect(regex.test("BadKey")).toBe(false);
    expect(regex.test("A")).toBe(false);
  });

  it("field key regex rejects keys starting with numbers", () => {
    const regex = /^[a-z][a-z0-9_-]*$/;
    expect(regex.test("1bad")).toBe(false);
    expect(regex.test("0field")).toBe(false);
  });

  it("field key regex rejects keys with slashes", () => {
    const regex = /^[a-z][a-z0-9_-]*$/;
    expect(regex.test("my/field")).toBe(false);
    expect(regex.test("a/b")).toBe(false);
  });

  it("field key regex rejects empty string", () => {
    const regex = /^[a-z][a-z0-9_-]*$/;
    expect(regex.test("")).toBe(false);
  });
});

describe("pluginCustomFieldDeclarationSchema", () => {
  it("accepts valid text field", () => {
    const result = pluginCustomFieldDeclarationSchema.safeParse({ key: "workstream", label: "Workstream", type: "text", scope: "issue" });
    expect(result.success).toBe(true);
  });

  it("accepts valid number field", () => {
    const result = pluginCustomFieldDeclarationSchema.safeParse({ key: "score", label: "Score", type: "number", scope: "issue" });
    expect(result.success).toBe(true);
  });

  it("accepts valid url field", () => {
    const result = pluginCustomFieldDeclarationSchema.safeParse({ key: "docs", label: "Docs", type: "url", scope: "issue" });
    expect(result.success).toBe(true);
  });

  it("accepts valid enum-ref field with enumValues", () => {
    const result = pluginCustomFieldDeclarationSchema.safeParse({
      key: "status", label: "Status", type: "enum-ref", scope: "issue",
      enumValues: [{ id: "open", label: "Open" }, { id: "closed", label: "Closed" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects enum-ref without enumValues", () => {
    const result = pluginCustomFieldDeclarationSchema.safeParse({ key: "status", label: "Status", type: "enum-ref", scope: "issue" });
    expect(result.success).toBe(false);
  });

  it("rejects non-enum type with enumValues", () => {
    const result = pluginCustomFieldDeclarationSchema.safeParse({
      key: "notes", label: "Notes", type: "text", scope: "issue",
      enumValues: [{ id: "a", label: "A" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid field key (dots)", () => {
    const result = pluginCustomFieldDeclarationSchema.safeParse({ key: "bad.key", label: "Label", type: "text", scope: "issue" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid field key (uppercase)", () => {
    const result = pluginCustomFieldDeclarationSchema.safeParse({ key: "BadKey", label: "Label", type: "text", scope: "issue" });
    expect(result.success).toBe(false);
  });
});
