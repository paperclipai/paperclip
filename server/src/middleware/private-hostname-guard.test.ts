import { describe, expect, it } from "vitest";
import { resolvePrivateHostnameAllowSet } from "./private-hostname-guard.js";

// ============================================================================
// resolvePrivateHostnameAllowSet
// ============================================================================

describe("resolvePrivateHostnameAllowSet", () => {
  it("always includes localhost", () => {
    const set = resolvePrivateHostnameAllowSet({ allowedHostnames: [], bindHost: "0.0.0.0" });
    expect(set.has("localhost")).toBe(true);
  });

  it("always includes 127.0.0.1", () => {
    const set = resolvePrivateHostnameAllowSet({ allowedHostnames: [], bindHost: "0.0.0.0" });
    expect(set.has("127.0.0.1")).toBe(true);
  });

  it("always includes ::1 (IPv6 loopback)", () => {
    const set = resolvePrivateHostnameAllowSet({ allowedHostnames: [], bindHost: "0.0.0.0" });
    expect(set.has("::1")).toBe(true);
  });

  it("includes configured allowed hostnames", () => {
    const set = resolvePrivateHostnameAllowSet({
      allowedHostnames: ["example.com"],
      bindHost: "0.0.0.0",
    });
    expect(set.has("example.com")).toBe(true);
  });

  it("includes bindHost when it is not 0.0.0.0", () => {
    const set = resolvePrivateHostnameAllowSet({
      allowedHostnames: [],
      bindHost: "192.168.1.100",
    });
    expect(set.has("192.168.1.100")).toBe(true);
  });

  it("does not include bindHost when it is 0.0.0.0", () => {
    const set = resolvePrivateHostnameAllowSet({ allowedHostnames: [], bindHost: "0.0.0.0" });
    expect(set.has("0.0.0.0")).toBe(false);
  });

  it("normalizes allowedHostnames to lowercase", () => {
    const set = resolvePrivateHostnameAllowSet({
      allowedHostnames: ["EXAMPLE.COM"],
      bindHost: "0.0.0.0",
    });
    expect(set.has("example.com")).toBe(true);
  });

  it("normalizes bindHost to lowercase", () => {
    const set = resolvePrivateHostnameAllowSet({
      allowedHostnames: [],
      bindHost: "MyHost",
    });
    expect(set.has("myhost")).toBe(true);
  });

  it("filters out empty strings from allowedHostnames", () => {
    const set = resolvePrivateHostnameAllowSet({
      allowedHostnames: ["", "  ", "valid.host"],
      bindHost: "0.0.0.0",
    });
    expect(set.has("")).toBe(false);
    expect(set.has("valid.host")).toBe(true);
  });

  it("deduplicates allowedHostnames", () => {
    const set = resolvePrivateHostnameAllowSet({
      allowedHostnames: ["example.com", "example.com"],
      bindHost: "0.0.0.0",
    });
    expect(set.size).toBe(4); // example.com + localhost + 127.0.0.1 + ::1
  });

  it("handles multiple allowed hostnames", () => {
    const set = resolvePrivateHostnameAllowSet({
      allowedHostnames: ["app.example.com", "api.example.com"],
      bindHost: "0.0.0.0",
    });
    expect(set.has("app.example.com")).toBe(true);
    expect(set.has("api.example.com")).toBe(true);
  });
});
