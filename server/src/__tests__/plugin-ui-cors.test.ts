import { describe, it, expect } from "vitest";
import { resolvePluginCorsOrigin } from "../routes/plugin-ui-static.js";

describe("resolvePluginCorsOrigin", () => {
  it("returns origin when hostname matches allowedHostnames", () => {
    const result = resolvePluginCorsOrigin("https://app.example.com", ["app.example.com"]);
    expect(result).toBe("https://app.example.com");
  });

  it("returns null when hostname does not match", () => {
    const result = resolvePluginCorsOrigin("https://evil.com", ["app.example.com"]);
    expect(result).toBeNull();
  });

  it("returns null when origin is missing", () => {
    const result = resolvePluginCorsOrigin(undefined, ["app.example.com"]);
    expect(result).toBeNull();
  });

  it("handles localhost for dev", () => {
    const result = resolvePluginCorsOrigin("http://localhost:3100", ["localhost"]);
    expect(result).toBe("http://localhost:3100");
  });

  it("falls back to wildcard when allowedHostnames is empty (local_trusted mode)", () => {
    const result = resolvePluginCorsOrigin("http://localhost:3100", []);
    expect(result).toBe("*");
  });
});
