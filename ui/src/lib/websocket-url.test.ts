import { describe, expect, it } from "vitest";
import { browserReachableHost, buildSameOriginWebSocketUrl } from "./websocket-url";

describe("browserReachableHost", () => {
  it("keeps concrete browser hosts unchanged", () => {
    expect(browserReachableHost({
      protocol: "http:",
      hostname: "paperclip-dev",
      host: "paperclip-dev:46259",
      port: "46259",
    })).toBe("paperclip-dev:46259");
  });

  it("rewrites wildcard IPv4 bind hosts to localhost", () => {
    expect(browserReachableHost({
      protocol: "http:",
      hostname: "0.0.0.0",
      host: "0.0.0.0:46259",
      port: "46259",
    })).toBe("localhost:46259");
  });

  it("rewrites wildcard IPv6 bind hosts to localhost", () => {
    expect(browserReachableHost({
      protocol: "http:",
      hostname: "::",
      host: "[::]:46259",
      port: "46259",
    })).toBe("localhost:46259");
  });
});

describe("buildSameOriginWebSocketUrl", () => {
  it("uses wss for https pages", () => {
    expect(buildSameOriginWebSocketUrl("/api/events/ws", {
      protocol: "https:",
      hostname: "example.com",
      host: "example.com",
      port: "",
    })).toBe("wss://example.com/api/events/ws");
  });

  it("does not emit 0.0.0.0 websocket URLs", () => {
    expect(buildSameOriginWebSocketUrl("api/events/ws", {
      protocol: "http:",
      hostname: "0.0.0.0",
      host: "0.0.0.0:46259",
      port: "46259",
    })).toBe("ws://localhost:46259/api/events/ws");
  });
});
