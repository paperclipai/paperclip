import { describe, it, expect } from "vitest";
import { isBlockedIP, validateUrlNotInternal } from "../utils/url-validation.js";

describe("isBlockedIP", () => {
  it("blocks IPv4 loopback addresses", () => {
    expect(isBlockedIP("127.0.0.1")).toBe(true);
    expect(isBlockedIP("127.0.0.2")).toBe(true);
    expect(isBlockedIP("127.255.255.255")).toBe(true);
  });

  it("blocks IPv4 private 10.x.x.x range", () => {
    expect(isBlockedIP("10.0.0.1")).toBe(true);
    expect(isBlockedIP("10.255.255.255")).toBe(true);
  });

  it("blocks IPv4 private 172.16-31.x.x range", () => {
    expect(isBlockedIP("172.16.0.1")).toBe(true);
    expect(isBlockedIP("172.31.255.255")).toBe(true);
  });

  it("does not block IPv4 172 addresses outside private range", () => {
    expect(isBlockedIP("172.15.0.1")).toBe(false);
    expect(isBlockedIP("172.32.0.1")).toBe(false);
  });

  it("blocks IPv4 private 192.168.x.x range", () => {
    expect(isBlockedIP("192.168.1.1")).toBe(true);
    expect(isBlockedIP("192.168.0.1")).toBe(true);
  });

  it("blocks IPv4 link-local range", () => {
    expect(isBlockedIP("169.254.169.254")).toBe(true);
    expect(isBlockedIP("169.254.0.1")).toBe(true);
  });

  it("blocks IPv4 unspecified addresses", () => {
    expect(isBlockedIP("0.0.0.0")).toBe(true);
  });

  it("allows public IPv4 addresses", () => {
    expect(isBlockedIP("8.8.8.8")).toBe(false);
    expect(isBlockedIP("1.1.1.1")).toBe(false);
    expect(isBlockedIP("93.184.216.34")).toBe(false);
  });

  it("blocks IPv6 loopback", () => {
    expect(isBlockedIP("::1")).toBe(true);
    expect(isBlockedIP("::")).toBe(true);
  });

  it("blocks IPv6 link-local addresses", () => {
    expect(isBlockedIP("fe80::1")).toBe(true);
  });

  it("blocks IPv6 unique local addresses", () => {
    expect(isBlockedIP("fc00::1")).toBe(true);
    expect(isBlockedIP("fd00::1")).toBe(true);
  });
});

describe("validateUrlNotInternal", () => {
  it("rejects non-http/https schemes", async () => {
    await expect(validateUrlNotInternal("ftp://example.com/file")).rejects.toThrow(
      /URL scheme.*is not allowed/,
    );
    await expect(validateUrlNotInternal("file:///etc/passwd")).rejects.toThrow(
      /URL scheme.*is not allowed/,
    );
    await expect(validateUrlNotInternal("gopher://example.com")).rejects.toThrow(
      /URL scheme.*is not allowed/,
    );
  });

  it("rejects URLs with private IP addresses", async () => {
    await expect(validateUrlNotInternal("http://127.0.0.1/admin")).rejects.toThrow(
      /private\/internal IP/,
    );
    await expect(validateUrlNotInternal("http://10.0.0.1/secret")).rejects.toThrow(
      /private\/internal IP/,
    );
    await expect(validateUrlNotInternal("http://192.168.1.1/router")).rejects.toThrow(
      /private\/internal IP/,
    );
    await expect(validateUrlNotInternal("http://172.16.0.1/internal")).rejects.toThrow(
      /private\/internal IP/,
    );
    await expect(validateUrlNotInternal("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /private\/internal IP/,
    );
  });

  it("rejects URLs with IPv6 loopback", async () => {
    await expect(validateUrlNotInternal("http://[::1]/admin")).rejects.toThrow(
      /private\/internal IP/,
    );
  });

  it("does not reject URLs with public IP addresses", async () => {
    // These should not throw for the IP check itself.
    // They may throw for DNS resolution if hostname is used, but direct IPs should pass.
    await expect(validateUrlNotInternal("http://8.8.8.8/")).resolves.toBeUndefined();
    await expect(validateUrlNotInternal("https://1.1.1.1/")).resolves.toBeUndefined();
  });
});
