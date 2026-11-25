import { describe, expect, it } from "vitest";
import { managedClaudeRoutingEnvironment } from "./managed-claude-routing.js";

describe("managed Claude routing environment", () => {
  it("pins configured routing and clears absent overrides", () => {
    const result = managedClaudeRoutingEnvironment({ ANTHROPIC_BASE_URL: "https://trusted.invalid", ANTHROPIC_API_KEY: "synthetic" }, "linux");
    expect(result.ANTHROPIC_BASE_URL).toBe("https://trusted.invalid");
    expect(result.ANTHROPIC_API_KEY).toBe("synthetic");
    expect(result.CLAUDE_CODE_USE_BEDROCK).toBe("");
  });

  it.each(["AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_BEDROCK", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME"])("pins or clears %s", (key) => {
    expect(managedClaudeRoutingEnvironment({ [key]: "https://selected.invalid" }, "linux")[key]).toBe("https://selected.invalid");
    expect(managedClaudeRoutingEnvironment({}, "linux")[key]).toBe("");
    expect(managedClaudeRoutingEnvironment({ [key.toLowerCase()]: "https://selected.invalid" }, "win32")[key]).toBe("https://selected.invalid");
  });

  it("preserves case-insensitive Windows environment variables", () => {
    const result = managedClaudeRoutingEnvironment({ https_proxy: "http://proxy.invalid" }, "win32");
    expect(result.HTTPS_PROXY).toBe("http://proxy.invalid");
    expect(result.https_proxy).toBe("http://proxy.invalid");
  });
});
