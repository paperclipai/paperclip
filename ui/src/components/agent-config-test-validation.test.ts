import { describe, expect, it } from "vitest";
import { validateAdapterEnvironmentTestInput } from "./agent-config-test-validation";

describe("validateAdapterEnvironmentTestInput", () => {
  it("requires a websocket URL for openclaw gateway tests", () => {
    expect(validateAdapterEnvironmentTestInput("openclaw_gateway", {})).toContain("Gateway URL");
    expect(
      validateAdapterEnvironmentTestInput("openclaw_gateway", {
        url: "https://ollama-api.example.test",
      }),
    ).toContain("WebSocket Gateway URL");
    expect(
      validateAdapterEnvironmentTestInput("openclaw_gateway", {
        url: "wss://gateway.example.test/socket",
      }),
    ).toBeNull();
  });

  it("requires an http url for ollama http tests", () => {
    expect(validateAdapterEnvironmentTestInput("ollama_http", {})).toContain("base URL");
    expect(
      validateAdapterEnvironmentTestInput("ollama_http", {
        baseUrl: "ws://gateway.example.test",
      }),
    ).toContain("HTTP base URL");
    expect(
      validateAdapterEnvironmentTestInput("ollama_http", {
        baseUrl: "https://ollama.example.test",
      }),
    ).toBeNull();
  });

  it("ignores adapter types without preflight validation", () => {
    expect(validateAdapterEnvironmentTestInput("claude_local", {})).toBeNull();
  });
});