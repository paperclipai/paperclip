import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  getAllowedPrivateHosts,
  _resetAllowedPrivateHostsCache,
  isPrivateIP,
  validateAndResolveFetchUrl,
} from "../services/plugin-host-services.js";

// ---------------------------------------------------------------------------
// getAllowedPrivateHosts
// ---------------------------------------------------------------------------

describe("getAllowedPrivateHosts", () => {
  beforeEach(() => {
    _resetAllowedPrivateHostsCache();
  });

  it("returns empty set when envValue is empty string", () => {
    const hosts = getAllowedPrivateHosts("");
    expect(hosts.size).toBe(0);
  });

  it("parses a single hostname", () => {
    const hosts = getAllowedPrivateHosts("localhost");
    expect(hosts.size).toBe(1);
    expect(hosts.has("localhost")).toBe(true);
  });

  it("parses multiple comma-separated hostnames", () => {
    const hosts = getAllowedPrivateHosts("localhost,127.0.0.1,myapi.local");
    expect(hosts.size).toBe(3);
    expect(hosts.has("localhost")).toBe(true);
    expect(hosts.has("127.0.0.1")).toBe(true);
    expect(hosts.has("myapi.local")).toBe(true);
  });

  it("trims whitespace around hostnames", () => {
    const hosts = getAllowedPrivateHosts("  localhost , 127.0.0.1 ");
    expect(hosts.has("localhost")).toBe(true);
    expect(hosts.has("127.0.0.1")).toBe(true);
  });

  it("normalises hostnames to lowercase", () => {
    const hosts = getAllowedPrivateHosts("LocalHost,MY-SERVER.Local");
    expect(hosts.has("localhost")).toBe(true);
    expect(hosts.has("my-server.local")).toBe(true);
  });

  it("filters out empty segments from trailing commas", () => {
    const hosts = getAllowedPrivateHosts("localhost,,,,127.0.0.1,");
    expect(hosts.size).toBe(2);
  });

  it("reads from process.env when no envValue is provided", () => {
    process.env.PAPERCLIP_PLUGIN_ALLOWED_HOSTS = "from-env.local";
    _resetAllowedPrivateHostsCache();
    const hosts = getAllowedPrivateHosts();
    expect(hosts.has("from-env.local")).toBe(true);
    delete process.env.PAPERCLIP_PLUGIN_ALLOWED_HOSTS;
  });

  it("caches the result from process.env on subsequent calls", () => {
    process.env.PAPERCLIP_PLUGIN_ALLOWED_HOSTS = "cached.local";
    _resetAllowedPrivateHostsCache();
    const first = getAllowedPrivateHosts();
    // Change env — should still return cached value
    process.env.PAPERCLIP_PLUGIN_ALLOWED_HOSTS = "different.local";
    const second = getAllowedPrivateHosts();
    expect(first).toBe(second); // same Set instance
    expect(second.has("cached.local")).toBe(true);
    expect(second.has("different.local")).toBe(false);
    delete process.env.PAPERCLIP_PLUGIN_ALLOWED_HOSTS;
  });

  it("bypasses cache when explicit envValue is provided", () => {
    process.env.PAPERCLIP_PLUGIN_ALLOWED_HOSTS = "from-env.local";
    _resetAllowedPrivateHostsCache();
    const hosts = getAllowedPrivateHosts("explicit.local");
    expect(hosts.has("explicit.local")).toBe(true);
    expect(hosts.has("from-env.local")).toBe(false);
    delete process.env.PAPERCLIP_PLUGIN_ALLOWED_HOSTS;
  });
});

// ---------------------------------------------------------------------------
// isPrivateIP
// ---------------------------------------------------------------------------

