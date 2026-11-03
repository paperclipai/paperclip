import { describe, expect, it } from "vitest";
import { localRunnerApiUrl } from "./runner-api-client.js";

describe("localRunnerApiUrl", () => {
  const cases = [
    ["public HTTPS", "https://example.test/api/issues/1?x=1", "https://example.test", "http://127.0.0.1:3100", "http://127.0.0.1:3100/api/issues/1?x=1"],
    ["default port and host case", "https://EXAMPLE.TEST:443/api/x", "https://example.test/", "http://127.0.0.1:3100", "http://127.0.0.1:3100/api/x"],
    ["configured trailing API slash", "https://example.test/api/x", "https://example.test/api/", "http://127.0.0.1:3100", "http://127.0.0.1:3100/api/x"],
    ["reverse proxy path prefix", "https://example.test/paperclip/api/x?next=1", "https://example.test/paperclip/api", "http://127.0.0.1:3100", "http://127.0.0.1:3100/api/x?next=1"],
    ["reverse proxy base prefix", "https://example.test/paperclip/api/x", "https://example.test/paperclip/", "http://127.0.0.1:3100", "http://127.0.0.1:3100/api/x"],
    ["direct API path with configured prefix", "https://example.test/api/x", "https://example.test/paperclip/api", "http://127.0.0.1:3100", "http://127.0.0.1:3100/api/x"],
    ["custom IPv4 bind", "https://example.test/api/x", "https://example.test", "http://192.0.2.15:3200", "http://192.0.2.15:3200/api/x"],
    ["default HTTP listener port", "https://example.test/api/x", "https://example.test", "http://127.0.0.1:80", "http://127.0.0.1/api/x"],
    ["IPv6-only bind", "https://example.test/api/x", "https://example.test", "http://[2001:db8::2]:3200", "http://[2001:db8::2]:3200/api/x"],
    ["IPv6 wildcard bind", "https://example.test/api/x", "https://example.test", "http://[::1]:3200", "http://[::1]:3200/api/x"],
    ["already at verified listener", "http://127.0.0.1:3100/api/x", "http://127.0.0.1:3100", "http://127.0.0.1:3100", "http://127.0.0.1:3100/api/x"],
    ["loopback on wrong port", "http://localhost:3100/api/x", "http://localhost:3100", "http://127.0.0.1:3200", "http://127.0.0.1:3200/api/x"],
    ["other hostname", "https://other.example.test/api/x", "https://example.test", "http://127.0.0.1:3100", "https://other.example.test/api/x"],
    ["other scheme", "http://example.test/api/x", "https://example.test", "http://127.0.0.1:3100", "http://example.test/api/x"],
    ["other port", "https://example.test:8443/api/x", "https://example.test", "http://127.0.0.1:3100", "https://example.test:8443/api/x"],
    ["configured userinfo", "https://example.test/api/x", "https://name:pass@example.test", "http://127.0.0.1:3100", "https://example.test/api/x"],
    ["request userinfo", "https://name:pass@example.test/api/x", "https://example.test", "http://127.0.0.1:3100", "https://name:pass@example.test/api/x"],
    ["configured query", "https://example.test/api/x", "https://example.test/?x=1", "http://127.0.0.1:3100", "https://example.test/api/x"],
    ["request fragment", "https://example.test/api/x#fragment", "https://example.test", "http://127.0.0.1:3100", "https://example.test/api/x#fragment"],
    ["not an API route", "https://example.test/private", "https://example.test", "http://127.0.0.1:3100", "https://example.test/private"],
    ["unrelated path prefix", "https://example.test/paperclip-other/api/x", "https://example.test/paperclip/api", "http://127.0.0.1:3100", "https://example.test/paperclip-other/api/x"],
    ["malformed configured URL", "https://example.test/api/x", "https://[", "http://127.0.0.1:3100", "https://example.test/api/x"],
    ["unsupported scheme", "ftp://example.test/api/x", "ftp://example.test", "http://127.0.0.1:3100", "ftp://example.test/api/x"],
    ["invalid local listener URL", "https://example.test/api/x", "https://example.test", "not-a-url", "https://example.test/api/x"],
    ["non-HTTP local listener", "https://example.test/api/x", "https://example.test", "https://127.0.0.1:3100", "https://example.test/api/x"],
  ] as const;

  it.each(cases)("%s", (_name, raw, own, listener, expected) => {
    const url = new URL(raw);
    const env = { PAPERCLIP_API_URL: own, PAPERCLIP_LISTEN_PORT: "3100" } as NodeJS.ProcessEnv;
    const result = localRunnerApiUrl(url, env, () => listener);
    expect(result.href).toBe(expected);
    if (expected === url.href) expect(result).toBe(url);
  });

  it.each([
    { PAPERCLIP_API_URL: "https://example.test" },
    { PAPERCLIP_LISTEN_PORT: "3100" },
    {},
  ])("does not rewrite without both advertised origin and listener gate: %j", (env) => {
    const url = new URL("https://example.test/api/x");
    expect(localRunnerApiUrl(url, env, () => "http://127.0.0.1:3100")).toBe(url);
  });

  it("does not rewrite if no verified local listener is available", () => {
    const url = new URL("https://example.test/api/x");
    const env = { PAPERCLIP_API_URL: "https://example.test", PAPERCLIP_LISTEN_PORT: "3100" };
    expect(localRunnerApiUrl(url, env, () => { throw new Error("unavailable"); })).toBe(url);
  });
});
