import { describe, expect, it } from "vitest";
import {
  aliasFromConfigPath,
  consumerTypeLabel,
  deliveryModeForConfigPath,
  deliveryModeLabel,
} from "./secret-delivery";

describe("deliveryModeForConfigPath", () => {
  it("classifies env config paths", () => {
    expect(deliveryModeForConfigPath("env.OPENAI_API_KEY")).toBe("env");
  });

  it("classifies API-access config paths", () => {
    expect(deliveryModeForConfigPath("access.STRIPE")).toBe("api");
  });

  it("falls back to config for other paths and empties", () => {
    expect(deliveryModeForConfigPath("headers.authorization")).toBe("config");
    expect(deliveryModeForConfigPath(null)).toBe("config");
    expect(deliveryModeForConfigPath("")).toBe("config");
  });
});

describe("deliveryModeLabel", () => {
  it("maps each mode to a human label", () => {
    expect(deliveryModeLabel("env")).toBe("Env var");
    expect(deliveryModeLabel("api")).toBe("API access");
    expect(deliveryModeLabel("config")).toBe("Config");
  });
});

describe("aliasFromConfigPath", () => {
  it("strips the delivery prefix", () => {
    expect(aliasFromConfigPath("env.GH_TOKEN")).toBe("GH_TOKEN");
    expect(aliasFromConfigPath("access.STRIPE")).toBe("STRIPE");
  });

  it("returns the raw path when no known prefix applies", () => {
    expect(aliasFromConfigPath("headers.authorization")).toBe("headers.authorization");
    expect(aliasFromConfigPath(null)).toBe("");
  });
});

describe("consumerTypeLabel", () => {
  it("renders agent_api and other multiword consumers sensibly", () => {
    expect(consumerTypeLabel("agent_api")).toBe("Agent API");
    expect(consumerTypeLabel("plugin_worker")).toBe("Plugin worker");
    expect(consumerTypeLabel("tool_connection")).toBe("Tool connection");
  });

  it("capitalizes single-word consumer types", () => {
    expect(consumerTypeLabel("agent")).toBe("Agent");
    expect(consumerTypeLabel("project")).toBe("Project");
  });
});