describe("isPrivateIP", () => {
  it.each([
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.15.0.1", false],
    ["172.32.0.1", false],
    ["192.168.0.1", true],
    ["192.168.255.255", true],
    ["127.0.0.1", true],
    ["127.255.255.255", true],
    ["169.254.1.1", true],
    ["0.0.0.0", true],
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["142.250.80.46", false],
  ])("IPv4 %s → private=%s", (ip, expected) => {
    expect(isPrivateIP(ip)).toBe(expected);
  });

  it.each([
    ["::1", true],
    ["fc00::1", true],
    ["fd12:3456::1", true],
    ["fe80::1", true],
    ["::", true],
    ["2001:4860:4860::8888", false],
  ])("IPv6 %s → private=%s", (ip, expected) => {
    expect(isPrivateIP(ip)).toBe(expected);
  });

  it.each([
    ["::ffff:127.0.0.1", true],
    ["::ffff:10.0.0.1", true],
    ["::ffff:8.8.8.8", false],
    ["::ffff:192.168.1.1", true],
  ])("IPv4-mapped IPv6 %s → private=%s", (ip, expected) => {
    expect(isPrivateIP(ip)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// validateAndResolveFetchUrl — protocol & SSRF checks
// ---------------------------------------------------------------------------

describe("validateAndResolveFetchUrl", () => {
  beforeEach(() => {
    _resetAllowedPrivateHostsCache();
  });

  it("rejects invalid URLs", async () => {
    await expect(validateAndResolveFetchUrl("not-a-url")).rejects.toThrow("Invalid URL");
  });

  it("rejects disallowed protocols", async () => {
    await expect(validateAndResolveFetchUrl("ftp://example.com/file")).rejects.toThrow(
      /Disallowed protocol.*ftp/,
    );
  });

  it("rejects file:// protocol", async () => {
    await expect(validateAndResolveFetchUrl("file:///etc/passwd")).rejects.toThrow(
      /Disallowed protocol.*file/,
    );
  });

  it("resolves a public hostname and returns pinned target", async () => {
    // example.com is IANA-reserved and should resolve to a public IP
    const target = await validateAndResolveFetchUrl("https://example.com/path?q=1");
    expect(target.parsedUrl.hostname).toBe("example.com");
    expect(target.resolvedAddress).toBeTruthy();
    expect(target.hostHeader).toBe("example.com");
    expect(target.useTls).toBe(true);
    expect(target.tlsServername).toBe("example.com");
    expect(isPrivateIP(target.resolvedAddress)).toBe(false);
  });

  it("blocks localhost by default (no allowlist)", async () => {
    await expect(validateAndResolveFetchUrl("http://localhost:3000/api")).rejects.toThrow(
      /private\/reserved/,
    );
  });

  it("blocks 127.0.0.1 by default (no allowlist)", async () => {
    await expect(validateAndResolveFetchUrl("http://127.0.0.1:8080/")).rejects.toThrow(
      /private\/reserved/,
    );
  });

  it("allows localhost when in PAPERCLIP_PLUGIN_ALLOWED_HOSTS", async () => {
    process.env.PAPERCLIP_PLUGIN_ALLOWED_HOSTS = "localhost";
    _resetAllowedPrivateHostsCache();
    const target = await validateAndResolveFetchUrl("http://localhost:3000/api");
    expect(target.parsedUrl.hostname).toBe("localhost");
    // Resolved IP should be loopback — pinned for DNS rebinding prevention
    expect(target.resolvedAddress).toMatch(/^127\.|^::1$/);
    expect(target.useTls).toBe(false);
    delete process.env.PAPERCLIP_PLUGIN_ALLOWED_HOSTS;
  });

  it("allows 127.0.0.1 when in PAPERCLIP_PLUGIN_ALLOWED_HOSTS", async () => {
    process.env.PAPERCLIP_PLUGIN_ALLOWED_HOSTS = "127.0.0.1";
    _resetAllowedPrivateHostsCache();
    const target = await validateAndResolveFetchUrl("http://127.0.0.1:18890/api/tasks");
    expect(target.resolvedAddress).toMatch(/^127\./);
    delete process.env.PAPERCLIP_PLUGIN_ALLOWED_HOSTS;
  });

  it("still applies DNS pinning to allowed private hosts", async () => {
    process.env.PAPERCLIP_PLUGIN_ALLOWED_HOSTS = "localhost";
    _resetAllowedPrivateHostsCache();
    const target = await validateAndResolveFetchUrl("http://localhost:3000/test");
    // The resolved address should be set (DNS pinning happened)
    expect(target.resolvedAddress).toBeTruthy();
    // Host header preserved for correct routing
    expect(target.hostHeader).toBe("localhost:3000");
    delete process.env.PAPERCLIP_PLUGIN_ALLOWED_HOSTS;
  });

  it("hostname matching is case-insensitive", async () => {
    process.env.PAPERCLIP_PLUGIN_ALLOWED_HOSTS = "LOCALHOST";
    _resetAllowedPrivateHostsCache();
    // URL hostname is normalised to lowercase by URL constructor
    const target = await validateAndResolveFetchUrl("http://localhost:3000/");
    expect(target.resolvedAddress).toBeTruthy();
    delete process.env.PAPERCLIP_PLUGIN_ALLOWED_HOSTS;
  });

  it("does not allow unlisted private hosts even when allowlist is non-empty", async () => {
    process.env.PAPERCLIP_PLUGIN_ALLOWED_HOSTS = "localhost";
    _resetAllowedPrivateHostsCache();
    // 127.0.0.2 resolves to private IP but isn't "localhost"
    await expect(validateAndResolveFetchUrl("http://127.0.0.2:3000/")).rejects.toThrow(
      /private\/reserved/,
    );
    delete process.env.PAPERCLIP_PLUGIN_ALLOWED_HOSTS;
  });

  it("preserves path and query string in parsed URL", async () => {
    const target = await validateAndResolveFetchUrl(
      "https://example.com/api/v1/tasks?status=open&limit=10",
    );
    expect(target.parsedUrl.pathname).toBe("/api/v1/tasks");
    expect(target.parsedUrl.search).toBe("?status=open&limit=10");
  });
});
