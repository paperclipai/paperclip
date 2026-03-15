import { describe, expect, it } from "vitest";
import { parseBuiltinTemplateRef, resolveCompanyImportSource } from "../commands/client/company.js";

describe("parseBuiltinTemplateRef", () => {
  it("parses builtin template references", () => {
    expect(parseBuiltinTemplateRef("builtin:solo-founder-lite")).toBe("solo-founder-lite");
    expect(parseBuiltinTemplateRef(" BUILTIN:safe-autonomous-organization ")).toBe(
      "safe-autonomous-organization",
    );
  });

  it("returns null for non-builtin sources", () => {
    expect(parseBuiltinTemplateRef("https://example.com/template.json")).toBeNull();
    expect(parseBuiltinTemplateRef("./company-template")).toBeNull();
  });

  it("throws when builtin source omits the template id", () => {
    expect(() => parseBuiltinTemplateRef("builtin:")).toThrow(/requires a template ID/i);
  });
});

describe("resolveCompanyImportSource", () => {
  it("resolves builtin sources without touching the filesystem", async () => {
    await expect(resolveCompanyImportSource("builtin:solo-founder-lite")).resolves.toEqual({
      type: "builtin",
      templateId: "solo-founder-lite",
    });
  });
});
