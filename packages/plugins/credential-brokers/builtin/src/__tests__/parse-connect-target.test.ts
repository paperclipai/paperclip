import { describe, expect, it } from "vitest";

import { parseConnectTarget } from "../proxy-listener.js";

describe("parseConnectTarget", () => {
  it("parses canonical host:port", () => {
    expect(parseConnectTarget("api.github.com:443")).toEqual({
      host: "api.github.com",
      port: 443,
    });
  });

  it("parses host with non-default port", () => {
    expect(parseConnectTarget("localhost:8443")).toEqual({
      host: "localhost",
      port: 8443,
    });
  });

  it("defaults to 443 when port is missing", () => {
    expect(parseConnectTarget("api.github.com")).toEqual({
      host: "api.github.com",
      port: 443,
    });
  });

  it("strips brackets from IPv6 targets", () => {
    expect(parseConnectTarget("[::1]:443")).toEqual({ host: "::1", port: 443 });
    expect(parseConnectTarget("[2001:db8::1]:9443")).toEqual({
      host: "2001:db8::1",
      port: 9443,
    });
  });

  it("uses last colon for plain host:port (so DNS names with no colons work)", () => {
    expect(parseConnectTarget("api.example.com:8443")).toEqual({
      host: "api.example.com",
      port: 8443,
    });
  });

  it("falls back to 443 on malformed port", () => {
    expect(parseConnectTarget("[::1]:abc")).toEqual({ host: "::1", port: 443 });
    expect(parseConnectTarget("api.example.com:abc")).toEqual({
      host: "api.example.com",
      port: 443,
    });
  });

  it("handles bare IPv6 without port", () => {
    expect(parseConnectTarget("[::1]")).toEqual({ host: "::1", port: 443 });
  });
});
