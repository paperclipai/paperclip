import { describe, expect, it } from "vitest";
import {
  REACHABLE_URL_REASON,
  resolveReachableUrl,
  type ReachableUrlInput,
} from "../services/host-urls.js";

function input(overrides: Partial<ReachableUrlInput> = {}): ReachableUrlInput {
  return {
    bindHost: "0.0.0.0",
    deploymentExposure: "public",
    authPublicBaseUrl: "https://example.com",
    pathname: "/api/webhooks/gitea",
    ...overrides,
  };
}

describe("resolveReachableUrl", () => {
  describe("loopback bind", () => {
    it("returns loopback_bind for bindHost=127.0.0.1 regardless of other config", () => {
      const result = resolveReachableUrl(input({
        bindHost: "127.0.0.1",
        deploymentExposure: "public",
        authPublicBaseUrl: "https://example.com",
      }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.loopbackBind });
    });

    it("returns loopback_bind for bindHost=localhost", () => {
      const result = resolveReachableUrl(input({ bindHost: "localhost" }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.loopbackBind });
    });

    it("returns loopback_bind for bindHost=::1 (IPv6 loopback)", () => {
      const result = resolveReachableUrl(input({ bindHost: "::1" }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.loopbackBind });
    });

    it("returns loopback_bind even when bind=custom with loopback customBindHost", () => {
      const result = resolveReachableUrl(input({
        bindHost: "127.0.0.1",
        deploymentExposure: "public",
        authPublicBaseUrl: "https://example.com",
      }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.loopbackBind });
    });
  });

  describe("private exposure", () => {
    it("returns private_exposure for non-loopback host with private exposure", () => {
      const result = resolveReachableUrl(input({ deploymentExposure: "private" }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.privateExposure });
    });

    it("returns private_exposure for tailnet bindHost with private exposure", () => {
      const result = resolveReachableUrl(input({ bindHost: "100.64.0.1", deploymentExposure: "private" }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.privateExposure });
    });

    it("returns private_exposure for custom bindHost with private exposure", () => {
      const result = resolveReachableUrl(input({ bindHost: "10.0.0.1", deploymentExposure: "private" }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.privateExposure });
    });
  });

  describe("missing public base URL", () => {
    it("returns no_public_base_url when authPublicBaseUrl is undefined", () => {
      const result = resolveReachableUrl(input({ authPublicBaseUrl: undefined }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.noPublicBaseUrl });
    });

    it("returns no_public_base_url when authPublicBaseUrl is empty string", () => {
      const result = resolveReachableUrl(input({ authPublicBaseUrl: "" }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.noPublicBaseUrl });
    });
  });

  describe("successful URL construction", () => {
    it("constructs canonical URL for all-interfaces (lan) bindHost", () => {
      const result = resolveReachableUrl(input({ bindHost: "0.0.0.0" }));
      expect(result).toEqual({ url: "https://example.com/api/webhooks/gitea" });
    });

    it("constructs canonical URL for tailnet bindHost", () => {
      const result = resolveReachableUrl(input({ bindHost: "100.64.0.1" }));
      expect(result).toEqual({ url: "https://example.com/api/webhooks/gitea" });
    });

    it("constructs canonical URL for custom non-loopback bindHost", () => {
      const result = resolveReachableUrl(input({ bindHost: "192.168.1.100" }));
      expect(result).toEqual({ url: "https://example.com/api/webhooks/gitea" });
    });

    it("adds leading slash to pathname when missing", () => {
      const result = resolveReachableUrl(input({ pathname: "api/webhooks/gitea" }));
      expect(result).toEqual({ url: "https://example.com/api/webhooks/gitea" });
    });

    it("strips trailing slash from base URL before joining", () => {
      const result = resolveReachableUrl(input({ authPublicBaseUrl: "https://example.com/" }));
      expect(result).toEqual({ url: "https://example.com/api/webhooks/gitea" });
    });

    it("handles base URL with path prefix", () => {
      const result = resolveReachableUrl(input({
        authPublicBaseUrl: "https://example.com/paperclip",
        pathname: "/webhooks/gitea",
      }));
      expect(result).toEqual({ url: "https://example.com/paperclip/webhooks/gitea" });
    });

    it("handles base URL with trailing slash in path prefix", () => {
      const result = resolveReachableUrl(input({
        authPublicBaseUrl: "https://example.com/paperclip/",
        pathname: "/webhooks/gitea",
      }));
      expect(result).toEqual({ url: "https://example.com/paperclip/webhooks/gitea" });
    });

    it("result has no reason field when url is set", () => {
      const result = resolveReachableUrl(input());
      expect(result.url).toBeTruthy();
      expect("reason" in result && result.reason).toBeFalsy();
    });

    it("constructs valid URL for localhost with port (http scheme)", () => {
      const result = resolveReachableUrl(input({ authPublicBaseUrl: "http://localhost:3000" }));
      expect(result).toEqual({ url: "http://localhost:3000/api/webhooks/gitea" });
    });

    it("constructs valid URL for IPv6 address with brackets", () => {
      const result = resolveReachableUrl(input({
        authPublicBaseUrl: "https://[::1]:8080",
        pathname: "/hook",
      }));
      expect(result).toEqual({ url: "https://[::1]:8080/hook" });
    });

    it("constructs valid URL with non-standard port", () => {
      const result = resolveReachableUrl(input({ authPublicBaseUrl: "https://example.com:8443" }));
      expect(result).toEqual({ url: "https://example.com:8443/api/webhooks/gitea" });
    });
  });

  describe("pathname validation", () => {
    it("rejects empty pathname", () => {
      const result = resolveReachableUrl(input({ pathname: "" }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.invalidPathname });
    });

    it("rejects absolute URL in pathname (http scheme)", () => {
      const result = resolveReachableUrl(input({ pathname: "http://evil.com/hook" }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.invalidPathname });
    });

    it("rejects absolute URL in pathname (https scheme)", () => {
      const result = resolveReachableUrl(input({ pathname: "https://evil.com/hook" }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.invalidPathname });
    });

    it("rejects protocol-relative URL in pathname", () => {
      const result = resolveReachableUrl(input({ pathname: "//evil.com/hook" }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.invalidPathname });
    });

    it("rejects CRLF injection in pathname", () => {
      const result = resolveReachableUrl(input({ pathname: "/foo\r\nX-Header: evil" }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.invalidPathname });
    });

    it("rejects LF injection in pathname", () => {
      const result = resolveReachableUrl(input({ pathname: "/foo\nX-Header: evil" }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.invalidPathname });
    });

    it("rejects null byte in pathname", () => {
      const result = resolveReachableUrl(input({ pathname: "/foo\0bar" }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.invalidPathname });
    });

    it("rejects pathname exceeding 2048 chars", () => {
      const result = resolveReachableUrl(input({ pathname: "/" + "a".repeat(2048) }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.invalidPathname });
    });

    it("accepts pathname exactly at 2048 chars (with leading slash)", () => {
      const pathname = "/" + "a".repeat(2047);
      expect(pathname.length).toBe(2048);
      const result = resolveReachableUrl(input({ pathname }));
      expect(result.url).toBeTruthy();
    });
  });

  describe("invalid base URL", () => {
    it("returns invalid_base_url for non-URL string", () => {
      const result = resolveReachableUrl(input({ authPublicBaseUrl: "not a url" }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.invalidBaseUrl });
    });

    it("returns invalid_base_url for malformed URL", () => {
      const result = resolveReachableUrl(input({ authPublicBaseUrl: "://missing-scheme" }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.invalidBaseUrl });
    });

    it("returns invalid_base_url for bare hostname without scheme", () => {
      const result = resolveReachableUrl(input({ authPublicBaseUrl: "myhost.example.com" }));
      expect(result).toEqual({ url: null, reason: REACHABLE_URL_REASON.invalidBaseUrl });
    });
  });

  describe("result type discrimination", () => {
    it("url=string and no reason when reachable", () => {
      const result = resolveReachableUrl(input());
      if (result.url !== null) {
        expect(typeof result.url).toBe("string");
      }
    });

    it("url=null and reason=string when not reachable", () => {
      const result = resolveReachableUrl(input({ bindHost: "127.0.0.1" }));
      expect(result.url).toBeNull();
      expect(typeof result.reason).toBe("string");
    });
  });
});
