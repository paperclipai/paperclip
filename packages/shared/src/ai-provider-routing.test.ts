import { describe, expect, it } from "vitest";
import { aiProviderRoutingSchema, isLocalEndpointHost } from "./ai-provider-routing.js";

describe("isLocalEndpointHost", () => {
  it("accepts loopback addresses", () => {
    expect(isLocalEndpointHost("localhost")).toBe(true);
    expect(isLocalEndpointHost("127.0.0.1")).toBe(true);
    expect(isLocalEndpointHost("127.5.6.7")).toBe(true);
    expect(isLocalEndpointHost("[::1]")).toBe(true);
    expect(isLocalEndpointHost("::1")).toBe(true);
    expect(isLocalEndpointHost("LOCALHOST")).toBe(true);
  });

  it("accepts RFC 1918 private ranges", () => {
    expect(isLocalEndpointHost("10.0.0.5")).toBe(true);
    expect(isLocalEndpointHost("10.255.255.255")).toBe(true);
    expect(isLocalEndpointHost("172.16.0.1")).toBe(true);
    expect(isLocalEndpointHost("172.31.255.254")).toBe(true);
    expect(isLocalEndpointHost("192.168.1.130")).toBe(true);
    expect(isLocalEndpointHost("192.168.0.1")).toBe(true);
  });

  it("accepts IPv6 ULA and link-local ranges", () => {
    expect(isLocalEndpointHost("fd00::1")).toBe(true);
    expect(isLocalEndpointHost("[fd12:3456:789a::1]")).toBe(true);
    expect(isLocalEndpointHost("fc00::1")).toBe(true);
    expect(isLocalEndpointHost("fe80::1")).toBe(true);
    expect(isLocalEndpointHost("febf::1")).toBe(true);
  });

  it("rejects public addresses and hostnames", () => {
    expect(isLocalEndpointHost("203.0.113.5")).toBe(false);
    expect(isLocalEndpointHost("8.8.8.8")).toBe(false);
    expect(isLocalEndpointHost("172.15.0.1")).toBe(false);
    expect(isLocalEndpointHost("172.32.0.1")).toBe(false);
    expect(isLocalEndpointHost("192.169.1.1")).toBe(false);
    expect(isLocalEndpointHost("9.9.9.9")).toBe(false);
    expect(isLocalEndpointHost("11.0.0.1")).toBe(false);
    expect(isLocalEndpointHost("128.0.0.1")).toBe(false);
    expect(isLocalEndpointHost("fe7f::1")).toBe(false);
    expect(isLocalEndpointHost("fe7e::1")).toBe(false);
    expect(isLocalEndpointHost("example.com")).toBe(false);
    expect(isLocalEndpointHost("192.168.1.256")).toBe(false);
    expect(isLocalEndpointHost("::ffff:192.168.1.5")).toBe(false);
  });
});

describe("aiProviderRoutingSchema local kind", () => {
  const base = { protocol: "chat" as const, auth: "bearer" as const, models: [] as Array<{ id: string; label?: string }> };

  it("accepts a loopback http endpoint", () => {
    expect(
      aiProviderRoutingSchema.safeParse({ ...base, kind: "local", baseUrl: "http://localhost:4000/v1" }).success,
    ).toBe(true);
  });

  it("accepts a private-network http endpoint", () => {
    expect(
      aiProviderRoutingSchema.safeParse({ ...base, kind: "local", baseUrl: "http://192.168.1.130:4000/v1" }).success,
    ).toBe(true);
  });

  it("accepts an https private endpoint", () => {
    expect(
      aiProviderRoutingSchema.safeParse({ ...base, kind: "local", baseUrl: "https://10.0.0.5:8443/v1" }).success,
    ).toBe(true);
  });

  it("rejects a public http endpoint for a local route", () => {
    const result = aiProviderRoutingSchema.safeParse({ ...base, kind: "local", baseUrl: "http://llm.example.com/v1" });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some((issue) => issue.message.includes("HTTPS is required"))).toBe(true);
  });

  it("rejects a non-local https endpoint for a local route", () => {
    const result = aiProviderRoutingSchema.safeParse({ ...base, kind: "local", baseUrl: "https://llm.example.com/v1" });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some((issue) => issue.message.includes("private network address"))).toBe(true);
  });

  it("rejects credentials, queries, or fragments in a URL", () => {
    for (const baseUrl of [
      "http://user:pass@192.168.1.5:4000/v1",
      "http://192.168.1.5:4000/v1?x=1",
      "http://192.168.1.5:4000/v1#frag",
    ]) {
      const result = aiProviderRoutingSchema.safeParse({ ...base, kind: "local", baseUrl });
      expect(result.success).toBe(false);
    }
  });

  it("keeps the gateway kind on the loopback-only http rule", () => {
    expect(
      aiProviderRoutingSchema.safeParse({ ...base, kind: "gateway", baseUrl: "http://127.0.0.1:4000/v1" }).success,
    ).toBe(true);
    expect(
      aiProviderRoutingSchema.safeParse({ ...base, kind: "gateway", baseUrl: "http://192.168.1.130:4000/v1" }).success,
    ).toBe(false);
    expect(
      aiProviderRoutingSchema.safeParse({ ...base, kind: "gateway", baseUrl: "https://gateway.example.com/v1" }).success,
    ).toBe(true);
  });
});
