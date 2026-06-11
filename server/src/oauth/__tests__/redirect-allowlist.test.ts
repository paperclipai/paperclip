import { describe, it, expect } from "vitest";
import { validateReturnUrl } from "../redirect-allowlist.js";

const PUBLIC = "https://app.paperclip.test";

describe("validateReturnUrl", () => {
  it("accepts /settings/* paths", () => expect(validateReturnUrl("/settings/connections", PUBLIC)).toBe("/settings/connections"));
  it("accepts /agents/* paths", () => expect(validateReturnUrl("/agents/abc", PUBLIC)).toBe("/agents/abc"));
  it("accepts /runs/* paths", () => expect(validateReturnUrl("/runs/xyz", PUBLIC)).toBe("/runs/xyz"));
  it("rejects cross-origin absolute URLs", () => expect(validateReturnUrl("https://evil.example/x", PUBLIC)).toBe("/settings/connections"));
  it("rejects javascript: scheme", () => expect(validateReturnUrl("javascript:alert(1)", PUBLIC)).toBe("/settings/connections"));
  it("rejects data: scheme", () => expect(validateReturnUrl("data:text/html,x", PUBLIC)).toBe("/settings/connections"));
  it("rejects schema-relative //evil.example", () => expect(validateReturnUrl("//evil.example/x", PUBLIC)).toBe("/settings/connections"));
  it("rejects double-encoded slashes", () => expect(validateReturnUrl("https:%2F%2Fevil.example", PUBLIC)).toBe("/settings/connections"));
  it("rejects backslash schema-relative", () => expect(validateReturnUrl("\\\\evil.example/x", PUBLIC)).toBe("/settings/connections"));
  it("falls back when undefined", () => expect(validateReturnUrl(undefined, PUBLIC)).toBe("/settings/connections"));
  it("rejects /admin/x (not in allowlist)", () => expect(validateReturnUrl("/admin/x", PUBLIC)).toBe("/settings/connections"));
});
