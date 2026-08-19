import { describe, expect, it } from "vitest";

import {
  resolveScenarioChatProxyConfig,
  selectedScenarioChatProxyHeaders,
} from "./scenario-chat-proxy-config.js";

const baseEnv = {
  SCENARIO_CHAT_SOCKET_PATH: "/tmp/scenario-chat.sock",
  SCENARIO_CHAT_PROXY_PORT: "4197",
};

describe("Scenario chat proxy configuration", () => {
  it("keeps HTTPS loopback-only by default", () => {
    expect(resolveScenarioChatProxyConfig({
      ...baseEnv,
      SCENARIO_CHAT_PUBLIC_ORIGIN: "https://scenario-chat.example.ts.net",
    })).toMatchObject({
      bindHost: "127.0.0.1",
      port: 4197,
      socketPath: "/tmp/scenario-chat.sock",
    });
    expect(() => resolveScenarioChatProxyConfig({
      ...baseEnv,
      SCENARIO_CHAT_PUBLIC_ORIGIN: "https://scenario-chat.example.ts.net",
      SCENARIO_CHAT_PROXY_HOST: "0.0.0.0",
    })).toThrow(/allowed .*bind mode/);
  });

  it("requires explicit tailnet HTTP opt-in before binding beyond loopback", () => {
    expect(() => resolveScenarioChatProxyConfig({
      ...baseEnv,
      SCENARIO_CHAT_PUBLIC_ORIGIN: "http://scenario-chat.example.ts.net:4197",
      SCENARIO_CHAT_PROXY_HOST: "0.0.0.0",
    })).toThrow(/allowed .*bind mode/);
    expect(resolveScenarioChatProxyConfig({
      ...baseEnv,
      SCENARIO_CHAT_PUBLIC_ORIGIN: "http://scenario-chat.example.ts.net:4197",
      SCENARIO_CHAT_PROXY_HOST: "0.0.0.0",
      SCENARIO_CHAT_ALLOW_INSECURE_HTTP: "1",
    })).toMatchObject({
      bindHost: "0.0.0.0",
      port: 4197,
    });
  });

  it("derives direct-tailnet identity from the socket instead of spoofable headers", () => {
    const headers = selectedScenarioChatProxyHeaders({
      cookie: "paperclip_scenario-chat=capability",
      "tailscale-user-login": "spoof@example.com",
      "tailscale-user-name": "Spoofed User",
      "x-forwarded-for": "203.0.113.10",
    }, new URL("http://scenario-chat.example.ts.net:4197"), "100.64.0.2");
    expect(headers).toMatchObject({
      host: "scenario-chat.example.ts.net:4197",
      cookie: "paperclip_scenario-chat=capability",
      "x-forwarded-for": "100.64.0.2",
      "x-forwarded-host": "scenario-chat.example.ts.net:4197",
      "x-forwarded-proto": "http",
      "x-scenario-chat-proxy": "v1",
    });
    expect(headers).not.toHaveProperty("tailscale-user-login");
    expect(headers).not.toHaveProperty("tailscale-user-name");
  });
});
