import { describe, expect, it } from "vitest";
import { resolvePluginMinimumHostVersion } from "./plugin.js";

describe("resolvePluginMinimumHostVersion", () => {
  it("prefers the generic minimumHostVersion field", () => {
    expect(
      resolvePluginMinimumHostVersion({
        minimumHostVersion: "2.3.0",
        minimumPaperclipVersion: "1.0.0",
      }),
    ).toBe("2.3.0");
  });

  it("falls back to the legacy minimumPaperclipVersion alias", () => {
    expect(
      resolvePluginMinimumHostVersion({ minimumPaperclipVersion: "1.4.2" }),
    ).toBe("1.4.2");
  });

  it("returns undefined (no lower bound) when neither field is declared", () => {
    expect(resolvePluginMinimumHostVersion({})).toBeUndefined();
  });
});
